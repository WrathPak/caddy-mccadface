/**
 * Model builders for the 3-point rectangle, the 2-point / 3-point / 2-tangent circles and the centre-point arc. Same rules as
 * shapes.ts: they mutate a model the caller owns and leave the new geometry constrained.
 */
import { add, circumcircle, cross, dist, dot, intersectCircleCircle, intersectLineCircle, intersectLineLine, mul, norm, perp, polar, relAngle, sub, TAU } from './geom'
import { addArc, addCircle, addConic, addConstraint, addLine, addPoint, circleOf, entityById, lineEnds } from './model'
import type { ArcE, CircleE, ConicE, Entity, LineE, SketchModel, Vec2 } from './types'

// ------------------------------------------------------------------------------------------------ 3-point rectangle

/** Rectangle from the two ends of one side and a third point that sets how far the rectangle reaches to that side (squared up to it). */
export function drawRect3(m: SketchModel, a: Vec2, b: Vec2, third: Vec2, construction = false): string | { lines: string[]; pts: string[] } {
  const u = sub(b, a), l = Math.hypot(u[0], u[1])
  if (l < 1e-9) return 'The first side has no length: pick two different points'
  const n = perp(norm(u))
  const h = dot(sub(third, a), n)
  if (Math.abs(h) < 1e-9 * Math.max(1, l)) return 'Pick the third point away from the first side to give the rectangle a width'
  const off = mul(n, h)
  const pts = [addPoint(m, a[0], a[1]), addPoint(m, b[0], b[1]), addPoint(m, b[0] + off[0], b[1] + off[1]), addPoint(m, a[0] + off[0], a[1] + off[1])]
  const lines = [0, 1, 2, 3].map((i) => addLine(m, pts[i], pts[(i + 1) % 4], construction))
  // square corners, and level when the first side was drawn level (the 4th corner follows from the other three)
  for (let i = 0; i < 3; i++) addConstraint(m, { type: 'perpendicular', refs: [lines[i].id, lines[i + 1].id] })
  if (Math.abs(u[1]) < 1e-9 * l) addConstraint(m, { type: 'horizontal', refs: [lines[0].id] })
  else if (Math.abs(u[0]) < 1e-9 * l) addConstraint(m, { type: 'vertical', refs: [lines[0].id] })
  return { lines: lines.map((x) => x.id), pts }
}

// ------------------------------------------------------------------------------------------------ circles

/** Circle with its diameter between two points. */
export function drawCircle2(m: SketchModel, a: Vec2, b: Vec2, construction = false): string | CircleE {
  const d = dist(a, b)
  if (d < 1e-6) return 'The two points are the same: pick the ends of a diameter'
  const c = addPoint(m, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
  return addCircle(m, c, d / 2, construction)
}

/** Circle through three points. */
export function drawCircle3(m: SketchModel, a: Vec2, b: Vec2, c: Vec2, construction = false): string | CircleE {
  const cc = circumcircle(a, b, c)
  if (!cc) return 'The three points are in a line: no circle goes through them'
  return addCircle(m, addPoint(m, cc.c[0], cc.c[1]), cc.r, construction)
}

type Tangent = LineE | CircleE | ArcE
export const isTangentTarget = (e?: Entity): e is Tangent => e?.type === 'line' || e?.type === 'circle' || e?.type === 'arc'

/** The curves a circle of radius r that touches `e` has its centre on: the two parallels of a line, the two concentric circles of a circle or arc. */
function loci(m: SketchModel, e: Tangent, r: number): ({ k: 'l'; p: Vec2; q: Vec2 } | { k: 'c'; c: Vec2; r: number })[] {
  if (e.type === 'line') {
    const [a, b] = lineEnds(m, e)
    const n = mul(perp(norm(sub(b, a))), r)
    return [{ k: 'l', p: add(a, n), q: add(b, n) }, { k: 'l', p: sub(a, n), q: sub(b, n) }]
  }
  const { c, r: R } = circleOf(m, e)
  return [{ k: 'c', c, r: R + r }, ...(Math.abs(R - r) > 1e-9 ? [{ k: 'c' as const, c, r: Math.abs(R - r) }] : [])]
}

/** Every centre a circle of radius r touching both `a` and `b` can have. */
function centresFor(m: SketchModel, a: Tangent, b: Tangent, r: number): Vec2[] {
  const out: Vec2[] = []
  for (const x of loci(m, a, r)) {
    for (const y of loci(m, b, r)) {
      if (x.k === 'l' && y.k === 'l') { const h = intersectLineLine(x.p, x.q, y.p, y.q); if (h) out.push(h.p) }
      else if (x.k === 'l' && y.k === 'c') out.push(...intersectLineCircle(x.p, x.q, y.c, y.r).map((h) => h.p))
      else if (x.k === 'c' && y.k === 'l') out.push(...intersectLineCircle(y.p, y.q, x.c, x.r).map((h) => h.p))
      else if (x.k === 'c' && y.k === 'c') out.push(...intersectCircleCircle(x.c, x.r, y.c, y.r))
    }
  }
  return out
}

/**
 * The circle that touches both curves and reaches `near`: radius and centre are found by sliding the radius until the centre is as
 * close to the cursor as the two curves allow, so moving the mouse swings the circle through the four corners they make.
 */
export function circleTouching(m: SketchModel, a: Tangent, b: Tangent, near: Vec2): { c: Vec2; r: number } | null {
  const pa = lineOrCircleSize(m, a), pb = lineOrCircleSize(m, b)
  const scale = Math.max(pa, pb, 1)
  const best = (r: number) => {
    let bc: Vec2 | null = null, bd = Infinity
    for (const c of centresFor(m, a, b, r)) { const d = dist(c, near); if (d < bd) { bd = d; bc = c } }
    return { c: bc, d: bd }
  }
  let bestR = 0, bestD = Infinity
  for (let r = scale * 1e-3; r < scale * 40; r *= 1.04) { const f = best(r); if (f.c && f.d < bestD) { bestD = f.d; bestR = r } }
  if (!bestR) return null
  let lo = bestR / 1.04, hi = bestR * 1.04
  for (let i = 0; i < 40; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3
    if ((best(m1).c ? best(m1).d : Infinity) < (best(m2).c ? best(m2).d : Infinity)) hi = m2; else lo = m1
  }
  const r = (lo + hi) / 2, f = best(r)
  return f.c ? { c: f.c, r } : null
}
const lineOrCircleSize = (m: SketchModel, e: Tangent) => (e.type === 'line' ? dist(...lineEnds(m, e)) : circleOf(m, e).r * 2)

/** Circle touching two curves, with a tangent constraint to each. */
export function drawCircle2Tangent(m: SketchModel, aId: string, bId: string, near: Vec2, construction = false): string | CircleE {
  const a = entityById(m, aId), b = entityById(m, bId)
  if (!isTangentTarget(a) || !isTangentTarget(b)) return 'Pick lines, circles or arcs for the circle to touch'
  if (a.id === b.id) return 'Pick two different curves'
  const hit = circleTouching(m, a, b, near)
  if (!hit) return 'No circle touches those two curves there (parallel lines have no corner): pick another spot'
  const circle = addCircle(m, addPoint(m, hit.c[0], hit.c[1]), hit.r, construction)
  addConstraint(m, { type: 'tangent', refs: [a.id, circle.id] })
  addConstraint(m, { type: 'tangent', refs: [b.id, circle.id] })
  return circle
}

// ------------------------------------------------------------------------------------------------ centre point arc

/**
 * Arc round `centre` from `start`, ending on the ray through `end`. It turns the short way towards `end`, or - when `sweep` (degrees,
 * signed: positive counter-clockwise) is given - exactly that far.
 */
export function drawArcCentre(m: SketchModel, centre: Vec2, start: Vec2, end: Vec2, sweep?: number, construction = false): string | ArcE {
  const r = dist(centre, start)
  if (r < 1e-6) return 'Drag out from the centre to set the radius'
  const a0 = Math.atan2(start[1] - centre[1], start[0] - centre[0])
  let ccw: boolean, a1: number
  if (sweep !== undefined) {
    if (Math.abs(sweep) < 1e-6 || Math.abs(sweep) > 360 - 1e-6) return 'The sweep must be more than 0 and less than 360 degrees'
    ccw = sweep > 0
    a1 = a0 + (sweep * Math.PI) / 180
  } else {
    const a = Math.atan2(end[1] - centre[1], end[0] - centre[0])
    const d = relAngle(a, a0)
    if (d < 1e-6 || TAU - d < 1e-6) return 'Pick an end point round the circle from the start'
    ccw = d <= Math.PI
    a1 = a
  }
  const C = addPoint(m, centre[0], centre[1]), S = addPoint(m, start[0], start[1])
  const e = polar(centre, r, a1)
  const E = addPoint(m, e[0], e[1])
  return ccw ? addArc(m, C, S, E, construction) : addArc(m, C, E, S, construction)
}


// ------------------------------------------------------------------------------------------------ conic curve

/** Conic from its two end points, the apex (where the tangents at the ends meet) and a point it passes through (which sets rho). */
export function drawConic(m: SketchModel, s: Vec2, e: Vec2, apex: Vec2, through: Vec2, construction = false): string | ConicE {
  const mid: Vec2 = [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2]
  const ma = sub(apex, mid)
  const l2 = dot(ma, ma)
  if (dist(s, e) < 1e-6) return 'The two end points are the same: pick two different points'
  if (Math.sqrt(l2) < 1e-6 || Math.abs(cross(sub(e, s), ma)) < 1e-9 * Math.max(1, dist(s, e))) return 'Put the apex away from the line between the end points'
  // how far along from the middle of the chord towards the apex the curve passes the chosen point
  const rho = Math.min(0.95, Math.max(0.05, dot(sub(through, mid), ma) / l2))
  return addConic(m, addPoint(m, s[0], s[1]), addPoint(m, apex[0], apex[1]), addPoint(m, e[0], e[1]), rho, construction)
}
