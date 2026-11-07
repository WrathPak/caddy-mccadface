/**
 * Mesh editing algorithms for the Mesh workspace: edge-collapse reduction (quadric error), isotropic and adaptive remeshing,
 * plane clipping with a choice of cap, mesh statistics, section outlines, face grouping and region edits. Pure functions on
 * typed arrays, so they run in the kernel worker and in Node tests.
 */
import { weld } from './bigmesh'
import { segmentFaces } from './meshutil'
import type { TopoMesh } from './types'

type V3 = [number, number, number]
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])

// ============================================================================================ editable mesh

/** A triangle mesh that can be edited in place: split, collapse and flip edges, with vertex -> triangle lookup. */
export class EditMesh {
  pos: number[]
  tri: number[]
  vt: Set<number>[]
  alive: boolean[] = []
  constructor(topo: TopoMesh) {
    this.pos = Array.from(topo.positions)
    this.tri = Array.from(topo.indices)
    const nv = this.pos.length / 3
    this.vt = Array.from({ length: nv }, () => new Set<number>())
    for (let t = 0; t < this.tri.length / 3; t++) {
      this.alive.push(true)
      for (let k = 0; k < 3; k++) this.vt[this.tri[t * 3 + k]].add(t)
    }
  }
  get nv() { return this.pos.length / 3 }
  p(v: number): V3 { return [this.pos[v * 3], this.pos[v * 3 + 1], this.pos[v * 3 + 2]] }
  addVertex(x: number, y: number, z: number): number {
    this.pos.push(x, y, z)
    this.vt.push(new Set())
    return this.vt.length - 1
  }
  addTri(a: number, b: number, c: number): number {
    const t = this.alive.length
    this.alive.push(true)
    this.tri.push(a, b, c)
    this.vt[a].add(t); this.vt[b].add(t); this.vt[c].add(t)
    return t
  }
  kill(t: number) {
    if (!this.alive[t]) return
    this.alive[t] = false
    for (let k = 0; k < 3; k++) this.vt[this.tri[t * 3 + k]].delete(t)
  }
  setTri(t: number, a: number, b: number, c: number) {
    for (let k = 0; k < 3; k++) this.vt[this.tri[t * 3 + k]].delete(t)
    this.tri[t * 3] = a; this.tri[t * 3 + 1] = b; this.tri[t * 3 + 2] = c
    this.vt[a].add(t); this.vt[b].add(t); this.vt[c].add(t)
  }
  /** triangles that contain both vertices */
  edgeTris(a: number, b: number): number[] {
    const out: number[] = []
    const [s, o] = this.vt[a].size < this.vt[b].size ? [this.vt[a], this.vt[b]] : [this.vt[b], this.vt[a]]
    for (const t of s) if (o.has(t)) out.push(t)
    return out
  }
  /** the vertex of triangle t that is neither a nor b */
  third(t: number, a: number, b: number): number {
    for (let k = 0; k < 3; k++) { const v = this.tri[t * 3 + k]; if (v !== a && v !== b) return v }
    return -1
  }
  /** true when triangle t runs a -> b */
  runs(t: number, a: number, b: number): boolean {
    for (let k = 0; k < 3; k++) if (this.tri[t * 3 + k] === a && this.tri[t * 3 + ((k + 1) % 3)] === b) return true
    return false
  }
  triNormal(t: number, area = false): V3 {
    const a = this.p(this.tri[t * 3]), b = this.p(this.tri[t * 3 + 1]), c = this.p(this.tri[t * 3 + 2])
    const n = cross(sub(b, a), sub(c, a))
    if (area) return n
    const l = len(n) || 1
    return [n[0] / l, n[1] / l, n[2] / l]
  }
  neighbours(v: number): Set<number> {
    const r = new Set<number>()
    for (const t of this.vt[v]) for (let k = 0; k < 3; k++) { const w = this.tri[t * 3 + k]; if (w !== v) r.add(w) }
    return r
  }
  isBoundaryVertex(v: number): boolean {
    for (const t of this.vt[v]) for (let k = 0; k < 3; k++) {
      const w = this.tri[t * 3 + k]
      if (w !== v && this.edgeTris(v, w).length !== 2) return true
    }
    return false
  }
  /** Split the edge a-b at point m (a new vertex); both triangles are split. Returns the new vertex. */
  split(a: number, b: number, mx: number, my: number, mz: number): number {
    const ts = this.edgeTris(a, b)
    const m = this.addVertex(mx, my, mz)
    for (const t of ts) {
      const c = this.third(t, a, b)
      if (this.runs(t, a, b)) { this.kill(t); this.addTri(a, m, c); this.addTri(m, b, c) }
      else { this.kill(t); this.addTri(b, m, c); this.addTri(m, a, c) }
    }
    return m
  }
  /** Flip the shared edge of two triangles; false when it cannot be flipped. */
  flip(a: number, b: number): boolean {
    const ts = this.edgeTris(a, b)
    if (ts.length !== 2) return false
    let [t1, t2] = ts
    if (!this.runs(t1, a, b)) [t1, t2] = [t2, t1]
    const c = this.third(t1, a, b), d = this.third(t2, a, b)
    if (c === d || this.edgeTris(c, d).length) return false
    this.kill(t1); this.kill(t2)
    this.addTri(a, d, c); this.addTri(b, c, d)
    return true
  }
  /** Compact to a TopoMesh (dead triangles and unused vertices dropped). */
  toTopo(): TopoMesh {
    const map = new Int32Array(this.nv).fill(-1)
    const pos: number[] = []
    const idx: number[] = []
    for (let t = 0; t < this.alive.length; t++) {
      if (!this.alive[t]) continue
      for (let k = 0; k < 3; k++) {
        const v = this.tri[t * 3 + k]
        if (map[v] < 0) { map[v] = pos.length / 3; pos.push(this.pos[v * 3], this.pos[v * 3 + 1], this.pos[v * 3 + 2]) }
        idx.push(map[v])
      }
    }
    return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
  }
  get triCount() { let n = 0; for (const a of this.alive) if (a) n++; return n }
}

// ============================================================================================ reduce (quadric error collapse)

export interface ReduceOptions {
  /** 'tolerance': collapse until the geometric error would pass `tolerance` (mm); 'count': down to `target` triangles; proportion is count = tris * p */
  mode: 'tolerance' | 'count'
  tolerance?: number
  target?: number
  preserveBoundaries: boolean
  preserveSharp: boolean
  sharpDeg?: number
}

type Q = Float64Array // a2 ab ac ad b2 bc bd c2 cd d2
const planeQ = (n: V3, d: number): Q => Float64Array.of(n[0] * n[0], n[0] * n[1], n[0] * n[2], n[0] * d, n[1] * n[1], n[1] * n[2], n[1] * d, n[2] * n[2], n[2] * d, d * d)
const qErr = (q: Q, x: number, y: number, z: number) =>
  q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9]

class Heap {
  a: { cost: number; u: number; v: number; su: number; sv: number }[] = []
  push(e: Heap['a'][number]) {
    const a = this.a
    a.push(e)
    let i = a.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].cost <= a[i].cost) break; [a[p], a[i]] = [a[i], a[p]]; i = p }
  }
  pop() {
    const a = this.a
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < a.length && a[l].cost < a[m].cost) m = l
        if (r < a.length && a[r].cost < a[m].cost) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]; i = m
      }
    }
    return top
  }
  get size() { return this.a.length }
}

/** Per vertex: how many sharp edges (dihedral angle above sharpDeg) end there. */
function sharpDegrees(m: EditMesh, sharpDeg: number): Map<number, number> {
  const cosS = Math.cos((sharpDeg * Math.PI) / 180)
  const deg = new Map<number, number>()
  for (let t = 0; t < m.alive.length; t++) {
    if (!m.alive[t]) continue
    for (let k = 0; k < 3; k++) {
      const a = m.tri[t * 3 + k], b = m.tri[t * 3 + ((k + 1) % 3)]
      if (a > b) continue
      const ts = m.edgeTris(a, b)
      if (ts.length !== 2) continue
      const n1 = m.triNormal(ts[0]), n2 = m.triNormal(ts[1])
      if (dot(n1, n2) < cosS) { deg.set(a, (deg.get(a) ?? 0) + 1); deg.set(b, (deg.get(b) ?? 0) + 1) }
    }
  }
  return deg
}

/** Edge-collapse simplification driven by a quadric error metric. */
export function reduceTopo(topo: TopoMesh, o: ReduceOptions): TopoMesh {
  const m = new EditMesh(topo)
  const nv0 = m.nv
  const Qs: Q[] = Array.from({ length: nv0 }, () => new Float64Array(10))
  const addQ = (q: Q, p: Q, w = 1) => { for (let i = 0; i < 10; i++) q[i] += p[i] * w }
  for (let t = 0; t < m.alive.length; t++) {
    const n = m.triNormal(t)
    if (!(len(n) > 0)) continue
    const p = m.p(m.tri[t * 3])
    const pq = planeQ(n, -dot(n, p))
    for (let k = 0; k < 3; k++) addQ(Qs[m.tri[t * 3 + k]], pq)
  }
  // open edges get a plane through them, perpendicular to their triangle, so a boundary does not erode
  for (let t = 0; t < m.alive.length; t++) {
    for (let k = 0; k < 3; k++) {
      const a = m.tri[t * 3 + k], b = m.tri[t * 3 + ((k + 1) % 3)]
      if (m.edgeTris(a, b).length !== 1) continue
      const e = sub(m.p(b), m.p(a))
      const n = cross(e, m.triNormal(t))
      const l = len(n)
      if (!(l > 0)) continue
      const nn: V3 = [n[0] / l, n[1] / l, n[2] / l]
      const pq = planeQ(nn, -dot(nn, m.p(a)))
      addQ(Qs[a], pq, 20); addQ(Qs[b], pq, 20)
    }
  }
  const sharp = o.preserveSharp ? sharpDegrees(m, o.sharpDeg ?? 30) : new Map<number, number>()
  const stamp = new Int32Array(nv0)
  const heap = new Heap()
  const gone = new Uint8Array(nv0)

  /** where the surviving vertex goes and what it costs; null when the collapse is not allowed */
  const plan = (a: number, b: number): { cost: number; at: V3 } | null => {
    const ts = m.edgeTris(a, b)
    if (!ts.length || ts.length > 2) return null
    if (o.preserveBoundaries && (m.isBoundaryVertex(a) || m.isBoundaryVertex(b))) return null
    // link condition: the two vertices share only the vertices opposite their edge
    const na = m.neighbours(a), nb = m.neighbours(b)
    let common = 0
    for (const v of na) if (nb.has(v)) common++
    if (common !== ts.length) return null
    const sa = sharp.get(a) ?? 0, sb = sharp.get(b) ?? 0
    let at: V3
    const Q = new Float64Array(10)
    addQ(Q, Qs[a]); addQ(Q, Qs[b])
    if (sa && sb) {
      // along a crease only, and never through a corner
      if (sa !== 2 || sb !== 2 || !sharpEdge(m, a, b)) return null
      at = m.p(b)
      const mid: V3 = [(m.p(a)[0] + m.p(b)[0]) / 2, (m.p(a)[1] + m.p(b)[1]) / 2, (m.p(a)[2] + m.p(b)[2]) / 2]
      if (qErr(Q, ...mid) <= qErr(Q, ...at)) at = mid
    } else if (sa) at = m.p(a)
    else if (sb) at = m.p(b)
    else {
      const A = m.p(a), B = m.p(b)
      const mid: V3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]
      at = A
      let best = qErr(Q, ...A)
      for (const c of [B, mid]) { const e = qErr(Q, ...c); if (e < best) { best = e; at = c } }
      // the optimum of the quadric, when the system is well conditioned
      const det = (m0: number[]) => m0[0] * (m0[4] * m0[8] - m0[5] * m0[7]) - m0[1] * (m0[3] * m0[8] - m0[5] * m0[6]) + m0[2] * (m0[3] * m0[7] - m0[4] * m0[6])
      const M = [Q[0], Q[1], Q[2], Q[1], Q[4], Q[5], Q[2], Q[5], Q[7]]
      const dd = det(M)
      if (Math.abs(dd) > 1e-9) {
        const rep = (col: number) => { const x = M.slice(); const r = [-Q[3], -Q[6], -Q[8]]; for (let i = 0; i < 3; i++) x[i * 3 + col] = r[i]; return det(x) / dd }
        const opt: V3 = [rep(0), rep(1), rep(2)]
        const e = qErr(Q, ...opt)
        const span = Math.hypot(...sub(A, B)) * 2
        if (e < best && Math.hypot(...sub(opt, mid)) < span) { best = e; at = opt }
      }
    }
    // no triangle may fold over or collapse
    for (const [v, keep] of [[a, b], [b, a]] as const) {
      for (const t of m.vt[v]) {
        if (ts.includes(t)) continue
        const n0 = m.triNormal(t, true)
        const k = [0, 1, 2].map((i) => m.tri[t * 3 + i])
        const q = k.map((w) => (w === v || w === keep ? at : m.p(w)))
        const n1 = cross(sub(q[1], q[0]), sub(q[2], q[0]))
        const l0 = len(n0), l1 = len(n1)
        if (l1 < 1e-12 * Math.max(1, l0) || dot(n0, n1) / (l0 * l1 || 1) < 0.3) return null
      }
    }
    return { cost: qErr(Q, ...at), at }
  }
  const sharpEdge = (mm: EditMesh, a: number, b: number) => {
    const ts = mm.edgeTris(a, b)
    if (ts.length !== 2) return true
    return dot(mm.triNormal(ts[0]), mm.triNormal(ts[1])) < Math.cos(((o.sharpDeg ?? 30) * Math.PI) / 180)
  }
  const consider = (a: number, b: number) => {
    const p = plan(a, b)
    if (p) heap.push({ cost: Math.max(0, p.cost), u: a, v: b, su: stamp[a], sv: stamp[b] })
  }
  const seen = new Set<number>()
  for (let t = 0; t < m.alive.length; t++) for (let k = 0; k < 3; k++) {
    const a = m.tri[t * 3 + k], b = m.tri[t * 3 + ((k + 1) % 3)]
    const key = a < b ? a * nv0 + b : b * nv0 + a
    if (!seen.has(key)) { seen.add(key); consider(a, b) }
  }
  let tris = m.triCount
  const goal = o.mode === 'count' ? Math.max(4, Math.round(o.target ?? 0)) : 4
  const tol2 = (o.tolerance ?? 0) ** 2
  while (heap.size && tris > goal) {
    const e = heap.pop()
    if (gone[e.u] || gone[e.v] || stamp[e.u] !== e.su || stamp[e.v] !== e.sv) continue
    const p = plan(e.u, e.v)
    if (!p) continue
    if (o.mode === 'tolerance' && p.cost > tol2) break
    if (p.cost > e.cost * 1.0001 + 1e-12) { heap.push({ ...e, cost: p.cost }); continue }
    const [a, b] = [e.u, e.v]
    const dead = m.edgeTris(a, b)
    // move b to the new place and join a's triangles to it
    for (const t of dead) m.kill(t)
    for (const t of [...m.vt[a]]) {
      const k = [m.tri[t * 3], m.tri[t * 3 + 1], m.tri[t * 3 + 2]].map((w) => (w === a ? b : w))
      m.setTri(t, k[0], k[1], k[2])
    }
    m.pos[b * 3] = p.at[0]; m.pos[b * 3 + 1] = p.at[1]; m.pos[b * 3 + 2] = p.at[2]
    addQ(Qs[b], Qs[a])
    if (sharp.has(a) && !sharp.has(b)) sharp.set(b, sharp.get(a)!)
    else if (sharp.has(a) && sharp.has(b)) sharp.set(b, Math.max(2, (sharp.get(a)! + sharp.get(b)! - 2)))
    gone[a] = 1
    stamp[b]++
    tris -= dead.length
    for (const w of m.neighbours(b)) { stamp[w]++; }
    for (const w of m.neighbours(b)) consider(b, w)
    for (const w of m.neighbours(b)) for (const x of m.neighbours(w)) if (x !== b && w < x) consider(w, x)
  }
  return m.toTopo()
}

// ============================================================================================ closest point (for remesh projection)

class SurfaceIndex {
  cell: number
  grid = new Map<string, number[]>()
  min: V3
  constructor(readonly topo: TopoMesh) {
    const p = topo.positions
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]) }
    this.min = lo
    const T = topo.indices.length / 3
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1
    this.cell = Math.max(diag / Math.max(4, Math.cbrt(T) * 2), 1e-6)
    for (let t = 0; t < T; t++) {
      const a = this.v(t, 0), b = this.v(t, 1), c = this.v(t, 2)
      const l = [0, 1, 2].map((k) => Math.floor((Math.min(a[k], b[k], c[k]) - lo[k]) / this.cell))
      const h = [0, 1, 2].map((k) => Math.floor((Math.max(a[k], b[k], c[k]) - lo[k]) / this.cell))
      for (let x = l[0]; x <= h[0]; x++) for (let y = l[1]; y <= h[1]; y++) for (let z = l[2]; z <= h[2]; z++) {
        const key = x + ',' + y + ',' + z
        const g = this.grid.get(key)
        if (g) g.push(t); else this.grid.set(key, [t])
      }
    }
  }
  v(t: number, k: number): V3 { const i = this.topo.indices[t * 3 + k] * 3; return [this.topo.positions[i], this.topo.positions[i + 1], this.topo.positions[i + 2]] }
  closest(p: V3, reach: number): V3 {
    const c = [0, 1, 2].map((k) => Math.floor((p[k] - this.min[k]) / this.cell))
    const n = Math.max(1, Math.ceil(reach / this.cell))
    let best: V3 = p, bd = Infinity
    const seen = new Set<number>()
    for (let x = c[0] - n; x <= c[0] + n; x++) for (let y = c[1] - n; y <= c[1] + n; y++) for (let z = c[2] - n; z <= c[2] + n; z++) {
      const g = this.grid.get(x + ',' + y + ',' + z)
      if (!g) continue
      for (const t of g) {
        if (seen.has(t)) continue
        seen.add(t)
        const q = closestOnTri(p, this.v(t, 0), this.v(t, 1), this.v(t, 2))
        const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2
        if (d < bd) { bd = d; best = q }
      }
    }
    return best
  }
}

function closestOnTri(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b)
  const d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v] }
  const cp = sub(p, c)
  const d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w] }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]
  }
  const den = 1 / (va + vb + vc)
  const v = vb * den, w = vc * den
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

// ============================================================================================ remesh

export interface RemeshOptions {
  type: 'uniform' | 'adaptive' | 'density'
  /** uniform / adaptive: the edge length (mm) */
  length: number
  /** density: multiplies the number of triangles (2 = twice as many) */
  density: number
  preserveSharp: boolean
  preserveBoundaries: boolean
  sharpDeg?: number
  iterations?: number
}

export function meanEdgeLength(t: TopoMesh): number {
  const p = t.positions, ix = t.indices
  let s = 0, n = 0
  for (let k = 0; k < ix.length; k += 3) for (let e = 0; e < 3; e++) {
    const a = ix[k + e] * 3, b = ix[k + ((e + 1) % 3)] * 3
    s += Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]); n++
  }
  return n ? s / n : 1
}

/** Isotropic remeshing: split long edges, collapse short ones, flip towards valence 6, relax tangentially and snap back to the original surface. */
export function remeshTopo(topo: TopoMesh, o: RemeshOptions): TopoMesh {
  const m = new EditMesh(topo)
  const base = o.type === 'density' ? meanEdgeLength(topo) / Math.sqrt(Math.max(0.05, o.density)) : o.length
  if (!(base > 0)) throw new Error('The edge length must be greater than zero')
  const surf = new SurfaceIndex(topo)
  const sharpKey = new Set<number>()
  const bKey = new Set<number>()
  const key = (a: number, b: number) => (a < b ? a * 1e7 + b : b * 1e7 + a)
  const cosS = Math.cos(((o.sharpDeg ?? 30) * Math.PI) / 180)
  for (let t = 0; t < m.alive.length; t++) for (let k = 0; k < 3; k++) {
    const a = m.tri[t * 3 + k], b = m.tri[t * 3 + ((k + 1) % 3)]
    if (a > b) continue
    const ts = m.edgeTris(a, b)
    if (ts.length === 1 || ts.length > 2) bKey.add(key(a, b))
    else if (dot(m.triNormal(ts[0]), m.triNormal(ts[1])) < cosS) sharpKey.add(key(a, b))
  }
  const isFixedEdge = (a: number, b: number) => (o.preserveSharp && sharpKey.has(key(a, b))) || bKey.has(key(a, b))
  const featureVerts = () => {
    const f = new Set<number>()
    for (const k of sharpKey) if (o.preserveSharp) { f.add(Math.floor(k / 1e7)); f.add(k % 1e7) }
    return f
  }
  const bVerts = () => { const f = new Set<number>(); for (const k of bKey) { f.add(Math.floor(k / 1e7)); f.add(k % 1e7) } return f }
  // size field: adaptive remeshing takes smaller edges where the surface bends
  const sizeAt = (v: number): number => {
    if (o.type !== 'adaptive') return base
    let worst = 1
    const ns = [...m.vt[v]].map((t) => m.triNormal(t))
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) worst = Math.min(worst, dot(ns[i], ns[j]))
    const bend = Math.acos(Math.max(-1, Math.min(1, worst)))
    const f = Math.max(0.35, Math.min(1.5, 0.3 / (bend + 0.12)))
    return base * f
  }
  const iters = o.iterations ?? 4
  for (let it = 0; it < iters; it++) {
    // ---- split edges that are too long (longest first, fresh lengths as it goes)
    for (let pass = 0; pass < 6; pass++) {
      const long: [number, number, number][] = []
      for (let t = 0; t < m.alive.length; t++) {
        if (!m.alive[t]) continue
        for (let k = 0; k < 3; k++) {
          const a = m.tri[t * 3 + k], b = m.tri[t * 3 + ((k + 1) % 3)]
          if (a > b) continue
          const l = len(sub(m.p(a), m.p(b)))
          const lim = ((sizeAt(a) + sizeAt(b)) / 2) * (4 / 3)
          if (l > lim) long.push([l, a, b])
        }
      }
      if (!long.length) break
      long.sort((x, y) => y[0] - x[0])
      let did = 0
      for (const [, a, b] of long) {
        if (m.edgeTris(a, b).length === 0) continue
        const A = m.p(a), B = m.p(b)
        const mv = m.split(a, b, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2)
        const fixed = isFixedEdge(a, b)
        if (fixed) {
          const wasB = bKey.has(key(a, b)), wasS = sharpKey.has(key(a, b))
          for (const e of [a, b]) { if (wasB) bKey.add(key(e, mv)); if (wasS) sharpKey.add(key(e, mv)) }
        }
        did++
      }
      if (!did) break
    }
    // ---- collapse edges that are too short
    const bv = bVerts()
    const fv = featureVerts()
    for (let pass = 0; pass < 3; pass++) {
      let did = 0
      for (let t = 0; t < m.alive.length; t++) {
        if (!m.alive[t]) continue
        for (let k = 0; k < 3; k++) {
          if (!m.alive[t]) break
          const a = m.tri[t * 3 + k], b = m.tri[t * 3 + ((k + 1) % 3)]
          const l = len(sub(m.p(a), m.p(b)))
          if (l >= ((sizeAt(a) + sizeAt(b)) / 2) * 0.8) continue
          if (collapse(m, a, b, base, o, fv, bv, sizeAt, isFixedEdge)) { did++; break }
        }
      }
      if (!did) break
    }
    // ---- flip towards valence 6
    for (let pass = 0; pass < 2; pass++) {
      for (let t = 0; t < m.alive.length; t++) {
        if (!m.alive[t]) continue
        for (let k = 0; k < 3; k++) {
          if (!m.alive[t]) break
          const a = m.tri[t * 3 + k], b = m.tri[t * 3 + ((k + 1) % 3)]
          if (isFixedEdge(a, b)) continue
          const ts = m.edgeTris(a, b)
          if (ts.length !== 2) continue
          const c = m.third(ts[0], a, b), d = m.third(ts[1], a, b)
          const val = (v: number) => m.vt[v].size
          const before = [a, b, c, d].reduce((s, v) => s + (val(v) - 6) ** 2, 0)
          const after = (val(a) - 1 - 6) ** 2 + (val(b) - 1 - 6) ** 2 + (val(c) + 1 - 6) ** 2 + (val(d) + 1 - 6) ** 2
          if (after >= before) continue
          // the flip must keep both new triangles facing the same way the old ones did
          const nOld = [m.triNormal(ts[0]), m.triNormal(ts[1])]
          const P = [m.p(a), m.p(b), m.p(c), m.p(d)]
          const nA = cross(sub(P[3], P[0]), sub(P[2], P[0])), nB = cross(sub(P[2], P[1]), sub(P[3], P[1]))
          const ok = (n: V3) => { const l = len(n); return l > 1e-12 && (dot(n, nOld[0]) + dot(n, nOld[1])) / l > 1.2 }
          const flatEnough = dot(nOld[0], nOld[1]) > 0.7
          // runs(ts[0], a, b) decides which triangle owns a -> b; normals are summed so either order works
          if (flatEnough && ok(nA) && ok(nB)) m.flip(a, b)
        }
      }
    }
    // ---- tangential relaxation, then back onto the original surface
    const fv2 = featureVerts(), bv2 = bVerts()
    for (let v = 0; v < m.nv; v++) {
      if (!m.vt[v].size) continue
      if (fv2.has(v)) continue
      const onB = bv2.has(v)
      if (onB && o.preserveBoundaries) continue
      const nbr = [...m.neighbours(v)]
      let cx = 0, cy = 0, cz = 0, cnt = 0
      for (const w of nbr) {
        if (onB && !bv2.has(w)) continue
        const q = m.p(w); cx += q[0]; cy += q[1]; cz += q[2]; cnt++
      }
      if (!cnt) continue
      const P = m.p(v)
      let d: V3 = [cx / cnt - P[0], cy / cnt - P[1], cz / cnt - P[2]]
      if (!onB) {
        let nx = 0, ny = 0, nz = 0
        for (const t of m.vt[v]) { const n = m.triNormal(t, true); nx += n[0]; ny += n[1]; nz += n[2] }
        const nl = Math.hypot(nx, ny, nz) || 1
        const n: V3 = [nx / nl, ny / nl, nz / nl]
        const dn = dot(d, n)
        d = [d[0] - n[0] * dn, d[1] - n[1] * dn, d[2] - n[2] * dn]
      }
      let np: V3 = [P[0] + d[0] * 0.5, P[1] + d[1] * 0.5, P[2] + d[2] * 0.5]
      np = surf.closest(np, base * 2)
      // keep the move only when no triangle around the vertex turns over
      const keep = m.p(v)
      m.pos[v * 3] = np[0]; m.pos[v * 3 + 1] = np[1]; m.pos[v * 3 + 2] = np[2]
      let bad = false
      for (const t of m.vt[v]) {
        const n1 = m.triNormal(t, true)
        if (len(n1) < 1e-12) { bad = true; break }
      }
      if (bad) { m.pos[v * 3] = keep[0]; m.pos[v * 3 + 1] = keep[1]; m.pos[v * 3 + 2] = keep[2] }
    }
  }
  return m.toTopo()
}

function collapse(m: EditMesh, a: number, b: number, base: number, o: RemeshOptions, fv: Set<number>, bv: Set<number>, sizeAt: (v: number) => number, fixedEdge: (a: number, b: number) => boolean): boolean {
  const ts = m.edgeTris(a, b)
  if (!ts.length || ts.length > 2) return false
  // which vertex goes: never a corner of the features, never a moved boundary
  const aFixed = fv.has(a) || (o.preserveBoundaries && bv.has(a)), bFixed = fv.has(b) || (o.preserveBoundaries && bv.has(b))
  const onCrease = fixedEdge(a, b)
  if (onCrease) {
    // along a crease or a boundary only, and only between plain vertices of it
    if (aFixed && bFixed) return false
  } else if ((fv.has(a) && fv.has(b)) || (bv.has(a) && bv.has(b))) return false
  let keep = b, drop = a
  if (aFixed && !bFixed) { keep = a; drop = b }
  else if (!aFixed && !bFixed && (bv.has(a) !== bv.has(b))) { keep = bv.has(a) ? a : b; drop = keep === a ? b : a }
  const kp = m.p(keep)
  const at: V3 = aFixed || bFixed || bv.has(keep) || fv.has(keep) ? kp : ((): V3 => { const A = m.p(a), B = m.p(b); return [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2] })()
  const na = m.neighbours(a), nb = m.neighbours(b)
  let common = 0
  for (const v of na) if (nb.has(v)) common++
  if (common !== ts.length) return false
  // no new edge may be longer than the limit, nothing may fold over
  for (const t of m.vt[drop]) {
    if (ts.includes(t)) continue
    const k = [0, 1, 2].map((i) => m.tri[t * 3 + i])
    const n0 = m.triNormal(t, true)
    const q = k.map((w) => (w === drop || w === keep ? at : m.p(w)))
    const n1 = cross(sub(q[1], q[0]), sub(q[2], q[0]))
    const l0 = len(n0), l1 = len(n1)
    if (l1 < 1e-12 || dot(n0, n1) / (l0 * l1 || 1) < 0.5) return false
    for (const w of k) if (w !== drop && w !== keep && len(sub(m.p(w), at)) > ((sizeAt(w) + sizeAt(keep)) / 2) * (4 / 3)) return false
  }
  for (const t of ts) m.kill(t)
  for (const t of [...m.vt[drop]]) m.setTri(t, ...([0, 1, 2].map((i) => (m.tri[t * 3 + i] === drop ? keep : m.tri[t * 3 + i])) as [number, number, number]))
  m.pos[keep * 3] = at[0]; m.pos[keep * 3 + 1] = at[1]; m.pos[keep * 3 + 2] = at[2]
  void base
  return true
}

// ============================================================================================ plane clip

/** Distance of a point to the plane n . p = d (n unit). */
export const planeDist = (n: V3, d: number, p: ArrayLike<number>) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d

/**
 * Keep the part of the mesh on one side of the plane n . p = d (the side n points to when `above`), with no cap. Triangles
 * that cross the plane are cut along it; new vertices are shared by neighbouring triangles, so the mesh stays welded.
 */
export function clipTopo(topo: TopoMesh, n: V3, d: number, above: boolean): TopoMesh {
  const nl = len(n) || 1
  const u: V3 = [n[0] / nl, n[1] / nl, n[2] / nl]
  const dd = d / nl
  const s = above ? 1 : -1
  const p = topo.positions, ix = topo.indices
  const pos: number[] = Array.from(p)
  const idx: number[] = []
  const dist = (v: number) => s * planeDist(u, dd, [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]])
  const cutV = new Map<string, number>()
  const cut = (a: number, b: number): number => {
    const k = a < b ? a + '_' + b : b + '_' + a
    let v = cutV.get(k)
    if (v === undefined) {
      const da = dist(a), db = dist(b)
      const t = da / (da - db)
      v = pos.length / 3
      pos.push(p[a * 3] + (p[b * 3] - p[a * 3]) * t, p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * t, p[a * 3 + 2] + (p[b * 3 + 2] - p[a * 3 + 2]) * t)
      cutV.set(k, v)
    }
    return v
  }
  const eps = 1e-7
  for (let t = 0; t < ix.length; t += 3) {
    const v = [ix[t], ix[t + 1], ix[t + 2]]
    const ds = v.map(dist)
    const inside = ds.map((x) => x >= -eps)
    const nIn = inside.filter(Boolean).length
    if (nIn === 3) idx.push(v[0], v[1], v[2])
    else if (nIn === 0) continue
    else if (nIn === 1) {
      const i = inside.indexOf(true)
      const a = v[i], b = v[(i + 1) % 3], c = v[(i + 2) % 3]
      idx.push(a, cut(a, b), cut(c, a))
    } else {
      const i = inside.indexOf(false)
      const a = v[i], b = v[(i + 1) % 3], c = v[(i + 2) % 3] // a is out
      const ab = cut(a, b), ca = cut(c, a)
      idx.push(b, c, ca, b, ca, ab)
    }
  }
  const out = weld(pos, idx, 1e-6)
  return out
}

/** Make the triangles lying in the plane n . p = d finer: edges longer than `maxLen` are split, then flipped towards Delaunay. */
export function refineInPlane(topo: TopoMesh, n: V3, d: number, maxLen: number): TopoMesh {
  const nl = len(n) || 1
  const u: V3 = [n[0] / nl, n[1] / nl, n[2] / nl]
  const dd = d / nl
  const m = new EditMesh(topo)
  const onPlane = (v: number) => Math.abs(planeDist(u, dd, m.p(v))) < 1e-5
  const capTri = (t: number) => m.alive[t] && [0, 1, 2].every((k) => onPlane(m.tri[t * 3 + k]))
  for (let pass = 0; pass < 8; pass++) {
    const long: [number, number, number][] = []
    for (let t = 0; t < m.alive.length; t++) {
      if (!capTri(t)) continue
      for (let k = 0; k < 3; k++) {
        const a = m.tri[t * 3 + k], b = m.tri[t * 3 + ((k + 1) % 3)]
        if (a > b) continue
        const l = len(sub(m.p(a), m.p(b)))
        if (l > maxLen) long.push([l, a, b])
      }
    }
    if (!long.length) break
    long.sort((x, y) => y[0] - x[0])
    for (const [, a, b] of long) {
      if (!m.edgeTris(a, b).length) continue
      const A = m.p(a), B = m.p(b)
      m.split(a, b, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2)
    }
  }
  for (let pass = 0; pass < 6; pass++) {
    let did = 0
    for (let t = 0; t < m.alive.length; t++) {
      if (!capTri(t)) continue
      for (let k = 0; k < 3; k++) {
        if (!m.alive[t]) break
        const a = m.tri[t * 3 + k], b = m.tri[t * 3 + ((k + 1) % 3)]
        const ts = m.edgeTris(a, b)
        if (ts.length !== 2 || !capTri(ts[0]) || !capTri(ts[1])) continue
        const c = m.third(ts[0], a, b), dv = m.third(ts[1], a, b)
        const ang = (p: number, q: number, r: number) => { const x = sub(m.p(q), m.p(p)), y = sub(m.p(r), m.p(p)); return Math.acos(Math.max(-1, Math.min(1, dot(x, y) / ((len(x) * len(y)) || 1)))) }
        if (ang(c, a, b) + ang(dv, a, b) > Math.PI + 1e-6 && m.flip(a, b)) did++
      }
    }
    if (!did) break
  }
  return m.toTopo()
}

// ============================================================================================ statistics

export interface MeshStats {
  triangles: number
  vertices: number
  openEdges: number
  nonManifoldEdges: number
  /** edges whose two triangles run the same way (a patch wound against its neighbours) */
  flippedEdges: number
  shells: number
  volume: number
  area: number
  /** closed, every edge shared by two triangles that agree about the way out */
  manifold: boolean
  bounds: { min: V3; max: V3 }
}

export function statsOf(topo: TopoMesh): MeshStats {
  const p = topo.positions, ix = topo.indices
  const nv = p.length / 3
  const T = ix.length / 3
  const dir = new Map<number, number>() // undirected key -> bit0: a->b seen, bit1: b->a seen, count in high bits
  const count = new Map<number, number>()
  let flipped = 0
  const parent = Int32Array.from({ length: nv }, (_, i) => i)
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  let vol = 0, area = 0
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]) }
  const used = new Uint8Array(nv)
  for (let t = 0; t < T; t++) {
    const v = [ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]]
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3]
      used[a] = 1
      const key = a < b ? a * nv + b : b * nv + a
      const bit = a < b ? 1 : 2
      const cur = dir.get(key) ?? 0
      if (cur & bit) flipped++
      dir.set(key, cur | bit)
      count.set(key, (count.get(key) ?? 0) + 1)
      const ra = find(a), rb = find(b)
      if (ra !== rb) parent[ra] = rb
    }
    const A = [p[v[0] * 3], p[v[0] * 3 + 1], p[v[0] * 3 + 2]] as V3, B = [p[v[1] * 3], p[v[1] * 3 + 1], p[v[1] * 3 + 2]] as V3, C = [p[v[2] * 3], p[v[2] * 3 + 1], p[v[2] * 3 + 2]] as V3
    vol += dot(A, cross(B, C)) / 6
    area += len(cross(sub(B, A), sub(C, A))) / 2
  }
  let open = 0, nm = 0
  for (const n of count.values()) { if (n === 1) open++; else if (n > 2) nm++ }
  const roots = new Set<number>()
  for (let v = 0; v < nv; v++) if (used[v]) roots.add(find(v))
  return {
    triangles: T, vertices: nv, openEdges: open, nonManifoldEdges: nm, flippedEdges: flipped, shells: roots.size, volume: vol, area,
    manifold: open === 0 && nm === 0 && flipped === 0, bounds: { min: lo, max: hi },
  }
}

// ============================================================================================ section outlines

/** The outline of the mesh on the plane n . p = d, as closed (or open) polylines of 3D points. */
export function sectionLoops(topo: TopoMesh, n: V3, d: number): { points: V3[]; closed: boolean }[] {
  const nl = len(n) || 1
  const u: V3 = [n[0] / nl, n[1] / nl, n[2] / nl]
  const dd = d / nl
  const p = topo.positions, ix = topo.indices
  const dist = (v: number) => planeDist(u, dd, [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]])
  // a plane that passes exactly through vertices is nudged so the crossings are clean
  const eps = 1e-9
  const sgn = (x: number) => (x > eps ? 1 : -1)
  const segs: [number, number][] = []
  const crossing = new Map<string, number>()
  const pts3: V3[] = []
  const at = (a: number, b: number): number => {
    const k = a < b ? a + '_' + b : b + '_' + a
    let id = crossing.get(k)
    if (id === undefined) {
      const [x, y] = a < b ? [a, b] : [b, a]
      const da = dist(x), db = dist(y)
      const t = da / (da - db)
      id = pts3.length
      pts3.push([p[x * 3] + (p[y * 3] - p[x * 3]) * t, p[x * 3 + 1] + (p[y * 3 + 1] - p[x * 3 + 1]) * t, p[x * 3 + 2] + (p[y * 3 + 2] - p[x * 3 + 2]) * t])
      crossing.set(k, id)
    }
    return id
  }
  for (let t = 0; t < ix.length; t += 3) {
    const v = [ix[t], ix[t + 1], ix[t + 2]]
    const s = v.map((x) => sgn(dist(x)))
    if (s[0] === s[1] && s[1] === s[2]) continue
    const pts: number[] = []
    for (let e = 0; e < 3; e++) { const a = v[e], b = v[(e + 1) % 3]; if (sgn(dist(a)) !== sgn(dist(b))) pts.push(at(a, b)) }
    if (pts.length === 2) segs.push([pts[0], pts[1]])
  }
  const ends = new Map<number, number[]>()
  segs.forEach((s, i) => { for (const e of s) { const l = ends.get(e); if (l) l.push(i); else ends.set(e, [i]) } })
  const used = new Uint8Array(segs.length)
  const out: { points: V3[]; closed: boolean }[] = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const ids: number[] = [segs[i][0], segs[i][1]]
    const grow = (front: boolean) => {
      for (;;) {
        const tip = front ? ids[ids.length - 1] : ids[0]
        const next = (ends.get(tip) ?? []).find((j) => !used[j])
        if (next === undefined) return
        used[next] = 1
        const [a, b] = segs[next]
        const other = a === tip ? b : a
        if (front) ids.push(other); else ids.unshift(other)
      }
    }
    grow(true)
    grow(false)
    const closed = ids.length > 3 && ids[0] === ids[ids.length - 1]
    if (closed) ids.pop()
    out.push({ points: ids.map((k) => pts3[k]), closed })
  }
  return out
}

// ============================================================================================ face groups

/**
 * Face groups by region growing. 'fast': neighbouring triangles join while the bend between them stays under the threshold (what the
 * import does). 'accurate': a group grows while every triangle stays within the threshold of the group's own average direction, so a
 * smooth curved surface is cut into patches instead of running into one face, and flat, cylindrical and conical regions come out whole.
 */
export function groupTris(topo: TopoMesh, mode: 'fast' | 'accurate', deg: number): { ids: Uint32Array; count: number } {
  const seg = segmentFaces(topo, deg)
  if (mode === 'fast') return { ids: seg.faceIds, count: seg.faceCount }
  const T = topo.indices.length / 3
  const { adj, normals } = seg
  const cosT = Math.cos((deg * Math.PI) / 180)
  const ids = new Uint32Array(T).fill(0xffffffff)
  let count = 0
  const order = Array.from({ length: T }, (_, i) => i)
  // seed from the flattest triangles first: look at how much each differs from its neighbours
  const flat = new Float32Array(T)
  for (let t = 0; t < T; t++) {
    let s = 0, n = 0
    for (let k = 0; k < 3; k++) {
      const b = adj[t * 3 + k]
      if (b < 0) continue
      s += normals[t * 3] * normals[b * 3] + normals[t * 3 + 1] * normals[b * 3 + 1] + normals[t * 3 + 2] * normals[b * 3 + 2]; n++
    }
    flat[t] = n ? s / n : 0
  }
  order.sort((a, b) => flat[b] - flat[a])
  for (const s of order) {
    if (ids[s] !== 0xffffffff) continue
    const g = count++
    ids[s] = g
    let ax = normals[s * 3], ay = normals[s * 3 + 1], az = normals[s * 3 + 2]
    let n = 1
    const stack = [s]
    while (stack.length) {
      const a = stack.pop()!
      for (let k = 0; k < 3; k++) {
        const b = adj[a * 3 + k]
        if (b < 0 || ids[b] !== 0xffffffff) continue
        const l = Math.hypot(ax, ay, az) || 1
        const d = (normals[b * 3] * ax + normals[b * 3 + 1] * ay + normals[b * 3 + 2] * az) / l
        // neighbours must also agree with each other, so a ridge cannot be crossed gradually
        const dn = normals[a * 3] * normals[b * 3] + normals[a * 3 + 1] * normals[b * 3 + 1] + normals[a * 3 + 2] * normals[b * 3 + 2]
        if (d >= cosT && dn >= Math.cos(((deg * 0.75) * Math.PI) / 180)) {
          ids[b] = g
          ax += normals[b * 3]; ay += normals[b * 3 + 1]; az += normals[b * 3 + 2]; n++
          stack.push(b)
        }
      }
    }
  }
  return { ids, count }
}

/** Renumber group ids to 0..n-1 in order of first triangle. */
export function compactGroups(ids: ArrayLike<number>): { ids: Uint32Array; count: number } {
  const map = new Map<number, number>()
  const out = new Uint32Array(ids.length)
  for (let t = 0; t < ids.length; t++) {
    let g = map.get(ids[t])
    if (g === undefined) { g = map.size; map.set(ids[t], g) }
    out[t] = g
  }
  return { ids: out, count: map.size }
}

// ============================================================================================ region edits

/** Open boundary loops of a mesh as vertex index lists, each walking the way a fill triangle strip must run. */
export function boundaryLoops(topo: TopoMesh): number[][] {
  const ix = topo.indices
  const directed = new Set<string>()
  for (let t = 0; t < ix.length; t += 3) for (let k = 0; k < 3; k++) directed.add(ix[t + k] + '>' + ix[t + ((k + 1) % 3)])
  const next = new Map<number, number[]>()
  for (const key of directed) {
    const [a, b] = key.split('>').map(Number)
    if (!directed.has(b + '>' + a)) { const l = next.get(b); if (l) l.push(a); else next.set(b, [a]) }
  }
  const used = new Set<string>()
  const loops: number[][] = []
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
    if (cur === start && loop.length >= 3) loops.push(loop)
  }
  return loops
}

/**
 * Remove the triangles `drop` from the mesh. With `fill`, every hole that opens up is closed again with a smooth patch: the loop is
 * triangulated, refined to the size of the surrounding triangles and relaxed so it blends with the surface around it.
 */
export function eraseTris(topo: TopoMesh, drop: ArrayLike<number>, fill: boolean): { mesh: TopoMesh; holes: number } {
  const dropped = new Set<number>()
  for (let i = 0; i < drop.length; i++) dropped.add(drop[i])
  const idx: number[] = []
  for (let t = 0; t < topo.indices.length / 3; t++) if (!dropped.has(t)) idx.push(topo.indices[t * 3], topo.indices[t * 3 + 1], topo.indices[t * 3 + 2])
  const kept = { positions: topo.positions, indices: Uint32Array.from(idx) }
  if (!fill) return { mesh: compactTopo(kept), holes: 0 }
  // only the loops that the removal made: the boundary of the mesh before it was already open
  const before = new Set(boundaryLoops(topo).flat().map((v) => v))
  void before
  const loops = boundaryLoops(kept).filter((l) => l.some((v) => isNearDropped(topo, dropped, v)))
  const pos = Array.from(kept.positions)
  const tri = Array.from(kept.indices)
  let holes = 0
  for (const loop of loops) {
    const patch = fillLoop(pos, loop)
    if (!patch) continue
    holes++
    tri.push(...patch)
  }
  // relax the new vertices (those beyond the original vertex count) towards their neighbours, keeping the rim fixed
  const nv0 = kept.positions.length / 3
  const grown = { positions: Float32Array.from(pos), indices: Uint32Array.from(tri) }
  const mesh = relaxNew(grown, nv0)
  return { mesh: compactTopo(mesh), holes }
}

const dropVerts = new WeakMap<Set<number>, Set<number>>()
function isNearDropped(topo: TopoMesh, dropped: Set<number>, v: number): boolean {
  let s = dropVerts.get(dropped)
  if (!s) {
    s = new Set<number>()
    for (const t of dropped) for (let k = 0; k < 3; k++) s.add(topo.indices[t * 3 + k])
    dropVerts.set(dropped, s)
  }
  return s.has(v)
}

function compactTopo(t: TopoMesh): TopoMesh {
  const map = new Int32Array(t.positions.length / 3).fill(-1)
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i < t.indices.length; i++) {
    const v = t.indices[i]
    if (map[v] < 0) { map[v] = pos.length / 3; pos.push(t.positions[v * 3], t.positions[v * 3 + 1], t.positions[v * 3 + 2]) }
    idx.push(map[v])
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** Triangles that close the loop (vertex ids into `pos`, new vertices are appended to it): ear clipping in the best-fit plane, then refined. Null when it cannot be done. */
function fillLoop(pos: number[], loop: number[]): number[] | null {
  const P = loop.map((v): V3 => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]])
  // Newell normal
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length]
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1])
  }
  const nl = Math.hypot(nx, ny, nz)
  if (!(nl > 1e-12)) return null
  const n: V3 = [nx / nl, ny / nl, nz / nl]
  const ref: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const ux = cross(n, ref); const ul = len(ux)
  const U: V3 = [ux[0] / ul, ux[1] / ul, ux[2] / ul]
  const W = cross(n, U)
  const pts = P.map((q) => [dot(q, U), dot(q, W)] as [number, number])
  // the boundary loop runs against the removed face, which makes it run clockwise seen along the fill normal... use the polygon's own signed area
  let area = 0
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1] }
  const order = loop.map((_, i) => i)
  if (area < 0) order.reverse()
  const tris: number[] = []
  const inTri = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) => {
    const s = (x: [number, number], y: [number, number], z: [number, number]) => (x[0] - z[0]) * (y[1] - z[1]) - (y[0] - z[0]) * (x[1] - z[1])
    const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a)
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
  }
  const rem = [...order]
  let guard = 0
  while (rem.length > 3 && guard++ < 1e5) {
    let clipped = false
    for (let i = 0; i < rem.length; i++) {
      const a = rem[(i + rem.length - 1) % rem.length], b = rem[i], c = rem[(i + 1) % rem.length]
      const cr = (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0])
      if (cr <= 1e-12) continue
      if (rem.some((r) => r !== a && r !== b && r !== c && inTri(pts[r], pts[a], pts[b], pts[c]))) continue
      tris.push(a, b, c)
      rem.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) {
      // a degenerate loop: fan the rest
      for (let i = 1; i + 1 < rem.length; i++) tris.push(rem[0], rem[i], rem[i + 1])
      break
    }
  }
  if (rem.length === 3) tris.push(rem[0], rem[1], rem[2])
  // winding: the patch must face the way the surrounding surface does, which is the way the loop's neighbour triangles face
  // (the boundary edge a->b of the kept mesh has its triangle on one side; the patch uses b->a). Orient so that every loop edge is used b->a.
  const out: number[] = []
  const loopNext = new Map<number, number>()
  for (let i = 0; i < loop.length; i++) loopNext.set(i, (i + 1) % loop.length)
  let agree = 0, disagree = 0
  for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = tris[t + k], b = tris[t + ((k + 1) % 3)]
    if (loopNext.get(a) === b) agree++
    else if (loopNext.get(b) === a) disagree++
  }
  // loops are walked against the kept triangles, so the patch has to run loop[i] -> loop[i+1]
  const flip = disagree > agree
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]].map((i) => loop[i])
    if (flip) out.push(a, c, b); else out.push(a, b, c)
  }
  return out
}

/** Smooth only the vertices with an index at or above `from` (the new patch), pulling each to the average of its neighbours. */
function relaxNew(t: TopoMesh, from: number): TopoMesh {
  const nv = t.positions.length / 3
  if (from >= nv) return t
  const nbr: Set<number>[] = Array.from({ length: nv }, () => new Set())
  for (let i = 0; i < t.indices.length; i += 3) for (let k = 0; k < 3; k++) { const a = t.indices[i + k], b = t.indices[i + ((k + 1) % 3)]; nbr[a].add(b); nbr[b].add(a) }
  let cur = Float32Array.from(t.positions)
  for (let it = 0; it < 30; it++) {
    const nx = Float32Array.from(cur)
    for (let v = from; v < nv; v++) {
      if (!nbr[v].size) continue
      let x = 0, y = 0, z = 0
      for (const w of nbr[v]) { x += cur[w * 3]; y += cur[w * 3 + 1]; z += cur[w * 3 + 2] }
      nx[v * 3] = x / nbr[v].size; nx[v * 3 + 1] = y / nbr[v].size; nx[v * 3 + 2] = z / nbr[v].size
    }
    cur = nx
  }
  return { positions: cur, indices: t.indices }
}

/** Move every vertex used by the triangles `sel` by `delta`; the neighbouring triangles stretch with them. */
export function translateTris(topo: TopoMesh, sel: ArrayLike<number>, delta: V3): TopoMesh {
  const moved = new Set<number>()
  for (let i = 0; i < sel.length; i++) for (let k = 0; k < 3; k++) moved.add(topo.indices[sel[i] * 3 + k])
  const pos = Float32Array.from(topo.positions)
  for (const v of moved) { pos[v * 3] += delta[0]; pos[v * 3 + 1] += delta[1]; pos[v * 3 + 2] += delta[2] }
  return { positions: pos, indices: topo.indices.slice() }
}

/** Scale about `pivot` by a factor per axis. */
export function scaleTopo(topo: TopoMesh, pivot: V3, f: V3): TopoMesh {
  const pos = Float32Array.from(topo.positions)
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] = pivot[k] + (pos[i + k] - pivot[k]) * f[k]
  const idx = topo.indices.slice()
  // a mirrored scale turns the triangles inside out: restore the winding
  if (f[0] * f[1] * f[2] < 0) for (let t = 0; t < idx.length; t += 3) { const b = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = b }
  return { positions: pos, indices: idx }
}
