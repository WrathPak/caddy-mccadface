/**
 * Adaptive subdivision of part of a closed triangle mesh: triangles of the region are split (longest edge first, with the
 * neighbour split along the same edge so the mesh stays watertight) until no region edge is longer than the target. The rest
 * of the mesh is only touched where a split reaches across the region boundary.
 */
import type { TopoMesh } from '../types'

export interface Subdivided {
  mesh: TopoMesh
  /** 1 for triangles that belong to the region */
  region: Uint8Array
  /** vertices that sit on the boundary of the region */
  triangles: number
  /** true when the triangle budget forced a coarser edge length than asked for */
  limited: boolean
  edgeLength: number
}

const KEY = 67108864 // 2^26

export const edgeKey = (a: number, b: number) => (a < b ? a * KEY + b : b * KEY + a)

/** Triangle count after splitting every region triangle to edges of length `len` (rough estimate used to pick the detail). */
export function estimateTriangles(areaMm2: number, len: number): number {
  return (areaMm2 * 2.4) / (len * len)
}

/**
 * Split the triangles flagged in `inRegion` until their edges are at most `len` long. Stops growing at `maxTris` (the
 * returned `limited` flag tells the caller the target was not reached everywhere).
 */
export function subdivideRegion(mesh: TopoMesh, inRegion: Uint8Array, len: number, maxTris: number): Subdivided {
  const pos: number[] = Array.from(mesh.positions)
  const A: number[] = [], B: number[] = [], C: number[] = []
  const reg: number[] = []
  const T0 = mesh.indices.length / 3
  for (let t = 0; t < T0; t++) { A.push(mesh.indices[t * 3]); B.push(mesh.indices[t * 3 + 1]); C.push(mesh.indices[t * 3 + 2]); reg.push(inRegion[t]) }
  const dead: number[] = new Array(T0).fill(0)
  let alive = T0

  // edge -> up to two triangles
  const edges = new Map<number, [number, number]>()
  const addEdge = (a: number, b: number, t: number) => {
    const k = edgeKey(a, b)
    const e = edges.get(k)
    if (!e) edges.set(k, [t, -1])
    else if (e[0] < 0) e[0] = t
    else e[1] = t
  }
  const dropEdge = (a: number, b: number, t: number) => {
    const k = edgeKey(a, b)
    const e = edges.get(k)
    if (!e) return
    if (e[0] === t) { e[0] = e[1]; e[1] = -1 } else if (e[1] === t) e[1] = -1
    if (e[0] < 0) edges.delete(k)
  }
  const addTri = (t: number) => { addEdge(A[t], B[t], t); addEdge(B[t], C[t], t); addEdge(C[t], A[t], t) }
  const dropTri = (t: number) => { dropEdge(A[t], B[t], t); dropEdge(B[t], C[t], t); dropEdge(C[t], A[t], t) }
  for (let t = 0; t < T0; t++) addTri(t)

  const d2 = (a: number, b: number) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2
  /** index 0..2 of the longest edge (edge k runs from corner k to corner k+1) */
  const longest = (t: number): number => {
    const l0 = d2(A[t], B[t]), l1 = d2(B[t], C[t]), l2 = d2(C[t], A[t])
    // ties: break by the vertex ids so both triangles of a shared edge agree
    const k0 = edgeKey(A[t], B[t]), k1 = edgeKey(B[t], C[t]), k2 = edgeKey(C[t], A[t])
    let best = 0, bl = l0, bk = k0
    if (l1 > bl + 1e-12 || (Math.abs(l1 - bl) <= 1e-12 && k1 < bk)) { best = 1; bl = l1; bk = k1 }
    if (l2 > bl + 1e-12 || (Math.abs(l2 - bl) <= 1e-12 && k2 < bk)) best = 2
    return best
  }
  const corner = (t: number, k: number) => (k === 0 ? A[t] : k === 1 ? B[t] : C[t])
  const mids = new Map<number, number>()
  const midOf = (a: number, b: number): number => {
    const k = edgeKey(a, b)
    let m = mids.get(k)
    if (m === undefined) {
      m = pos.length / 3
      pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2)
      mids.set(k, m)
    }
    return m
  }
  const newTri = (a: number, b: number, c: number, r: number) => {
    const t = A.length
    A.push(a); B.push(b); C.push(c); reg.push(r); dead.push(0)
    addTri(t)
    alive++
    return t
  }
  /** Split triangle t across its edge `k` (corner k -> k+1) into two, and the neighbour across it as well. */
  const bisect = (t: number, k: number) => {
    const p = corner(t, k), q = corner(t, (k + 1) % 3), r = corner(t, (k + 2) % 3)
    const e = edges.get(edgeKey(p, q))!
    const nb = e[0] === t ? e[1] : e[0]
    const m = midOf(p, q)
    const rt = reg[t]
    dropTri(t); dead[t] = 1; alive--
    newTri(p, m, r, rt); newTri(m, q, r, rt)
    if (nb >= 0) {
      // the neighbour runs q -> p along this edge
      let nk = 0
      for (let c = 0; c < 3; c++) if (corner(nb, c) === q && corner(nb, (c + 1) % 3) === p) nk = c
      const s = corner(nb, (nk + 2) % 3)
      const rn = reg[nb]
      dropTri(nb); dead[nb] = 1; alive--
      newTri(q, m, s, rn); newTri(m, p, s, rn)
    }
  }
  const len2 = len * len
  let limited = false
  // entries are [triangle, forced]: a forced triangle outside the region (or short enough) is only split because a neighbour needs it
  const stack: [number, boolean][] = []
  for (let t = 0; t < T0; t++) if (inRegion[t]) stack.push([t, false])
  let guard = 0
  const guardMax = maxTris * 40 + 100000
  while (stack.length) {
    if (++guard > guardMax) { limited = true; break }
    const [t, forced] = stack[stack.length - 1]
    if (dead[t] || (!forced && !reg[t])) { stack.pop(); continue }
    const k = longest(t)
    const a = corner(t, k), b = corner(t, (k + 1) % 3)
    if (!forced && d2(a, b) <= len2) { stack.pop(); continue }
    if (alive + 4 > maxTris) { limited = true; break }
    // the neighbour across the longest edge must have the same edge as its longest, or it is refined first
    const e = edges.get(edgeKey(a, b))!
    const nb = e[0] === t ? e[1] : e[0]
    if (nb >= 0 && !dead[nb]) {
      const nk = longest(nb)
      const na = corner(nb, nk), nbb = corner(nb, (nk + 1) % 3)
      if (edgeKey(na, nbb) !== edgeKey(a, b)) { stack.push([nb, true]); continue }
    }
    stack.pop()
    const before = A.length
    bisect(t, k)
    // children (and the neighbour's) may still be too long
    for (let c = A.length - 1; c >= before; c--) if (reg[c]) stack.push([c, false])
  }

  // compact
  const keep: number[] = []
  for (let t = 0; t < A.length; t++) if (!dead[t]) keep.push(t)
  const indices = new Uint32Array(keep.length * 3)
  const region = new Uint8Array(keep.length)
  keep.forEach((t, i) => { indices[i * 3] = A[t]; indices[i * 3 + 1] = B[t]; indices[i * 3 + 2] = C[t]; region[i] = reg[t] })
  return { mesh: { positions: Float32Array.from(pos), indices }, region, triangles: keep.length, limited, edgeLength: len }
}
