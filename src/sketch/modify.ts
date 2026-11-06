/**
 * Sketch Extend, Break and Scale. Pure model edits on a model the caller owns (clone first, as `commit` does).
 *
 *  - Extend: the end of a line or arc nearest the click grows out along its own path to the first curve it meets, and stays on it
 *  - Break: a line, arc or circle is cut into separate curves at every crossing with the other curves (or at the click when
 *    nothing crosses it); the pieces stay joined at the cut points
 *  - Scale: selected curves grow or shrink about a base point; the dimensions among them follow
 */
import { dist, relAngle, TAU } from './geom'
import { holds } from './holds'
import { addArc, addCircle, addConic, addConstraint, addEllipse, addLine, addPoint, addSpline, addText, deps, endPointsOf, entityById, newId, pos, removeIds } from './model'
import { pointsOf } from './shapes'
import { clickParam, curveConstraint, cutsAlong, cutsOf, curveOf, pointAt, release, setPos } from './trim'
import { isDim, ORIGIN, type ArcE, type Constraint, type Entity, type SketchModel, type Vec2 } from './types'
import { isDerived } from './curves'

const EPS = 1e-7
const REACH = 1e6 // how far a line is stretched when looking for what it runs into

/** Constraint that holds `point` on the curve `cutter` it was cut / extended to (none for splines and the like, which have no such constraint). */
const bindTo = (m: SketchModel, point: string, cutter: string) => {
  const c = entityById(m, cutter)
  if (c && !isDerived(c)) addConstraint(m, curveConstraint(m, point, cutter))
}

// ------------------------------------------------------------------------------------------------ extend

/** Extend the end of line / arc `id` that is nearer `click` out to the first curve in its way. */
export function extendCurve(m: SketchModel, id: string, click: Vec2): string | null {
  const e = entityById(m, id)
  if (!e || (e.type !== 'line' && e.type !== 'arc')) return 'Extend works on lines and arcs'
  if (e.ref) return 'Projected geometry cannot be changed'
  const ends: [string, string] = e.type === 'line' ? [e.p1, e.p2] : [e.s, e.e]
  const [pa, pb] = ends.map((p) => pos(m, p))
  const endIdx = dist(pa, click) <= dist(pb, click) ? 0 : 1
  const P = ends[endIdx]
  // only a free end can grow: one shared with another curve, or pinned by a constraint to other geometry, would drag that along
  const joined = m.entities.some((x) => x.id !== id && x.type !== 'point' && deps(x).includes(P))
  const tied = m.constraints.some((c) => c.refs.includes(P) && !isDim(c) && c.type !== 'pointOnLine' && c.type !== 'pointOnCurve')
  if (joined || tied) return 'Only an end that is not joined to anything can be extended'
  const at = pos(m, P)
  let hit: { p: Vec2; cutter: string } | null = null
  if (e.type === 'line') {
    const other = pos(m, ends[1 - endIdx])
    const u: Vec2 = [(at[0] - other[0]) / dist(at, other), (at[1] - other[1]) / dist(at, other)]
    const far: Vec2 = [at[0] + u[0] * REACH, at[1] + u[1] * REACH]
    const near = cutsAlong(m, id, { k: 'l', a: at, b: far }).find((c) => c.t * REACH > 1e-5)
    if (near) hit = { p: near.p, cutter: near.cutter }
  } else {
    const info = curveOf(m, e)
    if (info?.k !== 'a') return 'Extend works on lines and arcs'
    const fwd = endIdx === 1 // the end of an arc grows counter-clockwise, its start clockwise
    const a = Math.atan2(at[1] - info.c[1], at[0] - info.c[0])
    const cuts = cutsAlong(m, id, { k: 'c', c: info.c, r: info.r })
    let bd = Infinity
    for (const c of cuts) {
      const ca = Math.atan2(c.p[1] - info.c[1], c.p[0] - info.c[0])
      const d = fwd ? relAngle(ca, a) : relAngle(a, ca)
      if (d > 1e-5 && d < TAU - 1e-5 && d < bd) { bd = d; hit = { p: c.p, cutter: c.cutter } }
    }
  }
  if (!hit) return 'There is nothing in the way to extend to'
  setPos(m, P, hit.p)
  release(m, P, id)
  bindTo(m, P, hit.cutter)
  return null
}

// ------------------------------------------------------------------------------------------------ break

/** Cut curve `id` into separate curves at its crossings with other curves; with none (or too few for a circle), at `click`. */
export function breakCurve(m: SketchModel, id: string, click: Vec2): string | null {
  const e = entityById(m, id)
  if (!e || (e.type !== 'line' && e.type !== 'arc' && e.type !== 'circle')) return 'Break works on lines, arcs and circles'
  if (e.ref) return 'Projected geometry cannot be changed'
  const info = cutsOf(m, id)
  if (!info) return 'Nothing to break'
  const { cv } = info
  const max = cv.k === 'l' ? 1 : cv.k === 'a' ? cv.span : TAU
  let cuts: { t: number; p: Vec2; cutter: string | null }[] = info.cuts.filter((c) => (cv.k === 'c' ? true : c.t > EPS && c.t < max - EPS))
  if (cuts.length < (cv.k === 'c' ? 2 : 1)) {
    const t = clickParam(cv, click)
    const tooNear = (u: number) => Math.abs(u - t) < 1e-6
    if (cv.k !== 'c' && (t < EPS || t > max - EPS)) return 'Click inside the curve to say where to break it'
    if (!cuts.some((c) => tooNear(c.t))) cuts = [...cuts, { t, p: pointAt(cv, t), cutter: null }].sort((a, b) => a.t - b.t)
    if (cv.k === 'c' && cuts.length < 2) return 'A circle breaks into arcs at two points: cross it with another curve first, or click twice'
  }
  const make = (c: { p: Vec2; cutter: string | null }) => {
    const pid = addPoint(m, c.p[0], c.p[1], e.construction)
    if (c.cutter) bindTo(m, pid, c.cutter)
    return pid
  }
  const xs = cuts.map(make)

  if (e.type === 'line') {
    const p2 = e.p2
    const rest = [...xs, p2]
    e.p2 = xs[0]
    // later pieces stay on the line the first one lies along
    for (const x of xs.slice(1)) addConstraint(m, { type: 'pointOnLine', refs: [x, e.id] })
    addConstraint(m, { type: 'pointOnLine', refs: [p2, e.id] })
    for (let i = 0; i + 1 < rest.length; i++) addLine(m, rest[i], rest[i + 1], e.construction)
    return null
  }
  if (e.type === 'arc') {
    const end = e.e
    const rest = [...xs, end]
    e.e = xs[0]
    for (const x of xs.slice(1)) addConstraint(m, { type: 'pointOnCurve', refs: [x, e.id] })
    for (let i = 0; i + 1 < rest.length; i++) addArc(m, e.c, rest[i], rest[i + 1], e.construction)
    return null
  }
  // a circle becomes the arcs between its cut points; what was said of the circle (radius, tangents ...) is said of the first arc
  const arcs: ArcE[] = xs.map((x, i) => addArc(m, e.c, x, xs[(i + 1) % xs.length], e.construction))
  for (const c of m.constraints) c.refs = c.refs.map((r) => (r === e.id ? arcs[0].id : r))
  for (const x of xs.slice(1)) addConstraint(m, { type: 'pointOnCurve', refs: [x, arcs[0].id] })
  removeIds(m, [e.id])
  return null
}

// ------------------------------------------------------------------------------------------------ scale

export interface ScaleOpts { ids: string[]; base: Vec2; factor: number }

/** Scale the selected curves (and the points they are made of) about `base`. Dimensions among them are scaled with them. */
export function scaleCurves(m: SketchModel, o: ScaleOpts): string | null {
  const f = o.factor
  if (!(f > 0) || !Number.isFinite(f)) return 'The scale factor must be greater than zero'
  if (Math.abs(f - 1) < 1e-12) return 'A factor of 1 changes nothing'
  const curves = o.ids.map((i) => entityById(m, i)).filter((e) => e && e.type !== 'point' && !e.ref)
  if (!curves.length) return 'Select the curves to scale first'
  const pts = pointsOf(m, curves.map((c) => c!.id)).filter((p) => !(entityById(m, p) as { ref?: boolean } | undefined)?.ref)
  const inside = new Set<string>([...pts, ...curves.map((c) => c!.id)])
  const atOrigin = Math.abs(o.base[0]) < 1e-9 && Math.abs(o.base[1]) < 1e-9
  if (atOrigin) inside.add(ORIGIN) // scaling about the origin keeps whatever is measured from it consistent
  m.constraints = m.constraints.filter((c) => {
    const moved = c.refs.some((r) => inside.has(r))
    if (!moved) return true
    if (c.type === 'fix') return false
    if (c.type === 'onAxis' && !atOrigin) return false
    if (!atOrigin && c.refs.includes(ORIGIN)) return false
    // a dimension that ties the scaled curves to something that stays put would pull them back
    return !isDim(c) || c.refs.every((r) => inside.has(r))
  })
  for (const p of pts) {
    const [x, y] = pos(m, p)
    setPos(m, p, [o.base[0] + (x - o.base[0]) * f, o.base[1] + (y - o.base[1]) * f])
  }
  for (const c of curves) {
    if (c!.type === 'circle' || c!.type === 'ellipse') c!.r *= f
    else if (c!.type === 'text') c!.h *= f
  }
  for (const c of m.constraints) if (isDim(c) && c.refs.some((r) => inside.has(r))) scaleDim(c, f)
  return null
}

/** Lengths grow with the factor; angles stay. A parameter expression becomes the plain number it comes to. */
function scaleDim(c: Constraint, f: number) {
  if (c.type === 'angle' || c.value === undefined) return
  c.value *= f
  c.expr = String(+c.value.toFixed(6))
}


// ------------------------------------------------------------------------------------------------ chain, copy, move

/** The curve `id` and every curve joined to it end to end (a shared point, coincident ends, or ends in the same place), the way a double click selects them. */
export function connectedCurves(m: SketchModel, id: string): string[] {
  const curves = m.entities.filter((e) => e.type !== 'point')
  const joined = (a: Entity, b: Entity) => {
    for (const p of endPointsOf(a)) {
      for (const q of endPointsOf(b)) {
        if (p === q || dist(pos(m, p), pos(m, q)) < 1e-6) return true
        if (m.constraints.some((c) => c.type === 'coincident' && c.refs.includes(p) && c.refs.includes(q))) return true
      }
    }
    return false
  }
  const out = [id]
  for (let i = 0; i < out.length; i++) {
    const here = entityById(m, out[i])
    if (!here) continue
    for (const o of curves) if (!out.includes(o.id) && joined(here, o)) out.push(o.id)
  }
  return out
}

/**
 * Copies of curves (and the points they are made of, moved by `tf`) added to `m`. `from` is the model they are read from - `m`
 * itself, or a snapshot taken by Copy. The constraints among the copied things come along; ties to anything else (the origin, a
 * fixed point, geometry that is not copied) do not, so the copy is free to be moved.
 */
export function duplicateCurves(m: SketchModel, ids: string[], tf: (p: Vec2) => Vec2, from: SketchModel = m, rotateBy = 0): string[] {
  const curves = ids.map((i) => entityById(from, i)).filter((e): e is Entity => !!e && e.type !== 'point' && !e.ref)
  const pm = new Map<string, string>()
  for (const p of pointsOf(from, curves.map((c) => c.id))) {
    if (entityById(from, p)?.type === 'point' && (entityById(from, p) as { ref?: boolean }).ref) { pm.set(p, p); continue }
    const q = tf(pos(from, p))
    pm.set(p, addPoint(m, q[0], q[1]))
  }
  const P = (id: string) => pm.get(id) ?? id
  const cm = new Map<string, string>()
  for (const e of curves) {
    let n: Entity | null = null
    if (e.type === 'line') n = addLine(m, P(e.p1), P(e.p2), e.construction)
    else if (e.type === 'circle') n = addCircle(m, P(e.c), e.r, e.construction)
    else if (e.type === 'arc') n = addArc(m, P(e.c), P(e.s), P(e.e), e.construction)
    else if (e.type === 'ellipse') n = addEllipse(m, P(e.c), P(e.m), e.r, e.construction)
    else if (e.type === 'conic') n = addConic(m, P(e.s), P(e.a), P(e.e), e.rho, e.construction)
    else if (e.type === 'spline') {
      const sp = addSpline(m, e.pts.map(P), e.mode, e.closed, e.construction)
      if (e.t0) sp.t0 = P(e.t0)
      if (e.t1) sp.t1 = P(e.t1)
      n = sp
    } else if (e.type === 'text') n = addText(m, P(e.p), e.text, e.h, e.a + rotateBy, e.font)
    if (n) cm.set(e.id, n.id)
  }
  const inside = (r: string) => pm.has(r) || cm.has(r)
  const groups = new Map<string, string>()
  for (const c of from.constraints) {
    if (c.type === 'fix' || !c.refs.every(inside) || c.refs.some((r) => pm.get(r) === r)) continue
    const group = c.group ? (groups.get(c.group) ?? groups.set(c.group, newId(m, 'k')).get(c.group)) : undefined
    const { id: _id, name: _name, ...rest } = c
    void _id; void _name
    addConstraint(m, { ...rest, refs: c.refs.map((r) => cm.get(r) ?? P(r)), ...(group ? { group } : {}) })
  }
  // a copy that is turned is no longer level, upright or on an axis
  if (Math.abs(rotateBy) > 1e-9) {
    const made = new Set([...pm.values(), ...cm.values()])
    m.constraints = m.constraints.filter((c) => !(c.refs.some((r) => made.has(r)) && !holds(m, c)))
  }
  return [...cm.values()]
}

export interface MoveOpts { ids: string[]; dx: number; dy: number; angle: number }

/** Move the curves by (dx, dy) after turning them `angle` degrees about their middle. Constraints the move breaks are released. */
export function moveCurves(m: SketchModel, o: MoveOpts): string | null {
  const curves = o.ids.map((i) => entityById(m, i)).filter((e): e is Entity => !!e && e.type !== 'point' && !e.ref)
  if (!curves.length) return 'Select the curves to move first'
  if (Math.abs(o.dx) < 1e-12 && Math.abs(o.dy) < 1e-12 && Math.abs(o.angle) < 1e-12) return 'Set a distance or an angle to move by'
  const tf = transformOf(m, curves.map((c) => c.id), o)
  const pts = pointsOf(m, curves.map((c) => c.id)).filter((p) => !(entityById(m, p) as { ref?: boolean } | undefined)?.ref)
  const moved = new Set(pts)
  for (const p of pts) { const q = tf(pos(m, p)); setPos(m, p, q) }
  for (const c of curves) if (c.type === 'text') c.a += o.angle
  m.constraints = m.constraints.filter((c) => !c.refs.some((r) => moved.has(r) || curves.some((k) => k.id === r)) || holds(m, c))
  return null
}

/** The turn-then-shift of a Move / Copy as a function of a point. */
export function transformOf(m: SketchModel, ids: string[], o: { dx: number; dy: number; angle: number }): (p: Vec2) => Vec2 {
  const pts = pointsOf(m, ids).map((p) => pos(m, p))
  const cx = pts.reduce((a, p) => a + p[0], 0) / (pts.length || 1), cy = pts.reduce((a, p) => a + p[1], 0) / (pts.length || 1)
  const a = (o.angle * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a)
  return (p) => [cx + (p[0] - cx) * cs - (p[1] - cy) * sn + o.dx, cy + (p[0] - cx) * sn + (p[1] - cy) * cs + o.dy]
}
