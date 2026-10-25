/** Small 4x4 rigid-transform toolkit. Matrices are column-major number[16], the layout three.js and composeTransform use. */
import type { Vec3 } from '@/kernel/types'

export type Mat4 = number[]

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
export const identity = (): Mat4 => IDENTITY.slice()

// ---- vectors
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
export const dist = (a: Vec3, b: Vec3) => len(sub(a, b))
export const norm = (a: Vec3): Vec3 => {
  const l = len(a)
  return l < 1e-12 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l]
}
/** Any unit vector perpendicular to `a`. */
export function perpendicular(a: Vec3): Vec3 {
  const n = norm(a)
  const h: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  return norm(cross(h, n))
}

// ---- matrices
/** a * b (apply b first, then a). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}
export const chain = (...ms: Mat4[]): Mat4 => ms.reduce((acc, m) => multiply(acc, m), identity())

/** Inverse of a rigid transform (rotation + translation, no scale). */
export function invert(m: Mat4): Mat4 {
  const r00 = m[0], r10 = m[1], r20 = m[2], r01 = m[4], r11 = m[5], r21 = m[6], r02 = m[8], r12 = m[9], r22 = m[10]
  const tx = m[12], ty = m[13], tz = m[14]
  return [
    r00, r01, r02, 0, r10, r11, r12, 0, r20, r21, r22, 0,
    -(r00 * tx + r10 * ty + r20 * tz), -(r01 * tx + r11 * ty + r21 * tz), -(r02 * tx + r12 * ty + r22 * tz), 1,
  ]
}

export const translation = (v: Vec3): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1]

/** Rotation by `rad` about the unit axis `a` through the origin. */
export function rotation(a: Vec3, rad: number): Mat4 {
  const [x, y, z] = norm(a)
  const c = Math.cos(rad), s = Math.sin(rad), t = 1 - c
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ]
}
export const rotateX = (rad: number) => rotation([1, 0, 0], rad)
export const rotateY = (rad: number) => rotation([0, 1, 0], rad)
export const rotateZ = (rad: number) => rotation([0, 0, 1], rad)

/** Rotation by `rad` about an axis through `pivot`. */
export function rotationAbout(pivot: Vec3, axis: Vec3, rad: number): Mat4 {
  return chain(translation(pivot), rotation(axis, rad), translation(mul(pivot, -1)))
}

export const point = (m: Mat4, p: Vec3): Vec3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
]
export const vector = (m: Mat4, v: Vec3): Vec3 => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
]
export const originOf = (m: Mat4): Vec3 => [m[12], m[13], m[14]]

export function isIdentity(m: Mat4, eps = 1e-9): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - IDENTITY[i]) > eps) return false
  return true
}
export const sameMat = (a: Mat4, b: Mat4, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= eps)

/** A frame: origin, z axis (the joint axis) and x axis (perpendicular to z). y = z x x. */
export interface Frame { origin: Vec3; z: Vec3; x: Vec3 }

/** Matrix whose columns are the frame's axes (maps frame-local coordinates to the space the frame is written in). */
export function frameMatrix(f: Frame): Mat4 {
  const z = norm(f.z)
  let x = sub(f.x, mul(z, dot(f.x, z)))
  x = len(x) < 1e-9 ? perpendicular(z) : norm(x)
  const y = cross(z, x)
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, f.origin[0], f.origin[1], f.origin[2], 1]
}
export function matrixFrame(m: Mat4): Frame {
  return { origin: [m[12], m[13], m[14]], x: [m[0], m[1], m[2]], z: [m[8], m[9], m[10]] }
}

/** Rotation vector (axis * angle) of the rotation part of `m`. */
export function rotationVector(m: Mat4): Vec3 {
  const tr = m[0] + m[5] + m[10]
  const cosA = Math.max(-1, Math.min(1, (tr - 1) / 2))
  const ang = Math.acos(cosA)
  if (ang < 1e-9) return [0, 0, 0]
  let ax: Vec3 = [m[6] - m[9], m[8] - m[2], m[1] - m[4]]
  if (Math.PI - ang < 1e-4) {
    // near 180 degrees the antisymmetric part vanishes: read the axis from the symmetric part
    const x = Math.sqrt(Math.max(0, (m[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (m[5] + 1) / 2)), z = Math.sqrt(Math.max(0, (m[10] + 1) / 2))
    ax = [x, m[4] + m[1] < 0 ? -y : y, m[8] + m[2] < 0 ? -z : z]
  }
  const n = norm(ax)
  return [n[0] * ang, n[1] * ang, n[2] * ang]
}

/** Six numbers (translation, rotation vector) that vanish exactly when `a` and `b` are the same pose. */
export function poseError(a: Mat4, b: Mat4): number[] {
  const rel = multiply(invert(a), b)
  const r = rotationVector(rel)
  const t = sub(originOf(b), originOf(a))
  return [t[0], t[1], t[2], r[0], r[1], r[2]]
}

export const DEG = Math.PI / 180
export const round = (v: number, d = 6) => { const k = 10 ** d; return Math.round(v * k) / k }
