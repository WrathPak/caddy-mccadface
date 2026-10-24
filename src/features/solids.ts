/** Cylinder primitive, Sweep, Loft, Combine and Shell: schemas, compute (kernel ops in kernel/solid-ops.ts), live previews. */
import { Cylinder, Package, Path, Shapes, Unite } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, bodyIdsOf, decodeRef, encodeSelection, resolveFace } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel, type KernelClient } from '@/kernel/client'
import type { LoftSection, PathSeg } from '@/kernel/solid-ops'
import type { Body, Vec3 } from '@/kernel/types'
import { useSketchData } from '@/sketch/draw'
import { arcOf, lineEnds, pos } from '@/sketch/model'
import { dist, polar } from '@/sketch/geom'
import { derivedSegs, entityPolyline } from '@/sketch/curves'
import { originPlane, toWorld } from '@/sketch/plane'
import type { SketchData, Vec2 } from '@/sketch/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, setPreview, useProfilePick } from '@/viewport/preview'
import { combine, ctxEnv, liveEnv, profileRef, resolveInputs, type Env } from './modeling'
import { createRunner } from './previewKit'

// ---------------------------------------------------------------- Cylinder

export const cylinderSchema: ParamSchema = {
  id: 'cylinder',
  title: 'Cylinder',
  params: [
    { type: 'enum', key: 'plane', help: 'The plane the cylinder stands on: XY makes it point up (Z), XZ points along Y, YZ points along X.', label: 'Base plane', display: 'segmented', default: 'XY', options: [{ value: 'XY', label: 'XY' }, { value: 'XZ', label: 'XZ' }, { value: 'YZ', label: 'YZ' }] },
    { type: 'vector3', key: 'position', help: 'Where the middle of the cylinder base sits, as X, Y, Z in mm.', label: 'Base center', unit: 'mm', step: 1, default: [0, 0, 0] },
    { type: 'number', key: 'radius', help: 'Radius of the cylinder, in mm (half the diameter).', label: 'Radius', unit: 'mm', min: 0.001, step: 1, default: 10 },
    { type: 'number', key: 'height', help: 'Length of the cylinder along its axis, in mm.', label: 'Height', unit: 'mm', min: 0.001, step: 1, default: 20 },
  ],
}

function cylinderArgs(p: ParamValues, id: string, name: string) {
  const plane = originPlane((p.plane as 'XY' | 'XZ' | 'YZ') ?? 'XY')
  return { id, name, radius: p.radius as number, height: p.height as number, origin: p.position as Vec3, dir: plane.normal }
}

registerFeature({
  type: 'cylinder',
  label: 'Cylinder',
  icon: Cylinder,
  schema: cylinderSchema,
  async compute(ctx, p) {
    const body = (await ctx.kernel.call('cylinderTool', cylinderArgs(p, ctx.newBodyId(), ctx.feature.name))) as Body
    return { bodies: [body] }
  },
  preview({ values }) {
    let cur: ParamValues = values
    const runner = createRunner(async (stale) => {
      let p: ParamValues
      try { p = resolveParams(cylinderSchema, cur) } catch { clearPreview(); return }
      const body = (await getKernel().call('cylinderTool', cylinderArgs(p, 'preview', 'preview'))) as Body
      if (!stale()) setPreview([{ mesh: body.mesh, kind: 'add' }])
    })
    runner.schedule()
    return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clearPreview() } }
  },
})

// ---------------------------------------------------------------- shared helpers

const opOptions = [
  { value: 'join', label: 'Join' }, { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' }, { value: 'new', label: 'New body' },
]

/** Plane-local sketch curves -> one connected chain of world-space segments. */
export function sketchPath(data: SketchData): PathSeg[] {
  const model = { entities: data.entities, constraints: data.constraints, next: 0 }
  interface L { a: Vec2; b: Vec2; m?: Vec2; c?: [Vec2, Vec2]; id?: string }
  const segs: L[] = []
  for (const e of data.entities) {
    if (e.construction || e.type === 'point') continue
    if (e.type === 'line') {
      const [a, b] = lineEnds(model, e)
      if (dist(a, b) > 1e-9) segs.push({ a, b, id: e.id })
    } else if (e.type === 'arc') {
      const i = arcOf(model, e)
      segs.push({ a: pos(model, e.s), b: pos(model, e.e), m: polar(pos(model, e.c), i.r, i.a0 + i.span / 2), id: e.id })
    } else if (e.type === 'circle') {
      const c = pos(model, e.c)
      const p0: Vec2 = [c[0] + e.r, c[1]], p1: Vec2 = [c[0] - e.r, c[1]]
      segs.push({ a: p0, b: p1, m: [c[0], c[1] + e.r], id: e.id }, { a: p1, b: p0, m: [c[0], c[1] - e.r], id: e.id })
    } else {
      // splines and ellipses are followed exactly, piece by piece (cubic curves); only text falls back to straight pieces
      const loops = e.type === 'text' ? [] : derivedSegs(model, e)
      if (loops.length) {
        for (const s of loops[0]) if (s.k === 'b') segs.push({ a: s.a, b: s.b, c: [s.c1, s.c2], id: e.id })
      } else {
        const pl = entityPolyline(model, e)
        for (let i = 0; i + 1 < pl.length; i++) if (dist(pl[i], pl[i + 1]) > 1e-9) segs.push({ a: pl[i], b: pl[i + 1], id: e.id })
      }
    }
  }
  if (!segs.length) throw new Error('The path sketch has no curves')
  const same = (p: Vec2, q: Vec2) => dist(p, q) < 1e-5
  const degree = (p: Vec2) => segs.filter((s) => same(s.a, p)).length + segs.filter((s) => same(s.b, p)).length
  const startIdx = Math.max(0, segs.findIndex((s) => degree(s.a) === 1 || degree(s.b) === 1))
  const used = new Set<number>([startIdx])
  let first = segs[startIdx]
  if (degree(first.b) === 1 && degree(first.a) !== 1) first = { a: first.b, b: first.a, m: first.m, c: first.c && [first.c[1], first.c[0]], id: first.id }
  const chain: L[] = [first]
  for (let end = first.b; ;) {
    const k = segs.findIndex((s, i) => !used.has(i) && (same(s.a, end) || same(s.b, end)))
    if (k < 0) break
    used.add(k)
    const s = segs[k]
    const oriented: L = same(s.a, end) ? s : { a: s.b, b: s.a, m: s.m, c: s.c && [s.c[1], s.c[0]], id: s.id }
    chain.push(oriented)
    end = oriented.b
  }
  if (used.size !== segs.length) throw new Error('The path sketch curves must form one connected chain')
  const w = (p: Vec2): Vec3 => toWorld(data.plane, p)
  return chain.map((s): PathSeg => (s.c ? { k: 'b', a: w(s.a), c1: w(s.c[0]), c2: w(s.c[1]), b: w(s.b), id: s.id } : s.m ? { k: 'a', a: w(s.a), m: w(s.m), b: w(s.b), id: s.id } : { k: 'l', a: w(s.a), b: w(s.b), id: s.id }))
}

function pathOf(refs: string[], env: Env): PathSeg[] {
  const id = refs[0] ? bodyIdsOf([refs[0]])[0] : undefined
  const data = id ? (env.dataOf(id) as SketchData | undefined) : undefined
  if (!data) throw new Error(refs.length ? 'The path sketch no longer exists' : 'Select a sketch for the path')
  return sketchPath(data)
}

/** Profile refs wired to the viewport profile picker; returns a cleanup function. */
function profilePicking(get: () => ParamValues, set: (v: ParamValues) => void) {
  const profiles = () => ((get().profiles as string[]) ?? []).filter((s) => s.startsWith('prof:'))
  const sync = () => useProfilePick.setState({
    active: true,
    selected: profiles(),
    toggle: (ref) => {
      const list = profiles()
      set({ ...get(), profiles: list.includes(ref) ? list.filter((r) => r !== ref) : [...list, ref] })
    },
  })
  sync()
  return { sync, dispose: () => useProfilePick.setState({ active: false, selected: [], toggle: null }) }
}

/** Preview of a tool body (translucent add / cut) built from the current values. */
function toolPreview(schema: ParamSchema, build: (p: ParamValues, env: Env, kernel: KernelClient) => Promise<Body | null>, { values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  const runner = createRunner(async (stale) => {
    let p: ParamValues
    try { p = resolveParams(schema, cur) } catch { clearPreview(); return }
    let tool: Body | null = null
    try { tool = await build(p, liveEnv(), getKernel()) } catch { /* incomplete input: show nothing */ }
    if (stale()) return
    if (!tool) clearPreview()
    else setPreview([{ mesh: tool.mesh, kind: p.operation === 'cut' ? 'cut' : 'add' }])
  })
  const picking = profilePicking(() => cur, (v) => { cur = v; setValues(v) })
  runner.schedule()
  return {
    update(v) { cur = v; picking.sync(); runner.schedule() },
    dispose() { runner.dispose(); clearPreview(); picking.dispose() },
  }
}

// ---------------------------------------------------------------- Sweep

export const sweepSchema: ParamSchema = {
  id: 'sweep',
  title: 'Sweep',
  params: [
    { type: 'selection-ref', key: 'profiles', help: 'The closed sketch shape to drag along the path.', label: 'Profile', accepts: ['sketch'], multiple: true, required: true, default: [] },
    { type: 'selection-ref', key: 'path', help: 'The sketch line or curve the profile follows. Click it in the viewport.', label: 'Path', accepts: ['sketch'], required: true, pick: true, default: [] },
    { type: 'enum', key: 'operation', help: 'Join: add to the body. Cut: remove material. Intersect: keep only the overlap. New body: make a separate body.', label: 'Operation', display: 'select', default: 'join', options: opOptions },
    { type: 'selection-ref', key: 'targets', help: 'The bodies to join to, cut or intersect. Leave empty to use every body that the shape touches.', label: 'Target bodies', accepts: ['body'], multiple: true, default: [], visibleWhen: (v) => v.operation !== 'new' },
  ],
}

async function buildSweep(p: ParamValues, env: Env, kernel: KernelClient, id: string, name: string, report = new RefReport()): Promise<Body> {
  const inp = resolveInputs(p.profiles as string[], env)
  inp.report.rebound.forEach((v, k) => report.rebound.set(k, v))
  inp.report.upgrades.forEach((v, k) => report.upgrades.set(k, v))
  if (!inp.groups.length) throw new RefError(inp.missing ? 'The profile no longer exists (an edit upstream removed it). Pick it again.' : 'Select a profile to sweep', inp.report.lostRefs)
  const path = pathOf(p.path as string[], env)
  return (await kernel.call('sweepTool', { id, name, groups: inp.groups, path })) as Body
}

registerFeature({
  type: 'sweep',
  label: 'Sweep',
  icon: Path,
  schema: sweepSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const tool = await buildSweep(p, ctxEnv(ctx), ctx.kernel, ctx.newBodyId(), ctx.feature.name, report)
    const res = await combine(ctx, tool, p.operation as string, p.targets as string[])
    return { ...res, warning: report.warning ?? res.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview: (ctx) => toolPreview(sweepSchema, (p, env, k) => buildSweep(p, env, k, 'preview', 'preview'), ctx),
})

// ---------------------------------------------------------------- Loft

export const loftSchema: ParamSchema = {
  id: 'loft',
  title: 'Loft',
  params: [
    { type: 'selection-ref', key: 'profiles', help: 'The closed sketch shapes to blend between, in order. Pick at least two.', label: 'Profiles', accepts: ['sketch'], multiple: true, required: true, min: 2, default: [] },
    { type: 'bool', key: 'ruled', help: 'On: straight lines between the profiles (angular). Off: a smooth curve through them.', label: 'Ruled (straight sections)', default: false },
    { type: 'enum', key: 'operation', help: 'Join: add to the body. Cut: remove material. Intersect: keep only the overlap. New body: make a separate body.', label: 'Operation', display: 'select', default: 'join', options: opOptions },
    { type: 'selection-ref', key: 'targets', help: 'The bodies to join to, cut or intersect. Leave empty to use every body that the shape touches.', label: 'Target bodies', accepts: ['body'], multiple: true, default: [], visibleWhen: (v) => v.operation !== 'new' },
  ],
}

async function buildLoft(p: ParamValues, env: Env, kernel: KernelClient, id: string, name: string, report = new RefReport()): Promise<Body> {
  const sections: LoftSection[] = []
  for (const ref of p.profiles as string[]) {
    const inp = resolveInputs([ref], env)
    inp.report.rebound.forEach((v, k) => report.rebound.set(k, v))
    inp.report.upgrades.forEach((v, k) => report.upgrades.set(k, v))
    const g = inp.groups[0]
    if (!g) throw new RefError('A loft profile no longer exists (an edit upstream removed it). Pick it again.', inp.report.lostRefs)
    sections.push({ plane: g.plane, profile: g.profiles[0] })
  }
  if (sections.length < 2) throw new Error('A loft needs at least two profiles')
  return (await kernel.call('loftTool', { id, name, sections, ruled: !!p.ruled })) as Body
}

registerFeature({
  type: 'loft',
  label: 'Loft',
  icon: Shapes,
  schema: loftSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const tool = await buildLoft(p, ctxEnv(ctx), ctx.kernel, ctx.newBodyId(), ctx.feature.name, report)
    const res = await combine(ctx, tool, p.operation as string, p.targets as string[])
    return { ...res, warning: report.warning ?? res.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview: (ctx) => toolPreview(loftSchema, (p, env, k) => buildLoft(p, env, k, 'preview', 'preview'), ctx),
})

/** Sketch ids visible at the rollback point (for pre-filling profile lists). */
function visibleSketches() {
  const doc = useDoc.getState()
  const data = useSketchData.getState().data
  return doc.features.filter((f, i) => f.type === 'sketch' && i < doc.rollback && !f.suppressed && data[f.id]).map((f) => ({ id: f.id, data: data[f.id] }))
}
const selectedSketchIds = () => useUi.getState().selection.filter((r) => r.kind === 'sketch').map((r) => r.id)

export function startSweep() {
  const sketches = visibleSketches()
  const chosen = selectedSketchIds()
  // a selected sketch is the path; otherwise the path is the one sketch that has curves but no closed region
  const openOnes = sketches.filter((s) => s.data.profiles.length === 0 && s.data.entities.some((e) => e.type !== 'point' && !e.construction))
  const path = chosen.length === 1 ? [chosen[0]] : openOnes.length === 1 ? [openOnes[0].id] : []
  // the profile is the one sketch with a single closed region (other than the path)
  const others = sketches.filter((s) => !path.includes(s.id) && s.data.profiles.length)
  const profiles = others.length === 1 && others[0].data.profiles.length === 1 ? [profileRef(others[0].id, others[0].data.profiles[0].key, others[0].data.profiles[0].id)] : []
  createFeature('sweep', { profiles, path }, 'solid.sweep')
}

export function startLoft() {
  const sketches = visibleSketches()
  const chosen = selectedSketchIds()
  const pool = chosen.length >= 2 ? sketches.filter((s) => chosen.includes(s.id)) : sketches
  // one profile from every sketch, but only when that is unambiguous
  const profiles = pool.length >= 2 && pool.every((s) => s.data.profiles.length === 1) ? pool.map((s) => profileRef(s.id, s.data.profiles[0].key, s.data.profiles[0].id)) : []
  createFeature('loft', { profiles }, 'solid.loft')
}

// ---------------------------------------------------------------- Combine

export const combineSchema: ParamSchema = {
  id: 'combine',
  title: 'Combine',
  params: [
    { type: 'selection-ref', key: 'target', help: 'The body that is changed (the one you keep working on).', label: 'Target body', accepts: ['body'], required: true, pick: true, default: [] },
    { type: 'selection-ref', key: 'tools', help: 'The bodies that act on the target: they are added to it, cut out of it, or intersected with it.', label: 'Tool bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [] },
    { type: 'enum', key: 'operation', help: 'Join: merge the tools into the target. Cut: subtract the tools from it. Intersect: keep only the part where they overlap.', label: 'Operation', display: 'segmented', default: 'join', options: [{ value: 'join', label: 'Join' }, { value: 'cut', label: 'Cut' }, { value: 'intersect', label: 'Intersect' }] },
    { type: 'bool', key: 'keepTools', help: 'Leave the tool bodies in place after the operation instead of using them up.', label: 'Keep tools', default: false },
  ],
}

const BOOL_OP: Record<string, 'union' | 'subtract' | 'intersect'> = { join: 'union', cut: 'subtract', intersect: 'intersect' }

interface CombinePlan { target: Body; tools: Body[]; op: 'union' | 'subtract' | 'intersect'; keep: boolean }

function planCombine(p: ParamValues, find: (id: string) => Body | undefined): CombinePlan {
  const [tid] = bodyIdsOf((p.target as string[]) ?? [])
  const target = tid ? find(tid) : undefined
  if (!target) throw new Error(tid ? 'The target body no longer exists' : 'Select the target body')
  const tools = bodyIdsOf((p.tools as string[]) ?? []).filter((id) => id !== target.id).map(find)
  if (!tools.length || tools.some((t) => !t)) throw new Error(tools.length ? 'A tool body no longer exists' : 'Select at least one tool body')
  return { target, tools: tools as Body[], op: BOOL_OP[p.operation as string] ?? 'union', keep: !!p.keepTools }
}

registerFeature({
  type: 'combine',
  label: 'Combine',
  icon: Unite,
  schema: combineSchema,
  async compute(ctx, p) {
    const { target, tools, op, keep } = planCombine(p, (id) => ctx.body(id))
    // B-rep inputs use OpenCascade; as soon as one input is a mesh the kernel falls back to manifold
    const result = (await ctx.kernel.boolean({ id: target.id, name: target.name, op, base: target.key, tools: tools.map((t) => t.key) })) as Body
    return { bodies: [result], remove: keep ? [] : tools.map((t) => t.id) }
  },
  preview({ values }) {
    let cur = values
    const runner = createRunner(async (stale) => {
      let plan: CombinePlan
      try {
        plan = planCombine(resolveParams(combineSchema, cur), (id) => useDoc.getState().geometry.find((b) => b.id === id))
      } catch { clearPreview(); return }
      const result = (await getKernel().boolean({ id: 'preview', name: 'preview', op: plan.op, base: plan.target.key, tools: plan.tools.map((t) => t.key) })) as Body
      if (stale()) return
      setPreview([{ mesh: result.mesh, kind: 'result' }], [plan.target.id, ...(plan.keep ? [] : plan.tools.map((t) => t.id))])
    })
    runner.schedule()
    return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clearPreview() } }
  },
})

export function startCombine(operation = 'join') {
  const geometry = useDoc.getState().geometry
  const ids = [...new Set(useUi.getState().selection.filter((r) => r.kind === 'body' || r.kind === 'mesh').map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id))
  createFeature('combine', { target: ids.slice(0, 1), tools: ids.slice(1), operation }, 'solid.combine')
}

// ---------------------------------------------------------------- Shell

export const shellSchema: ParamSchema = {
  id: 'shell',
  title: 'Shell',
  params: [
    { type: 'selection-ref', key: 'faces', help: 'The faces that become openings. Click them in the viewport. Everything else is hollowed out.', label: 'Faces to remove', accepts: ['face'], multiple: true, required: true, pick: true, default: [] },
    { type: 'number', key: 'thickness', help: 'Wall thickness left after hollowing, in mm.', label: 'Thickness', unit: 'mm', min: 0.001, step: 0.5, default: 2 },
    { type: 'enum', key: 'side', help: 'Inside: the wall grows into the body, keeping its outer size. Outside: the wall grows outward, keeping the inner size.', label: 'Direction', display: 'segmented', default: 'inside', options: [{ value: 'inside', label: 'Inside' }, { value: 'outside', label: 'Outside' }] },
  ],
}

function shellGroups(refs: string[], bodies: Body[], report = new RefReport()): { body: Body; faces: number[] }[] {
  const by = new Map<string, { body: Body; faces: number[] }>()
  for (const s of refs) {
    const ref = decodeRef(s)
    const r = ref && ref.kind === 'face' ? resolveFace(ref, bodies, report) : null
    if (!r) throw new RefError('A face to remove no longer exists (an edit upstream removed it). Pick it again.', report.lostRefs)
    const g = by.get(r.body.id) ?? by.set(r.body.id, { body: r.body, faces: [] }).get(r.body.id)!
    if (!g.faces.includes(r.index)) g.faces.push(r.index)
  }
  if (!by.size) throw new Error('Select the faces to remove')
  for (const g of by.values()) if (g.body.kind !== 'brep') throw new Error('Shell needs a solid (B-rep) body')
  return [...by.values()]
}

async function runShell(kernel: KernelClient, p: ParamValues, bodies: Body[], idOf?: (b: Body) => string, fid = 'preview', report = new RefReport()): Promise<Body[]> {
  const out: Body[] = []
  for (const g of shellGroups(p.faces as string[], bodies, report)) {
    out.push((await kernel.call('shellOp', { id: idOf ? idOf(g.body) : g.body.id, name: g.body.name, key: g.body.key, faces: g.faces, thickness: p.thickness as number, side: p.side as string, fid })) as Body)
  }
  return out
}

registerFeature({
  type: 'shell',
  label: 'Shell',
  icon: Package,
  schema: shellSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const bodies = await runShell(ctx.kernel, p, ctx.bodies, undefined, ctx.feature.id, report)
    return { bodies, warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview({ values }) {
    let cur = values
    const runner = createRunner(async (stale) => {
      let p: ParamValues
      try { p = resolveParams(shellSchema, cur) } catch { clearPreview(); return }
      const bodies = useDoc.getState().geometry
      let out: Body[]
      try { out = await runShell(getKernel(), p, bodies, (b) => 'preview-' + b.id) } catch { clearPreview(); return }
      if (stale()) return
      setPreview(out.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), out.map((b) => b.id.replace('preview-', '')))
    })
    runner.schedule()
    return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clearPreview() } }
  },
})

export function startShell() {
  const faces = encodeSelection(useUi.getState().selection.filter((r) => r.kind === 'face'), useDoc.getState().geometry)
  createFeature('shell', { faces }, 'solid.shell')
}
