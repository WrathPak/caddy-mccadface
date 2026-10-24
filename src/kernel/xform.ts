/** Rigid and mirror transforms as plain data (shared by the pattern / mirror features and the kernel ops). Pure math, no OCC. */
import type { Vec3 } from './types'

/** `rigid`: x' = R x + p with R a rotation (row-major 3x3). `mirror`: reflection across the plane through `origin` with unit `normal`. */
export type Xf =
  | { t: 'rigid'; R: number[]; p: Vec3 }
  | { t: 'mirror'; origin: Vec3; normal: Vec3 }

export const IDENTITY_R = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export const norm3 = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const mul3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]

export const translation = (p: Vec3): Xf => ({ t: 'rigid', R: IDENTITY_R, p })

/** Rotation about the axis through `origin` along `dir` by `deg` (Rodrigues). */
export function rotationAbout(origin: Vec3, dir: Vec3, deg: number): Xf {
  const [x, y, z] = norm3(dir)
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c
  const R = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c]
  const rO = applyR(R, origin)
  return { t: 'rigid', R, p: sub3(origin, rO) }
}

export const applyR = (R: number[], v: Vec3): Vec3 => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
]

/** Image of a point. */
export function applyPoint(x: Xf, v: Vec3): Vec3 {
  if (x.t === 'rigid') return add3(applyR(x.R, v), x.p)
  const n = norm3(x.normal)
  const d = dot3(sub3(v, x.origin), n)
  return sub3(v, mul3(n, 2 * d))
}

/** Image of a direction (no translation). */
export function applyDir(x: Xf, v: Vec3): Vec3 {
  if (x.t === 'rigid') return applyR(x.R, v)
  const n = norm3(x.normal)
  return sub3(v, mul3(n, 2 * dot3(v, n)))
}

/** Rotation matrix taking unit vector `a` to unit vector `b` (shortest arc). */
export function rotationBetween(a: Vec3, b: Vec3): number[] {
  const u = norm3(a), v = norm3(b)
  const c = dot3(u, v)
  if (c > 1 - 1e-12) return IDENTITY_R
  if (c < -1 + 1e-12) {
    // half turn about any axis perpendicular to u
    const ref: Vec3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const ax = norm3(cross3(u, ref))
    const r = rotationAbout([0, 0, 0], ax, 180)
    return (r as { R: number[] }).R
  }
  const ax = cross3(u, v)
  const s = Math.hypot(ax[0], ax[1], ax[2])
  const k = (1 - c) / (s * s)
  const [x, y, z] = ax
  return [
    1 + k * (-(y * y) - z * z), k * x * y - z, k * x * z + y,
    k * x * y + z, 1 + k * (-(x * x) - z * z), k * y * z - x,
    k * x * z - y, k * y * z + x, 1 + k * (-(x * x) - y * y),
  ]
}

/** Axis (unit) and angle (degrees) of a rotation matrix. */
export function axisAngle(R: number[]): { axis: Vec3; deg: number } {
  const tr = R[0] + R[4] + R[8]
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2))
  const ang = Math.acos(c)
  if (ang < 1e-9) return { axis: [0, 0, 1], deg: 0 }
  if (Math.abs(ang - Math.PI) < 1e-6) {
    // symmetric part gives the axis: R = 2 a a^T - I
    const xx = (R[0] + 1) / 2, yy = (R[4] + 1) / 2, zz = (R[8] + 1) / 2
    let a: Vec3
    if (xx >= yy && xx >= zz) { const x = Math.sqrt(Math.max(xx, 1e-12)); a = [x, (R[1] + R[3]) / (4 * x), (R[2] + R[6]) / (4 * x)] }
    else if (yy >= zz) { const y = Math.sqrt(Math.max(yy, 1e-12)); a = [(R[1] + R[3]) / (4 * y), y, (R[5] + R[7]) / (4 * y)] }
    else { const z = Math.sqrt(Math.max(zz, 1e-12)); a = [(R[2] + R[6]) / (4 * z), (R[5] + R[7]) / (4 * z), z] }
    return { axis: norm3(a), deg: 180 }
  }
  const s = 2 * Math.sin(ang)
  return { axis: norm3([(R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s]), deg: (ang * 180) / Math.PI }
}

/** Compose: apply `a` first, then `b`. */
export function compose(a: Xf, b: Xf): Xf {
  if (a.t === 'rigid' && b.t === 'rigid') {
    const R = [0, 0, 0, 0, 0, 0, 0, 0, 0]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i * 3 + j] = b.R[i * 3] * a.R[j] + b.R[i * 3 + 1] * a.R[3 + j] + b.R[i * 3 + 2] * a.R[6 + j]
    return { t: 'rigid', R, p: add3(applyR(b.R, a.p), b.p) }
  }
  throw new Error('compose supports rigid transforms only')
}
