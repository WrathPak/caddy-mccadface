/**
 * Sketch Extend, Break and Scale. Pure model edits on a model the caller owns (clone first, as `commit` does).
 *
 *  - Extend: the end of a line or arc nearest the click grows out along its own path to the first curve it meets, and stays on it
 *  - Break: a line, arc or circle is cut into separate curves at every crossing with the other curves (or at the click when
 *    nothing crosses it); the pieces stay joined at the cut points
 *  - Scale: selected curves grow or shrink about a base point; the dimensions among them follow
 */
import { dist, relAngle, TAU } from './geom'
import { addArc, addConstraint, addLine, addPoint, deps, entityById, pos, removeIds } from './model'
import { pointsOf } from './shapes'
import { clickParam, curveConstraint, cutsAlong, cutsOf, curveOf, pointAt, setPos, unpin } from './trim'
import { isDim, ORIGIN, type ArcE, type Constraint, type SketchModel, type Vec2 } from './types'
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
  unpin(m, P, id)
  setPos(m, P, hit.p)
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

