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

/** Default dihedral angle (degrees) above which two adjacent triangles belong to different faces of a mesh body. */
export const DEFAULT_CREASE_DEG = 20

export interface Segmentation {
  /** face id per triangle (numbered in order of first triangle) */
  faceIds: Uint32Array
  faceCount: number
  /** per triangle edge k (a->b, k = 0..2): the neighbouring triangle across it, or -1 for boundary / non-manifold edges */
  adj: Int32Array
  /** unit triangle normals */
  normals: Float32Array
}

/**
 * Split a welded triangle mesh into faces: flood fill over edges shared by exactly two triangles whose dihedral angle
 * (angle between their normals) is below `creaseDeg`. Boundary and non-manifold edges never connect.
 */
export function segmentFaces(topo: TopoMesh, creaseDeg = DEFAULT_CREASE_DEG): Segmentation {
  const p = topo.positions, idx = topo.indices
  const T = idx.length / 3
  const nrm = new Float32Array(T * 3)
  const flat = new Uint8Array(T) // zero-area triangles carry no orientation: they join whichever face they touch
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z)
    if (l < 1e-20) flat[t] = 1
    else nrm.set([x / l, y / l, z / l], t * 3)
  }
  // adj[t*3+k] is set only when the edge has exactly two triangles
  const nv = p.length / 3
  const slots = new Map<number, number[]>() // edge key -> slots (t*3+k)
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const x = idx[t * 3 + k], y = idx[t * 3 + ((k + 1) % 3)]
      const key = x < y ? x * nv + y : y * nv + x
      const l = slots.get(key)
      if (l) l.push(t * 3 + k); else slots.set(key, [t * 3 + k])
    }
  }
  const adj = new Int32Array(T * 3).fill(-1)
  for (const l of slots.values()) {
    if (l.length !== 2) continue
    const t0 = (l[0] / 3) | 0, t1 = (l[1] / 3) | 0
    if (t0 === t1) continue
    adj[l[0]] = t1
    adj[l[1]] = t0
  }
  const cosC = Math.cos((creaseDeg * Math.PI) / 180)
  const faceIds = new Uint32Array(T).fill(0xffffffff)
  let faceCount = 0
  const stack: number[] = []
  for (let s = 0; s < T; s++) {
    if (faceIds[s] !== 0xffffffff) continue
    const f = faceCount++
    faceIds[s] = f
    stack.push(s)
    while (stack.length) {
      const a = stack.pop()!
      for (let k = 0; k < 3; k++) {
        const b = adj[a * 3 + k]
        if (b < 0 || faceIds[b] !== 0xffffffff) continue
        const d = nrm[a * 3] * nrm[b * 3] + nrm[a * 3 + 1] * nrm[b * 3 + 1] + nrm[a * 3 + 2] * nrm[b * 3 + 2]
        if (flat[a] || flat[b] || d >= cosC) { faceIds[b] = f; stack.push(b) }
      }
    }
  }
  return { faceIds, faceCount, adj, normals: nrm }
}

/**
 * Display mesh for a plain triangle mesh: faces segmented by crease angle, crease-aware normals (split vertices) and
 * feature edges. Feature edges are the face boundaries plus open / non-manifold edges; they are chained into edges
 * (`edgeIds`) the way a B-rep's edges are: a chain continues through a vertex only while both neighbours separate the
 * same pair of faces and the path does not turn sharply.
 */
export function meshDisplay(topo: TopoMesh, creaseDeg = DEFAULT_CREASE_DEG): MeshData {
  const p = topo.positions, idx = topo.indices
  const T = idx.length / 3
  const nv = p.length / 3
  const seg = segmentFaces(topo, creaseDeg)
  const { faceIds, faceCount, adj, normals: un } = seg
  const fn = new Float32Array(T * 3) // area-weighted (unnormalised) normal
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    fn.set([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], t * 3)
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

  // feature edges: every mesh edge that is open / non-manifold or separates two different faces
  const ea: number[] = [], eb: number[] = [], ekey: number[] = []
  const seen = new Set<number>()
  const sentinel = faceCount // "no face on this side"
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k], b = idx[t * 3 + ((k + 1) % 3)]
      const key = a < b ? a * nv + b : b * nv + a
      if (seen.has(key)) continue
      seen.add(key)
      const o = adj[t * 3 + k]
      let f0: number, f1: number
      if (o >= 0) {
        f0 = faceIds[t]; f1 = faceIds[o]
        if (f0 === f1) continue
      } else { f0 = faceIds[t]; f1 = sentinel }
      const lo = Math.min(f0, f1), hi = Math.max(f0, f1)
      ea.push(a); eb.push(b); ekey.push(lo * (faceCount + 1) + hi)
    }
  }
  const E = ea.length
  const parent = Int32Array.from({ length: E }, (_, i) => i)
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const incident = new Map<number, number[]>()
  for (let e = 0; e < E; e++) for (const v of [ea[e], eb[e]]) {
    const l = incident.get(v)
    if (l) l.push(e); else incident.set(v, [e])
  }
  const cosTurn = Math.cos((40 * Math.PI) / 180)
  for (const [v, es] of incident) {
    if (es.length !== 2 || ekey[es[0]] !== ekey[es[1]]) continue
    // direction of each edge pointing away from v
    const dir = (e: number) => {
      const o = ea[e] === v ? eb[e] : ea[e]
      const x = p[o * 3] - p[v * 3], y = p[o * 3 + 1] - p[v * 3 + 1], z = p[o * 3 + 2] - p[v * 3 + 2]
      const l = Math.hypot(x, y, z) || 1
      return [x / l, y / l, z / l]
    }
    const d0 = dir(es[0]), d1 = dir(es[1])
    if (-(d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2]) >= cosTurn) parent[find(es[0])] = find(es[1])
  }
  const ids = new Map<number, number>()
  const segs = new Float32Array(E * 6)
  const edgeIds = new Uint32Array(E)
  for (let e = 0; e < E; e++) {
    const r = find(e)
    let id = ids.get(r)
    if (id === undefined) { id = ids.size; ids.set(r, id) }
    edgeIds[e] = id
    segs.set([p[ea[e] * 3], p[ea[e] * 3 + 1], p[ea[e] * 3 + 2], p[eb[e] * 3], p[eb[e] * 3 + 1], p[eb[e] * 3 + 2]], e * 6)
  }
  return { positions, normals, indices, faceIds, edges: segs, edgeIds, faceCount, edgeCount: ids.size }
}

// ---------------------------------------------------------------- smoothing and repair (pure, no WASM)

/** Vertex -> neighbouring vertices of a welded mesh, plus which vertices lie on an open (boundary) edge. */
function vertexRings(topo: TopoMesh) {
  const nv = topo.positions.length / 3
  const rings: Set<number>[] = Array.from({ length: nv }, () => new Set<number>())
  const edgeUse = new Map<number, number>()
  const idx = topo.indices
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k], b = idx[t + ((k + 1) % 3)]
      rings[a].add(b)
      rings[b].add(a)
      const key = a < b ? a * nv + b : b * nv + a
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1)
    }
  }
  const boundary = new Uint8Array(nv)
  for (const [key, n] of edgeUse) if (n !== 2) { boundary[Math.floor(key / nv)] = 1; boundary[key % nv] = 1 }
  return { rings, boundary }
}

/**
 * Taubin (lambda | mu) smoothing: each iteration moves every vertex towards the average of its neighbours, then back out
 * a little, so surfaces relax without shrinking. Vertices on open boundaries stay put. `strength` is 0..1.
 */
export function smoothTopo(topo: TopoMesh, iterations: number, strength: number): TopoMesh {
  const { rings, boundary } = vertexRings(topo)
  const lambda = Math.min(1, Math.max(0, strength)) * 0.6
  const mu = -lambda * 1.03
  let cur = Float32Array.from(topo.positions)
  const nv = cur.length / 3
  const pass = (src: Float32Array, k: number) => {
    const out = Float32Array.from(src)
    for (let v = 0; v < nv; v++) {
      const r = rings[v]
      if (boundary[v] || !r.size) continue
      let x = 0, y = 0, z = 0
      for (const n of r) { x += src[n * 3]; y += src[n * 3 + 1]; z += src[n * 3 + 2] }
      out[v * 3] = src[v * 3] + k * (x / r.size - src[v * 3])
      out[v * 3 + 1] = src[v * 3 + 1] + k * (y / r.size - src[v * 3 + 1])
      out[v * 3 + 2] = src[v * 3 + 2] + k * (z / r.size - src[v * 3 + 2])
    }
    return out
  }
  for (let i = 0; i < iterations; i++) cur = pass(pass(cur, lambda), mu)
  return { positions: cur, indices: topo.indices.slice() }
}

export interface RepairReport { welded: number; degenerate: number; duplicates: number; holesFilled: number }

/**
 * Make a triangle soup a closed mesh where that is unambiguous: weld vertices within `eps`, drop degenerate and duplicate
 * triangles, and close each open boundary loop with a fan around its centroid.
 */
export function repairTopo(topo: TopoMesh, eps: number): { mesh: TopoMesh; report: RepairReport } {
  const before = topo.positions.length / 3
  const w = weld(topo.positions, topo.indices, Math.max(eps, 1e-9))
  const report: RepairReport = { welded: before - w.positions.length / 3, degenerate: topo.indices.length / 3 - w.indices.length / 3, duplicates: 0, holesFilled: 0 }
  // duplicate triangles (same vertex set)
  const seen = new Set<string>()
  const tri: number[] = []
  for (let t = 0; t < w.indices.length; t += 3) {
    const k = [w.indices[t], w.indices[t + 1], w.indices[t + 2]].sort((a, b) => a - b).join(',')
    if (seen.has(k)) { report.duplicates++; continue }
    seen.add(k)
    tri.push(w.indices[t], w.indices[t + 1], w.indices[t + 2])
  }
  const pos = Array.from(w.positions)
  // boundary half-edges: directed edges whose opposite does not exist; the hole is walked against them
  const directed = new Set<string>()
  for (let t = 0; t < tri.length; t += 3) for (let k = 0; k < 3; k++) directed.add(tri[t + k] + '>' + tri[t + ((k + 1) % 3)])
  const next = new Map<number, number[]>()
  for (const key of directed) {
    const [a, b] = key.split('>').map(Number)
    if (!directed.has(b + '>' + a)) (next.get(b) ?? next.set(b, []).get(b)!).push(a)
  }
  const used = new Set<string>()
  for (const [start] of next) {
    let cur = start
    const loop: number[] = [cur]
    for (let guard = 0; guard < 1e6; guard++) {
      const outs = next.get(cur)?.filter((n) => !used.has(cur + '>' + n))
      if (!outs?.length) break
      const n = outs[0]
      used.add(cur + '>' + n)
      if (n === start) { cur = n; break }
      loop.push(n)
      cur = n
    }
    if (cur !== start || loop.length < 3) continue
    let cx = 0, cy = 0, cz = 0
    for (const v of loop) { cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2] }
    const c = pos.length / 3
    pos.push(cx / loop.length, cy / loop.length, cz / loop.length)
    for (let i = 0; i < loop.length; i++) tri.push(c, loop[i], loop[(i + 1) % loop.length])
    report.holesFilled++
  }
  return { mesh: { positions: Float32Array.from(pos), indices: Uint32Array.from(tri) }, report }
}

/** Signed enclosed volume of a closed triangle mesh. */
export function topoVolume(t: TopoMesh): number {
  const p = t.positions, ix = t.indices
  let v = 0
  for (let k = 0; k < ix.length; k += 3) {
    const a = ix[k] * 3, b = ix[k + 1] * 3, c = ix[k + 2] * 3
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6
  }
  return v
}
