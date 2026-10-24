/** 2D geometry helpers (no dependencies; safe to import from the worker). */
import type { Loop, Seg, Vec2 } from './types'

export const TAU = Math.PI * 2
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]]
export const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k]
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1]
export const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0]
export const len = (a: Vec2) => Math.hypot(a[0], a[1])
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1])
export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l]
}
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]]
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
export const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
export const polar = (c: Vec2, r: number, a: number): Vec2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]

/** Angle of `a` relative to `a0`, normalised to [0, 2PI). */
export const relAngle = (a: number, a0: number) => {
  let d = (a - a0) % TAU
  if (d < 0) d += TAU
  return d
}

export interface ArcInfo { r: number; a0: number; a1: number; span: number }
/** Counter-clockwise arc from s to e around c. */
export function arcInfo(c: Vec2, s: Vec2, e: Vec2): ArcInfo {
  const r = dist(c, s)
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0])
  let a1 = Math.atan2(e[1] - c[1], e[0] - c[0])
  while (a1 <= a0 + 1e-12) a1 += TAU
  return { r, a0, a1, span: a1 - a0 }
}

export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { pt: Vec2; t: number } {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2))
  return { pt: [a[0] + ab[0] * t, a[1] + ab[1] * t], t }
}
export function closestOnLine(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a)
  const l2 = dot(ab, ab) || 1
  const t = dot(sub(p, a), ab) / l2
  return [a[0] + ab[0] * t, a[1] + ab[1] * t]
}
export function closestOnCircle(p: Vec2, c: Vec2, r: number): Vec2 {
  const d = sub(p, c)
  const l = len(d)
  return l < 1e-12 ? [c[0] + r, c[1]] : [c[0] + (d[0] / l) * r, c[1] + (d[1] / l) * r]
}
export function closestOnArc(p: Vec2, c: Vec2, s: Vec2, e: Vec2): Vec2 {
  const { r, a0, span } = arcInfo(c, s, e)
  const a = Math.atan2(p[1] - c[1], p[0] - c[0])
  if (relAngle(a, a0) <= span) return polar(c, r, a)
  return dist(p, s) < dist(p, e) ? s : e
}

/** Circle through three points, or null when collinear. */
export function circumcircle(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-12) return null
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1]
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
  return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) }
}

/** Sample points along an arc (excluding start, including end). */
export function sampleArc(c: Vec2, r: number, a0: number, a1: number, maxStep = Math.PI / 36): Vec2[] {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / maxStep))
  const out: Vec2[] = []
  for (let i = 1; i <= n; i++) out.push(polar(c, r, a0 + ((a1 - a0) * i) / n))
  return out
}

// ---- intersections (return points)

export function intersectLineLine(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { p: Vec2; t: number; u: number } | null {
  const r = sub(b, a), s = sub(d, c)
  const den = cross(r, s)
  if (Math.abs(den) < 1e-12) return null
  const qp = sub(c, a)
  const t = cross(qp, s) / den
  const u = cross(qp, r) / den
  return { p: [a[0] + r[0] * t, a[1] + r[1] * t], t, u }
}

export function intersectLineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): { p: Vec2; t: number }[] {
  const d = sub(b, a), f = sub(a, c)
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r
  const disc = B * B - 4 * A * C
  if (A < 1e-18 || disc < -1e-12) return []
  const sq = Math.sqrt(Math.max(0, disc))
  const ts = sq < 1e-9 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]
  return ts.map((t) => ({ p: [a[0] + d[0] * t, a[1] + d[1] * t] as Vec2, t }))
}

export function intersectCircleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = dist(c1, c2)
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return []
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a))
  const m: Vec2 = [c1[0] + ((c2[0] - c1[0]) * a) / d, c1[1] + ((c2[1] - c1[1]) * a) / d]
  if (h < 1e-9) return [m]
  const ox = (-(c2[1] - c1[1]) * h) / d, oy = ((c2[0] - c1[0]) * h) / d
  return [[m[0] + ox, m[1] + oy], [m[0] - ox, m[1] - oy]]
}

// ---- loops

/** Polyline for a loop (arcs flattened). The polygon is closed implicitly. */
export function loopPoly(loop: Loop, maxStep = Math.PI / 36): Vec2[] {
  const out: Vec2[] = []
  for (const s of loop) {
    if (s.k === 'c') {
      const n = 72
      for (let i = 0; i < n; i++) out.push(polar(s.c, s.r, (i / n) * TAU))
    } else if (s.k === 'l') {
      out.push(s.a)
    } else {
      out.push(s.a)
      const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0])
      let a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0])
      if (s.ccw) { while (a1 <= a0 + 1e-12) a1 += TAU } else { while (a1 >= a0 - 1e-12) a1 -= TAU }
      const pts = sampleArc(s.c, s.r, a0, a1, maxStep)
      for (let i = 0; i < pts.length - 1; i++) out.push(pts[i])
    }
  }
  return out
}

/** Signed area (positive for counter-clockwise). */
export function polyArea(p: Vec2[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    a += p[i][0] * q[1] - q[0] * p[i][1]
  }
  return a / 2
}

export function polyCentroid(p: Vec2[]): Vec2 {
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]
    const w = p[i][0] * q[1] - q[0] * p[i][1]
    a += w
    cx += (p[i][0] + q[0]) * w
    cy += (p[i][1] + q[1]) * w
  }
  if (Math.abs(a) < 1e-12) return p[0] ?? [0, 0]
  return [cx / (3 * a), cy / (3 * a)]
}

export function pointInPoly(pt: Vec2, p: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if (p[i][1] > pt[1] !== p[j][1] > pt[1] && pt[0] < ((p[j][0] - p[i][0]) * (pt[1] - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside
  }
  return inside
}

/** Reverse a loop's direction (segments reversed and each flipped). */
export function reverseLoop(loop: Loop): Loop {
  return loop
    .map((s): Seg => (s.k === 'l' ? { ...s, a: s.b, b: s.a } : s.k === 'a' ? { ...s, a: s.b, b: s.a, ccw: !s.ccw } : { ...s }))
    .reverse()
}
