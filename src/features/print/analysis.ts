/** Printability analysis on triangle meshes: overhang map, thin walls (rays cast inward through a BVH) and small features. Pure, runs in Node and the browser. */
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { Vec3 } from '@/kernel/types'

export interface MeshIn {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
  /** B-rep (or segmented) face id per triangle */
  faceIds?: ArrayLike<number>
}

export interface TriInfo {
  count: number
  /** unit normals, 3 per triangle */
  n: Float32Array
  area: Float32Array
  /** centroids, 3 per triangle */
  c: Float32Array
}

export function triInfo(m: MeshIn): TriInfo {
  const T = m.indices.length / 3
  const p = m.positions
  const n = new Float32Array(T * 3), area = new Float32Array(T), c = new Float32Array(T * 3)
  for (let t = 0; t < T; t++) {
    const a = m.indices[t * 3] * 3, b = m.indices[t * 3 + 1] * 3, d = m.indices[t * 3 + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[d] - p[a], vy = p[d + 1] - p[a + 1], vz = p[d + 2] - p[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z)
    area[t] = l / 2
    if (l > 1e-20) n.set([x / l, y / l, z / l], t * 3)
    c[t * 3] = (p[a] + p[b] + p[d]) / 3; c[t * 3 + 1] = (p[a + 1] + p[b + 1] + p[d + 1]) / 3; c[t * 3 + 2] = (p[a + 2] + p[b + 2] + p[d + 2]) / 3
  }
  return { count: T, n, area, c }
}

/** Lowest and highest point of the mesh along `up`. */
export function heightRange(m: MeshIn, up: Vec3): { min: number; max: number } {
  let min = Infinity, max = -Infinity
  const p = m.positions
  for (let i = 0; i < p.length; i += 3) {
    const h = p[i] * up[0] + p[i + 1] * up[1] + p[i + 2] * up[2]
    if (h < min) min = h
    if (h > max) max = h
  }
  return { min, max }
}

// ---------------------------------------------------------------- overhang

export interface OverhangResult {
  /** 0 = fine, else (0, 1]: how far past the threshold the surface leans */
  severity: Float32Array
  /** area that needs support, mm2 */
  area: number
  /** area of the whole surface, mm2 */
  total: number
  /** flat area resting on the plate, mm2 */
  contact: number
}

/** Height (mm) under which a downward face counts as lying on the plate. */
export const BED_TOL = 0.1

/**
 * Faces that lean over by more than `angle` degrees from vertical (0 = a wall, 90 = a flat ceiling) and are not on the plate.
 * `up` is the build direction.
 */
export function overhangMap(m: MeshIn, info: TriInfo, angle: number, up: Vec3 = [0, 0, 1]): OverhangResult {
  const { min } = heightRange(m, up)
  const severity = new Float32Array(info.count)
  let area = 0, total = 0, contact = 0
  for (let t = 0; t < info.count; t++) {
    total += info.area[t]
    const down = -(info.n[t * 3] * up[0] + info.n[t * 3 + 1] * up[1] + info.n[t * 3 + 2] * up[2])
    if (down <= 0) continue
    const a = (Math.asin(Math.min(1, down)) * 180) / Math.PI
    if (a <= angle + 1e-6) continue
    const h = info.c[t * 3] * up[0] + info.c[t * 3 + 1] * up[1] + info.c[t * 3 + 2] * up[2] - min
    if (h < BED_TOL && down > 0.99) { contact += info.area[t]; continue }
    severity[t] = Math.max(0.03, Math.min(1, (a - angle) / Math.max(90 - angle, 1e-6)))
    area += info.area[t]
  }
  return { severity, area, total, contact }
}

// ---------------------------------------------------------------- BVH

export function buildBvh(m: MeshIn): MeshBVH {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(m.positions instanceof Float32Array ? m.positions : Float32Array.from(m.positions), 3))
  g.setIndex(new BufferAttribute(m.indices instanceof Uint32Array ? m.indices : Uint32Array.from(m.indices), 1))
  return new MeshBVH(g, { targetLeafSize: 12 })
}

// ---------------------------------------------------------------- thin walls

export interface ThinResult {
  /** 0 = fine, else (0, 1]: 1 is a wall with no thickness at all */
  severity: Float32Array
  /** wall thickness behind every triangle (Infinity when the ray leaves the model without hitting anything) */
  thickness: Float32Array
  /** surface area below the minimum thickness, mm2 */
  area: number
  /** thinnest wall found, mm */
  thinnest: number
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * Wall thickness behind each triangle: a ray from its centre straight into the material (against the outward normal) up to the
 * first surface it meets. Walls thinner than `min` are flagged.
 */
export async function thinWallMap(m: MeshIn, info: TriInfo, min: number, opts: { bvh?: MeshBVH; shouldStop?: () => boolean } = {}): Promise<ThinResult> {
  const bvh = opts.bvh ?? buildBvh(m)
  const severity = new Float32Array(info.count)
  const thickness = new Float32Array(info.count).fill(Infinity)
  const ray = new Ray()
  const o = new Vector3(), d = new Vector3()
  let area = 0, thinnest = Infinity
  const eps = 1e-3
  for (let t = 0; t < info.count; t++) {
    if (t % 3000 === 2999) {
      await yieldNow()
      if (opts.shouldStop?.()) break
    }
    if (info.area[t] < 1e-12) continue
    d.set(-info.n[t * 3], -info.n[t * 3 + 1], -info.n[t * 3 + 2])
    o.set(info.c[t * 3] + d.x * eps, info.c[t * 3 + 1] + d.y * eps, info.c[t * 3 + 2] + d.z * eps)
    ray.set(o, d)
    const hit = bvh.raycastFirst(ray, DoubleSide)
    if (!hit) continue
    const w = hit.distance + eps
    thickness[t] = w
    if (w < thinnest) thinnest = w
    if (w < min) {
      severity[t] = Math.max(0.03, Math.min(1, 1 - w / min))
      area += info.area[t]
    }
  }
  return { severity, thickness, area, thinnest }
}

// ---------------------------------------------------------------- small features

export interface SmallFace { face: number; /** narrowest width of the face, mm */ size: number; area: number; centre: Vec3 }
export interface SmallResult {
  faces: SmallFace[]
  /** 1 on every triangle of a small face */
  flag: Uint8Array
  /** area of the small faces, mm2 */
  area: number
}

/** Smallest width of a set of points projected onto a plane (rotating a measuring line round in 2 degree steps). */
function minWidth(pts: Float64Array, u: Vec3, v: Vec3): number {
  let best = Infinity
  for (let deg = 0; deg < 180; deg += 2) {
    const a = (deg * Math.PI) / 180
    const dx = Math.cos(a) * u[0] + Math.sin(a) * v[0], dy = Math.cos(a) * u[1] + Math.sin(a) * v[1], dz = Math.cos(a) * u[2] + Math.sin(a) * v[2]
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < pts.length; i += 3) {
      const s = pts[i] * dx + pts[i + 1] * dy + pts[i + 2] * dz
      if (s < lo) lo = s
      if (s > hi) hi = s
    }
    if (hi - lo < best) best = hi - lo
  }
  return best
}

/** Eigenvector of the smallest eigenvalue of a symmetric 3x3 (cyclic Jacobi). */
function flattestAxis(c: number[]): Vec3 {
  const a = [c[0], c[1], c[2], c[1], c[3], c[4], c[2], c[4], c[5]]
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q]
      off += Math.abs(apq)
      if (Math.abs(apq) < 1e-14) continue
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq)
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q]
        a[k * 3 + p] = cs * akp - sn * akq; a[k * 3 + q] = sn * akp + cs * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k]
        a[p * 3 + k] = cs * apk - sn * aqk; a[q * 3 + k] = sn * apk + cs * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q]
        v[k * 3 + p] = cs * vkp - sn * vkq; v[k * 3 + q] = sn * vkp + cs * vkq
      }
    }
    if (off < 1e-14) break
  }
  const diag = [a[0], a[4], a[8]]
  const i = diag.indexOf(Math.min(...diag))
  return [v[i], v[3 + i], v[6 + i]]
}

/**
 * Faces narrower than `minSize` mm. A face's width is measured across the face seen along its flattest direction, so a thin strip,
 * a pin top, a tiny fillet or the wall of a small hole all read as their real width.
 */
export function smallFeatures(m: MeshIn, info: TriInfo, minSize: number): SmallResult {
  const ids = m.faceIds
  const flag = new Uint8Array(info.count)
  if (!ids) return { faces: [], flag, area: 0 }
  const byFace = new Map<number, number[]>()
  for (let t = 0; t < info.count; t++) {
    const l = byFace.get(ids[t])
    if (l) l.push(t); else byFace.set(ids[t], [t])
  }
  const p = m.positions
  const faces: SmallFace[] = []
  let total = 0
  for (const [face, tris] of byFace) {
    const verts = new Set<number>()
    for (const t of tris) for (let k = 0; k < 3; k++) verts.add(m.indices[t * 3 + k])
    if (verts.size < 3) continue
    const pts = new Float64Array(verts.size * 3)
    let i = 0, cx = 0, cy = 0, cz = 0
    for (const v of verts) {
      pts[i] = p[v * 3]; pts[i + 1] = p[v * 3 + 1]; pts[i + 2] = p[v * 3 + 2]
      cx += pts[i]; cy += pts[i + 1]; cz += pts[i + 2]
      i += 3
    }
    const k = verts.size
    cx /= k; cy /= k; cz /= k
    const cov = [0, 0, 0, 0, 0, 0]
    for (let j = 0; j < pts.length; j += 3) {
      const x = pts[j] - cx, y = pts[j + 1] - cy, z = pts[j + 2] - cz
      cov[0] += x * x; cov[1] += x * y; cov[2] += x * z; cov[3] += y * y; cov[4] += y * z; cov[5] += z * z
    }
    const axis = flattestAxis(cov.map((x) => x / k))
    // two directions across the axis
    const ref: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    let u: Vec3 = [axis[1] * ref[2] - axis[2] * ref[1], axis[2] * ref[0] - axis[0] * ref[2], axis[0] * ref[1] - axis[1] * ref[0]]
    const ul = Math.hypot(...u) || 1
    u = [u[0] / ul, u[1] / ul, u[2] / ul]
    const v: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]]
    const size = minWidth(pts, u, v)
    if (size >= minSize) continue
    let area = 0
    for (const t of tris) { area += info.area[t]; flag[t] = 1 }
    total += area
    faces.push({ face, size, area, centre: [cx, cy, cz] })
  }
  faces.sort((a, b) => a.size - b.size)
  return { faces, flag, area: total }
}
