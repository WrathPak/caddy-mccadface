/**
 * Scalable mesh helpers for multi-million triangle models: a typed-array vertex weld, the cheap display path used above
 * LARGE_MESH_TRIS, and a vertex-clustering decimator that produces the low-res mesh the viewport draws while orbiting.
 * Pure functions on typed arrays, so they run in the kernel worker, in the compute pool, and in Node tests.
 */
import { BufferAttribute, BufferGeometry } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { bbox, type MeshBvh, type MeshData, type MeshLod, type TopoMesh } from './types'

/** Above this many triangles a mesh body skips crease segmentation and feature edges (it is one face) and gets a LOD mesh. */
export const LARGE_MESH_TRIS = 400_000
/** Triangle budget of the orbit-time mesh. */
export const LOD_TRIS = 60_000

/** Open-addressing map from non-negative integers (below 2^53) to int32 values; no per-entry allocation. */
export class IntMap {
  private keys: Float64Array
  private vals: Int32Array
  private mask: number
  size = 0
  constructor(capacity = 1024) {
    let c = 16
    while (c < capacity * 2) c <<= 1
    this.keys = new Float64Array(c).fill(-1)
    this.vals = new Int32Array(c)
    this.mask = c - 1
  }
  private slot(k: number) {
    // k can exceed 32 bits: fold the halves, then scramble
    let h = (k % 4294967296) | 0
    h = Math.imul(h ^ ((k / 4294967296) | 0), 0x9e3779b1)
    h ^= h >>> 15
    return (Math.imul(h, 0x85ebca6b) >>> 0) & this.mask
  }
  get(k: number): number {
    let i = this.slot(k)
    for (;;) {
      const s = this.keys[i]
      if (s === k) return this.vals[i]
      if (s === -1) return -1
      i = (i + 1) & this.mask
    }
  }
  set(k: number, v: number) {
    if ((this.size + 1) * 2 > this.keys.length) this.grow()
    let i = this.slot(k)
    for (;;) {
      const s = this.keys[i]
      if (s === k) { this.vals[i] = v; return }
      if (s === -1) { this.keys[i] = k; this.vals[i] = v; this.size++; return }
      i = (i + 1) & this.mask
    }
  }
  private grow() {
    const ok = this.keys, ov = this.vals
    const c = ok.length * 2
    this.keys = new Float64Array(c).fill(-1)
    this.vals = new Int32Array(c)
    this.mask = c - 1
    this.size = 0
    for (let i = 0; i < ok.length; i++) if (ok[i] !== -1) this.set(ok[i], ov[i])
  }
}

/**
 * Weld coincident vertices (and drop degenerate triangles). Accepts indexed or non-indexed input. Two vertices are one when
 * their coordinates round to the same multiple of `eps` on every axis; unique vertices keep the order they first appear in.
 */
export function weld(positions: ArrayLike<number>, indices?: ArrayLike<number>, eps = 1e-5): TopoMesh {
  const inv = 1 / eps
  const count = indices ? indices.length : Math.floor(positions.length / 3)
  const nIn = indices ? Math.floor(positions.length / 3) : count
  // hash table over the unique vertices; grows as they appear (a triangle soup has about a sixth as many unique as given)
  let cap = 1 << 12
  let table = new Int32Array(cap).fill(-1)
  let mask = cap - 1
  let uCap = 1024
  let out = new Float32Array(uCap * 3)
  let qk = new Float64Array(uCap * 3)
  let nu = 0
  const hash = (a: number, b: number, c: number) => {
    let h = Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(c | 0, 83492791)
    h ^= h >>> 13
    return (Math.imul(h, 0x85ebca6b) >>> 0) & mask
  }
  const rehash = () => {
    cap <<= 1
    mask = cap - 1
    table = new Int32Array(cap).fill(-1)
    for (let u = 0; u < nu; u++) {
      let s = hash(qk[u * 3], qk[u * 3 + 1], qk[u * 3 + 2])
      while (table[s] !== -1) s = (s + 1) & mask
      table[s] = u
    }
  }
  // remap through a cache so an indexed input does the hashing once per input vertex
  const memo = indices ? new Int32Array(nIn).fill(-1) : null
  const remap = (i: number): number => {
    if (memo && memo[i] !== -1) return memo[i]
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    const a = Math.round(x * inv), b = Math.round(y * inv), c = Math.round(z * inv)
    let s = hash(a, b, c)
    let id = -1
    for (;;) {
      const u = table[s]
      if (u === -1) break
      if (qk[u * 3] === a && qk[u * 3 + 1] === b && qk[u * 3 + 2] === c) { id = u; break }
      s = (s + 1) & mask
    }
    if (id === -1) {
      if (nu === uCap) {
        uCap *= 2
        const o2 = new Float32Array(uCap * 3); o2.set(out); out = o2
        const q2 = new Float64Array(uCap * 3); q2.set(qk); qk = q2
      }
      id = nu++
      out[id * 3] = x; out[id * 3 + 1] = y; out[id * 3 + 2] = z
      qk[id * 3] = a; qk[id * 3 + 1] = b; qk[id * 3 + 2] = c
      table[s] = id
      if (nu * 2 > cap) rehash()
    }
    if (memo) memo[i] = id
    return id
  }
  let tri = new Uint32Array(Math.max(3, count))
  let nt = 0
  for (let t = 0; t + 2 < count; t += 3) {
    const a = remap(indices ? indices[t] : t), b = remap(indices ? indices[t + 1] : t + 1), c = remap(indices ? indices[t + 2] : t + 2)
    if (a !== b && b !== c && a !== c) { tri[nt++] = a; tri[nt++] = b; tri[nt++] = c }
  }
  return { positions: out.slice(0, nu * 3), indices: tri.slice(0, nt) }
}

/** Area-weighted vertex normals of an indexed mesh. */
export function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length)
  const p = positions
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    for (const o of [a, b, c]) { n[o] += x; n[o + 1] += y; n[o + 2] += z }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l
  }
  return n
}

/**
 * Vertex-clustering decimation: vertices that fall into the same cell of a regular grid collapse to their average, triangles
 * that lose a corner vanish. The grid is refined until the result is close to `target` triangles. O(vertices), no queues.
 */
export function buildLod(positions: Float32Array, indices: Uint32Array, target = LOD_TRIS): MeshLod {
  const nv = positions.length / 3
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1
  const cluster = new Int32Array(nv)
  /** assign every vertex a cluster at grid resolution g; returns the cluster count */
  const assign = (g: number) => {
    const cell = size / g
    const map = new IntMap(Math.min(nv, 1 << 16))
    let n = 0
    for (let i = 0; i < nv; i++) {
      const cx = Math.min(g - 1, Math.floor((positions[i * 3] - minX) / cell))
      const cy = Math.min(g - 1, Math.floor((positions[i * 3 + 1] - minY) / cell))
      const cz = Math.min(g - 1, Math.floor((positions[i * 3 + 2] - minZ) / cell))
      const k = cx + g * (cy + g * cz)
      let c = map.get(k)
      if (c === -1) { c = n++; map.set(k, c) }
      cluster[i] = c
    }
    return n
  }
  let g = Math.max(4, Math.round(Math.sqrt(target / 4)))
  let n = assign(g)
  for (let it = 0; it < 4; it++) {
    const tris = n * 2 // a closed surface has about two triangles per vertex
    if (tris > target * 0.7 && tris < target * 1.3) break
    g = Math.max(2, Math.round(g * Math.sqrt(target / Math.max(tris, 1))))
    n = assign(g)
  }
  const sum = new Float64Array(n * 3)
  const cnt = new Uint32Array(n)
  for (let i = 0; i < nv; i++) {
    const c = cluster[i]
    sum[c * 3] += positions[i * 3]; sum[c * 3 + 1] += positions[i * 3 + 1]; sum[c * 3 + 2] += positions[i * 3 + 2]
    cnt[c]++
  }
  const lp = new Float32Array(n * 3)
  for (let c = 0; c < n; c++) { lp[c * 3] = sum[c * 3] / cnt[c]; lp[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]; lp[c * 3 + 2] = sum[c * 3 + 2] / cnt[c] }
  const li: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const a = cluster[indices[t]], b = cluster[indices[t + 1]], c = cluster[indices[t + 2]]
    if (a !== b && b !== c && a !== c) li.push(a, b, c)
  }
  const idx = Uint32Array.from(li)
  return { positions: lp, normals: vertexNormals(lp, idx), indices: idx }
}

/** Build the picking BVH for an indexed mesh (indirect, so `indices` is left untouched). */
export function buildMeshBvh(positions: Float32Array, indices: Uint32Array): MeshBvh {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(positions, 3))
  g.setIndex(new BufferAttribute(indices, 1))
  const bvh = new MeshBVH(g, { indirect: true })
  const s = MeshBVH.serialize(bvh, { cloneBuffers: false })
  return { roots: s.roots as ArrayBuffer[], indirect: s.indirectBuffer as Uint32Array }
}

/** Display data of a very large mesh: indexed, smooth vertex normals, a single face, no feature edges, plus the LOD mesh. */
export function meshDisplayLarge(topo: TopoMesh): MeshData {
  const positions = topo.positions.slice()
  const indices = topo.indices.slice()
  return {
    positions,
    normals: vertexNormals(positions, indices),
    indices,
    faceIds: new Uint32Array(indices.length / 3),
    edges: new Float32Array(0),
    edgeIds: new Uint32Array(0),
    faceCount: 1,
    edgeCount: 0,
    lod: buildLod(positions, indices),
    bvh: buildMeshBvh(positions, indices),
    bounds: bbox(positions),
  }
}

export const isLargeTopo = (t: TopoMesh) => t.indices.length / 3 > LARGE_MESH_TRIS
