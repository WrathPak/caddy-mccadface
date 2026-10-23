/** Sacrificial wall: closed watertight shells (follow-surface / planar / cylindrical), a ray caster and self-intersection repair data. */
import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Ray, Vector3 } from 'three'
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh'
import type { HairParams, V3 } from './schema'
import { prepSurface, type Surf } from './sampling'
import type { Raw } from './strands'
import { add, basis, cross, dot, len, mul, norm, sub } from './vec'

export interface Mesh3 { positions: Float32Array; indices: Uint32Array }
export interface Axis { o: V3; d: V3 }

export interface Caster {
  /** first hit along a segment (distance + face normal) */
  cast(origin: V3, dir: V3, maxDist: number): { dist: number; normal: V3 } | null
  /** nearest point on the wall surface */
  closest(p: V3): { point: V3; dist: number; normal: V3 }
}

export interface WallResult {
  mesh: Mesh3
  /** follow walls: bottom/top vertex sheets, used to rebuild the wall as a distance-field level set when the shell self-intersects */
  follow?: { positions: Float32Array; tris: Uint32Array }
}

function bvhOf(m: Mesh3) {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(m.positions, 3))
  g.setIndex(new BufferAttribute(m.indices.slice(), 1))
  return { g, bvh: new MeshBVH(g) }
}

export function makeCaster(m: Mesh3): Caster {
  const { g, bvh } = bvhOf(m)
  const ray = new Ray()
  const faceNormal = (fi: number): V3 => {
    const ix = g.index!, pa = g.attributes.position
    const a = new Vector3().fromBufferAttribute(pa, ix.getX(fi * 3)), b = new Vector3().fromBufferAttribute(pa, ix.getX(fi * 3 + 1)), c = new Vector3().fromBufferAttribute(pa, ix.getX(fi * 3 + 2))
    const n = b.sub(a).cross(c.sub(a)).normalize()
    return [n.x, n.y, n.z]
  }
  return {
    cast(o, d, far) {
      ray.origin.set(o[0], o[1], o[2])
      ray.direction.set(d[0], d[1], d[2])
      const h = bvh.raycastFirst(ray, DoubleSide, 0, far)
      return h ? { dist: h.distance, normal: faceNormal(h.faceIndex!) } : null
    },
    closest(p) {
      const h = bvh.closestPointToPoint(new Vector3(p[0], p[1], p[2]))
      if (!h) throw new Error('The wall has no geometry')
      return { point: [h.point.x, h.point.y, h.point.z], dist: h.distance, normal: faceNormal(h.faceIndex) }
    },
  }
}

/** True when two non-adjacent triangles of a mesh intersect (the mesh cannot be trusted as a solid). */
export function selfIntersects(m: Mesh3): boolean {
  const { g, bvh } = bvhOf(m)
  const ix = g.index!
  return bvh.bvhcast(bvh, new Matrix4(), {
    intersectsTriangles: (t1: ExtendedTriangle, t2: ExtendedTriangle, i1: number, i2: number) => {
      if (i1 >= i2) return false
      const a = [ix.getX(i1 * 3), ix.getX(i1 * 3 + 1), ix.getX(i1 * 3 + 2)]
      for (let k = 0; k < 3; k++) if (a.includes(ix.getX(i2 * 3 + k))) return false
      return t1.intersectsTriangle(t2)
    },
  })
}

// ------------------------------------------------------------------ follow-surface wall

interface Geo { pos: Float32Array; idx: Uint32Array; vn: Float32Array }

/** Directed boundary edges of an indexed triangle set. */
function boundaryOf(idx: Uint32Array, nv: number): [number, number][] {
  const dir = new Set<number>()
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) dir.add(idx[t + k] * nv + idx[t + ((k + 1) % 3)])
  const out: [number, number][] = []
  for (const key of dir) {
    const a = Math.floor(key / nv), b = key % nv
    if (!dir.has(b * nv + a)) out.push([a, b])
  }
  return out
}

/** Vertex adjacency (CSR, neighbours unique) with edge lengths. */
function adjacency(g: Geo) {
  const nv = g.pos.length / 3
  const sets: Set<number>[] = Array.from({ length: nv }, () => new Set())
  for (let t = 0; t < g.idx.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = g.idx[t + k], b = g.idx[t + ((k + 1) % 3)]
    sets[a].add(b); sets[b].add(a)
  }
  const start = new Uint32Array(nv + 1)
  for (let v = 0; v < nv; v++) start[v + 1] = start[v] + sets[v].size
  const nbr = new Uint32Array(start[nv])
  const w = new Float32Array(start[nv])
  for (let v = 0; v < nv; v++) {
    let i = start[v]
    for (const u of [...sets[v]].sort((a, b) => a - b)) {
      nbr[i] = u
      w[i++] = Math.hypot(g.pos[u * 3] - g.pos[v * 3], g.pos[u * 3 + 1] - g.pos[v * 3 + 1], g.pos[u * 3 + 2] - g.pos[v * 3 + 2])
    }
  }
  return { start, nbr, w }
}

/**
 * Normals averaged over the geodesic (mesh-graph) neighbourhood of each vertex, Gaussian-weighted by distance and vertex area.
 * The radius is capped so each neighbourhood holds a bounded number of vertices (keeps dense meshes fast).
 */
function smoothNormals(g: Geo, adj: ReturnType<typeof adjacency>, rho0: number): Float32Array {
  const nv = g.pos.length / 3
  const va = new Float64Array(nv)
  let total = 0
  for (let t = 0; t < g.idx.length; t += 3) {
    const a = g.idx[t] * 3, b = g.idx[t + 1] * 3, c = g.idx[t + 2] * 3
    const ux = g.pos[b] - g.pos[a], uy = g.pos[b + 1] - g.pos[a + 1], uz = g.pos[b + 2] - g.pos[a + 2]
    const vx = g.pos[c] - g.pos[a], vy = g.pos[c + 1] - g.pos[a + 1], vz = g.pos[c + 2] - g.pos[a + 2]
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6
    va[g.idx[t]] += ar; va[g.idx[t + 1]] += ar; va[g.idx[t + 2]] += ar
    total += 3 * ar
  }
  const rho = Math.min(rho0, Math.sqrt((300 * total) / (nv * Math.PI)))
  const out = new Float32Array(nv * 3)
  if (rho <= 0) return g.vn.slice()
  const dist = new Float64Array(nv).fill(Infinity)
  // binary heap of [dist, vertex]
  let hd: number[] = [], hv: number[] = []
  const push = (d: number, v: number) => {
    let i = hd.length
    hd.push(d); hv.push(v)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hd[p] <= d) break
      hd[i] = hd[p]; hv[i] = hv[p]; i = p
    }
    hd[i] = d; hv[i] = v
  }
  const pop = () => {
    const d0 = hd[0], v0 = hv[0]
    const d = hd.pop()!, v = hv.pop()!
    const n = hd.length
    if (n) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && hd[c + 1] < hd[c]) c++
        if (hd[c] >= d) break
        hd[i] = hd[c]; hv[i] = hv[c]; i = c
      }
      hd[i] = d; hv[i] = v
    }
    return [d0, v0] as const
  }
  const inv2 = 2 / (rho * rho)
  for (let s = 0; s < nv; s++) {
    const touched: number[] = [s]
    dist[s] = 0
    hd = []; hv = []
    push(0, s)
    let nx = 0, ny = 0, nz = 0
    while (hd.length) {
      const [d, u] = pop()
      if (d > dist[u]) continue
      // bilateral: never mix normals more than 60 deg apart (keeps tight concave/convex features from being averaged away)
      if (g.vn[u * 3] * g.vn[s * 3] + g.vn[u * 3 + 1] * g.vn[s * 3 + 1] + g.vn[u * 3 + 2] * g.vn[s * 3 + 2] < 0.5) { /* skip accumulation */ } else {
      const w = Math.exp(-d * d * inv2) * (va[u] || 1e-9)
      nx += g.vn[u * 3] * w; ny += g.vn[u * 3 + 1] * w; nz += g.vn[u * 3 + 2] * w }
      for (let i = adj.start[u]; i < adj.start[u + 1]; i++) {
        const q = adj.nbr[i], nd = d + adj.w[i]
        if (nd > rho || nd >= dist[q]) continue
        if (dist[q] === Infinity) touched.push(q)
        dist[q] = nd
        push(nd, q)
      }
    }
    for (const q of touched) dist[q] = Infinity
    const l = Math.hypot(nx, ny, nz)
    if (l < 1e-9) out.set([g.vn[s * 3], g.vn[s * 3 + 1], g.vn[s * 3 + 2]], s * 3)
    else out.set([nx / l, ny / l, nz / l], s * 3)
  }
  return out
}

/** Per-vertex offset: D, reduced where concave curvature would fold an edge of the offset shell (inner or outer face). */
function clampedOffsets(g: Geo, adj: ReturnType<typeof adjacency>, sn: Float32Array, D: number, T: number, Dv?: Float32Array): Float32Array {
  const nv = g.pos.length / 3
  const lim = Dv ? Dv.slice() : new Float32Array(nv).fill(D)
  const floor = Math.min(D, 0.3)
  for (let a = 0; a < nv; a++) {
    for (let i = adj.start[a]; i < adj.start[a + 1]; i++) {
      const b = adj.nbr[i]
      let ee = 0, dn = 0
      for (let k = 0; k < 3; k++) {
        const e = g.pos[b * 3 + k] - g.pos[a * 3 + k]
        ee += e * e
        dn += (sn[b * 3 + k] - sn[a * 3 + k]) * e
      }
      if (dn >= 0 || ee < 1e-12) continue
      const kappa = -dn / ee // concave curvature along this edge
      const maxOuter = 0.7 / kappa // offset distance at which the edge shrinks to 30%
      lim[a] = Math.min(lim[a], Math.max(floor, maxOuter - T))
    }
  }
  // let the limit only decrease towards neighbours so the wall has no steps
  for (let it = 0; it < 3; it++) {
    const next = lim.slice()
    for (let v = 0; v < nv; v++) {
      const n = adj.start[v + 1] - adj.start[v]
      if (!n) continue
      let sum = 0
      for (let i = adj.start[v]; i < adj.start[v + 1]; i++) sum += lim[adj.nbr[i]]
      next[v] = Math.min(lim[v], 0.5 * lim[v] + 0.5 * (sum / n))
    }
    lim.set(next)
  }
  return lim
}

/** Closed shell mesh + prism source for bottom/top vertex sheets (bottom = first nv vertices, top = next nv). */
export function followResult(positions: Float32Array, tris: Uint32Array): WallResult {
  const nv = positions.length / 6
  const idx: number[] = []
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2]
    idx.push(a + nv, b + nv, c + nv, a, c, b)
  }
  for (const [u, v] of boundaryOf(tris, nv)) idx.push(u, v, v + nv, u, v + nv, u + nv)
  return { mesh: { positions, indices: new Uint32Array(idx) }, follow: { positions, tris } }
}

// ------------------------------------------------------------------ face-following wall

/** Flat top and bottom of the wall (world Z): spans the strands plus the margins. */
export interface WallZ { lo: number; hi: number }

/** Offset vector of length-d planes: the point m with n_i . m = d for every distinct face normal (a mitered corner). */
function miterVec(normals: V3[], d: number): V3 {
  const u: V3[] = []
  for (const n of normals) if (!u.some((q) => dot(q, n) > 0.9995)) u.push(n)
  if (u.length === 1) return mul(u[0], d)
  const cap = (m: V3): V3 => { const l = len(m); return l > 3 * d ? mul(m, (3 * d) / l) : m }
  if (u.length === 2) {
    const k = 1 + dot(u[0], u[1])
    if (k < 0.2) return mul(norm(add(u[0], u[1])), d) // very sharp: bevel instead of a long spike
    return cap(mul(add(u[0], u[1]), d / k))
  }
  // three or more: least squares on the first three well-separated normals
  const t = u.slice(0, 3)
  const G = t.map((a) => t.map((b) => dot(a, b)))
  const det = G[0][0] * (G[1][1] * G[2][2] - G[1][2] * G[2][1]) - G[0][1] * (G[1][0] * G[2][2] - G[1][2] * G[2][0]) + G[0][2] * (G[1][0] * G[2][1] - G[1][1] * G[2][0])
  if (Math.abs(det) < 1e-3) return mul(norm(u.reduce((a, b) => add(a, b), [0, 0, 0] as V3)), d)
  // Cramer's rule for G c = d * 1
  const col = (k: number) => {
    const M = G.map((r) => r.slice())
    for (let i = 0; i < 3; i++) M[i][k] = 1
    return (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det
  }
  return cap(mul(add(add(mul(t[0], col(0)), mul(t[1], col(1))), mul(t[2], col(2))), d))
}

const slerp = (a: V3, b: V3, t: number): V3 => {
  const c = Math.max(-1, Math.min(1, dot(a, b)))
  const th = Math.acos(c)
  if (th < 1e-4) return a
  const s = Math.sin(th)
  return add(mul(a, Math.sin((1 - t) * th) / s), mul(b, Math.sin(t * th) / s))
}

/**
 * Wall that copies the selected faces, offset by the strand length. Every smooth face (patch) is offset along its own normals,
 * so flat faces give flat slabs and curved faces stay smooth. Where two faces meet, the sheets are joined by a mitered corner or
 * a circular arc (the rounded join also serves Blend mode). The top and bottom are cut flat at the shared wall heights.
 * `dist` optionally overrides the offset per surface vertex (used by the through-tips fit).
 */
function followSheet(s: Surf, P: HairParams, z: WallZ, dist?: (v: number) => number): WallResult {
  const D = P.length, T = P.wallThickness
  const nv = s.pos.length / 3
  // 1. split every vertex per patch so that smoothing and clamping never cross a hard edge
  const slot = new Map<number, number>()
  const bpos: number[] = [], bn: number[] = []
  const tris = new Uint32Array(s.idx.length)
  for (let t = 0; t < s.idx.length / 3; t++) for (let k = 0; k < 3; k++) {
    const v = s.idx[t * 3 + k], key = s.patch[t] * nv + v
    let id = slot.get(key)
    if (id === undefined) {
      id = bpos.length / 3
      slot.set(key, id)
      bpos.push(s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2])
      bn.push(s.cn[t * 9 + k * 3], s.cn[t * 9 + k * 3 + 1], s.cn[t * 9 + k * 3 + 2])
    }
    tris[t * 3 + k] = id
  }
  const ns = bpos.length / 3
  const g: Geo = { pos: Float32Array.from(bpos), idx: tris, vn: Float32Array.from(bn) }
  const baseOf = new Uint32Array(ns)
  for (const [key, id] of slot) baseOf[id] = key % nv
  const adj = adjacency(g)
  const sn = smoothNormals(g, adj, Math.max(0.5, 0.4 * D))
  const Dv = dist ? Float32Array.from({ length: ns }, (_, i) => dist(baseOf[i])) : undefined
  const off = clampedOffsets(g, adj, sn, D, T, Dv)
  const nrm = (i: number): V3 => [sn[i * 3], sn[i * 3 + 1], sn[i * 3 + 2]]
  const bp = (i: number): V3 => [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]

  // 2. classify the seams between faces
  const miter = P.dirMode === 'perFace' && P.wallCorner === 'miter'
  const par = Array.from({ length: ns }, (_, i) => i)
  const find = (x: number): number => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x] } return x }
  const arcs: { aa: number; ab: number; ba: number; bb: number }[] = []
  for (const [a, b, ta, tb] of s.seams) {
    const aa = slot.get(s.patch[ta] * nv + a)!, ab = slot.get(s.patch[ta] * nv + b)!
    const ba = slot.get(s.patch[tb] * nv + a)!, bb = slot.get(s.patch[tb] * nv + b)!
    const e = norm(sub([s.pos[b * 3], s.pos[b * 3 + 1], s.pos[b * 3 + 2]], [s.pos[a * 3], s.pos[a * 3 + 1], s.pos[a * 3 + 2]]))
    const out = cross(e, [s.tn[ta * 3], s.tn[ta * 3 + 1], s.tn[ta * 3 + 2]])
    const convex = dot([s.tn[tb * 3], s.tn[tb * 3 + 1], s.tn[tb * 3 + 2]], out) > 1e-4
    if (miter || !convex) {
      par[find(aa)] = find(ba); par[find(ab)] = find(bb)
    } else arcs.push({ aa, ab, ba, bb })
  }

  // 3. one sheet vertex per class, positioned by the (mitered) offset planes
  const cls = new Map<number, number[]>()
  for (let i = 0; i < ns; i++) { const r = find(i); const l = cls.get(r); if (l) l.push(i); else cls.set(r, [i]) }
  const sheet = new Uint32Array(ns)
  const inner: number[] = [], outer: number[] = []
  const addVert = (pi: V3, po: V3) => { inner.push(pi[0], pi[1], pi[2]); outer.push(po[0], po[1], po[2]); return inner.length / 3 - 1 }
  for (const members of cls.values()) {
    const b = bp(members[0])
    const d = Math.min(...members.map((m) => off[m]))
    const normals = members.map(nrm)
    const id = addVert(add(b, miterVec(normals, d)), add(b, miterVec(normals, d + T)))
    for (const m of members) sheet[m] = id
  }
  const idx: number[] = []
  for (let t = 0; t < tris.length; t += 3) idx.push(sheet[tris[t]], sheet[tris[t + 1]], sheet[tris[t + 2]])

  // 4. rounded joins: a strip of circular-arc rings across each convex seam
  for (const { aa, ab, ba, bb } of arcs) {
    const cosA = Math.max(-1, Math.min(1, dot(nrm(aa), nrm(ba))))
    const K = Math.max(1, Math.ceil(Math.acos(cosA) / (Math.PI / 12)))
    const ringOf = (x: number, y: number): number[] => {
      const r = [sheet[x]]
      const b = bp(x)
      const dx = off[x], dy = off[y]
      for (let k = 1; k < K; k++) {
        const nk = slerp(nrm(x), nrm(y), k / K)
        const d = dx + (dy - dx) * (k / K)
        r.push(addVert(add(b, mul(nk, d)), add(b, mul(nk, d + T))))
      }
      r.push(sheet[y])
      return r
    }
    const ra = ringOf(aa, ba), rb = ringOf(ab, bb)
    // the region triangle holds a->b, so the strip walks b->a first (reverse edge) to keep the winding consistent
    for (let k = 0; k < K; k++) idx.push(rb[k], ra[k], ra[k + 1], rb[k], ra[k + 1], rb[k + 1])
  }

  // 5. flat top and bottom: boundary edges that face up (or down) are extruded vertically to the shared heights
  const tri = Uint32Array.from(idx)
  const nsh = inner.length / 3
  const ext = new Map<number, number>()
  const extra: number[] = []
  const extrude = (v: number, zt: number) => {
    let id = ext.get(v)
    if (id === undefined) {
      id = inner.length / 3
      ext.set(v, id)
      inner.push(inner[v * 3], inner[v * 3 + 1], zt)
      outer.push(outer[v * 3], outer[v * 3 + 1], zt)
    }
    return id
  }
  const owner = new Map<number, V3>()
  for (let t = 0; t < tri.length; t += 3) {
    const A = vec(inner, tri[t]), B = vec(inner, tri[t + 1]), C = vec(inner, tri[t + 2])
    const nn = norm(cross(sub(B, A), sub(C, A)))
    for (let k = 0; k < 3; k++) owner.set(tri[t + k] * nsh + tri[t + ((k + 1) % 3)], nn)
  }
  for (const [u, v] of boundaryOf(tri, nsh)) {
    // outward direction of the edge inside its triangle's plane
    const tn = owner.get(u * nsh + v)!
    const e = norm(sub(vec(inner, v), vec(inner, u)))
    const w = norm(cross(e, tn))
    const top = w[2] > 0.5 && P.wallTop > 0, bot = w[2] < -0.5 && P.wallBottom > 0
    if (!top && !bot) continue
    const zt = top ? z.hi : z.lo
    const okU = top ? inner[u * 3 + 2] < zt - 1e-6 : inner[u * 3 + 2] > zt + 1e-6
    const okV = top ? inner[v * 3 + 2] < zt - 1e-6 : inner[v * 3 + 2] > zt + 1e-6
    if (!okU && !okV) continue
    const nu = okU ? extrude(u, zt) : u, nvv = okV ? extrude(v, zt) : v
    if (nu !== u && nvv !== v) extra.push(v, u, nu, v, nu, nvv)
    else if (nu !== u) extra.push(v, u, nu)
    else extra.push(v, u, nvv)
  }
  const all = Uint32Array.from([...idx, ...extra])
  const n2 = inner.length / 3
  const positions = new Float32Array(n2 * 6)
  positions.set(inner, 0)
  positions.set(outer, n2 * 3)
  return followResult(positions, all)
}

const vec = (a: number[], i: number): V3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]

function followWall(s: Surf, P: HairParams, z: WallZ): WallResult {
  return followSheet(s, P, z)
}

/** Midpoint-subdivide a triangle soup until no edge is longer than maxEdge (or the triangle budget is reached). */
function refine(s: Surf, maxEdge: number, budget = 40000): Surf {
  let pos = Array.from(s.pos), idx = Array.from(s.idx)
  for (let it = 0; it < 6; it++) {
    let longest = 0
    for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = idx[t + k] * 3, b = idx[t + ((k + 1) % 3)] * 3
      longest = Math.max(longest, Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]))
    }
    if (longest <= maxEdge || (idx.length / 3) * 4 > budget) break
    const mid = new Map<number, number>()
    const m = (a: number, b: number) => {
      const key = Math.min(a, b) * 1e7 + Math.max(a, b)
      let id = mid.get(key)
      if (id === undefined) {
        id = pos.length / 3
        mid.set(key, id)
        pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2)
      }
      return id
    }
    const next: number[] = []
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]]
      const ab = m(a, b), bc = m(b, c), ca = m(c, a)
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca)
    }
    idx = next
  }
  return prepSurface(Float32Array.from(pos), Uint32Array.from(idx))
}

/**
 * Wall through the strand tips: the followed faces, but each point is set out to the (smoothed) distance of the tips around it,
 * so the wall is a smooth surface fitted to the tips instead of a copy of the faces.
 */
function tipsWall(s0: Surf, P: HairParams, raws: Raw[], z: WallZ): WallResult {
  if (!raws.length) throw new Error('No strands to fit a wall through')
  const s = refine(s0, Math.max(2.5, P.length / 6))
  const nv = s.pos.length / 3
  // distance of each tip from its root along the face normal
  const rr = raws.map((r) => {
    const tip = r.poly[r.poly.length - 1]
    const root = add(r.start, mul(r.dir, r.sink))
    return { root, d: Math.max(0.5, dot(sub(tip, root), r.n)) }
  })
  const rho = Math.max(4, 3 * Math.sqrt((s0.total / Math.max(1, raws.length)) || 1))
  const grid = new Map<string, number[]>()
  const key = (p: V3) => `${Math.floor(p[0] / rho)},${Math.floor(p[1] / rho)},${Math.floor(p[2] / rho)}`
  rr.forEach((r, i) => { const k = key(r.root); const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]) })
  const mean = rr.reduce((a, r) => a + r.d, 0) / rr.length
  const raw = new Float32Array(nv)
  for (let v = 0; v < nv; v++) {
    const p: V3 = [s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2]]
    let sw = 0, sd = 0
    const cx = Math.floor(p[0] / rho), cy = Math.floor(p[1] / rho), cz = Math.floor(p[2] / rho)
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let w = -1; w <= 1; w++) {
      for (const i of grid.get(`${cx + x},${cy + y},${cz + w}`) ?? []) {
        const q = rr[i].root
        const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2
        const wt = 1 / (d2 + 0.25)
        sw += wt; sd += wt * rr[i].d
      }
    }
    raw[v] = sw > 0 ? sd / sw : mean
  }
  // a few passes of neighbour averaging make the fitted surface smooth
  const nb: number[][] = Array.from({ length: nv }, () => [])
  for (let t = 0; t < s.idx.length; t += 3) for (let k = 0; k < 3; k++) { const a = s.idx[t + k], b = s.idx[t + ((k + 1) % 3)]; nb[a].push(b); nb[b].push(a) }
  let cur = raw
  for (let it = 0; it < 4; it++) {
    const nx = cur.slice()
    for (let v = 0; v < nv; v++) if (nb[v].length) nx[v] = 0.5 * cur[v] + 0.5 * (nb[v].reduce((a, q) => a + cur[q], 0) / nb[v].length)
    cur = nx
  }
  return followSheet(s, P, z, (v) => cur[v])
}

// ------------------------------------------------------------------ box / cylinder walls

/** Box from an origin and three orthonormal axes with extents [lo, hi] along each. */
function box(o: V3, ax: [V3, V3, V3], lo: V3, hi: V3): Mesh3 {
  const positions = new Float32Array(24)
  for (let i = 0; i < 8; i++) {
    let p = o
    for (let k = 0; k < 3; k++) p = add(p, mul(ax[k], (i >> k) & 1 ? hi[k] : lo[k]))
    positions.set(p, i * 3)
  }
  const quads = [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]]
  const c = [0, 1, 2].reduce((a, k) => add(a, mul(ax[k], (lo[k] + hi[k]) / 2)), o)
  const idx: number[] = []
  for (const q of quads) {
    const P = q.map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]] as V3)
    const n = cross(sub(P[1], P[0]), sub(P[2], P[0]))
    const out = dot(n, sub(P[0], c)) > 0
    idx.push(...(out ? [q[0], q[1], q[2], q[0], q[2], q[3]] : [q[0], q[2], q[1], q[0], q[3], q[2]]))
  }
  return { positions, indices: new Uint32Array(idx) }
}

function cylinderShell(o: V3, a: V3, r0: number, r1: number, z0: number, z1: number): Mesh3 {
  const [e1, e2] = basis(a)
  const M = Math.max(48, Math.min(160, Math.round((2 * Math.PI * r1) / 1.2)))
  const positions = new Float32Array(M * 4 * 3)
  const put = (i: number, r: number, z: number, ang: number) => {
    const p = add(add(o, mul(a, z)), add(mul(e1, r * Math.cos(ang)), mul(e2, r * Math.sin(ang))))
    positions.set(p, i * 3)
  }
  for (let k = 0; k < M; k++) {
    const ang = (2 * Math.PI * k) / M
    put(k, r0, z0, ang); put(M + k, r0, z1, ang); put(2 * M + k, r1, z0, ang); put(3 * M + k, r1, z1, ang)
  }
  const idx: number[] = []
  for (let k = 0; k < M; k++) {
    const j = (k + 1) % M
    const ib = k, ibn = j, it = M + k, itn = M + j, ob = 2 * M + k, obn = 2 * M + j, ot = 3 * M + k, otn = 3 * M + j
    idx.push(ob, obn, otn, ob, otn, ot)
    idx.push(ib, itn, ibn, ib, it, itn)
    idx.push(it, ot, otn, it, otn, itn)
    idx.push(ib, ibn, obn, ib, obn, ob)
  }
  return { positions, indices: new Uint32Array(idx) }
}

const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2])

/** Builds the wall from the surface (follow) or from the envelope of the natural strands (planar / cylindrical). */
export function buildWall(s: Surf, P: HairParams, raws: Raw[], axis: Axis, z: WallZ): WallResult {
  const T = P.wallThickness
  if (P.wallMode === 'follow') return followWall(s, P, z)
  if (P.wallMode === 'tips') return tipsWall(s, P, raws, z)
  if (!raws.length) throw new Error('No strands to build a wall for')
  const tipOf = (r: Raw) => r.poly[r.poly.length - 1]
  const tanOf = (r: Raw): V3 => norm(sub(r.poly[r.poly.length - 1], r.poly[r.poly.length - 2]))
  const roots = raws.map((r) => add(r.start, mul(r.dir, 0.2)))
  const reach = Math.max(1, 0.2 * P.length)

  if (P.wallMode === 'planar') {
    const mean = raws.reduce((a, r) => add(a, r.dir), [0, 0, 0] as V3)
    let N: V3 = norm(P.wallDir)
    if (!N.some(Boolean)) N = norm(mean)
    if (!N.some(Boolean)) throw new Error('Cannot infer the wall plane; set the plane normal')
    if (dot(N, mean) < 0) N = mul(N, -1)
    let V = sub([0, 0, 1], mul(N, N[2]))
    V = len3(V) > 1e-3 ? norm(V) : norm(sub([0, 1, 0], mul(N, N[1])))
    const U = cross(V, N)
    // inner face: at the mean tip distance but always beyond every root so no strand starts inside the wall
    const meanTip = raws.reduce((a, r) => a + dot(tipOf(r), N), 0) / raws.length
    const off = Math.max(meanTip, Math.max(...roots.map((q) => dot(q, N))) + reach)
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    const grow = (q: V3) => {
      u0 = Math.min(u0, dot(q, U)); u1 = Math.max(u1, dot(q, U))
      v0 = Math.min(v0, dot(q, V)); v1 = Math.max(v1, dot(q, V))
    }
    for (const r of raws) {
      const tip = tipOf(r), t = tanOf(r)
      grow(tip)
      const c = dot(t, N)
      if (c > 0.05) grow(add(tip, mul(t, (off - dot(tip, N)) / c))) // where the strand actually lands
    }
    const pad = Math.max(2, 0.06 * (u1 - u0))
    const horiz = Math.abs(N[2]) < 1e-3 // vertical wall: V is exactly world Z, so the flat top and bottom land on the shared heights
    return { mesh: box([0, 0, 0], [U, V, N], [u0 - pad, horiz ? Math.min(v0 - P.wallBottom, z.lo) : v0 - P.wallBottom, off], [u1 + pad, horiz ? Math.max(v1 + P.wallTop, z.hi) : v1 + P.wallTop, off + T]) }
  }

  // cylindrical
  let o = axis.o, a = norm(axis.d)
  if (P.dirMode !== 'radial' || !a.some(Boolean)) {
    a = [0, 0, 1]
    o = roots.reduce((acc, q) => add(acc, q), [0, 0, 0] as V3).map((x) => x / roots.length) as V3
  }
  const dist = (q: V3) => {
    const w = sub(q, o)
    return len3(sub(w, mul(a, dot(w, a))))
  }
  const meanR = raws.reduce((acc, r) => acc + dist(tipOf(r)), 0) / raws.length
  const R = Math.max(meanR, Math.max(...roots.map(dist)) + reach)
  if (R < 1) throw new Error('Cylindrical wall radius is too small; use a different axis or wall mode')
  let z0 = Infinity, z1 = -Infinity
  for (const r of raws) for (const q of [tipOf(r), r.start]) {
    z0 = Math.min(z0, dot(sub(q, o), a)); z1 = Math.max(z1, dot(sub(q, o), a))
  }
  const vert = a[2] > 0.999 // axis along Z: the flat ends are the shared heights
  return { mesh: cylinderShell(o, a, R, R + T, vert ? Math.min(z0 - P.wallBottom, z.lo - o[2]) : z0 - P.wallBottom, vert ? Math.max(z1 + P.wallTop, z.hi - o[2]) : z1 + P.wallTop) }
}

// ------------------------------------------------------------------ robust wall volume (signed distance field)

export interface WallField {
  /** positive inside the wall, negative outside (manifold-3d levelSet convention) */
  sdf: (p: V3) => number
  min: V3
  max: V3
  /** half the wall thickness */
  half: number
}

/**
 * The wall volume as an SDF: every point within half a thickness of the follow sheet's mid-surface. This is the union of
 * balls swept along the mid-sheet, so it is well defined (and the iso-surface is manifold) even where the offset shell
 * folds through itself. Distance queries run on a BVH, so evaluation is O(log n) per sample.
 */
export function wallField(f: NonNullable<WallResult['follow']>): WallField {
  const nv = f.positions.length / 6
  const mid = new Float32Array(nv * 3)
  let half = 0
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity]
  for (let v = 0; v < nv; v++) {
    let d2 = 0
    for (let k = 0; k < 3; k++) {
      const b = f.positions[v * 3 + k], t = f.positions[(nv + v) * 3 + k]
      mid[v * 3 + k] = (b + t) / 2
      d2 += (t - b) * (t - b)
      min[k] = Math.min(min[k], b, t); max[k] = Math.max(max[k], b, t)
    }
    half += Math.sqrt(d2) / 2
  }
  half /= Math.max(1, nv)
  const { bvh } = bvhOf({ positions: mid, indices: f.tris })
  const q = new Vector3()
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 }
  return {
    half,
    min, max,
    sdf: (p) => {
      q.set(p[0], p[1], p[2])
      const h = bvh.closestPointToPoint(q, target)
      return h ? half - h.distance : -1
    },
  }
}
