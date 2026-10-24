/** Cubic Bezier helpers for splines, ellipses and text outlines: evaluation, splitting, flattening, closest point, intersections. */
import { dist } from './geom'
import type { Vec2 } from './types'

export type Bez = [Vec2, Vec2, Vec2, Vec2]

export const bezAt = (b: Bez, t: number): Vec2 => {
  const u = 1 - t
  const a = u * u * u, c = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t
  return [a * b[0][0] + c * b[1][0] + d * b[2][0] + e * b[3][0], a * b[0][1] + c * b[1][1] + d * b[2][1] + e * b[3][1]]
}

/** First derivative with respect to t. */
export const bezDeriv = (b: Bez, t: number): Vec2 => {
  const u = 1 - t
  const a = 3 * u * u, c = 6 * u * t, d = 3 * t * t
  return [
    a * (b[1][0] - b[0][0]) + c * (b[2][0] - b[1][0]) + d * (b[3][0] - b[2][0]),
    a * (b[1][1] - b[0][1]) + c * (b[2][1] - b[1][1]) + d * (b[3][1] - b[2][1]),
  ]
}

const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/** de Casteljau split at t. */
export function bezSplit(b: Bez, t: number): [Bez, Bez] {
  const p01 = lerp2(b[0], b[1], t), p12 = lerp2(b[1], b[2], t), p23 = lerp2(b[2], b[3], t)
  const p012 = lerp2(p01, p12, t), p123 = lerp2(p12, p23, t)
  const m = lerp2(p012, p123, t)
  return [[b[0], p01, p012, m], [m, p123, p23, b[3]]]
}

/** The piece between t0 and t1 (t0 < t1). */
export function bezSub(b: Bez, t0: number, t1: number): Bez {
  if (t0 <= 0 && t1 >= 1) return b
  const right = t0 > 0 ? bezSplit(b, t0)[1] : b
  if (t1 >= 1) return right
  const s = (t1 - t0) / (1 - t0)
  return bezSplit(right, s)[0]
}

export const bezReverse = (b: Bez): Bez => [b[3], b[2], b[1], b[0]]

/** Cubic from a quadratic (TrueType outlines). */
export const bezFromQuad = (p0: Vec2, q: Vec2, p1: Vec2): Bez => [
  p0,
  [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
  [p1[0] + (2 / 3) * (q[0] - p1[0]), p1[1] + (2 / 3) * (q[1] - p1[1])],
  p1,
]

/** The cubic that traces the straight segment a -> b. */
export const bezLine = (a: Vec2, b: Vec2): Bez => [a, lerp2(a, b, 1 / 3), lerp2(a, b, 2 / 3), b]

/** Control-polygon length (an upper bound of the arc length). */
const polyLen = (b: Bez) => dist(b[0], b[1]) + dist(b[1], b[2]) + dist(b[2], b[3])

/** Points along the curve: `n` segments, or enough for a smooth look when omitted. */
export function bezFlatten(b: Bez, n?: number): Vec2[] {
  const k = n ?? Math.max(8, Math.min(64, Math.ceil(polyLen(b) / Math.max(dist(b[0], b[3]), 1e-9) * 12 + 4)))
  const out: Vec2[] = []
  for (let i = 0; i <= k; i++) out.push(bezAt(b, i / k))
  return out
}

/** Nearest point on the curve to p: parameter, point and distance. */
export function bezClosest(b: Bez, p: Vec2): { t: number; pt: Vec2; d: number } {
  const N = 24
  let bt = 0, bd = Infinity
  for (let i = 0; i <= N; i++) {
    const d = dist(bezAt(b, i / N), p)
    if (d < bd) { bd = d; bt = i / N }
  }
  // Newton on the squared distance
  let t = bt
  for (let it = 0; it < 12; it++) {
    const q = bezAt(b, t), d1 = bezDeriv(b, t)
    // second derivative
    const u = 1 - t
    const d2: Vec2 = [
      6 * u * (b[2][0] - 2 * b[1][0] + b[0][0]) + 6 * t * (b[3][0] - 2 * b[2][0] + b[1][0]),
      6 * u * (b[2][1] - 2 * b[1][1] + b[0][1]) + 6 * t * (b[3][1] - 2 * b[2][1] + b[1][1]),
    ]
    const r: Vec2 = [q[0] - p[0], q[1] - p[1]]
    const f = r[0] * d1[0] + r[1] * d1[1]
    const fp = d1[0] * d1[0] + d1[1] * d1[1] + r[0] * d2[0] + r[1] * d2[1]
    if (Math.abs(fp) < 1e-14) break
    const nt = Math.max(0, Math.min(1, t - f / fp))
    if (Math.abs(nt - t) < 1e-12) { t = nt; break }
    t = nt
  }
  const pt = bezAt(b, t)
  const d = dist(pt, p)
  return d <= bd ? { t, pt, d } : { t: bt, pt: bezAt(b, bt), d: bd }
}

const box = (b: Bez) => {
  const xs = b.map((p) => p[0]), ys = b.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const
}
const overlap = (a: ReturnType<typeof box>, c: ReturnType<typeof box>, eps: number) =>
  a[0] <= c[2] + eps && c[0] <= a[2] + eps && a[1] <= c[3] + eps && c[1] <= a[3] + eps

/** How far the inner control points are from the chord. */
function flatness(b: Bez): number {
  const [a, d] = [b[0], b[3]]
  const l = dist(a, d)
  if (l < 1e-12) return Math.max(dist(a, b[1]), dist(a, b[2]))
  const dx = (d[0] - a[0]) / l, dy = (d[1] - a[1]) / l
  return Math.max(Math.abs((b[1][0] - a[0]) * dy - (b[1][1] - a[1]) * dx), Math.abs((b[2][0] - a[0]) * dy - (b[2][1] - a[1]) * dx))
}

export interface BezHit { t: number; u: number; p: Vec2 }

/** All crossings of two cubics (t on `a`, u on `b`), refined with Newton. */
export function bezIntersect(a: Bez, b: Bez): BezHit[] {
  const out: BezHit[] = []
  const FLAT = 1e-7
  const rec = (x: Bez, tx0: number, tx1: number, y: Bez, uy0: number, uy1: number, depth: number) => {
    if (out.length > 64) return
    if (!overlap(box(x), box(y), 1e-9)) return
    const fx = flatness(x) < FLAT, fy = flatness(y) < FLAT
    if ((fx && fy) || depth > 44) {
      // both are straight enough: intersect the chords
      const p = x[0], r: Vec2 = [x[3][0] - x[0][0], x[3][1] - x[0][1]]
      const q = y[0], s: Vec2 = [y[3][0] - y[0][0], y[3][1] - y[0][1]]
      const den = r[0] * s[1] - r[1] * s[0]
      if (Math.abs(den) < 1e-14) return
      const qp: Vec2 = [q[0] - p[0], q[1] - p[1]]
      const tt = (qp[0] * s[1] - qp[1] * s[0]) / den
      const uu = (qp[0] * r[1] - qp[1] * r[0]) / den
      if (tt < -1e-6 || tt > 1 + 1e-6 || uu < -1e-6 || uu > 1 + 1e-6) return
      out.push({ t: tx0 + (tx1 - tx0) * Math.max(0, Math.min(1, tt)), u: uy0 + (uy1 - uy0) * Math.max(0, Math.min(1, uu)), p: [p[0] + r[0] * tt, p[1] + r[1] * tt] })
      return
    }
    if (!fx && (fy || dist(x[0], x[3]) >= dist(y[0], y[3]))) {
      const [x1, x2] = bezSplit(x, 0.5), tm = (tx0 + tx1) / 2
      rec(x1, tx0, tm, y, uy0, uy1, depth + 1); rec(x2, tm, tx1, y, uy0, uy1, depth + 1)
    } else {
      const [y1, y2] = bezSplit(y, 0.5), um = (uy0 + uy1) / 2
      rec(x, tx0, tx1, y1, uy0, um, depth + 1); rec(x, tx0, tx1, y2, um, uy1, depth + 1)
    }
  }
  rec(a, 0, 1, b, 0, 1, 0)
  // Newton refinement, then drop duplicates
  const res: BezHit[] = []
  for (const h of out) {
    let { t, u } = h
    for (let it = 0; it < 6; it++) {
      const A = bezAt(a, t), B = bezAt(b, u), da = bezDeriv(a, t), db = bezDeriv(b, u)
      const f: Vec2 = [A[0] - B[0], A[1] - B[1]]
      const det = -da[0] * db[1] + da[1] * db[0]
      if (Math.abs(det) < 1e-12) break
      // solve [da -db][dT dU]^T = -f
      const dT = (-f[0] * (-db[1]) - (-db[0]) * -f[1]) / det
      const dU = (da[0] * -f[1] - da[1] * -f[0]) / det
      const nt = Math.max(0, Math.min(1, t + dT)), nu = Math.max(0, Math.min(1, u + dU))
      if (Math.hypot(nt - t, nu - u) < 1e-13) { t = nt; u = nu; break }
      t = nt; u = nu
    }
    const p = bezAt(a, t)
    if (dist(p, bezAt(b, u)) > 1e-5) continue
    if (res.some((r) => dist(r.p, p) < 1e-6)) continue
    res.push({ t, u, p })
  }
  return res
}

/** Cubic approximation of a circular arc (<= 90 degrees per piece, counter-clockwise from a0 over span). */
export function arcBeziers(c: Vec2, r: number, a0: number, span: number): Bez[] {
  const n = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 4) - 1e-9))
  const step = span / n
  const k = (4 / 3) * Math.tan(step / 4)
  const out: Bez[] = []
  for (let i = 0; i < n; i++) {
    const t0 = a0 + step * i, t1 = t0 + step
    const p0: Vec2 = [c[0] + r * Math.cos(t0), c[1] + r * Math.sin(t0)], p3: Vec2 = [c[0] + r * Math.cos(t1), c[1] + r * Math.sin(t1)]
    out.push([
      p0,
      [p0[0] - k * r * Math.sin(t0), p0[1] + k * r * Math.cos(t0)],
      [p3[0] + k * r * Math.sin(t1), p3[1] - k * r * Math.cos(t1)],
      p3,
    ])
  }
  return out
}

/** Bounding box of a set of curves: [x0, y0, x1, y1]. */
export function bezBounds(bs: Bez[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of bs) for (const p of bezFlatten(b, 16)) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
  return [x0, y0, x1, y1]
}
