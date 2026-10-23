/** Shared kernel types (safe to import from both the main thread and the worker). */

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  /** B-rep face id per triangle (0..n-1; all 0 for plain meshes) */
  faceIds: Uint32Array
  /** line segments for edge display: [x0,y0,z0,x1,y1,z1, ...] */
  edges: Float32Array
  /** B-rep edge id per segment (parallel to `edges`, 6 floats per segment); absent => segment index */
  edgeIds?: Uint32Array
}

export interface Body {
  /** stable document-level id (selection, hide, rename); `${featureId}` or `${featureId}.${n}` */
  id: string
  name: string
  kind: 'brep' | 'mesh'
  /** worker handle of the geometry; changes whenever the geometry changes */
  key: string
  /** feature that originally created this body */
  featureId?: string
  mesh: MeshData
}

export type Vec3 = [number, number, number]

export interface FaceSig { normal: Vec3; centroid: Vec3; area: number }
export interface EdgeSig { midpoint: Vec3; direction: Vec3; length: number }

/** Welded triangle mesh (topology), used for booleans and export. */
export interface TopoMesh { positions: Float32Array; indices: Uint32Array }

export interface TransformSpec {
  /** pivot for scale and rotation */
  pivot: Vec3
  translate: Vec3
  /** euler degrees, applied X then Y then Z about world axes through the pivot */
  rotate: Vec3
  /** uniform scale */
  scale: number
}

/** Column-major 4x4 matrix for `T(translate) * Rz*Ry*Rx * S * T(-pivot)` (shared by viewport preview and kernel). */
export function composeTransform(t: TransformSpec): number[] {
  const [rx, ry, rz] = t.rotate.map((d) => (d * Math.PI) / 180)
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz)
  // R = Rz * Ry * Rx
  const r00 = cz * cy, r01 = cz * sy * sx - sz * cx, r02 = cz * sy * cx + sz * sx
  const r10 = sz * cy, r11 = sz * sy * sx + cz * cx, r12 = sz * sy * cx - cz * sx
  const r20 = -sy, r21 = cy * sx, r22 = cy * cx
  const s = t.scale
  const [px, py, pz] = t.pivot
  const m = (a: number, b: number, c: number, p: number) => [a * s, b * s, c * s, p]
  const row0 = m(r00, r01, r02, 0), row1 = m(r10, r11, r12, 0), row2 = m(r20, r21, r22, 0)
  const tx = px + t.translate[0] - (row0[0] * px + row0[1] * py + row0[2] * pz)
  const ty = py + t.translate[1] - (row1[0] * px + row1[1] * py + row1[2] * pz)
  const tz = pz + t.translate[2] - (row2[0] * px + row2[1] * py + row2[2] * pz)
  // column-major
  return [row0[0], row1[0], row2[0], 0, row0[1], row1[1], row2[1], 0, row0[2], row1[2], row2[2], 0, tx, ty, tz, 1]
}

export function bbox(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  return { min, max }
}

/** Per-face signature (area-weighted normal, centroid, area) computed from the tessellation. */
export function computeFaceSigs(m: MeshData): FaceSig[] {
  const n = m.faceIds.length ? Math.max(...m.faceIds) + 1 : 0
  const acc = Array.from({ length: n }, () => ({ nx: 0, ny: 0, nz: 0, cx: 0, cy: 0, cz: 0, a: 0 }))
  const p = m.positions
  for (let t = 0; t < m.indices.length / 3; t++) {
    const i0 = m.indices[t * 3] * 3, i1 = m.indices[t * 3 + 1] * 3, i2 = m.indices[t * 3 + 2] * 3
    const ux = p[i1] - p[i0], uy = p[i1 + 1] - p[i0 + 1], uz = p[i1 + 2] - p[i0 + 2]
    const vx = p[i2] - p[i0], vy = p[i2 + 1] - p[i0 + 1], vz = p[i2 + 2] - p[i0 + 2]
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    const area = Math.hypot(cx, cy, cz) / 2
    const f = acc[m.faceIds[t]]
    f.nx += cx / 2; f.ny += cy / 2; f.nz += cz / 2
    f.cx += area * (p[i0] + p[i1] + p[i2]) / 3
    f.cy += area * (p[i0 + 1] + p[i1 + 1] + p[i2 + 1]) / 3
    f.cz += area * (p[i0 + 2] + p[i1 + 2] + p[i2 + 2]) / 3
    f.a += area
  }
  return acc.map((f) => {
    const l = Math.hypot(f.nx, f.ny, f.nz) || 1
    const a = f.a || 1
    return { normal: [f.nx / l, f.ny / l, f.nz / l], centroid: [f.cx / a, f.cy / a, f.cz / a], area: f.a }
  })
}

/** Per-edge signature from the display segments. */
export function computeEdgeSigs(m: MeshData): EdgeSig[] {
  const segs = m.edges.length / 6
  const n = m.edgeIds && segs ? Math.max(...m.edgeIds) + 1 : segs
  const acc = Array.from({ length: n }, () => ({ mx: 0, my: 0, mz: 0, dx: 0, dy: 0, dz: 0, len: 0, c: 0 }))
  for (let s = 0; s < segs; s++) {
    const e = acc[m.edgeIds ? m.edgeIds[s] : s]
    const o = s * 6
    const dx = m.edges[o + 3] - m.edges[o], dy = m.edges[o + 4] - m.edges[o + 1], dz = m.edges[o + 5] - m.edges[o + 2]
    e.mx += (m.edges[o] + m.edges[o + 3]) / 2; e.my += (m.edges[o + 1] + m.edges[o + 4]) / 2; e.mz += (m.edges[o + 2] + m.edges[o + 5]) / 2
    e.len += Math.hypot(dx, dy, dz)
    if (e.c === 0) { e.dx = dx; e.dy = dy; e.dz = dz }
    e.c++
  }
  return acc.map((e) => {
    const c = e.c || 1
    const l = Math.hypot(e.dx, e.dy, e.dz) || 1
    return { midpoint: [e.mx / c, e.my / c, e.mz / c], direction: [e.dx / l, e.dy / l, e.dz / l], length: e.len }
  })
}
