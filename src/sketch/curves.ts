/**
 * Curves that are derived from points rather than being primitives of the solver: splines (fit point, control point,
 * Bezier), ellipses and text outlines. Each becomes a list of cubic Bezier pieces (text also has straight pieces), which is
 * what profile detection, drawing, hit testing and the kernel work with.
 */
import { bezAt, bezFlatten, bezFromQuad, bezLine, bezClosest, type Bez } from './bezier'
import { dist, sub, add, mul, perp, norm, TAU } from './geom'
import { entityById, pos } from './model'
import { fontNow, layoutText } from './font'
import type { Entity, EllipseE, Seg, SketchModel, SplineE, TextE, Vec2 } from './types'

export type DerivedEntity = SplineE | EllipseE | TextE
export const isDerived = (e: Entity): e is DerivedEntity => e.type === 'spline' || e.type === 'ellipse' || e.type === 'text'

const len = (a: Vec2) => Math.hypot(a[0], a[1])

// ------------------------------------------------------------------------------------------------ splines

/**
 * Fit spline: a C1 chain of cubics through the points. The tangent at each point is a chord-length weighted average of the
 * two neighbouring chords (Bessel), which does not overshoot when the spacing is uneven. Open splines start and end straight
 * unless a tangent handle gives the first / last inner control point.
 */
export function fitBeziers(P: Vec2[], closed: boolean, h0?: Vec2, h1?: Vec2): Bez[] {
  const pts: Vec2[] = []
  for (const p of P) if (!pts.length || dist(p, pts[pts.length - 1]) > 1e-9) pts.push(p)
  const n = pts.length
  if (n < 2) return []
  const at = (i: number) => pts[((i % n) + n) % n]
  const chord = (i: number) => dist(at(i), at(i + 1))
  const tangent = (i: number): Vec2 => {
    const open = !closed
    if (open && i === 0) return norm(sub(at(1), at(0)))
    if (open && i === n - 1) return norm(sub(at(n - 1), at(n - 2)))
    const a = chord(i - 1), b = chord(i)
    const d0 = mul(sub(at(i), at(i - 1)), 1 / (a || 1)), d1 = mul(sub(at(i + 1), at(i)), 1 / (b || 1))
    const t = add(mul(d0, b / (a + b || 1)), mul(d1, a / (a + b || 1)))
    return len(t) < 1e-12 ? d1 : norm(t)
  }
  const segs = closed && n >= 3 ? n : n - 1
  const out: Bez[] = []
  for (let i = 0; i < segs; i++) {
    const L = chord(i)
    const a = at(i), b = at(i + 1)
    let c1 = add(a, mul(tangent(i), L / 3))
    let c2 = sub(b, mul(tangent(i + 1), L / 3))
    if (!closed && i === 0 && h0) c1 = h0
    if (!closed && i === segs - 1 && h1) c2 = h1
    out.push([a, c1, c2, b])
  }
  return out
}

/** Elevate a degree-p Bezier (p = 1..3) to a cubic. */
function elevate(q: Vec2[]): Bez {
  if (q.length === 4) return q as Bez
  if (q.length === 2) return bezLine(q[0], q[1])
  return bezFromQuad(q[0], q[1], q[2])
}

/** Clamped uniform B-spline of degree min(3, n - 1) as cubic Bezier pieces (Boehm knot insertion); closed: periodic cubic B-spline. */
export function bsplineBeziers(P: Vec2[], closed: boolean): Bez[] {
  const n = P.length
  if (n < 2) return []
  if (closed && n >= 3) {
    const out: Bez[] = []
    const at = (i: number) => P[((i % n) + n) % n]
    for (let i = 0; i < n; i++) {
      const p0 = at(i), p1 = at(i + 1), p2 = at(i + 2), p3 = at(i + 3)
      const f = (a: Vec2, b: Vec2, c: Vec2, wa: number, wb: number, wc: number): Vec2 => [(a[0] * wa + b[0] * wb + c[0] * wc) / 6, (a[1] * wa + b[1] * wb + c[1] * wc) / 6]
      out.push([f(p0, p1, p2, 1, 4, 1), [(4 * p1[0] + 2 * p2[0]) / 6, (4 * p1[1] + 2 * p2[1]) / 6], [(2 * p1[0] + 4 * p2[0]) / 6, (2 * p1[1] + 4 * p2[1]) / 6], f(p1, p2, p3, 1, 4, 1)])
    }
    return out
  }
  const p = Math.min(3, n - 1)
  // clamped uniform knots
  let U: number[] = [...Array(p + 1).fill(0), ...Array.from({ length: n - p - 1 }, (_, i) => i + 1), ...Array(p + 1).fill(n - p)]
  let Q = P.map((q) => [...q] as Vec2)
  // insert every internal knot until it has multiplicity p
  for (let k = 1; k <= n - p - 1; k++) {
    for (let rep = 0; rep < p - 1; rep++) {
      // find span of knot value k
      let s = U.findIndex((u, i) => u <= k && U[i + 1] > k)
      if (s < 0) break
      const next: Vec2[] = []
      for (let i = 0; i <= Q.length; i++) {
        if (i <= s - p) next.push(Q[i])
        else if (i >= s + 1) next.push(Q[i - 1])
        else {
          const a = (k - U[i]) / (U[i + p] - U[i])
          next.push([(1 - a) * Q[i - 1][0] + a * Q[i][0], (1 - a) * Q[i - 1][1] + a * Q[i][1]])
        }
      }
      Q = next
      U = [...U.slice(0, s + 1), k, ...U.slice(s + 1)]
    }
  }
  const out: Bez[] = []
  for (let i = 0; i + p < Q.length; i += p) out.push(elevate(Q.slice(i, i + p + 1)))
  return out
}

/** Bezier pieces of a spline entity from the current point positions. */
export function splineBeziers(m: SketchModel, e: SplineE): Bez[] {
  const P = e.pts.map((id) => pos(m, id))
  if (e.mode === 'bez') {
    const out: Bez[] = []
    for (let i = 0; i + 3 < P.length; i += 3) out.push([P[i], P[i + 1], P[i + 2], P[i + 3]])
    return out
  }
  if (e.mode === 'ctrl') return bsplineBeziers(P, !!e.closed)
  return fitBeziers(P, !!e.closed, e.t0 ? pos(m, e.t0) : undefined, e.t1 ? pos(m, e.t1) : undefined)
}

// ------------------------------------------------------------------------------------------------ ellipse

/** Eight cubic pieces round an ellipse with centre c, major semi-axis end m and minor semi-axis r. */
export function ellipseBeziers(c: Vec2, m: Vec2, r: number): Bez[] {
  const a = dist(c, m)
  if (a < 1e-9 || r < 1e-9) return []
  const u = norm(sub(m, c)), v = perp(u)
  const P = (t: number): Vec2 => [c[0] + a * Math.cos(t) * u[0] + r * Math.sin(t) * v[0], c[1] + a * Math.cos(t) * u[1] + r * Math.sin(t) * v[1]]
  const D = (t: number): Vec2 => [-a * Math.sin(t) * u[0] + r * Math.cos(t) * v[0], -a * Math.sin(t) * u[1] + r * Math.cos(t) * v[1]]
  const n = 8, step = TAU / n, k = (4 / 3) * Math.tan(step / 4)
  const out: Bez[] = []
  for (let i = 0; i < n; i++) {
    const t0 = i * step, t1 = t0 + step
    out.push([P(t0), add(P(t0), mul(D(t0), k)), sub(P(t1), mul(D(t1), k)), P(t1)])
  }
  return out
}

export function ellipseOf(m: SketchModel, e: EllipseE): { c: Vec2; major: Vec2; a: number; r: number } {
  const c = pos(m, e.c), major = pos(m, e.m)
  return { c, major, a: dist(c, major), r: e.r }
}

// ------------------------------------------------------------------------------------------------ text

/** TrueType outlines run clockwise round the letter and counter-clockwise round its counters. */
function contourIsCounter(c: import('./font').Contour): boolean {
  let a = 0
  for (const s of c) a += s.a[0] * s.b[1] - s.b[0] * s.a[1]
  return a > 0
}

/** Outline segments of a text entity (lines and cubic pieces), one id per letter outline so profiles and faces can be told apart. */
export function textSegs(m: SketchModel, e: TextE): Seg[][] {
  const font = fontNow(e.font)
  if (!font || !e.text.trim() || e.h <= 0) return []
  const lay = layoutText(font, e.text, e.h)
  const o = pos(m, e.p)
  const ang = ((e.a ?? 0) * Math.PI) / 180
  const cs = Math.cos(ang), sn = Math.sin(ang)
  const tp = (p: Vec2): Vec2 => [o[0] + p[0] * cs - p[1] * sn, o[1] + p[0] * sn + p[1] * cs]
  return lay.contours.map((c, ci) => c.map((s): Seg => {
    // counters (the inside of an O) are marked with an h: the region they enclose is not a profile
    const id = `${e.id}.${ci}${contourIsCounter(c) ? 'h' : ''}`
    if (s.k === 'l') return { k: 'l', a: tp(s.a), b: tp(s.b), id }
    const q = bezFromQuad(tp(s.a), tp(s.c), tp(s.b))
    return { k: 'b', a: q[0], c1: q[1], c2: q[2], b: q[3], id }
  }))
}

// ------------------------------------------------------------------------------------------------ generic access

/** Closed or open loops of segments of a derived entity (spline: one open chain, or a closed loop; ellipse: a closed loop; text: one loop per outline). */
export function derivedSegs(m: SketchModel, e: DerivedEntity): Seg[][] {
  if (e.type === 'text') return textSegs(m, e)
  const bz = e.type === 'spline' ? splineBeziers(m, e) : ellipseBeziers(pos(m, e.c), pos(m, e.m), e.r)
  return bz.length ? [bz.map((b): Seg => ({ k: 'b', a: b[0], c1: b[1], c2: b[2], b: b[3], id: e.id }))] : []
}

const segBez = (s: Seg): Bez | null => (s.k === 'b' ? [s.a, s.c1, s.c2, s.b] : s.k === 'l' ? bezLine(s.a, s.b) : null)

/** Polylines (one per chain / outline) of a derived entity for drawing and picking. */
export function derivedPolys(m: SketchModel, e: DerivedEntity): Vec2[][] {
  return derivedSegs(m, e).map((chain) => {
    const pts: Vec2[] = []
    for (const s of chain) {
      const b = segBez(s)
      if (!b) continue
      const f = bezFlatten(b)
      pts.push(...(pts.length ? f.slice(1) : f))
    }
    return pts
  })
}

/** Nearest point of a derived entity to p. */
export function closestOnDerived(m: SketchModel, e: DerivedEntity, p: Vec2): { pt: Vec2; d: number } {
  let best = { pt: p, d: Infinity }
  for (const chain of derivedSegs(m, e)) {
    for (const s of chain) {
      const b = segBez(s)
      if (!b) continue
      const c = bezClosest(b, p)
      if (c.d < best.d) best = { pt: c.pt, d: c.d }
    }
  }
  return best
}

/** Point at parameter t (0..1 along the first chain, by piece) of a spline: used for dimension anchors and markers. */
export function splineMid(m: SketchModel, e: SplineE): Vec2 {
  const bz = splineBeziers(m, e)
  if (!bz.length) return [0, 0]
  const i = Math.floor(bz.length / 2)
  return bezAt(bz[i], bz.length % 2 ? 0.5 : 0)
}

/** Ids of the control / fit points of a derived entity (what moves with it). */
export function derivedPoints(e: DerivedEntity): string[] {
  if (e.type === 'spline') return [...e.pts, ...(e.t0 ? [e.t0] : []), ...(e.t1 ? [e.t1] : [])]
  if (e.type === 'ellipse') return [e.c, e.m]
  return [e.p]
}

/** A polyline for any curve entity (used by path patterns and picking). */
export function entityPolyline(m: SketchModel, e: Entity): Vec2[] {
  if (e.type === 'line') return [pos(m, e.p1), pos(m, e.p2)]
  if (e.type === 'circle') { const c = pos(m, e.c); return Array.from({ length: 97 }, (_, i): Vec2 => [c[0] + e.r * Math.cos((i / 96) * TAU), c[1] + e.r * Math.sin((i / 96) * TAU)]) }
  if (e.type === 'arc') {
    const c = pos(m, e.c), s = pos(m, e.s), t = pos(m, e.e)
    const r = dist(c, s)
    const a0 = Math.atan2(s[1] - c[1], s[0] - c[0])
    let a1 = Math.atan2(t[1] - c[1], t[0] - c[0])
    while (a1 <= a0 + 1e-12) a1 += TAU
    const n = Math.max(4, Math.ceil((a1 - a0) / (Math.PI / 48)))
    return Array.from({ length: n + 1 }, (_, i): Vec2 => [c[0] + r * Math.cos(a0 + ((a1 - a0) * i) / n), c[1] + r * Math.sin(a0 + ((a1 - a0) * i) / n)])
  }
  if (e.type === 'point') return [[e.x, e.y]]
  return derivedPolys(m, e).flat()
}

export { entityById }
