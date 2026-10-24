/** Hollow: turn a body into a shell of a given wall thickness, with drain holes placed by clicking on the surface. */
import { Drop } from '@phosphor-icons/react'
import { create } from 'zustand'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, bodyIdsOf } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { HollowArgs } from '@/kernel/print-ops'
import type { Body, MeshData, Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema } from '@/ui/schema'
import { clearPreview, setPreview } from '@/viewport/preview'
import { createRunner } from '../previewKit'

export interface Drain { p: Vec3; n: Vec3 }

export const hollowSchema: ParamSchema = {
  id: 'hollow',
  title: 'Hollow',
  params: [
    { type: 'selection-ref', key: 'bodies', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [], help: 'The bodies to hollow out. Each keeps its outside shape and gets an empty inside.' },
    { type: 'number', key: 'thickness', label: 'Wall thickness', unit: 'mm', min: 0.2, step: 0.2, default: 2, help: 'How thick the wall that is left should be, in mm. It has to be less than half the smallest size of the body.' },
    { type: 'number', key: 'diameter', label: 'Drain hole diameter', unit: 'mm', min: 0.5, step: 0.5, default: 3, help: 'Width of the holes that let trapped powder or resin out, in mm. They go through the wall into the empty inside.' },
    {
      type: 'info', key: 'drainInfo', label: 'Drain holes', default: '',
      help: 'How many drain holes are placed. Click Add drain holes in the viewport bar, then click the surface where each hole should go.',
      text: (v) => {
        const n = ((v.drains as string[]) ?? []).length
        return n ? `${n} drain ${n === 1 ? 'hole' : 'holes'}. Use the bar at the top of the viewport to add or remove them.` : 'None yet. Use the bar at the top of the viewport to add them by clicking the surface.'
      },
    },
    // the placed holes; edited from the viewport bar, so the dialog does not show this field
    { type: 'selection-ref', key: 'drains', label: 'Holes', accepts: ['face'], default: [], visibleWhen: () => false, help: 'The positions of the drain holes, kept with the feature and edited from the viewport bar.' },
  ],
}

interface HollowP { bodies: string[]; thickness: number; diameter: number; drains: string[] }

export const encodeDrain = (d: Drain) => JSON.stringify({ p: d.p.map((x) => +x.toFixed(3)), n: d.n.map((x) => +x.toFixed(4)) })
export function decodeDrain(s: string): Drain | null {
  try {
    const j = JSON.parse(s) as Drain
    return Array.isArray(j.p) && Array.isArray(j.n) && j.p.length === 3 && j.n.length === 3 ? j : null
  } catch { return null }
}

/** Distance from a point to the surface of a display mesh. */
export function distanceToMesh(p: Vec3, m: Pick<MeshData, 'positions' | 'indices'>): number {
  let best = Infinity
  const P = m.positions
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3
    const d = pointTriangle(p, [P[a], P[a + 1], P[a + 2]], [P[b], P[b + 1], P[b + 2]], [P[c], P[c + 1], P[c + 2]])
    if (d < best) best = d
  }
  return best
}

function pointTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]]
  const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  const at = (q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
  if (d1 <= 0 && d2 <= 0) return at(a)
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return at(b)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return at([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]) }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return at(c)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return at([a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]) }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return at([b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]) }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w])
}

/** Which body each drain belongs to: the one whose surface it is closest to (within 1 mm). */
export function assignDrains(drains: Drain[], bodies: Body[]): Map<string, Drain[]> {
  const out = new Map<string, Drain[]>()
  for (const d of drains) {
    let best: Body | null = null, bd = 1
    for (const b of bodies) {
      const dist = distanceToMesh(d.p, b.mesh)
      if (dist < bd) { bd = dist; best = b }
    }
    if (best) out.set(best.id, [...(out.get(best.id) ?? []), d])
  }
  return out
}

async function runHollow(p: HollowP, bodies: Body[], call: (n: string, a: unknown) => Promise<unknown>, fid: string, idOf: (b: Body) => string): Promise<{ bodies: Body[]; warning?: string }> {
  const targets = bodyIdsOf(p.bodies).map((id) => bodies.find((b) => b.id === id)).filter((b): b is Body => !!b)
  if (!targets.length) throw new RefError(p.bodies.length ? 'The bodies to hollow no longer exist. Pick them again.' : 'Select a body to hollow', [])
  const drains = p.drains.map(decodeDrain).filter((d): d is Drain => !!d)
  const per = assignDrains(drains, targets)
  const placed = [...per.values()].reduce((n, l) => n + l.length, 0)
  const out: Body[] = []
  for (const b of targets) {
    out.push((await call('printHollow', { id: idOf(b), name: b.name, key: b.key, thickness: p.thickness, drains: per.get(b.id) ?? [], diameter: p.diameter, fid } satisfies HollowArgs)) as Body)
  }
  const lost = drains.length - placed
  return { bodies: out, warning: lost ? `${lost} drain ${lost === 1 ? 'hole is' : 'holes are'} no longer on the surface and ${lost === 1 ? 'was' : 'were'} left out` : undefined }
}

registerFeature({
  type: 'hollow',
  label: 'Hollow',
  icon: Drop,
  schema: hollowSchema,
  async compute(ctx, raw) {
    return runHollow(raw as unknown as HollowP, ctx.bodies, (n, a) => ctx.kernel.call(n, a as never), ctx.feature.id, (b) => b.id)
  },
  preview: (ctx) => hollowPreview(ctx),
})

/** Drain hole placing state shared with the viewport. */
export const useDrains = create<{
  /** the dialog is open */
  open: boolean
  /** clicking the surface adds a hole */
  adding: boolean
  holes: Drain[]
  diameter: number
  set: ((holes: Drain[]) => void) | null
}>(() => ({ open: false, adding: false, holes: [], diameter: 3, set: null }))

function hollowPreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  const sync = () => useDrains.setState({
    open: true,
    holes: ((cur.drains as string[]) ?? []).map(decodeDrain).filter((d): d is Drain => !!d),
    diameter: (cur.diameter as number) || 3,
    set: (holes) => { cur = { ...cur, drains: holes.map(encodeDrain) }; setValues(cur); sync() },
  })
  sync()
  const runner = createRunner(async (stale) => {
    let p: HollowP
    try { p = resolveParams(hollowSchema, cur) as unknown as HollowP } catch { clearPreview(); return }
    // while holes are being placed the real body is shown, so clicks land on its surface
    if (useDrains.getState().adding) { clearPreview(); return }
    try {
      const r = await runHollow(p, useDoc.getState().geometry, (n, a) => getKernel().call(n, a as never), 'preview', (b) => `preview.${b.id}`)
      if (stale()) return
      setPreview(r.bodies.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), bodyIdsOf(p.bodies))
      useUi.setState({ inspectorNotice: null })
    } catch (e) {
      if (stale()) return
      clearPreview()
      useUi.setState({ inspectorNotice: e instanceof Error ? e.message : String(e) })
    }
  }, 260)
  runner.schedule()
  const off = useDrains.subscribe((n, o) => { if (n.adding !== o.adding) runner.schedule() })
  return {
    update(v) { cur = v; sync(); runner.schedule() },
    dispose() {
      off()
      runner.dispose()
      clearPreview()
      useUi.setState({ inspectorNotice: null })
      useDrains.setState({ open: false, adding: false, holes: [], set: null })
    },
  }
}

export function startHollow() {
  const { geometry } = useDoc.getState()
  const sel = useUi.getState().selection
  let ids = [...new Set(sel.map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id))
  if (!ids.length && geometry.length === 1) ids = [geometry[0].id]
  createFeature('hollow', { bodies: ids }, 'print.hollow')
}
