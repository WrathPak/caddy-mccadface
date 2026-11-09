/** Auto orient: pick the way up that needs the least support. Pure, runs in Node and the browser. */
import { DoubleSide, Ray, Vector3 } from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import { composeTransform, type Vec3 } from '@/kernel/types'
import { eulerFromMatrix, rotationBetween } from '@/kernel/print-geom'
import { buildBvh, heightRange, overhangMap, triInfo, type MeshIn, type TriInfo } from './analysis'

export type OrientGoal = 'support' | 'overhang'

export interface OrientCandidate {
  /** the model direction that ends up pointing at the plate */
  down: Vec3
  /** support material estimate, mm3 */
  supportVolume: number
  /** area that needs support, mm2 */
  overhangArea: number
  /** flat area on the plate, mm2 */
  contactArea: number
  /** height of the part in this orientation, mm */
  height: number
}

export interface OrientResult {
  /** the orientation the model has now */
  current: OrientCandidate
  /** best first */
  ranked: OrientCandidate[]
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** Directions worth trying: the axes, the normals of the biggest flat areas and an even spread over the sphere. */
export function candidateDirections(info: TriInfo, spread = 40): Vec3[] {
  const out: Vec3[] = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]
  // area per quantised normal: the big flat faces make natural bottoms
  const bins = new Map<string, { n: Vec3; area: number }>()
  for (let t = 0; t < info.count; t++) {
    const n: Vec3 = [info.n[t * 3], info.n[t * 3 + 1], info.n[t * 3 + 2]]
    const key = n.map((x) => Math.round(x * 50)).join(',')
    const b = bins.get(key)
    if (b) { b.area += info.area[t]; b.n = [b.n[0] + n[0] * info.area[t], b.n[1] + n[1] * info.area[t], b.n[2] + n[2] * info.area[t]] }
    else bins.set(key, { n: [n[0] * info.area[t], n[1] * info.area[t], n[2] * info.area[t]], area: info.area[t] })
  }
  for (const b of [...bins.values()].sort((a, c) => c.area - a.area).slice(0, 14)) out.push(norm(b.n))
  for (let i = 0; i < spread; i++) {
    const y = 1 - (2 * (i + 0.5)) / spread
    const r = Math.sqrt(1 - y * y), th = i * 2.399963229728653
    out.push([Math.cos(th) * r, y, Math.sin(th) * r])
  }
  // drop near-duplicates
  const keep: Vec3[] = []
  for (const d of out) if (!keep.some((k) => dot(k, d) > Math.cos((2 * Math.PI) / 180))) keep.push(d)
  return keep
}

/** Evaluate one orientation: overhang area from the triangles, support volume from rays dropped to whatever is below. */
function evaluate(m: MeshIn, info: TriInfo, bvh: ReturnType<typeof buildBvh>, down: Vec3, angle: number, withVolume: boolean, maxRays = 5000): OrientCandidate {
  const up: Vec3 = [-down[0], -down[1], -down[2]]
  const oh = overhangMap(m, info, angle, up)
  const { min, max } = heightRange(m, up)
  let volume = 0
  if (withVolume) {
    const flagged: number[] = []
    for (let t = 0; t < info.count; t++) if (oh.severity[t] > 0) flagged.push(t)
    const stride = Math.max(1, Math.ceil(flagged.length / maxRays))
    const ray = new Ray()
    const o = new Vector3(), d = new Vector3(down[0], down[1], down[2])
    for (let i = 0; i < flagged.length; i += stride) {
      const t = flagged[i]
      const cx = info.c[t * 3], cy = info.c[t * 3 + 1], cz = info.c[t * 3 + 2]
      const hc = cx * up[0] + cy * up[1] + cz * up[2] - min // height above the plate
      o.set(cx + d.x * 1e-3, cy + d.y * 1e-3, cz + d.z * 1e-3)
      ray.set(o, d)
      const hit = bvh.raycastFirst(ray, DoubleSide)
      const gap = hit ? Math.min(hit.distance, hc) : hc
      const proj = info.area[t] * Math.abs(dot([info.n[t * 3], info.n[t * 3 + 1], info.n[t * 3 + 2]], down))
      volume += proj * gap * stride
    }
  }
  return { down, supportVolume: volume, overhangArea: oh.area, contactArea: oh.contact, height: max - min }
}

const better = (goal: OrientGoal) => (a: OrientCandidate, b: OrientCandidate) => {
  const pa = goal === 'support' ? a.supportVolume : a.overhangArea
  const pb = goal === 'support' ? b.supportVolume : b.overhangArea
  const tol = Math.max(pa, pb) * 0.02 + 1e-6
  if (Math.abs(pa - pb) > tol) return pa - pb
  // near ties: the other measure, then the bigger footprint on the plate (steadier), then the lower part
  const sa = goal === 'support' ? a.overhangArea : a.supportVolume, sb = goal === 'support' ? b.overhangArea : b.supportVolume
  if (Math.abs(sa - sb) > Math.max(sa, sb) * 0.02 + 1e-6) return sa - sb
  if (Math.abs(a.contactArea - b.contactArea) > 1e-3 * (a.contactArea + b.contactArea + 1)) return b.contactArea - a.contactArea
  return a.height - b.height
}

/** Flat area on the plate for `down`: triangles facing it within half a degree that lie on the lowest plane (mm2). 0 when the part cannot rest flat that way. */
export function flatContact(m: MeshIn, info: TriInfo, down: Vec3): number {
  const up: Vec3 = [-down[0], -down[1], -down[2]]
  const { min } = heightRange(m, up)
  const cosTol = Math.cos((0.5 * Math.PI) / 180)
  let area = 0
  for (let t = 0; t < info.count; t++) {
    if (dot([info.n[t * 3], info.n[t * 3 + 1], info.n[t * 3 + 2]], down) < cosTol) continue
    if (info.c[t * 3] * up[0] + info.c[t * 3 + 1] * up[1] + info.c[t * 3 + 2] * up[2] - min > 0.02) continue
    area += info.area[t]
  }
  return area
}

/** The normals of the biggest planar areas (triangle normals grouped within a degree), the exact area-weighted direction of each. */
function planarNormals(info: TriInfo, max = 30): Vec3[] {
  const order = Array.from({ length: info.count }, (_, i) => i).filter((t) => info.area[t] > 1e-9).sort((a, b) => info.area[b] - info.area[a])
  const taken = new Uint8Array(info.count)
  const cos1 = Math.cos((1 * Math.PI) / 180)
  const out: Vec3[] = []
  for (const s of order) {
    if (taken[s]) continue
    const sn: Vec3 = [info.n[s * 3], info.n[s * 3 + 1], info.n[s * 3 + 2]]
    let x = 0, y = 0, z = 0
    for (const t of order) {
      if (taken[t]) continue
      const tn: Vec3 = [info.n[t * 3], info.n[t * 3 + 1], info.n[t * 3 + 2]]
      if (dot(sn, tn) < cos1) continue
      taken[t] = 1
      x += tn[0] * info.area[t]; y += tn[1] * info.area[t]; z += tn[2] * info.area[t]
    }
    out.push(norm([x, y, z]))
    if (out.length >= max) break
  }
  return out
}

/** Facet normals of the convex hull (a part with no flat face of its own still rests on a hull facet): the biggest ones. */
function hullNormals(m: MeshIn, max = 24): Vec3[] {
  const p = m.positions
  const n = p.length / 3
  const stride = Math.max(1, Math.ceil(n / 20000))
  const pts: Vector3[] = []
  for (let i = 0; i < n; i += stride) pts.push(new Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]))
  if (pts.length < 4) return []
  let hull: ConvexHull
  try { hull = new ConvexHull().setFromPoints(pts) } catch { return [] }
  const bins: { n: Vec3; area: number }[] = []
  const cos2 = Math.cos((2 * Math.PI) / 180)
  for (const f of hull.faces) {
    const e0 = f.edge, pa = e0.head().point, pb = e0.next.head().point, pc = e0.next.next.head().point
    const a = new Vector3().subVectors(pb, pa).cross(new Vector3().subVectors(pc, pa)).length() / 2, fn: Vec3 = [f.normal.x, f.normal.y, f.normal.z]
    const b = bins.find((q) => dot(q.n, fn) > cos2)
    if (b) { b.area += a; b.n = norm([b.n[0] * (b.area - a) + fn[0] * a, b.n[1] * (b.area - a) + fn[1] * a, b.n[2] * (b.area - a) + fn[2] * a]) }
    else bins.push({ n: fn, area: a })
  }
  return bins.sort((a, b) => b.area - a.area).slice(0, max).map((b) => b.n)
}

/**
 * Orientations that rest on the plate: a real flat face of the part lying exactly on it (it has to be on the underside of the
 * part, so a recessed face does not count); a part without any flat face rests on convex-hull facets.
 */
export function flatDirections(m: MeshIn, info: TriInfo): { down: Vec3; contact: number }[] {
  const minContact = Math.max(0.05, 1e-4 * info.area.reduce((s, a) => s + a, 0))
  const flat: { down: Vec3; contact: number }[] = []
  for (const down of planarNormals(info)) {
    const contact = flatContact(m, info, down)
    if (contact >= minContact && !flat.some((f) => dot(f.down, down) > Math.cos((0.5 * Math.PI) / 180))) flat.push({ down, contact })
  }
  if (flat.length) return flat
  return hullNormals(m).map((down) => ({ down, contact: flatContact(m, info, down) }))
}

/** Rank the orientations that rest flat on the plate (Z is up now). `angle` is the overhang threshold in degrees from vertical. */
export function autoOrient(m: MeshIn, opts: { angle: number; goal: OrientGoal }): OrientResult {
  const info = triInfo(m)
  const bvh = buildBvh(m)
  const cmp = better(opts.goal)
  const current = evaluate(m, info, bvh, [0, 0, -1], opts.angle, true)
  const withContact = (c: OrientCandidate, contact: number): OrientCandidate => ({ ...c, contactArea: contact })
  // cheap pass over every flat-resting direction, then the volume estimate for the most promising few
  const dirs = flatDirections(m, info)
  const pre = dirs.map((d) => withContact(evaluate(m, info, bvh, d.down, opts.angle, false), d.contact))
  pre.sort((a, b) => a.overhangArea - b.overhangArea || b.contactArea - a.contactArea)
  const finalists = pre.slice(0, 10).map((c) => withContact(evaluate(m, info, bvh, c.down, opts.angle, true), c.contactArea))
  finalists.sort(cmp)
  return { current, ranked: finalists }
}

/**
 * The Move values that turn `down` towards the plate and set the part on it: rotate about the bounding-box centre, then drop
 * the lowest point to z = 0. `m` is the mesh in its current position (the same bodies the Move will act on).
 */
export function orientMove(m: MeshIn, down: Vec3): { rotate: Vec3; translate: Vec3; pivot: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  const p = m.positions
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]) }
  const pivot: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const rotate = eulerFromMatrix(rotationBetween(norm(down), [0, 0, -1]))
  const mat = composeTransform({ pivot, translate: [0, 0, 0], rotate, scale: 1 })
  let minZ = Infinity
  for (let i = 0; i < p.length; i += 3) minZ = Math.min(minZ, mat[2] * p[i] + mat[6] * p[i + 1] + mat[10] * p[i + 2] + mat[14])
  const r = (x: number) => +x.toFixed(4)
  return { rotate: rotate.map(r) as Vec3, translate: [0, 0, r(-minZ)], pivot }
}

/** Positions after a Move spec (for checking an orientation). */
export function transformed(m: MeshIn, spec: { pivot: Vec3; translate: Vec3; rotate: Vec3 }): MeshIn {
  const mat = composeTransform({ ...spec, scale: 1 })
  const p = m.positions
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    out[i] = mat[0] * p[i] + mat[4] * p[i + 1] + mat[8] * p[i + 2] + mat[12]
    out[i + 1] = mat[1] * p[i] + mat[5] * p[i + 1] + mat[9] * p[i + 2] + mat[13]
    out[i + 2] = mat[2] * p[i] + mat[6] * p[i + 1] + mat[10] * p[i + 2] + mat[14]
  }
  return { positions: out, indices: m.indices }
}

