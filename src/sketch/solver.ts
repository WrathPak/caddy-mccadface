/**
 * Bridge between SketchModel and planegcs (WASM bundled as a Vite asset, never fetched from a CDN).
 *
 * How the planegcs API is used (checked against @salusoft89/planegcs' d.ts / README and by the tests in solver.test.ts):
 *  - `solve()` returns a SolveStatus: Success (0), Converged (1: solved, but redundant constraints were found),
 *    Failed (2: conflicting constraints / no solution), SuccessfulSolutionInvalid (3: arc rules broken). Only 0 and 1
 *    leave a usable solution; `apply_solution()` is called for those alone, so a failed solve never corrupts the model.
 *  - `get_gcs_conflicting_constraints()` / `get_gcs_redundant_constraints()` report constraint ids after a solve.
 *  - `gcs.dof()` is the degrees of freedom of the solved system (temporary constraints do not reduce it).
 *  - dragging uses `temporary: true` constraints: they only pull as far as the real constraints allow.
 */
import { GcsWrapper, init_planegcs_module, type SketchPrimitive } from '@salusoft89/planegcs'
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url'
import { ORIGIN, type Constraint, type SketchModel, type Vec2 } from './types'
import { arcInfo } from './geom'
import { cloneModel, entityById, pos } from './model'
import { freedom, maxResidual } from './dof'

let wrapper: GcsWrapper | null = null
let loading: Promise<void> | null = null

export function ensureSolver(): Promise<void> {
  return (loading ??= (async () => {
    const mod = await init_planegcs_module({ locateFile: () => wasmUrl })
    const w = new GcsWrapper(new mod.GcsSystem(), mod)
    w.debug_mode = 0 // DebugMode.NoDebug: the solver otherwise prints to the console on every solve
    wrapper = w
  })())
}
export const solverReady = () => wrapper !== null

/** Temporary (drag) targets: points pulled to a position; a curve pulled through a position. */
export interface DragSpec {
  points?: Record<string, Vec2>
  /** resize the circle / arc `id` so that it reaches `to` (its radius becomes the distance centre -> `to`) */
  curve?: { id: string; to: Vec2 }
}

export interface SolveInfo {
  ok: boolean
  /** planegcs status code (see above), -1 when the solver is not loaded */
  status: number
  dof: number
  /** ids of constraints that contradict the others */
  conflicts: string[]
  /** ids of constraints that are implied by the others */
  redundant: string[]
  /** entity ids (points, curves) that are fully determined */
  fixed: Set<string>
}

type Prim = Record<string, unknown> & { id: string; type: string }

const isRefPoint = (m: SketchModel, id: string) => {
  const e = entityById(m, id)
  return e?.type === 'point' && !!e.ref
}

function build(m: SketchModel, drag?: DragSpec, extra?: Prim[]): Prim[] {
  const prims: Prim[] = [{ id: ORIGIN, type: 'point', x: 0, y: 0, fixed: true }]
  const fixedPts = new Set(m.constraints.filter((c) => c.type === 'fix').map((c) => c.refs[0]))
  for (const e of m.entities) if (e.type === 'point') prims.push({ id: e.id, type: 'point', x: e.x, y: e.y, fixed: fixedPts.has(e.id) || !!e.ref })
  for (const e of m.entities) {
    if (e.type === 'line') prims.push({ id: e.id, type: 'line', p1_id: e.p1, p2_id: e.p2 })
    else if (e.type === 'circle') {
      prims.push({ id: e.id, type: 'circle', c_id: e.c, radius: e.r })
      if (e.ref) prims.push({ id: e.id + '~ref', type: 'circle_radius', c_id: e.id, radius: e.r, driving: true })
    } else if (e.type === 'arc') {
      const i = arcInfo(pos(m, e.c), pos(m, e.s), pos(m, e.e))
      prims.push({ id: e.id, type: 'arc', c_id: e.c, radius: i.r, start_angle: i.a0, end_angle: i.a1, start_id: e.s, end_id: e.e })
      prims.push({ id: e.id + '_rules', type: 'arc_rules', a_id: e.id })
    }
  }
  for (const c of m.constraints) prims.push(...mapConstraint(m, c).map((p) => ({ ...p, driving: true })))
  if (drag?.points) {
    for (const [id, [x, y]] of Object.entries(drag.points)) {
      if (isRefPoint(m, id)) continue
      prims.push({ id: `~x${id}`, type: 'coordinate_x', p_id: id, x, temporary: true, driving: true })
      prims.push({ id: `~y${id}`, type: 'coordinate_y', p_id: id, y, temporary: true, driving: true })
    }
  }
  if (drag?.curve) {
    const e = entityById(m, drag.curve.id)
    if (e && (e.type === 'circle' || e.type === 'arc') && !e.ref) {
      // resize about the (unpinned) centre: pull the radius to the cursor distance rather than the curve through the
      // cursor, which would also slide the centre
      const r = Math.max(1e-3, Math.hypot(drag.curve.to[0] - pos(m, e.c)[0], drag.curve.to[1] - pos(m, e.c)[1]))
      prims.push(e.type === 'circle'
        ? { id: '~dc', type: 'circle_radius', c_id: e.id, radius: r, temporary: true, driving: true }
        : { id: '~dc', type: 'arc_radius', a_id: e.id, radius: r, temporary: true, driving: true })
    }
  }
  if (extra) prims.push(...extra)
  // planegcs wants geometry before the constraints that reference it
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
    case 'coincident': return [{ id, type: 'p2p_coincident', p1_id: a, p2_id: b }]
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
    case 'tangentAt': return [{ id, type: 'angle_via_point', crv1_id: a, crv2_id: b, p_id: c.refs[2], angle: (val * Math.PI) / 180 }]
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
    case 'angle': {
      const rad = ((val * (c.sgn ?? 1)) * Math.PI) / 180
      if (b && t(a) === 'line' && t(b) === 'line') return [{ id, type: 'l2l_angle_ll', l1_id: a, l2_id: b, angle: rad }]
      // direction of a line / of the vector pointA -> pointB, measured from the +X axis
      const l = t(a) === 'line' ? (entityById(m, a) as { p1: string; p2: string }) : null
      return [{ id, type: 'p2p_angle', p1_id: l ? l.p1 : a, p2_id: l ? l.p2 : b, angle: rad }]
    }
    case 'offset': {
      if (t(a) === 'line') {
        const l = entityById(m, a) as { p1: string }
        return [{ id, type: 'p2l_distance', p_id: l.p1, l_id: b, distance: val }]
      }
      // circles / arcs: radius(offset) - radius(source) = sgn * value
      return [{ id, type: 'difference', param1: { o_id: b, prop: 'radius' }, param2: { o_id: a, prop: 'radius' }, difference: val * (c.sgn ?? 1) }]
    }
  }
}

interface RunOut {
  status: number
  ok: boolean
  /** the solver's iterate was copied into `prims` */
  applied: boolean
  dof: number
  conflicts: string[]
  redundant: string[]
  prims: Map<string, Prim>
}
function run(prims: Prim[], constraintIds?: Set<string>, soft = false): RunOut {
  const w = wrapper!
  w.clear_data()
  w.push_primitives_and_params(prims as unknown as SketchPrimitive[])
  const status = w.solve()
  const ok = status === 0 || status === 1
  // with soft (temporary) pulls even a "failed" iterate may be usable; the caller verifies it
  const applied = ok || (soft && status === 2)
  if (applied) w.apply_solution()
  // `_b` / `_rules` / `~ref` suffixes mark helper primitives that belong to one model constraint / entity
  const strip = (s: string) => s.replace(/(_b|_rules|~ref)$/, '')
  const only = (l: string[]) => [...new Set(l.map(strip))].filter((i) => !constraintIds || constraintIds.has(i))
  const out: RunOut = {
    status,
    ok,
    applied,
    dof: ok ? w.gcs.dof() : 0,
    conflicts: only(w.get_gcs_conflicting_constraints()),
    redundant: ok ? only(w.get_gcs_redundant_constraints()) : [],
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

const constraintIdsOf = (m: SketchModel) => new Set(m.constraints.map((c) => c.id))
const emptyInfo = (ok = true): SolveInfo => ({ ok, status: -1, dof: 1, conflicts: [], redundant: [], fixed: new Set() })

/**
 * Solve a copy of the model (with optional temporary drag constraints). Returns the solved model.
 *
 * Temporary constraints are soft pulls that planegcs satisfies as far as the real constraints allow. When several of
 * them contradict each other (dragging a fixed-length line by both ends) it reports Failed even though the iterate is a
 * perfectly good compromise; such a result is accepted when no real constraint is conflicting and re-checking every
 * real constraint against the result (dof.ts) shows they all still hold.
 */
export function solveModel(model: SketchModel, drag?: DragSpec): { model: SketchModel; info: SolveInfo } {
  const m = cloneModel(model)
  if (!wrapper) return { model: m, info: emptyInfo() }
  const r = run(build(m, drag), constraintIdsOf(m), !!(drag?.points || drag?.curve))
  let ok = r.ok
  if (r.applied) {
    writeBack(m, r.prims)
    if (!ok && r.conflicts.length === 0 && maxResidual(m) < 1e-6) ok = true
  }
  if (!ok) return { model: cloneModel(model), info: { ok: false, status: r.status, dof: 0, conflicts: r.conflicts, redundant: [], fixed: new Set() } }
  return { model: m, info: { ok, status: r.status, dof: r.dof, conflicts: r.conflicts, redundant: r.redundant, fixed: new Set() } }
}

/**
 * Which entities are fully determined?  planegcs' `info.dof` answers it for the sketch as a whole: 0 means every entity
 * is fixed and nothing else has to be computed.  When degrees of freedom remain, the rank structure of the constraint
 * Jacobian (dof.ts, a direct elimination per connected component, no solver runs) tells which points and circles take
 * part in them.  Cost grows with the size of the largest connected group of constraints, not with the sketch.
 */
export function analyze(model: SketchModel, info: SolveInfo): Set<string> {
  const fixed = new Set<string>()
  if (!info.ok) return fixed
  const add = (free: Set<string>) => {
    fixed.add(ORIGIN)
    for (const e of model.entities) {
      if (e.type === 'point') { if (!free.has(e.id)) fixed.add(e.id) }
      else if (e.type === 'line') { if (!free.has(e.p1) && !free.has(e.p2)) fixed.add(e.id) }
      else if (e.type === 'circle') { if (!free.has(e.c) && !free.has(e.id)) fixed.add(e.id) }
      else if (!free.has(e.c) && !free.has(e.s) && !free.has(e.e)) fixed.add(e.id)
    }
    return fixed
  }
  if (info.dof === 0) return add(new Set())
  return add(freedom(model).free)
}

export interface PrunedSolve {
  model: SketchModel
  info: SolveInfo
  /** constraints dropped because the others already implied them */
  pruned: string[]
  /** `strict` was set and a new constraint is redundant (nothing is pruned in that case) */
  overConstrained: boolean
}

/**
 * Solve and deal with redundancy. `existing` are the constraint ids that were already part of the sketch before the
 * edit: redundancy among those is left alone. A NEW constraint that is implied by the others is dropped (auto-added
 * snap constraints, hidden members of an offset group), or - with `strict`, for constraints the user asked for -
 * reported as over-constraining so the caller can refuse the edit.
 */
export function solvePruned(model: SketchModel, existing: Set<string>, strict = false): PrunedSolve {
  let r = solveModel(model)
  const fresh = (info: SolveInfo) => info.redundant.filter((id) => !existing.has(id))
  let drop = r.info.ok ? fresh(r.info) : []
  if (!drop.length) return { model: r.model, info: r.info, pruned: [], overConstrained: false }
  if (strict) return { model: r.model, info: r.info, pruned: [], overConstrained: true }
  const pruned: string[] = []
  const work = cloneModel(model)
  for (let pass = 0; pass < 4 && drop.length; pass++) {
    const gone = new Set(drop)
    work.constraints = work.constraints.filter((c) => !gone.has(c.id))
    pruned.push(...drop)
    r = solveModel(work)
    drop = r.info.ok ? fresh(r.info) : []
  }
  return { model: r.model, info: r.info, pruned, overConstrained: false }
}
