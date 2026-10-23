import type { MeshData, TopoMesh } from './types'

/** Weld coincident vertices (and drop degenerate triangles). Accepts indexed or non-indexed input. */
export function weld(positions: ArrayLike<number>, indices?: ArrayLike<number>, eps = 1e-5): TopoMesh {
  const inv = 1 / eps
  const map = new Map<string, number>()
  const out: number[] = []
  const remap = (i: number) => {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    const k = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv)
    let id = map.get(k)
    if (id === undefined) {
      id = out.length / 3
      map.set(k, id)
      out.push(x, y, z)
    }
    return id
  }
  const count = indices ? indices.length : positions.length / 3
  const tri: number[] = []
  for (let t = 0; t < count; t += 3) {
    const a = remap(indices ? indices[t] : t), b = remap(indices ? indices[t + 1] : t + 1), c = remap(indices ? indices[t + 2] : t + 2)
    if (a !== b && b !== c && a !== c) tri.push(a, b, c)
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(tri) }
}

/** Display mesh for a plain triangle mesh: crease-aware normals (split vertices) and feature/boundary edges. */
export function meshDisplay(topo: TopoMesh, creaseDeg = 30): MeshData {
  const p = topo.positions, idx = topo.indices
  const T = idx.length / 3
  const nv = p.length / 3
  const fn = new Float32Array(T * 3) // area-weighted (unnormalised) normal
  const un = new Float32Array(T * 3) // unit normal
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z) || 1
    fn.set([x, y, z], t * 3)
    un.set([x / l, y / l, z / l], t * 3)
  }
  // vertex -> triangles (CSR)
  const start = new Uint32Array(nv + 1)
  for (let i = 0; i < idx.length; i++) start[idx[i] + 1]++
  for (let i = 0; i < nv; i++) start[i + 1] += start[i]
  const fill = start.slice(0, nv)
  const list = new Uint32Array(idx.length)
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) list[fill[idx[t * 3 + k]]++] = t

  const cosC = Math.cos((creaseDeg * Math.PI) / 180)
  const positions = new Float32Array(T * 9)
  const normals = new Float32Array(T * 9)
  const indices = new Uint32Array(T * 3)
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k]
      const o = (t * 3 + k) * 3
      positions[o] = p[v * 3]; positions[o + 1] = p[v * 3 + 1]; positions[o + 2] = p[v * 3 + 2]
      let nx = 0, ny = 0, nz = 0
      for (let j = start[v]; j < start[v + 1]; j++) {
        const u = list[j]
        if (un[u * 3] * un[t * 3] + un[u * 3 + 1] * un[t * 3 + 1] + un[u * 3 + 2] * un[t * 3 + 2] >= cosC) {
          nx += fn[u * 3]; ny += fn[u * 3 + 1]; nz += fn[u * 3 + 2]
        }
      }
      const l = Math.hypot(nx, ny, nz) || 1
      normals[o] = nx / l; normals[o + 1] = ny / l; normals[o + 2] = nz / l
      indices[t * 3 + k] = t * 3 + k
    }
  }
  // feature edges: boundary / non-manifold / sharp
  const emap = new Map<number, number[]>()
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k], b = idx[t * 3 + ((k + 1) % 3)]
      const key = a < b ? a * nv + b : b * nv + a
      const arr = emap.get(key)
      if (arr) arr.push(t)
      else emap.set(key, [t])
    }
  }
  const segs: number[] = []
  for (const [key, ts] of emap) {
    let sharp = ts.length !== 2
    if (!sharp) sharp = un[ts[0] * 3] * un[ts[1] * 3] + un[ts[0] * 3 + 1] * un[ts[1] * 3 + 1] + un[ts[0] * 3 + 2] * un[ts[1] * 3 + 2] < cosC
    if (!sharp) continue
    const a = Math.floor(key / nv), b = key % nv
    segs.push(p[a * 3], p[a * 3 + 1], p[a * 3 + 2], p[b * 3], p[b * 3 + 1], p[b * 3 + 2])
  }
  return { positions, normals, indices, faceIds: new Uint32Array(T), edges: new Float32Array(segs) }
}
