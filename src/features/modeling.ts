/** Shared helpers for solid features: profile / face inputs, boolean combination, preview plumbing. */
import { RefReport, decodeRef, faceSigs, resolveFace, bodyIdsOf } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import type { FeatureCtx, FeatureResult } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { FaceIn, ProfileGroup } from '@/kernel/model-ops'
import { bbox, type Body, type Vec3 } from '@/kernel/types'
import { useSketchData } from '@/sketch/draw'
import { toWorld } from '@/sketch/plane'
import type { PlaneDef, SketchData } from '@/sketch/types'

export interface Env {
  bodies: Body[]
  dataOf(featureId: string): unknown
}

/** Environment for live previews: current document geometry + sketch data mirror. */
export function liveEnv(): Env {
  return { bodies: useDoc.getState().geometry, dataOf: (id) => useSketchData.getState().data[id] }
}
export const ctxEnv = (ctx: FeatureCtx): Env => ({ bodies: ctx.bodies, dataOf: ctx.dataOf })

/** `prof:<sketch>:<centroid,area>@<profile id>`: the id (entity ids of the outer loop) is what finds the profile again, the key is the fallback. */
export const profileRef = (featureId: string, key: string, id?: string) => `prof:${featureId}:${key}${id ? '@' + id : ''}`

export interface Inputs {
  groups: ProfileGroup[]
  faces: FaceIn[]
  /** world position / direction for the on-canvas manipulator */
  anchor: Vec3 | null
  normal: Vec3 | null
  /** first profile's sketch (for revolve axes) */
  sketch: { id: string; data: SketchData } | null
  missing: number
  /** refs that were re-bound by position / could not be resolved */
  report: RefReport
}

function nearestProfile(data: SketchData, key: string, id?: string) {
  const [cx, cy, area] = key.split(',').map(Number)
  let best = -1, bestScore = Infinity
  const among = id ? data.profiles.map((p, i) => ({ p, i })).filter((x) => x.p.id === id) : []
  if (among.length === 1) return { prof: among[0].p, byId: true }
  data.profiles.forEach((p, i) => {
    if (among.length && p.id !== id) return
    const scale = Math.max(1, Math.sqrt(Math.abs(area)))
    const score = Math.hypot(p.centroid[0] - cx, p.centroid[1] - cy) / scale + Math.abs(p.area - area) / Math.max(Math.abs(area), 1e-6)
    if (score < bestScore) { bestScore = score; best = i }
  })
  return best >= 0 && bestScore < 4 ? { prof: data.profiles[best], byId: false } : null
}

/** Resolve profile refs ("prof:<sketch>:<key>") and face refs (JSON) against the current environment. */
export function resolveInputs(refs: string[], env: Env): Inputs {
  const groups = new Map<string, ProfileGroup>()
  const faces: FaceIn[] = []
  let anchor: Vec3 | null = null, normal: Vec3 | null = null, missing = 0
  let sketch: Inputs['sketch'] = null
  const report = new RefReport()
  for (const r of refs) {
    if (r.startsWith('prof:')) {
      const [, fid, ...rest] = r.split(':')
      const data = env.dataOf(fid) as SketchData | undefined
      const [key, pid] = rest.join(':').split('@')
      const hit = data && nearestProfile(data, key, pid)
      const prof = hit?.prof
      if (!data || !hit || !prof) { missing++; report.lost.set(r, 'The profile no longer exists'); continue }
      if (pid && !hit.byId) report.rebound.set(r, 'A profile reference was re-bound by position, check it')
      else if (!pid && prof.id) report.upgrades.set(r, r + '@' + prof.id)
      let g = groups.get(fid)
      if (!g) groups.set(fid, (g = { plane: data.plane as PlaneDef, profiles: [] }))
      g.profiles.push({ outer: prof.outer, holes: prof.holes })
      if (!anchor) { anchor = toWorld(data.plane, prof.centroid); normal = data.plane.normal }
      if (!sketch) sketch = { id: fid, data }
      continue
    }
    const ref = decodeRef(r)
    if (ref && ref.kind === 'face') {
      const res = resolveFace(ref, env.bodies, report)
      if (!res) { missing++; continue }
      faces.push({ key: res.body.key, index: res.index })
      if (!anchor) { const sg = faceSigs(res.body)[res.index]; anchor = sg.centroid; normal = sg.normal }
    } else missing++
  }
  return { groups: [...groups.values()], faces, anchor, normal, sketch, missing, report }
}

const overlaps = (a: Body, t: { min: Vec3; max: Vec3 }) => {
  const b = bbox(a.mesh.positions)
  return [0, 1, 2].every((k) => b.min[k] <= t.max[k] + 1e-6 && b.max[k] >= t.min[k] - 1e-6)
}

/** Target B-rep / mesh bodies for an operation: explicit list, else every body overlapping the tool. */
export function targetBodies(bodies: Body[], tool: Body, explicit: string[]): Body[] {
  const ids = bodyIdsOf(explicit)
  if (ids.length) return bodies.filter((b) => ids.includes(b.id))
  const box = bbox(tool.mesh.positions)
  // an open surface that happens to lie in the way is not something to join to or cut: only an explicit pick can name it
  return bodies.filter((b) => !b.surface && overlaps(b, box))
}

/** Combine a tool body with the document: Join / Cut / Intersect / New body. */
export async function combine(ctx: FeatureCtx, tool: Body, op: string, explicit: string[]): Promise<FeatureResult> {
  const kernel = ctx.kernel
  const asNew = (): FeatureResult => ({ bodies: [{ ...tool, id: ctx.newBodyId(), name: ctx.feature.name }] })
  if (op === 'new') return asNew()
  const targets = targetBodies(ctx.bodies, tool, explicit)
  if (op === 'join') {
    if (!targets.length) return asNew()
    const [base, ...rest] = targets
    const r = (await kernel.boolean({ id: base.id, name: base.name, op: 'union', base: base.key, tools: [...rest.map((b) => b.key), tool.key], fid: ctx.feature.id })) as Body
    return { bodies: [r], remove: rest.map((b) => b.id) }
  }
  if (!targets.length) throw new Error(op === 'cut' ? 'Cut does not touch any body' : 'Intersect does not touch any body')
  const out: Body[] = []
  for (const t of targets) {
    out.push((await kernel.boolean({ id: t.id, name: t.name, op: op === 'cut' ? 'subtract' : 'intersect', base: t.key, tools: [tool.key], fid: ctx.feature.id })) as Body)
  }
  return { bodies: out }
}

export const kernelNow = () => getKernel()

/** Smallest real dimension of a body (open surfaces and flat things ignore their zero thickness). */
export function minDim(b: Body): number {
  const bb = bbox(b.mesh.positions)
  const d = [0, 1, 2].map((k) => bb.max[k] - bb.min[k]).filter((x) => x > 1e-6)
  return d.length ? Math.min(...d) : 0
}

/** Largest 1 / 2 / 5 x 10^k that is not above `x` (a starting size that reads as a number a person would type). */
export function niceFloor(x: number): number {
  if (!(x > 0)) return 0
  const e = Math.pow(10, Math.floor(Math.log10(x)))
  const m = x / e
  return +((m >= 5 ? 5 : m >= 2 ? 2 : 1) * e).toPrecision(2)
}

/** The body a tool is about to work on: the one holding the first picked thing, else the lone body of the document. */
export function workBody(pickedBodyIds: string[]): Body | undefined {
  const g = useDoc.getState().geometry.filter((b) => b.kind === 'brep' && !b.surface)
  return g.find((b) => b.id === pickedBodyIds[0]) ?? (g.length === 1 ? g[0] : undefined)
}
