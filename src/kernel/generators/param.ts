/**
 * Surface parameterisation: fits a plane or a cylinder to a smooth patch and maps surface points to (u, v) in mm along it.
 * Flat patches use a planar map, round ones a cylindrical map whose circumference is a whole number of tiles, anything
 * else has no map (callers fall back to triplanar mapping).
 */
import type { Surf } from '../../features/hair/sampling'
import type { V3 } from '../../features/hair/schema'
import { add, cross, dot, len, mul, norm, perp, sub } from '../../features/hair/vec'

export interface PatchMap {
  kind: 'planar' | 'cylinder'
  /** a point on the plane / axis */
  o: V3
  /** plane normal / cylinder axis */
  a: V3
  /** the two tangent directions u and v point along (planar), or the radial reference and its 90 degree turn (cylinder) */
  ex: V3
  ey: V3
  /** cylinder radius, 0 for planar */
  r: number
  /** cylinder: v runs around the circumference (true) or along the axis (false) */
  around: boolean
  /** v sign: +1 or -1 along its direction */
  vSign: 1 | -1
}

/** Eigen decomposition of a symmetric 3x3 matrix (Jacobi). Eigenvalues ascending, vectors as columns of the returned rows. */
export function eigenSym(m: number[][]): { values: V3; vectors: V3[] } {
  const a = m.map((r) => [...r])
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j]
    if (off < 1e-24) break
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q])
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1))
      const c = 1 / Math.sqrt(t * t + 1), s = t * c
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y }
      for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j])
  return { values: order.map((i) => a[i][i]) as V3, vectors: order.map((i) => norm([v[0][i], v[1][i], v[2][i]])) }
}

/** Least squares circle through 2D points (algebraic fit). */
function fitCircle(pts: [number, number][]): { cx: number; cy: number; r: number } | null {
  const n = pts.length
  if (n < 3) return null
  let sx = 0, sy = 0
  for (const [x, y] of pts) { sx += x; sy += y }
  const mx = sx / n, my = sy / n
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const [x, y] of pts) {
    const u = x - mx, v = y - my
    suu += u * u; suv += u * v; svv += v * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-12) return null
  const uc = (0.5 * (suuu + suvv) * svv - 0.5 * (svvv + svuu) * suv) / det
  const vc = (0.5 * (svvv + svuu) * suu - 0.5 * (suuu + suvv) * suv) / det
  return { cx: mx + uc, cy: my + vc, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) }
}

/** Planar map along the area weighted mean normal of the triangles (exact for flat patches, a projection for curved ones). */
export function planarMap(s: Surf, tris: ArrayLike<number>, flow: V3): PatchMap {
  let mean: V3 = [0, 0, 0], cen: V3 = [0, 0, 0], tot = 0
  for (let k = 0; k < tris.length; k++) {
    const t = tris[k], w = s.area[t]
    mean = add(mean, mul([s.tn[t * 3], s.tn[t * 3 + 1], s.tn[t * 3 + 2]], w))
    for (let c = 0; c < 3; c++) { const vi = s.idx[t * 3 + c] * 3; cen = add(cen, mul([s.pos[vi], s.pos[vi + 1], s.pos[vi + 2]], w / 3)) }
    tot += w
  }
  const nrm = norm(mean)
  const fv = norm(flow)
  let ey = sub(fv, mul(nrm, dot(fv, nrm)))
  if (len(ey) < 1e-3) ey = sub([0, 1, 0], mul(nrm, nrm[1]))
  ey = norm(ey)
  if (!ey.some(Boolean)) ey = perp(nrm)
  const ex = norm(cross(ey, nrm))
  return { kind: 'planar', o: mul(cen, 1 / (tot || 1)), a: nrm, ex, ey, r: 0, around: false, vSign: 1 }
}

/**
 * Fit a map to triangles `tris` of the surface. `flow` picks which way v points (projected onto the plane, or along / around
 * the cylinder). Returns null when the patch is neither flat nor a clean cylinder.
 */
export function fitPatch(s: Surf, tris: ArrayLike<number>, flow: V3): PatchMap | null {
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  let tot = 0, cx = 0, cy = 0, cz = 0
  const n = tris.length
  for (let k = 0; k < n; k++) {
    const t = tris[k], w = s.area[t]
    const nx = s.tn[t * 3], ny = s.tn[t * 3 + 1], nz = s.tn[t * 3 + 2]
    const v = [nx, ny, nz]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += w * v[i] * v[j]
    tot += w
    for (let c = 0; c < 3; c++) {
      const vi = s.idx[t * 3 + c] * 3
      cx += w * s.pos[vi] / 3; cy += w * s.pos[vi + 1] / 3; cz += w * s.pos[vi + 2] / 3
    }
  }
  if (!tot) return null
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] /= tot
  const cen: V3 = [cx / tot, cy / tot, cz / tot]
  const { values, vectors } = eigenSym(m)
  const fv = norm(flow)
  if (values[2] > 0.985) return planarMap(s, tris, flow)
  if (values[0] < 0.02 * (values[0] + values[1] + values[2]) && values[1] > 0.05) {
    // cylinder: normals are perpendicular to the axis
    let ax = vectors[0]
    if (Math.abs(ax[2]) > 0.3 ? ax[2] < 0 : dot(ax, fv) < 0) ax = mul(ax, -1)
    const e1 = perp(ax), e2 = cross(ax, e1)
    const pts: [number, number][] = []
    const step = Math.max(1, Math.floor(n / 600))
    for (let k = 0; k < n; k += step) {
      const t = tris[k]
      const vi = s.idx[t * 3] * 3
      const q: V3 = [s.pos[vi] - cen[0], s.pos[vi + 1] - cen[1], s.pos[vi + 2] - cen[2]]
      pts.push([dot(q, e1), dot(q, e2)])
    }
    const c = fitCircle(pts)
    if (!c || !(c.r > 0)) return null
    const maxDev = pts.reduce((a, [x, y]) => Math.max(a, Math.abs(Math.hypot(x - c.cx, y - c.cy) - c.r)), 0)
    if (maxDev > 0.04 * c.r + 0.05) return null
    const o = add(cen, add(mul(e1, c.cx), mul(e2, c.cy)))
    // v follows the flow along the axis when the flow has a clear axial part, else around the circumference
    const axial = dot(fv, ax)
    const around = Math.abs(axial) < 0.5
    let vSign: 1 | -1 = !around && axial < 0 ? -1 : 1
    if (around) {
      // v runs round the circumference the way the flow runs at the middle of the patch
      const q = sub(cen, o)
      const rad = norm(sub(q, mul(ax, dot(q, ax))))
      if (dot(cross(ax, rad), fv) < 0) vSign = -1
    }
    return { kind: 'cylinder', o, a: ax, ex: e1, ey: e2, r: c.r, around, vSign }
  }
  return null
}

const TAU = Math.PI * 2

/** Circumference of a cylinder map. */
export const circumference = (m: PatchMap) => TAU * m.r

/** (u, v) of a point in mm. u of a cylinder wraps with the circumference. */
export function uvOf(m: PatchMap, p: V3): [number, number] {
  const q = sub(p, m.o)
  if (m.kind === 'planar') return [dot(q, m.ex), dot(q, m.ey)]
  const th = Math.atan2(dot(q, m.ey), dot(q, m.ex))
  const arc = th * m.r, ax = dot(q, m.a)
  return m.around ? [ax, m.vSign * arc] : [arc, m.vSign * ax]
}

/** Unit surface directions of +u and +v at point p. */
export function dirsOf(m: PatchMap, p: V3): { du: V3; dv: V3 } {
  if (m.kind === 'planar') return { du: m.ex, dv: m.ey }
  const q = sub(p, m.o)
  const rad = norm(sub(q, mul(m.a, dot(q, m.a))))
  const circ = cross(m.a, rad) // direction of increasing angle
  if (m.around) return { du: m.a, dv: mul(circ, m.vSign) }
  return { du: circ, dv: mul(m.a, m.vSign) }
}
