/** Tiny vector helpers for the hair pipeline. */
import type { V3 } from './schema'

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
export const norm = (a: V3): V3 => {
  const l = len(a)
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}
export const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Rotate v about a unit axis by angle (radians). */
export function rotate(v: V3, axis: V3, ang: number): V3 {
  const c = Math.cos(ang), s = Math.sin(ang), k = dot(axis, v), x = cross(axis, v)
  return [
    v[0] * c + x[0] * s + axis[0] * k * (1 - c),
    v[1] * c + x[1] * s + axis[1] * k * (1 - c),
    v[2] * c + x[2] * s + axis[2] * k * (1 - c),
  ]
}

/** Any unit vector perpendicular to a (unit). */
export function perp(a: V3): V3 {
  const t: V3 = Math.abs(a[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]
  return norm(cross(a, t))
}

/** Right-handed orthonormal basis (e1, e2, a) for the unit axis a. */
export function basis(a: V3): [V3, V3, V3] {
  const e1 = perp(a)
  return [e1, cross(a, e1), a]
}
