/**
 * Offsetting a chain / loop of lines and arcs (pure 2D, shared by the sketch Offset tool and the extrude taper).
 *
 * A chain is an ordered list of segments in travel order (each segment starts where the previous one ends). A positive
 * distance moves the curve to the LEFT of the travel direction (the inside of a counter-clockwise loop).
 *
 *  - inside corners: the two offset curves are trimmed to their intersection
 *  - outside corners: bridged by an arc centred on the original vertex ('round') or extended to the intersection ('miter')
 *  - segments that collapse (arcs whose radius would become <= 0, segments consumed by neighbours) disappear
 */
import { TAU, cross, dist, dot, intersectCircleCircle, intersectLineCircle, intersectLineLine, loopPoly, norm, perp, polar, polyArea, sub } from './geom'
import type { Seg, Vec2 } from './types'

export type CornerStyle = 'round' | 'miter'
type Line = Extract<Seg, { k: 'l' }>
type Arc = Extract<Seg, { k: 'a' }>

export interface OffsetSeg {
  seg: Line | Arc
  /** index of the source segment (for a corner arc: the segment that ends at its centre vertex) */
  src: number
  /** true for the arcs that bridge outside corners */
  corner?: boolean
}

const EPS = 1e-9

const arcTan = (s: Arc, p: Vec2): Vec2 => {
  const t = perp(norm(sub(p, s.c)))
  return s.ccw ? t : [-t[0], -t[1]]
}
const segStart = (s: Seg): Vec2 => (s.k === 'c' ? [s.c[0] + s.r, s.c[1]] : s.a)
const segEnd = (s: Seg): Vec2 => (s.k === 'c' ? [s.c[0] + s.r, s.c[1]] : s.b)
const tanStart = (s: Line | Arc): Vec2 => (s.k === 'l' ? norm(sub(s.b, s.a)) : arcTan(s, s.a))
const tanEnd = (s: Line | Arc): Vec2 => (s.k === 'l' ? norm(sub(s.b, s.a)) : arcTan(s, s.b))

/** Sweep angle (0, TAU] travelling from a to b around c in the given sense. */
export function sweepOf(a: Vec2, b: Vec2, c: Vec2, ccw: boolean): number {
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0])
  const a1 = Math.atan2(b[1] - c[1], b[0] - c[0])
  let d = ccw ? a1 - a0 : a0 - a1
  d %= TAU
  if (d <= 1e-12) d += TAU
  return d
}

/** Arc from a to b (both on the circle about c) in the given sense, with its midpoint. */
export function makeArc(a: Vec2, b: Vec2, c: Vec2, ccw: boolean): Arc {
  const r = dist(a, c)
  const sw = sweepOf(a, b, c, ccw)
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0])
  return { k: 'a', a, b, c, r, ccw, m: polar(c, r, a0 + (ccw ? sw : -sw) / 2) }
}

function offsetOne(s: Line | Arc, d: number): Line | Arc | null {
  if (s.k === 'l') {
    const n = perp(norm(sub(s.b, s.a)))
    return { k: 'l', a: [s.a[0] + n[0] * d, s.a[1] + n[1] * d], b: [s.b[0] + n[0] * d, s.b[1] + n[1] * d] }
  }
  const r = s.ccw ? s.r - d : s.r + d
  if (r <= EPS) return null
  const on = (p: Vec2): Vec2 => polar(s.c, r, Math.atan2(p[1] - s.c[1], p[0] - s.c[0]))
  return makeArc(on(s.a), on(s.b), s.c, s.ccw)
}

function intersectNear(a: Line | Arc, b: Line | Arc, near: Vec2): Vec2 | null {
  let pts: Vec2[]
  if (a.k === 'l' && b.k === 'l') {
    const r = intersectLineLine(a.a, a.b, b.a, b.b)
    pts = r ? [r.p] : []
  } else if (a.k === 'l' && b.k === 'a') pts = intersectLineCircle(a.a, a.b, b.c, b.r).map((h) => h.p)
  else if (a.k === 'a' && b.k === 'l') pts = intersectLineCircle(b.a, b.b, a.c, a.r).map((h) => h.p)
  else if (a.k === 'a' && b.k === 'a') pts = intersectCircleCircle(a.c, a.r, b.c, b.r)
  else pts = []
  let best: Vec2 | null = null
  for (const p of pts) if (!best || dist(p, near) < dist(best, near)) best = p
  return best
}

const withEnd = (s: Line | Arc, p: Vec2): Line | Arc => (s.k === 'l' ? { ...s, b: p } : makeArc(s.a, p, s.c, s.ccw))
const withStart = (s: Line | Arc, p: Vec2): Line | Arc => (s.k === 'l' ? { ...s, a: p } : makeArc(p, s.b, s.c, s.ccw))

/** True when an inward offset of a closed loop has turned inside out (the shape is thinner than twice the distance). */
function collapsed(src: (Line | Arc)[], out: (Line | Arc)[], d: number): boolean {
  const a0 = polyArea(loopPoly(src)), a1 = polyArea(loopPoly(out))
  const inward = a0 * d > 0
  return inward && (a1 * a0 <= 0 || Math.abs(a1) > Math.abs(a0))
}

/** Offset of a single circle (positive grows it). Returns null when it would vanish. */
export function offsetCircle(r: number, d: number): number | null {
  return r + d > EPS ? r + d : null
}

/**
 * Offset a chain by `d` (positive = left of travel). Returns null when nothing survives.
 * `segs` must contain only lines and arcs; a lone full circle goes through `offsetCircle`.
 */
export function offsetChain(segs: (Line | Arc)[], closed: boolean, d: number, style: CornerStyle = 'round'): OffsetSeg[] | null {
  if (Math.abs(d) < EPS) return segs.map((seg, src) => ({ seg, src }))
  const n = segs.length
  let live: { seg: Line | Arc; src: number; orig: Line | Arc; ins?: boolean }[] = []
  segs.forEach((s, i) => {
    const o = offsetOne(s, d)
    if (o) live.push({ seg: o, src: i, orig: o })
  })

  // iterate: join consecutive segments; segments reversed by trimming are dropped and the joints recomputed
  for (let pass = 0; pass <= n; pass++) {
    if (!live.length) return null
    const work = live.map((l) => ({ ...l, seg: l.orig, ins: false }))
    const bridges: (OffsetSeg | null)[] = []
    const count = closed ? work.length : work.length - 1
    for (let k = 0; k < count; k++) {
      const A = work[k], B = work[(k + 1) % work.length]
      bridges[k] = null
      if (A === B) continue
      const endA = segEnd(A.seg), startB = segStart(B.seg)
      if (dist(endA, startB) < 1e-7) continue
      const tA = tanEnd(A.seg), tB = tanStart(B.seg)
      const cr = cross(tA, tB)
      const adjacent = B.src === (A.src + 1) % n
      const V = segEnd(segs[A.src])
      const inside = cr * d > 0
      if (!adjacent) { bridges[k] = { seg: { k: 'l', a: endA, b: startB }, src: A.src, corner: true }; continue }
      if (inside) {
        const P = intersectNear(A.seg, B.seg, V)
        if (P) { A.seg = withEnd(A.seg, P); B.seg = withStart(B.seg, P); A.ins = B.ins = true } else bridges[k] = { seg: { k: 'l', a: endA, b: startB }, src: A.src, corner: true }
      } else if (style === 'miter') {
        const P = intersectNear(A.seg, B.seg, V)
        if (P && dist(P, V) <= 12 * Math.abs(d)) { A.seg = withEnd(A.seg, P); B.seg = withStart(B.seg, P) }
        else bridges[k] = { seg: makeArc(endA, startB, V, cr > 0), src: A.src, corner: true }
      } else {
        bridges[k] = { seg: makeArc(endA, startB, V, cr > 0), src: A.src, corner: true }
      }
    }
    // reversal check: a trimmed segment must still run the same way as its untrimmed offset
    const bad = new Set<number>()
    work.forEach((w, i) => {
      const o = w.orig, s = w.seg
      if (s === o || !w.ins) return
      if (o.k === 'l' && s.k === 'l') { if (dot(sub(s.b, s.a), sub(o.b, o.a)) <= EPS) bad.add(i) }
      else if (o.k === 'a' && s.k === 'a') {
        // trimming at an inside corner only shortens: a longer sweep means the end crossed the far end
        if (sweepOf(s.a, s.b, s.c, s.ccw) > sweepOf(o.a, o.b, o.c, o.ccw) + 1e-6) bad.add(i)
      }
    })
    if (!bad.size) {
      const out: OffsetSeg[] = []
      work.forEach((w, k) => {
        out.push({ seg: w.seg, src: w.src })
        const br = bridges[k]
        if (br) out.push(br)
      })
      if (closed && collapsed(segs, out.map((o) => o.seg), d)) return null
      return out
    }
    live = live.filter((_, i) => !bad.has(i))
  }
  return null
}
