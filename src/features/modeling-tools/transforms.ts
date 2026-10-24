/** Instance transforms of the pattern tools (pure math, no kernel): rectangular, circular and along a path. */
import { add3, applyDir, applyPoint, mul3, norm3, rotationAbout, rotationBetween, sub3, translation, type Xf } from '@/kernel/xform'
import type { Vec3 } from '@/kernel/types'

/** Offsets (in units of the step) of `count` instances around / along the original, which is always one of them. */
export function offsets(count: number, symmetric: boolean): number[] {
  const n = Math.max(1, Math.round(count))
  if (!symmetric) return Array.from({ length: n }, (_, i) => i)
  // the original sits in the middle; with an even count the extra instance goes on the positive side
  const lo = -Math.floor((n - 1) / 2)
  return Array.from({ length: n }, (_, i) => lo + i)
}

export interface LinearDir {
  dir: Vec3
  count: number
  /** distance between neighbours ('spacing') or between the first and last instance ('extent') */
  distance: number
  type: 'spacing' | 'extent'
  symmetric: boolean
  flip: boolean
}

/** Step length of one direction. */
export function stepOf(d: LinearDir): number {
  const n = Math.max(1, Math.round(d.count))
  return d.type === 'extent' ? (n > 1 ? d.distance / (n - 1) : 0) : d.distance
}

/** Rectangular pattern: translations for every cell of the grid except the original (0, 0). Index 0 is the first instance. */
export function rectXforms(a: LinearDir, b?: LinearDir): { xf: Xf; cell: [number, number] }[] {
  const dirOf = (d: LinearDir): Vec3 => mul3(norm3(d.dir), d.flip ? -1 : 1)
  const oa = offsets(a.count, a.symmetric), ob = b ? offsets(b.count, b.symmetric) : [0]
  const out: { xf: Xf; cell: [number, number] }[] = []
  const sa = stepOf(a), sb = b ? stepOf(b) : 0
  // the original is the cell at offset (0, 0); every other cell is an instance, in row-major order
  for (const j of ob) {
    for (const i of oa) {
      if (i === 0 && j === 0) continue
      const t = add3(mul3(dirOf(a), i * sa), b ? mul3(dirOf(b), j * sb) : [0, 0, 0])
      out.push({ xf: translation(t), cell: [i, j] })
    }
  }
  return out
}

export interface Circular {
  origin: Vec3
  dir: Vec3
  count: number
  /** total angle, degrees; 360 spreads the instances evenly round the full circle */
  angle: number
  symmetric: boolean
  flip: boolean
}

/** Circular pattern: rotations of every instance but the original. */
export function circXforms(a: Circular): { xf: Xf; index: number }[] {
  const n = Math.max(1, Math.round(a.count))
  const full = Math.abs(Math.abs(a.angle) - 360) < 1e-9
  const step = (full ? a.angle / n : n > 1 ? a.angle / (n - 1) : 0) * (a.flip ? -1 : 1)
  return offsets(n, a.symmetric)
    .filter((k) => k !== 0)
    .map((k, i) => ({ xf: rotationAbout(a.origin, a.dir, k * step), index: i + 1 }))
}

export interface PathPattern {
  /** the path as a polyline, in order */
  path: Vec3[]
  count: number
  distance: number
  type: 'spacing' | 'extent' | 'full'
  /** turn the instances to follow the path tangent */
  align: boolean
  flip: boolean
}

const len3 = (a: Vec3, b: Vec3) => Math.hypot(...sub3(a, b))

/** Position and unit tangent at arc length `s` of a polyline. */
export function pointAlong(path: Vec3[], s: number): { p: Vec3; t: Vec3 } {
  let left = Math.max(0, s)
  for (let i = 0; i + 1 < path.length; i++) {
    const l = len3(path[i], path[i + 1])
    if (left <= l + 1e-9 || i + 2 === path.length) {
      const k = l < 1e-12 ? 0 : Math.min(1, left / l)
      const t = norm3(sub3(path[i + 1], path[i]))
      return { p: add3(path[i], mul3(sub3(path[i + 1], path[i]), k)), t }
    }
    left -= l
  }
  return { p: path[0], t: [1, 0, 0] }
}

export const pathLength = (path: Vec3[]) => path.reduce((s, p, i) => (i ? s + len3(path[i - 1], p) : 0), 0)

/** Path pattern: the original sits at the start of the path; every other instance is carried along it. */
export function pathXforms(a: PathPattern): { xf: Xf; index: number }[] {
  const n = Math.max(1, Math.round(a.count))
  const pts = a.flip ? [...a.path].reverse() : a.path
  const total = pathLength(pts)
  let step: number
  if (a.type === 'spacing') step = a.distance
  else if (a.type === 'extent') step = n > 1 ? a.distance / (n - 1) : 0
  else step = n > 1 ? total / (n - 1) : 0
  const start = pointAlong(pts, 0)
  const out: { xf: Xf; index: number }[] = []
  for (let k = 1; k < n; k++) {
    const s = k * step
    if (s > total + 1e-6) break
    const at = pointAlong(pts, s)
    const shift = sub3(at.p, start.p)
    if (!a.align) { out.push({ xf: translation(shift), index: k }); continue }
    const R = rotationBetween(start.t, at.t)
    // rotate about the start point, then carry it to the new point
    const pivot = start.p
    const rotated = applyPoint({ t: 'rigid', R, p: [0, 0, 0] }, pivot)
    out.push({ xf: { t: 'rigid', R, p: add3(sub3(pivot, rotated), shift) }, index: k })
  }
  return out
}

/** Reflection across a plane. */
export const mirrorXf = (origin: Vec3, normal: Vec3): Xf => ({ t: 'mirror', origin, normal: norm3(normal) })

/** Where the marker of an instance goes: the anchor point carried by the transform. */
export const markerAt = (anchor: Vec3, xf: Xf): Vec3 => applyPoint(xf, anchor)
export { applyDir }
