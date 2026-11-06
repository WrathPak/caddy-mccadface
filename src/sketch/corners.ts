/**
 * Sketch fillet and chamfer for corners that involve an arc: a line and an arc, or two arcs, that meet end to end. (Two lines are
 * done in shapes.ts.) The corner is released the same way: the two curves end at the new tangent / cut points and a point K stays
 * at the sharp corner, on both curves, so the dimensions and constraints that referred to the corner keep their meaning.
 */
import { add, cross, dist, dot, intersectCircleCircle, intersectLineCircle, intersectLineLine, mul, norm, perp, relAngle, sub, TAU } from './geom'
import { defaultOff } from './dims'
import { addArc, addConstraint, addLine, addPoint, deps, entityById, newId, pos, removeIds, tangentValue } from './model'
import { ORIGIN, type ArcE, type LineE, type SketchModel, type Vec2 } from './types'

type Curve = LineE | ArcE
export const isCornerCurve = (e: unknown): e is Curve => !!e && ((e as Curve).type === 'line' || (e as Curve).type === 'arc')
const endsOf = (e: Curve): [string, string] => (e.type === 'line' ? [e.p1, e.p2] : [e.s, e.e])
const DIM_K = 6

export interface CurveCorner { a: Curve; b: Curve; pa: string; pb: string; at: Vec2 }

/** The corner where two lines / arcs meet end to end (the same point, or ends in the same place). */
export function cornerOfCurves(m: SketchModel, a: Curve, b: Curve): CurveCorner | null {
  let best: CurveCorner | null = null, bd = Infinity
  for (const pa of endsOf(a)) {
    for (const pb of endsOf(b)) {
      const d = dist(pos(m, pa), pos(m, pb))
      if (d < bd) { bd = d; best = { a, b, pa, pb, at: pos(m, pa) } }
    }
  }
  return best && bd < 1e-5 && a.id !== b.id ? best : null
}

/** A curve as seen from the corner: a line leaves it along `d`; an arc runs round (c, r) and its parameter is the angle from its start. */
type Leg = { k: 'l'; K: Vec2; d: Vec2; len: number } | { k: 'a'; K: Vec2; c: Vec2; r: number; a0: number; span: number; fromStart: boolean }

function legOf(m: SketchModel, e: Curve, end: string): Leg {
  const K = pos(m, end)
  if (e.type === 'line') {
    const far = pos(m, e.p1 === end ? e.p2 : e.p1)
    return { k: 'l', K, d: norm(sub(far, K)), len: dist(far, K) }
  }
  const c = pos(m, e.c), s = pos(m, e.s), f = pos(m, e.e)
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0])
  return { k: 'a', K, c, r: dist(c, s), a0, span: relAngle(Math.atan2(f[1] - c[1], f[0] - c[0]), a0) || TAU, fromStart: e.s === end }
}

/** Is p (on the leg's carrier) strictly between the corner and the far end? */
function onLeg(l: Leg, p: Vec2): boolean {
  if (l.k === 'l') { const t = dot(sub(p, l.K), l.d); return t > 1e-6 && t < l.len - 1e-6 }
  const t = relAngle(Math.atan2(p[1] - l.c[1], p[0] - l.c[0]), l.a0)
  return t > 1e-6 && t < l.span - 1e-6
}

/** Where the circle of radius r about x touches the leg's carrier (the point of the carrier nearest to x, for a line). */
function touchPoint(l: Leg, x: Vec2, r: number): Vec2 {
  if (l.k === 'l') return add(l.K, mul(l.d, dot(sub(x, l.K), l.d)))
  const u = norm(sub(x, l.c))
  const p = add(l.c, mul(u, l.r)), q = sub(l.c, mul(u, l.r))
  return Math.abs(dist(x, p) - r) <= Math.abs(dist(x, q) - r) ? p : q
}

/** Curves a fillet circle's centre lies on for radius r: both parallels of a line, the outer and inner concentric circle of an arc. */
function centreLoci(l: Leg, r: number): ({ k: 'l'; p: Vec2; q: Vec2 } | { k: 'c'; c: Vec2; r: number })[] {
  if (l.k === 'l') {
    const n = mul(perp(l.d), r)
    return [{ k: 'l', p: add(l.K, n), q: add(add(l.K, l.d), n) }, { k: 'l', p: sub(l.K, n), q: sub(add(l.K, l.d), n) }]
  }
  return [{ k: 'c', c: l.c, r: l.r + r }, ...(Math.abs(l.r - r) > 1e-9 ? [{ k: 'c' as const, c: l.c, r: Math.abs(l.r - r) }] : [])]
}

const meet = (x: ReturnType<typeof centreLoci>[number], y: ReturnType<typeof centreLoci>[number]): Vec2[] => {
  if (x.k === 'l' && y.k === 'l') { const h = intersectLineLine(x.p, x.q, y.p, y.q); return h ? [h.p] : [] }
  if (x.k === 'l' && y.k === 'c') return intersectLineCircle(x.p, x.q, y.c, y.r).map((h) => h.p)
  if (x.k === 'c' && y.k === 'l') return intersectLineCircle(y.p, y.q, x.c, x.r).map((h) => h.p)
  return x.k === 'c' && y.k === 'c' ? intersectCircleCircle(x.c, x.r, y.c, y.r) : []
}

/** The fillet circle of radius r that touches both legs on their way out of the corner (nearest the corner when several do). */
export function filletCircle(la: Leg, lb: Leg, r: number): { x: Vec2; ta: Vec2; tb: Vec2 } | null {
  let best: { x: Vec2; ta: Vec2; tb: Vec2 } | null = null, bd = Infinity
  for (const p of centreLoci(la, r)) {
    for (const q of centreLoci(lb, r)) {
      for (const x of meet(p, q)) {
        const ta = touchPoint(la, x, r), tb = touchPoint(lb, x, r)
        if (!onLeg(la, ta) || !onLeg(lb, tb)) continue
        if (Math.abs(dist(x, ta) - r) > 1e-6 * Math.max(1, r) || Math.abs(dist(x, tb) - r) > 1e-6 * Math.max(1, r)) continue
        const d = dist(ta, la.K) + dist(tb, lb.K)
        if (d < bd) { bd = d; best = { x, ta, tb } }
      }
    }
  }
  return best
}

/** The point of a leg at straight-line distance d from the corner (the one nearest the corner along the curve when there are two). */
export function legPointAt(l: Leg, d: number): Vec2 | null {
  if (l.k === 'l') return d > 1e-9 && d < l.len - 1e-9 ? add(l.K, mul(l.d, d)) : null
  const t0 = l.fromStart ? 0 : l.span
  const hits = intersectCircleCircle(l.K, d, l.c, l.r).filter((p) => onLeg(l, p))
  hits.sort((p, q) => Math.abs(arcT(l, p) - t0) - Math.abs(arcT(l, q) - t0))
  return hits[0] ?? null
}
const arcT = (l: Extract<Leg, { k: 'a' }>, p: Vec2) => relAngle(Math.atan2(p[1] - l.c[1], p[0] - l.c[0]), l.a0)

function replaceEnd(e: Curve, old: string, nw: string) {
  if (e.type === 'line') { if (e.p1 === old) e.p1 = nw; else e.p2 = nw } else if (e.s === old) e.s = nw; else e.e = nw
}

/** Take the two curves off the corner: their ends move to `repl`, and a point K stays at the sharp corner on both. */
function releaseCorner(m: SketchModel, c: CurveCorner, repl: [string, string]): string {
  const K = addPoint(m, c.at[0], c.at[1])
  replaceEnd(c.a, c.pa, repl[0])
  replaceEnd(c.b, c.pb, repl[1])
  m.constraints = m.constraints.filter((k) => !(k.type === 'coincident' && k.refs.every((r) => r === c.pa || r === c.pb)))
  for (const k of m.constraints) k.refs = k.refs.map((r) => (r === c.pa || r === c.pb ? K : r))
  const used = (id: string) => m.entities.some((e) => e.type !== 'point' && deps(e).includes(id))
  const gone = [c.pa, c.pb].filter((id, i, arr) => arr.indexOf(id) === i && id !== ORIGIN && !used(id))
  if (gone.length) removeIds(m, gone)
  for (const e of [c.a, c.b]) addConstraint(m, { type: e.type === 'line' ? 'pointOnLine' : 'pointOnCurve', refs: [K, e.id] })
  return K
}

function legs(m: SketchModel, a: Curve, b: Curve): { c: CurveCorner; la: Leg; lb: Leg } | string {
  const c = cornerOfCurves(m, a, b)
  if (!c) return 'The two curves must meet at a corner'
  return { c, la: legOf(m, a, c.pa), lb: legOf(m, b, c.pb) }
}

/** Round the corner of a line and an arc, or two arcs, with a tangent arc of radius r (a radius dimension is added). */
export function filletCurves(m: SketchModel, a: Curve, b: Curve, r: number): string | { arc: string } {
  const g = legs(m, a, b)
  if (typeof g === 'string') return g
  if (!(r > 0)) return 'The radius must be greater than zero'
  const f = filletCircle(g.la, g.lb, r)
  if (!f) return 'No fillet of that radius fits between these curves: try a smaller one'
  const T1 = addPoint(m, f.ta[0], f.ta[1]), T2 = addPoint(m, f.tb[0], f.tb[1]), C = addPoint(m, f.x[0], f.x[1])
  releaseCorner(m, g.c, [T1, T2])
  const arc = cross(sub(f.ta, f.x), sub(f.tb, f.x)) > 0 ? addArc(m, C, T1, T2) : addArc(m, C, T2, T1)
  addConstraint(m, { type: 'tangentAt', refs: [a.id, arc.id, T1], value: tangentValue(m, a.id, arc.id, T1) })
  addConstraint(m, { type: 'tangentAt', refs: [b.id, arc.id, T2], value: tangentValue(m, b.id, arc.id, T2) })
  addConstraint(m, { type: 'radius', refs: [arc.id], value: r, expr: String(+r.toFixed(4)), off: defaultOff(m, 'radius', [arc.id], DIM_K) })
  return { arc: arc.id }
}

/** Cut the corner of a line and an arc, or two arcs, with a straight chamfer: d1 from the corner along the first curve, d2 along the second. */
export function chamferCurves(m: SketchModel, a: Curve, b: Curve, d1: number, d2: number): string | { line: string } {
  const g = legs(m, a, b)
  if (typeof g === 'string') return g
  if (!(d1 > 0) || !(d2 > 0)) return 'The chamfer distances must be greater than zero'
  const p1 = legPointAt(g.la, d1), p2 = legPointAt(g.lb, d2)
  if (!p1 || !p2) return 'The chamfer is longer than the curves'
  const T1 = addPoint(m, p1[0], p1[1]), T2 = addPoint(m, p2[0], p2[1])
  const K = releaseCorner(m, g.c, [T1, T2])
  const line = addLine(m, T1, T2)
  const group = d1 === d2 ? newId(m, 'k') : undefined
  addConstraint(m, { type: 'distance', refs: [K, T1], value: d1, expr: String(+d1.toFixed(4)), off: defaultOff(m, 'distance', [K, T1], DIM_K), ...(group ? { group } : {}) })
  addConstraint(m, { type: 'distance', refs: [K, T2], value: d2, expr: String(+d2.toFixed(4)), off: defaultOff(m, 'distance', [K, T2], DIM_K), ...(group ? { group, hidden: true } : {}) })
  return { line: line.id }
}

export const curveById = (m: SketchModel, id: string): Curve | null => { const e = entityById(m, id); return isCornerCurve(e) ? e : null }
