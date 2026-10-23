/** Bridge between SketchModel and planegcs (WASM bundled as a Vite asset, never fetched from a CDN). */
import { GcsWrapper, init_planegcs_module, type SketchPrimitive } from '@salusoft89/planegcs'
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url'
import { ORIGIN, type Constraint, type SketchModel, type Vec2 } from './types'
import { arcInfo } from './geom'
import { cloneModel, entityById, pos } from './model'

let wrapper: GcsWrapper | null = null
let loading: Promise<void> | null = null

export function ensureSolver(): Promise<void> {
  return (loading ??= (async () => {
    const mod = await init_planegcs_module({ locateFile: () => wasmUrl })
    wrapper = new GcsWrapper(new mod.GcsSystem(), mod)
  })())
}
export const solverReady = () => wrapper !== null

/** Temporary (drag) targets: points pulled to a position; a curve pulled through a position. */
export interface DragSpec {
  points?: Record<string, Vec2>
  /** pull the curve `id` so it passes through `to` (circle radius / arc radius changes) */
  curve?: { id: string; to: Vec2 }
}

export interface SolveInfo {
  ok: boolean
  dof: number
  conflicts: string[]
  redundant: string[]
  /** entity ids (points, curves) that are fully determined */
  fixed: Set<string>
}

type Prim = Record<string, unknown> & { id: string; type: string }

function build(m: SketchModel, drag?: DragSpec, extra?: Prim[]): Prim[] {
  const prims: Prim[] = [{ id: ORIGIN, type: 'point', x: 0, y: 0, fixed: true }]
  const fixedPts = new Set(m.constraints.filter((c) => c.type === 'fix').map((c) => c.refs[0]))
  for (const e of m.entities) if (e.type === 'point') prims.push({ id: e.id, type: 'point', x: e.x, y: e.y, fixed: fixedPts.has(e.id) })
  for (const e of m.entities) {
    if (e.type === 'line') prims.push({ id: e.id, type: 'line', p1_id: e.p1, p2_id: e.p2 })
    else if (e.type === 'circle') prims.push({ id: e.id, type: 'circle', c_id: e.c, radius: e.r })
    else if (e.type === 'arc') {
      const i = arcInfo(pos(m, e.c), pos(m, e.s), pos(m, e.e))
      prims.push({ id: e.id, type: 'arc', c_id: e.c, radius: i.r, start_angle: i.a0, end_angle: i.a1, start_id: e.s, end_id: e.e })
      prims.push({ id: e.id + '_rules', type: 'arc_rules', a_id: e.id })
    }
  }
  for (const c of m.constraints) prims.push(...mapConstraint(m, c).map((p) => ({ ...p, driving: true })))
  if (drag?.points) {
    for (const [id, [x, y]] of Object.entries(drag.points)) {
      prims.push({ id: `~x${id}`, type: 'coordinate_x', p_id: id, x, temporary: true, driving: true })
      prims.push({ id: `~y${id}`, type: 'coordinate_y', p_id: id, y, temporary: true, driving: true })
    }
  }
  if (drag?.curve) {
    const e = entityById(m, drag.curve.id)
    if (e && (e.type === 'circle' || e.type === 'arc')) {
      prims.push({ id: '~dp', type: 'point', x: drag.curve.to[0], y: drag.curve.to[1], fixed: true })
      prims.push({ id: '~dc', type: e.type === 'circle' ? 'point_on_circle' : 'point_on_arc', p_id: '~dp', [e.type === 'circle' ? 'c_id' : 'a_id']: e.id, temporary: true, driving: true })
    }
  }
  if (extra) prims.push(...extra)
  // planegcs wants geometry before constraints; constraints were pushed last except the dummy point above
  return prims.sort((a, b) => weight(a.type) - weight(b.type))
}
const weight = (t: string) => (t === 'point' ? 0 : t === 'line' || t === 'circle' || t === 'arc' ? 1 : 2)

function mapConstraint(m: SketchModel, c: Constraint): Prim[] {
  const [a, b] = c.refs
  const id = c.id
  const t = (e: string) => entityById(m, e)?.type
  const val = c.value ?? 0
  switch (c.type) {
    case 'fix': return []
    case 'pointOnLine': return [{ id, type: 'point_on_line_pl', p_id: a, l_id: b }]
    case 'pointOnCurve': return [t(b) === 'arc' ? { id, type: 'point_on_arc', p_id: a, a_id: b } : { id, type: 'point_on_circle', p_id: a, c_id: b }]
    case 'onAxis': return [c.axis === 'x' ? { id, type: 'coordinate_y', p_id: a, y: 0 } : { id, type: 'coordinate_x', p_id: a, x: 0 }]
    case 'midpoint': return [
      { id, type: 'point_on_line_pl', p_id: a, l_id: b },
      { id: id + '_b', type: 'point_on_perp_bisector_pl', p_id: a, l_id: b },
    ]
    case 'horizontal': return [b ? { id, type: 'horizontal_pp', p1_id: a, p2_id: b } : { id, type: 'horizontal_l', l_id: a }]
    case 'vertical': return [b ? { id, type: 'vertical_pp', p1_id: a, p2_id: b } : { id, type: 'vertical_l', l_id: a }]
    case 'parallel': return [{ id, type: 'parallel', l1_id: a, l2_id: b }]
    case 'perpendicular': return [{ id, type: 'perpendicular_ll', l1_id: a, l2_id: b }]
    case 'tangent': {
      const ta = t(a), tb = t(b)
      if (ta === 'line') return [tb === 'arc' ? { id, type: 'tangent_la', l_id: a, a_id: b } : { id, type: 'tangent_lc', l_id: a, c_id: b }]
      if (tb === 'line') return [ta === 'arc' ? { id, type: 'tangent_la', l_id: b, a_id: a } : { id, type: 'tangent_lc', l_id: b, c_id: a }]
      if (ta === 'circle' && tb === 'circle') return [{ id, type: 'tangent_cc', c1_id: a, c2_id: b }]
      if (ta === 'arc' && tb === 'arc') return [{ id, type: 'tangent_aa', a1_id: a, a2_id: b }]
      return [ta === 'circle' ? { id, type: 'tangent_ca', c_id: a, a_id: b } : { id, type: 'tangent_ca', c_id: b, a_id: a }]
    }
    case 'equal': {
      const ta = t(a), tb = t(b)
      if (ta === 'line') return [{ id, type: 'equal_length', l1_id: a, l2_id: b }]
      if (ta === 'circle' && tb === 'circle') return [{ id, type: 'equal_radius_cc', c1_id: a, c2_id: b }]
      if (ta === 'arc' && tb === 'arc') return [{ id, type: 'equal_radius_aa', a1_id: a, a2_id: b }]
      return [ta === 'circle' ? { id, type: 'equal_radius_ca', c1_id: a, a2_id: b } : { id, type: 'equal_radius_ca', c1_id: b, a2_id: a }]
    }
    case 'distance':
      return [t(b) === 'line' ? { id, type: 'p2l_distance', p_id: a, l_id: b, distance: val } : { id, type: 'p2p_distance', p1_id: a, p2_id: b, distance: val }]
    case 'hdist':
      return [{ id, type: 'difference', param1: { o_id: a, prop: 'x' }, param2: { o_id: b, prop: 'x' }, difference: val * (c.sgn ?? 1) }]
    case 'vdist':
      return [{ id, type: 'difference', param1: { o_id: a, prop: 'y' }, param2: { o_id: b, prop: 'y' }, difference: val * (c.sgn ?? 1) }]
    case 'radius': return [t(a) === 'arc' ? { id, type: 'arc_radius', a_id: a, radius: val } : { id, type: 'circle_radius', c_id: a, radius: val }]
    case 'diameter': return [t(a) === 'arc' ? { id, type: 'arc_diameter', a_id: a, diameter: val } : { id, type: 'circle_diameter', c_id: a, diameter: val }]
    case 'angle': return [{ id, type: 'l2l_angle_ll', l1_id: a, l2_id: b, angle: ((val * (c.sgn ?? 1)) * Math.PI) / 180 }]
  }
}

interface RunOut { status: number; dof: number; conflicts: string[]; redundant: string[]; prims: Map<string, Prim> }
function run(prims: Prim[]): RunOut {
  const w = wrapper!
  w.clear_data()
  w.push_primitives_and_params(prims as unknown as SketchPrimitive[])
  const status = w.solve()
  const ok = status === 0 || status === 1
  if (ok) w.apply_solution()
  const strip = (s: string) => s.replace(/(_b|_rules)$/, '')
  const out: RunOut = {
    status,
    dof: ok ? w.gcs.dof() : 0,
    conflicts: [...new Set(w.get_gcs_conflicting_constraints().map(strip))],
    redundant: [...new Set(w.get_gcs_redundant_constraints().map(strip))],
    prims: new Map(),
  }
  for (const p of w.sketch_index.get_primitives()) out.prims.set(p.id, p as unknown as Prim)
  return out
}

/** Read solved point positions / circle radii back into the model. */
function writeBack(m: SketchModel, prims: Map<string, Prim>) {
  for (const e of m.entities) {
    const p = prims.get(e.id)
    if (!p) continue
    if (e.type === 'point') { e.x = p.x as number; e.y = p.y as number }
    else if (e.type === 'circle') e.r = Math.abs(p.radius as number)
  }
}

/** Solve a copy of the model (with optional temporary drag constraints). Returns the solved model. */
export function solveModel(model: SketchModel, drag?: DragSpec): { model: SketchModel; info: SolveInfo } {
  const m = cloneModel(model)
  if (!wrapper) return { model: m, info: { ok: true, dof: 1, conflicts: [], redundant: [], fixed: new Set() } }
  const r = run(build(m, drag))
  const ok = r.status === 0 || r.status === 1
  if (ok) writeBack(m, r.prims)
  return { model: m, info: { ok, dof: r.dof, conflicts: r.conflicts, redundant: r.redundant, fixed: new Set() } }
}

/** Determine which entities are fully constrained by trying to nudge every point / radius. */
export function analyze(model: SketchModel, info: SolveInfo): Set<string> {
  const fixed = new Set<string>()
  if (!wrapper || !info.ok) return fixed
  const pts = model.entities.filter((e) => e.type === 'point')
  const freePoint = new Set<string>()
  const freeRadius = new Set<string>()
  if (info.dof > 0) {
    const fixedByConstraint = new Set(model.constraints.filter((c) => c.type === 'fix').map((c) => c.refs[0]))
    for (const p of pts) {
      if (fixedByConstraint.has(p.id)) continue
      const r = run(build(model, { points: { [p.id]: [p.x + 0.37, p.y + 0.23] } }))
      const q = r.prims.get(p.id)
      if (!q || (r.status !== 0 && r.status !== 1) || Math.hypot((q.x as number) - p.x, (q.y as number) - p.y) > 1e-3) freePoint.add(p.id)
    }
    for (const e of model.entities) {
      if (e.type !== 'circle') continue
      const r = run(build(model, undefined, [{ id: '~rad', type: 'circle_radius', c_id: e.id, radius: e.r + 0.41, temporary: true, driving: true }]))
      const q = r.prims.get(e.id)
      if (!q || Math.abs((q.radius as number) - e.r) > 1e-3) freeRadius.add(e.id)
    }
  }
  const dead = (id: string) => freePoint.has(id)
  for (const e of model.entities) {
    if (e.type === 'point') { if (!dead(e.id)) fixed.add(e.id) }
    else if (e.type === 'line') { if (!dead(e.p1) && !dead(e.p2)) fixed.add(e.id) }
    else if (e.type === 'circle') { if (!dead(e.c) && !freeRadius.has(e.id)) fixed.add(e.id) }
    else if (!dead(e.c) && !dead(e.s) && !dead(e.e)) fixed.add(e.id)
  }
  return fixed
}
