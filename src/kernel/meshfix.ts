/**
 * Pure mesh repair helpers (no WASM): consistent winding, hole filling by ear clipping, small shell removal, feature
 * preserving Taubin smoothing, clipping an open mesh with a plane, deleting face groups, and the offset used by Mesh Shell.
 */
import { weld } from './bigmesh'
import { segmentFaces } from './meshutil'
import type { TopoMesh } from './types'

const nextPow2 = (n: number) => { let c = 1024; while (c < n) c <<= 1; return c }

/** Signed volume of a set of triangles, measured from `o` (an open mesh has no true volume; a nearby origin keeps the estimate sane). */
function triVol(p: ArrayLike<number>, ix: ArrayLike<number>, t: number, o: [number, number, number]): number {
  const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3
  const ax = p[a] - o[0], ay = p[a + 1] - o[1], az = p[a + 2] - o[2]
  const bx = p[b] - o[0], by = p[b + 1] - o[1], bz = p[b + 2] - o[2]
  const cx = p[c] - o[0], cy = p[c + 1] - o[1], cz = p[c + 2] - o[2]
  return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
}

export interface OrientReport { flipped: number; shells: number; /** shells turned inside out because their volume was negative */ inverted: number }

/**
 * Make every triangle of a welded mesh agree about which way is out. Triangles are linked across edges shared by exactly two
 * of them; each connected shell is wound consistently, then flipped as a whole when it encloses a negative volume. A shell
 * that sits inside another one (a cavity) keeps its inward winding. Non-manifold edges (three or more triangles) do not link.
 * Meshes of more than 1.5 million triangles only get the volume test on the whole mesh.
 */
export function orientTopo(topo: TopoMesh): { mesh: TopoMesh; report: OrientReport } {
  const p = topo.positions
  const idx = Uint32Array.from(topo.indices)
  const T = idx.length / 3
  if (!T) return { mesh: topo, report: { flipped: 0, shells: 0, inverted: 0 } }
  if (T > 1_500_000) {
    let v = 0
    for (let t = 0; t < T; t++) v += triVol(p, idx, t, [0, 0, 0])
    if (v < 0) { for (let t = 0; t < T; t++) { const x = idx[t * 3 + 1]; idx[t * 3 + 1] = idx[t * 3 + 2]; idx[t * 3 + 2] = x } return { mesh: { positions: p, indices: idx }, report: { flipped: T, shells: 1, inverted: 1 } } }
    return { mesh: { positions: p, indices: idx }, report: { flipped: 0, shells: 1, inverted: 0 } }
  }
  // edge table: each undirected edge keeps its first two slots (t * 3 + k)
  const cap = nextPow2(T * 3 * 2)
  const mask = cap - 1
  const ta = new Int32Array(cap).fill(-1), tb = new Int32Array(cap), first = new Int32Array(cap), second = new Int32Array(cap).fill(-1), cnt = new Uint8Array(cap)
  for (let s = 0; s < T * 3; s++) {
    const t = (s / 3) | 0, k = s - t * 3
    const a = idx[s], b = idx[t * 3 + ((k + 1) % 3)]
    const lo = a < b ? a : b, hi = a < b ? b : a
    let h = Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi + 0x7f4a7c15, 0x85ebca6b)
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15
    h &= mask
    for (;;) {
      if (ta[h] === -1) { ta[h] = lo; tb[h] = hi; first[h] = s; cnt[h] = 1; break }
      if (ta[h] === lo && tb[h] === hi) { if (cnt[h] === 1) second[h] = s; if (cnt[h] < 255) cnt[h]++; break }
      h = (h + 1) & mask
    }
  }
  const partner = new Int32Array(T * 3).fill(-1)
  const par = new Uint8Array(T * 3)
  const startOf = (s: number) => idx[s]
  for (let h = 0; h < cap; h++) {
    if (cnt[h] !== 2) continue
    const s1 = first[h], s2 = second[h]
    const p1 = startOf(s1) === startOf(s2) ? 1 : 0 // same direction: one of them must flip
    partner[s1] = (s2 / 3) | 0; partner[s2] = (s1 / 3) | 0
    par[s1] = p1; par[s2] = p1
  }
  const comp = new Int32Array(T).fill(-1)
  const flip = new Uint8Array(T)
  const stack = new Int32Array(T)
  let C = 0
  for (let seed = 0; seed < T; seed++) {
    if (comp[seed] >= 0) continue
    comp[seed] = C
    let sp = 0
    stack[sp++] = seed
    while (sp) {
      const t = stack[--sp]
      for (let k = 0; k < 3; k++) {
        const s = t * 3 + k
        const u = partner[s]
        if (u < 0 || comp[u] >= 0) continue
        comp[u] = C
        flip[u] = flip[t] ^ par[s]
        stack[sp++] = u
      }
    }
    C++
  }
  // per shell: bounding box and signed volume with the flips applied (about the box centre)
  const mn = new Float64Array(C * 3).fill(Infinity), mx = new Float64Array(C * 3).fill(-Infinity), count = new Int32Array(C)
  for (let t = 0; t < T; t++) {
    const c = comp[t]
    count[c]++
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3
      for (let d = 0; d < 3; d++) { const x = p[v + d]; if (x < mn[c * 3 + d]) mn[c * 3 + d] = x; if (x > mx[c * 3 + d]) mx[c * 3 + d] = x }
    }
  }
  const vol = new Float64Array(C)
  for (let t = 0; t < T; t++) {
    const c = comp[t]
    const o: [number, number, number] = [(mn[c * 3] + mx[c * 3]) / 2, (mn[c * 3 + 1] + mx[c * 3 + 1]) / 2, (mn[c * 3 + 2] + mx[c * 3 + 2]) / 2]
    vol[c] += flip[t] ? -triVol(p, idx, t, o) : triVol(p, idx, t, o)
  }
  const diag = (c: number) => Math.hypot(mx[c * 3] - mn[c * 3], mx[c * 3 + 1] - mn[c * 3 + 1], mx[c * 3 + 2] - mn[c * 3 + 2])
  const positives: number[] = []
  for (let c = 0; c < C; c++) if (vol[c] > 1e-9 * diag(c) ** 3) positives.push(c)
  positives.sort((a, b) => vol[b] - vol[a])
  const pool = positives.slice(0, 300)
  const eps = 1e-6
  const inside = (c: number) => pool.some((q) => q !== c && [0, 1, 2].every((d) => mn[c * 3 + d] >= mn[q * 3 + d] - eps && mx[c * 3 + d] <= mx[q * 3 + d] + eps))
  const toggle = new Uint8Array(C)
  let inverted = 0
  for (let c = 0; c < C; c++) {
    if (vol[c] < -1e-9 * diag(c) ** 3 && !inside(c)) { toggle[c] = 1; inverted++ }
  }
  let flipped = 0
  for (let t = 0; t < T; t++) {
    if (flip[t] ^ toggle[comp[t]]) {
      const x = idx[t * 3 + 1]; idx[t * 3 + 1] = idx[t * 3 + 2]; idx[t * 3 + 2] = x
      flipped++
    }
  }
  return { mesh: { positions: p, indices: idx }, report: { flipped, shells: C, inverted } }
}

/** Flip every triangle. */
export function reverseTopo(topo: TopoMesh): TopoMesh {
  const idx = Uint32Array.from(topo.indices)
  for (let t = 0; t < idx.length; t += 3) { const x = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = x }
  return { positions: topo.positions, indices: idx }
}

// ---------------------------------------------------------------- holes

/** Closed loops of boundary half-edges of a consistently wound mesh, each in the order a filling triangle fan would use. */
export function boundaryLoops(idx: ArrayLike<number>): number[][] {
  const directed = new Map<string, true>()
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) directed.set(idx[t + k] + '>' + idx[t + ((k + 1) % 3)], true)
  // an edge with no opposite is a boundary edge a->b; the hole is walked b->a
  const next = new Map<number, number[]>()
  for (const key of directed.keys()) {
    const [a, b] = key.split('>').map(Number)
    if (!directed.has(b + '>' + a)) (next.get(b) ?? next.set(b, []).get(b)!).push(a)
  }
  const used = new Set<string>()
  const loops: number[][] = []
  for (const [start] of next) {
    let cur = start
    const loop: number[] = [cur]
    let closed = false
    for (let guard = 0; guard < 4e6; guard++) {
      const outs = next.get(cur)?.filter((n) => !used.has(cur + '>' + n))
      if (!outs?.length) break
      const n = outs[0]
      used.add(cur + '>' + n)
      if (n === start) { closed = true; break }
      loop.push(n)
      cur = n
    }
    if (closed && loop.length >= 3) loops.push(loop)
  }
  return loops
}

/** Triangulate one loop of vertices by ear clipping in the plane of its Newell normal; null when it fails (the caller falls back to a fan). */
function earClip(loop: number[], pos: ArrayLike<number>): number[] | null {
  const n = loop.length
  if (n === 3) return [loop[0], loop[1], loop[2]]
  if (n > 3000) return null
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < n; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % n] * 3
    nx += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2])
    ny += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b])
    nz += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1])
  }
  const nl = Math.hypot(nx, ny, nz)
  if (nl < 1e-18) return null
  nx /= nl; ny /= nl; nz /= nl
  // 2D basis in the plane: u = n x h, v = n x u
  const hx = Math.abs(nx) < 0.9 ? 1 : 0, hy = hx ? 0 : 1
  let ux = ny * 0 - nz * hy, uy = nz * hx - nx * 0, uz = nx * hy - ny * hx
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul; uy /= ul; uz /= ul
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux
  const X = new Float64Array(n), Y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = loop[i] * 3
    X[i] = pos[a] * ux + pos[a + 1] * uy + pos[a + 2] * uz
    Y[i] = pos[a] * vx + pos[a + 1] * vy + pos[a + 2] * vz
  }
  const ring = Array.from({ length: n }, (_, i) => i)
  const cross = (i: number, j: number, k: number) => (X[j] - X[i]) * (Y[k] - Y[i]) - (Y[j] - Y[i]) * (X[k] - X[i])
  const out: number[] = []
  let guard = n * n + 10
  let at = 0
  while (ring.length > 3 && guard-- > 0) {
    const m = ring.length
    const i = ring[(at + m - 1) % m], j = ring[at % m], k = ring[(at + 1) % m]
    let ear = cross(i, j, k) > 1e-14
    if (ear) {
      for (const q of ring) {
        if (q === i || q === j || q === k) continue
        const d1 = cross(i, j, q), d2 = cross(j, k, q), d3 = cross(k, i, q)
        if (d1 >= -1e-14 && d2 >= -1e-14 && d3 >= -1e-14) { ear = false; break }
      }
    }
    if (ear) {
      out.push(loop[i], loop[j], loop[k])
      ring.splice(at % m, 1)
      at = at % ring.length
    } else at = (at + 1) % m
  }
  if (ring.length === 3) { out.push(loop[ring[0]], loop[ring[1]], loop[ring[2]]); return out }
  return null
}

/** Close every boundary loop of a consistently wound mesh. Ear clipping where the loop is flat enough to project, a centroid fan otherwise. */
export function fillHolesTopo(topo: TopoMesh): { mesh: TopoMesh; filled: number } {
  const loops = boundaryLoops(topo.indices)
  if (!loops.length) return { mesh: topo, filled: 0 }
  const pos = Array.from(topo.positions)
  const tri = Array.from(topo.indices)
  for (const loop of loops) {
    const ear = earClip(loop, pos)
    if (ear) { tri.push(...ear); continue }
    let cx = 0, cy = 0, cz = 0
    for (const v of loop) { cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2] }
    const c = pos.length / 3
    pos.push(cx / loop.length, cy / loop.length, cz / loop.length)
    for (let i = 0; i < loop.length; i++) tri.push(c, loop[i], loop[(i + 1) % loop.length])
  }
  return { mesh: { positions: Float32Array.from(pos), indices: Uint32Array.from(tri) }, filled: loops.length }
}

/** Drop the triangles whose vertices coincide or whose area is zero, and exact duplicates (same three vertices). */
export function cleanTriangles(topo: TopoMesh): { mesh: TopoMesh; degenerate: number; duplicates: number } {
  const p = topo.positions, ix = topo.indices
  const seen = new Set<string>()
  const out: number[] = []
  let degenerate = 0, duplicates = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2]
    if (a === b || b === c || a === c) { degenerate++; continue }
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-14) { degenerate++; continue }
    const k = [a, b, c].sort((x, y) => x - y).join(',')
    if (seen.has(k)) { duplicates++; continue }
    seen.add(k)
    out.push(a, b, c)
  }
  return { mesh: { positions: p, indices: Uint32Array.from(out) }, degenerate, duplicates }
}

/** Remove loose shells (triangles joined by shared vertices) whose bounding box diagonal is under `pct` percent of the biggest shell's. */
export function removeSmallShells(topo: TopoMesh, pct: number): { mesh: TopoMesh; removed: number } {
  const p = topo.positions, ix = topo.indices
  const nv = p.length / 3, T = ix.length / 3
  const parent = new Int32Array(nv).map((_, i) => i)
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  for (let t = 0; t < T; t++) {
    const a = find(ix[t * 3]), b = find(ix[t * 3 + 1]), c = find(ix[t * 3 + 2])
    if (a !== b) parent[b] = a
    const r = find(a)
    if (r !== c) parent[c] = r
  }
  const mn = new Map<number, number[]>(), mx = new Map<number, number[]>()
  for (let t = 0; t < T; t++) {
    const r = find(ix[t * 3])
    let lo = mn.get(r), hi = mx.get(r)
    if (!lo) { lo = [Infinity, Infinity, Infinity]; hi = [-Infinity, -Infinity, -Infinity]; mn.set(r, lo); mx.set(r, hi) }
    for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) { const x = p[ix[t * 3 + k] * 3 + d]; if (x < lo[d]) lo[d] = x; if (x > hi![d]) hi![d] = x }
  }
  const diag = new Map<number, number>()
  let big = 0
  for (const [r, lo] of mn) { const hi = mx.get(r)!; const d = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]); diag.set(r, d); if (d > big) big = d }
  const keep: number[] = []
  const gone = new Set<number>()
  for (let t = 0; t < T; t++) {
    const r = find(ix[t * 3])
    if (diag.get(r)! < (pct / 100) * big) { gone.add(r); continue }
    keep.push(ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2])
  }
  if (!gone.size) return { mesh: topo, removed: 0 }
  return { mesh: weld(p, Uint32Array.from(keep), 1e-9), removed: gone.size }
}

// ---------------------------------------------------------------- smoothing

export interface SmoothOptions {
  /** keep vertices on open edges (and on the border of a face selection) where they are */
  preserveBoundary?: boolean
  /** keep vertices on creases sharper than `sharpDeg` where they are */
  preserveSharp?: boolean
  sharpDeg?: number
  /** triangles that may be smoothed (all when absent) */
  triMask?: Uint8Array
}

/**
 * Taubin (lambda | mu) smoothing: a pass towards the neighbours' average, then one back out, so surfaces relax without shrinking.
 * Sharp creases and open boundaries can be pinned, and a closed mesh is scaled about its centre to give back what is left of its
 * volume, so a part keeps its size. `strength` is 0..1.
 */
export function smoothTopoKeep(topo: TopoMesh, iterations: number, strength: number, o: SmoothOptions = {}): TopoMesh {
  const p0 = topo.positions, idx = topo.indices
  const nv = p0.length / 3, T = idx.length / 3
  const rings: Set<number>[] = Array.from({ length: nv }, () => new Set<number>())
  const edge = new Map<number, number[]>()
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = idx[t * 3 + k], b = idx[t * 3 + ((k + 1) % 3)]
    rings[a].add(b); rings[b].add(a)
    const key = a < b ? a * nv + b : b * nv + a
    const l = edge.get(key)
    if (l) l.push(t); else edge.set(key, [t])
  }
  const pin = new Uint8Array(nv)
  const cosS = Math.cos(((o.sharpDeg ?? 35) * Math.PI) / 180)
  const nrm = (t: number) => {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3
    const ux = p0[b] - p0[a], uy = p0[b + 1] - p0[a + 1], uz = p0[b + 2] - p0[a + 2]
    const vx = p0[c] - p0[a], vy = p0[c + 1] - p0[a + 1], vz = p0[c + 2] - p0[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z) || 1
    return [x / l, y / l, z / l]
  }
  let closed = true
  for (const [key, ts] of edge) {
    const a = Math.floor(key / nv), b = key % nv
    if (ts.length !== 2) { closed = false; if (o.preserveBoundary !== false) { pin[a] = 1; pin[b] = 1 }; continue }
    if (o.preserveSharp) {
      const n0 = nrm(ts[0]), n1 = nrm(ts[1])
      if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < cosS) { pin[a] = 1; pin[b] = 1 }
    }
    if (o.triMask && o.triMask[ts[0]] !== o.triMask[ts[1]] && o.preserveBoundary !== false) { pin[a] = 1; pin[b] = 1 }
  }
  if (o.triMask) {
    const free = new Uint8Array(nv)
    for (let t = 0; t < T; t++) if (o.triMask[t]) for (let k = 0; k < 3; k++) free[idx[t * 3 + k]] = 1
    for (let v = 0; v < nv; v++) if (!free[v]) pin[v] = 1
    closed = false
  }
  const lambda = Math.min(1, Math.max(0, strength)) * 0.6
  const mu = -lambda * 1.03
  let cur = Float32Array.from(p0)
  const pass = (src: Float32Array, k: number) => {
    const out = Float32Array.from(src)
    for (let v = 0; v < nv; v++) {
      const r = rings[v]
      if (pin[v] || !r.size) continue
      let x = 0, y = 0, z = 0
      for (const n of r) { x += src[n * 3]; y += src[n * 3 + 1]; z += src[n * 3 + 2] }
      out[v * 3] = src[v * 3] + k * (x / r.size - src[v * 3])
      out[v * 3 + 1] = src[v * 3 + 1] + k * (y / r.size - src[v * 3 + 1])
      out[v * 3 + 2] = src[v * 3 + 2] + k * (z / r.size - src[v * 3 + 2])
    }
    return out
  }
  for (let i = 0; i < iterations; i++) cur = pass(pass(cur, lambda), mu)
  if (closed && !pin.some((x) => x)) {
    // nothing is pinned: give back the volume the passes took (or added), about the centre of the part
    const v0 = signedVol(p0, idx), v1 = signedVol(cur, idx)
    if (v0 > 0 && v1 > 0 && Math.abs(v1 - v0) / v0 > 1e-3) {
      const s = Math.cbrt(v0 / v1)
      let cx = 0, cy = 0, cz = 0
      for (let v = 0; v < nv; v++) { cx += cur[v * 3]; cy += cur[v * 3 + 1]; cz += cur[v * 3 + 2] }
      cx /= nv; cy /= nv; cz /= nv
      for (let v = 0; v < nv; v++) { cur[v * 3] = cx + (cur[v * 3] - cx) * s; cur[v * 3 + 1] = cy + (cur[v * 3 + 1] - cy) * s; cur[v * 3 + 2] = cz + (cur[v * 3 + 2] - cz) * s }
    }
  }
  return { positions: cur, indices: idx.slice() }
}

function signedVol(p: ArrayLike<number>, ix: ArrayLike<number>): number {
  let v = 0
  for (let t = 0; t < ix.length / 3; t++) v += triVol(p, ix, t, [0, 0, 0])
  return v
}

// ---------------------------------------------------------------- plane clip (open meshes)

/** Cut a triangle mesh at the plane n . p = d and keep the side `side` (+1: n . p >= d). The mesh does not have to be closed; the cut is left open. */
export function clipByPlane(topo: TopoMesh, n: [number, number, number], d: number, side: 1 | -1): TopoMesh {
  const p = topo.positions, ix = topo.indices
  const pos: number[] = Array.from(p)
  const cache = new Map<string, number>()
  const dist = (v: number) => side * (n[0] * p[v * 3] + n[1] * p[v * 3 + 1] + n[2] * p[v * 3 + 2] - d)
  const cut = (a: number, b: number) => {
    const key = a < b ? a + '_' + b : b + '_' + a
    let id = cache.get(key)
    if (id === undefined) {
      const lo = a < b ? a : b, hi = a < b ? b : a
      const da = dist(lo), db = dist(hi)
      const t = da / (da - db)
      id = pos.length / 3
      pos.push(p[lo * 3] + (p[hi * 3] - p[lo * 3]) * t, p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * t, p[lo * 3 + 2] + (p[hi * 3 + 2] - p[lo * 3 + 2]) * t)
      cache.set(key, id)
    }
    return id
  }
  const out: number[] = []
  for (let t = 0; t < ix.length; t += 3) {
    const v = [ix[t], ix[t + 1], ix[t + 2]]
    const dd = v.map(dist)
    const inn = dd.map((x) => x >= 0)
    const c = inn.filter(Boolean).length
    if (c === 3) out.push(...v)
    else if (c === 0) continue
    else if (c === 1) {
      const i = inn.indexOf(true)
      const a = v[i], b = v[(i + 1) % 3], cc = v[(i + 2) % 3]
      out.push(a, cut(a, b), cut(a, cc))
    } else {
      const i = inn.indexOf(false)
      const a = v[i], b = v[(i + 1) % 3], cc = v[(i + 2) % 3]
      const m1 = cut(a, b), m2 = cut(a, cc)
      out.push(b, cc, m2, b, m2, m1)
    }
  }
  return weld(Float32Array.from(pos), Uint32Array.from(out), 1e-9)
}

// ---------------------------------------------------------------- delete faces

/** Remove the face groups `faces` (as numbered by `segmentFaces` with this crease angle), leaving an open mesh. */
export function deleteFaceGroups(topo: TopoMesh, crease: number, faces: number[]): { mesh: TopoMesh; removed: number } {
  const ix = topo.indices
  const T = ix.length / 3
  const set = new Set(faces)
  const faceIds = T > 400_000 ? new Uint32Array(T) : segmentFaces(topo, crease).faceIds
  const keep: number[] = []
  let removed = 0
  for (let t = 0; t < T; t++) { if (set.has(faceIds[t])) removed++; else keep.push(ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]) }
  return { mesh: weld(topo.positions, Uint32Array.from(keep), 1e-9), removed }
}

// ---------------------------------------------------------------- shell (offset)

/**
 * Hollow a closed mesh: an inner surface is the outer one pushed in by `thickness` (a true offset: each vertex moves to where the
 * offset planes of the faces around it meet, so a flat wall is `thickness` thick everywhere and corners stay sharp), with the
 * wall closed at the openings. `outward` grows the wall out instead. Faces to open (triangle ids) are removed from both surfaces
 * and joined by a rim in the plane of the opened face.
 */
export function shellTopo(topo: TopoMesh, thickness: number, opened: Uint8Array | null, outward: boolean, crease: number): TopoMesh {
  const p = topo.positions, ix = topo.indices
  const nv = p.length / 3, T = ix.length / 3
  const t = outward ? -thickness : thickness
  const tn = (i: number) => {
    const a = ix[i * 3] * 3, b = ix[i * 3 + 1] * 3, c = ix[i * 3 + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z)
    return l < 1e-20 ? null : ([x / l, y / l, z / l, l / 2] as const)
  }
  // per vertex: clusters of the unit normals of its (kept) triangles within the crease angle, area weighted
  const cosC = Math.cos((Math.max(crease, 5) * Math.PI) / 180)
  const per: { n: [number, number, number]; w: number }[][] = Array.from({ length: nv }, () => [])
  const rim: [number, number, number][][] = Array.from({ length: nv }, () => [])
  for (let i = 0; i < T; i++) {
    const n = tn(i)
    if (!n) continue
    for (let k = 0; k < 3; k++) {
      const v = ix[i * 3 + k]
      if (opened && opened[i]) { rim[v].push([n[0], n[1], n[2]]); continue }
      const cl = per[v].find((c) => (c.n[0] * n[0] + c.n[1] * n[1] + c.n[2] * n[2]) / (Math.hypot(c.n[0], c.n[1], c.n[2]) || 1) >= cosC)
      if (cl) { cl.n[0] += n[0] * n[3]; cl.n[1] += n[1] * n[3]; cl.n[2] += n[2] * n[3]; cl.w += n[3] }
      else per[v].push({ n: [n[0] * n[3], n[1] * n[3], n[2] * n[3]], w: n[3] })
    }
  }
  const off = new Float32Array(nv * 3)
  const limit = Math.max(Math.abs(t) * 4, 1e-6)
  for (let v = 0; v < nv; v++) {
    // minimise |N d + t 1|^2 + eps |d|^2 over d: N has one row per cluster normal (and a zero row for the plane of an opened face)
    const rows: [number, number, number, number][] = []
    for (const c of per[v]) { const l = Math.hypot(...c.n) || 1; rows.push([c.n[0] / l, c.n[1] / l, c.n[2] / l, -t]) }
    if (per[v].length && rim[v].length) {
      let rx = 0, ry = 0, rz = 0
      for (const r of rim[v]) { rx += r[0]; ry += r[1]; rz += r[2] }
      const l = Math.hypot(rx, ry, rz)
      if (l > 1e-9) rows.push([rx / l, ry / l, rz / l, 0])
    }
    if (!rows.length) continue
    const A = [[1e-6, 0, 0], [0, 1e-6, 0], [0, 0, 1e-6]]
    const b = [0, 0, 0]
    for (const r of rows) for (let i = 0; i < 3; i++) { b[i] += r[i] * r[3]; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j] }
    const d = solve3(A, b)
    const l = Math.hypot(d[0], d[1], d[2])
    const s = l > limit ? limit / l : 1
    off[v * 3] = d[0] * s; off[v * 3 + 1] = d[1] * s; off[v * 3 + 2] = d[2] * s
  }
  // inward means against the outward normal: the cluster rows ask for n . d = -t, which for t > 0 is "t below the surface"
  const pos: number[] = Array.from(p)
  // inward: the original is the outer skin and the offset copy the cavity; outward: the offset copy is the outer skin and the original the cavity
  const outerBase = outward ? nv : 0, innerBase = outward ? 0 : nv
  for (let v = 0; v < nv; v++) pos.push(p[v * 3] + off[v * 3], p[v * 3 + 1] + off[v * 3 + 1], p[v * 3 + 2] + off[v * 3 + 2])
  const out: number[] = []
  const boundary = new Map<string, [number, number]>() // directed outer boundary edges of the opened region
  const dir = new Set<string>()
  for (let i = 0; i < T; i++) if (!(opened && opened[i])) for (let k = 0; k < 3; k++) dir.add(ix[i * 3 + k] + '>' + ix[i * 3 + ((k + 1) % 3)])
  for (let i = 0; i < T; i++) {
    if (opened && opened[i]) continue
    const a = ix[i * 3], b = ix[i * 3 + 1], c = ix[i * 3 + 2]
    out.push(outerBase + a, outerBase + b, outerBase + c) // outer surface keeps its winding
    out.push(innerBase + a, innerBase + c, innerBase + b) // inner surface faces the other way
    for (let k = 0; k < 3; k++) {
      const x = ix[i * 3 + k], y = ix[i * 3 + ((k + 1) % 3)]
      if (!dir.has(y + '>' + x)) boundary.set(x + '>' + y, [x, y])
    }
  }
  // rim: a quad strip between each outer boundary edge and its inner copy
  for (const [x, y] of boundary.values()) {
    out.push(outerBase + x, innerBase + y, outerBase + y, outerBase + x, innerBase + x, innerBase + y)
  }
  return weld(Float32Array.from(pos), Uint32Array.from(out), 1e-9)
}

function solve3(A: number[][], b: number[]): number[] {
  const m = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r
    ;[m[c], m[piv]] = [m[piv], m[c]]
    const d = m[c][c] || 1e-12
    for (let j = c; j < 4; j++) m[c][j] /= d
    for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c]; for (let j = c; j < 4; j++) m[r][j] -= f * m[c][j] }
  }
  return [m[0][3], m[1][3], m[2][3]]
}
