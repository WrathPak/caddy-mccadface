/** Pure geometry helpers for the print tools (section outlines, connector layout, orientation maths). No WASM, usable on both threads. */
import type { TopoMesh, Vec3 } from './types'

export type Vec2 = [number, number]
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const mul3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
export const unit3 = (a: Vec3): Vec3 => {
  const l = len3(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** In-plane axes for a cut plane: `u` is horizontal when the plane is not horizontal, `v = n x u`. */
export function planeBasis(n: Vec3): { u: Vec3; v: Vec3; n: Vec3 } {
  const nn = unit3(n)
  const ref: Vec3 = Math.abs(nn[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]
  const u = unit3(cross3(ref, nn))
  const v = cross3(nn, u)
  return { u, v, n: nn }
}

export interface Seg2 { a: Vec2; b: Vec2 }

/** Outline of the mesh cut by a plane, as 2D segments in the plane's (u, v) basis. */
export function sectionSegments(mesh: TopoMesh, origin: Vec3, normal: Vec3): { segs: Seg2[]; basis: ReturnType<typeof planeBasis> } {
  const basis = planeBasis(normal)
  const { u, v, n } = basis
  const p = mesh.positions, idx = mesh.indices
  const d = new Float64Array(p.length / 3)
  for (let i = 0; i < d.length; i++) d[i] = (p[i * 3] - origin[0]) * n[0] + (p[i * 3 + 1] - origin[1]) * n[1] + (p[i * 3 + 2] - origin[2]) * n[2]
  const segs: Seg2[] = []
  const to2 = (i: number, j: number, t: number): Vec2 => {
    const x = p[i * 3] + (p[j * 3] - p[i * 3]) * t - origin[0]
    const y = p[i * 3 + 1] + (p[j * 3 + 1] - p[i * 3 + 1]) * t - origin[1]
    const z = p[i * 3 + 2] + (p[j * 3 + 2] - p[i * 3 + 2]) * t - origin[2]
    return [x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]]
  }
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]]
    const pts: Vec2[] = []
    for (let k = 0; k < 3; k++) {
      const i = tri[k], j = tri[(k + 1) % 3]
      const di = d[i], dj = d[j]
      if ((di < 0 && dj > 0) || (di > 0 && dj < 0)) pts.push(to2(i, j, di / (di - dj)))
    }
    // a vertex exactly on the plane, with the opposite edge crossing it
    if (pts.length === 1) {
      for (let k = 0; k < 3; k++) if (d[tri[k]] === 0) pts.push(to2(tri[k], tri[k], 0))
    }
    if (pts.length === 2) segs.push({ a: pts[0], b: pts[1] })
  }
  return { segs, basis }
}

/** Even-odd containment of a 2D point in the outline. */
export function insideOutline(segs: Seg2[], x: number, y: number): boolean {
  let inside = false
  for (const s of segs) {
    const { a, b } = s
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside
  }
  return inside
}

export function distToOutline(segs: Seg2[], x: number, y: number): number {
  let best = Infinity
  for (const { a, b } of segs) {
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t))
    if (d < best) best = d
  }
  return best
}

export function outlineBounds(segs: Seg2[]) {
  const lo: Vec2 = [Infinity, Infinity], hi: Vec2 = [-Infinity, -Infinity]
  for (const { a, b } of segs) for (const q of [a, b]) {
    lo[0] = Math.min(lo[0], q[0]); lo[1] = Math.min(lo[1], q[1])
    hi[0] = Math.max(hi[0], q[0]); hi[1] = Math.max(hi[1], q[1])
  }
  return { lo, hi }
}

/**
 * Pin positions on a section: points at least `inset` away from the outline, spread out. The first is the deepest point
 * of the section, each next one the point farthest from those chosen. Returns fewer than `count` when they do not fit.
 */
export function layoutPins(segs: Seg2[], count: number, inset: number): Vec2[] {
  if (!segs.length || count < 1) return []
  const { lo, hi } = outlineBounds(segs)
  const w = hi[0] - lo[0], h = hi[1] - lo[1]
  const step = Math.max(Math.min(w, h) / 24, Math.sqrt((w * h) / 2500), inset / 4, 0.05)
  const cands: { p: Vec2; d: number }[] = []
  for (let x = lo[0] + step / 2; x < hi[0]; x += step) {
    for (let y = lo[1] + step / 2; y < hi[1]; y += step) {
      if (!insideOutline(segs, x, y)) continue
      const d = distToOutline(segs, x, y)
      if (d >= inset) cands.push({ p: [x, y], d })
    }
  }
  if (!cands.length) return []
  cands.sort((a, b) => b.d - a.d)
  const chosen: Vec2[] = [cands[0].p]
  const sep = inset * 2
  while (chosen.length < count) {
    let best = -1, bestD = -1
    cands.forEach((c, i) => {
      const dmin = Math.min(...chosen.map((q) => Math.hypot(q[0] - c.p[0], q[1] - c.p[1])))
      if (dmin > bestD) { bestD = dmin; best = i }
    })
    if (best < 0 || bestD < sep) break
    chosen.push(cands[best].p)
  }
  return chosen
}

/** Dovetail lanes: offsets across the section (v) where the outline has a chord along u of at least `minChord`. */
export function layoutLanes(segs: Seg2[], count: number, minChord: number): { v: number; u0: number; u1: number }[] {
  if (!segs.length || count < 1) return []
  const { lo, hi } = outlineBounds(segs)
  const out: { v: number; u0: number; u1: number }[] = []
  for (let i = 0; i < count; i++) {
    const v = lo[1] + ((i + 1) / (count + 1)) * (hi[1] - lo[1])
    // crossings of the line y = v
    const xs: number[] = []
    for (const { a, b } of segs) if ((a[1] > v) !== (b[1] > v)) xs.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
    xs.sort((p, q) => p - q)
    let best: [number, number] | null = null
    for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best[1] - best[0]) best = [xs[k], xs[k + 1]]
    if (best && best[1] - best[0] >= minChord) out.push({ v, u0: best[0], u1: best[1] })
  }
  return out
}

/** Rotation matrix (row-major 3x3) taking unit vector `a` onto unit vector `b` by the shortest turn. */
export function rotationBetween(a: Vec3, b: Vec3): number[] {
  const v = cross3(a, b)
  const c = dot3(a, b)
  if (c > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  if (c < -1 + 1e-12) {
    // half turn about any axis perpendicular to a
    const ax = unit3(Math.abs(a[0]) < 0.9 ? cross3(a, [1, 0, 0]) : cross3(a, [0, 1, 0]))
    const [x, y, z] = ax
    return [2 * x * x - 1, 2 * x * y, 2 * x * z, 2 * x * y, 2 * y * y - 1, 2 * y * z, 2 * x * z, 2 * y * z, 2 * z * z - 1]
  }
  const k = 1 / (1 + c)
  return [
    v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
  ]
}

/** Euler angles in degrees (X, then Y, then Z, about world axes: R = Rz Ry Rx, as `composeTransform` builds) for a row-major rotation. */
export function eulerFromMatrix(m: number[]): Vec3 {
  const sy = -m[6]
  const ry = Math.asin(Math.max(-1, Math.min(1, sy)))
  let rx: number, rz: number
  if (Math.abs(sy) < 1 - 1e-9) {
    rx = Math.atan2(m[7], m[8])
    rz = Math.atan2(m[3], m[0])
  } else {
    // gimbal lock: fold the Z turn into X
    rx = Math.atan2(-m[5], m[4])
    rz = 0
  }
  const deg = (r: number) => {
    const d = (r * 180) / Math.PI
    return Math.abs(d) < 1e-9 ? 0 : d
  }
  return [deg(rx), deg(ry), deg(rz)]
}
