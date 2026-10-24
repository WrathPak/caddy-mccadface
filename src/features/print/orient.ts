/** Auto orient: pick the way up that needs the least support. Pure, runs in Node and the browser. */
import { DoubleSide, Ray, Vector3 } from 'three'
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

/** Rank orientations of a mesh (Z is up now). `angle` is the overhang threshold in degrees from vertical. */
export function autoOrient(m: MeshIn, opts: { angle: number; goal: OrientGoal }): OrientResult {
  const info = triInfo(m)
  const bvh = buildBvh(m)
  const cmp = better(opts.goal)
  const current = evaluate(m, info, bvh, [0, 0, -1], opts.angle, true)
  // cheap pass over every direction, then the volume estimate for the most promising few
  const dirs = candidateDirections(info)
  const pre = dirs.map((d) => evaluate(m, info, bvh, d, opts.angle, false))
  pre.sort((a, b) => a.overhangArea - b.overhangArea || b.contactArea - a.contactArea)
  const finalists = pre.slice(0, 10).map((c) => evaluate(m, info, bvh, c.down, opts.angle, true))
  if (!finalists.some((f) => dot(f.down, current.down) > 0.9999)) finalists.push(current)
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

