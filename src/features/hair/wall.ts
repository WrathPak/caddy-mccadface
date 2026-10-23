/** Sacrificial wall: closed watertight shells (follow-surface / planar / cylindrical), a ray caster and self-intersection repair data. */
import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Ray, Vector3 } from 'three'
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh'
import type { HairParams, V3 } from './schema'
import type { Surf } from './sampling'
import type { Raw } from './strands'
import { add, basis, cross, dot, mul, norm, sub } from './vec'

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

/** Grow the region past its open boundary: top/bottom margins along the surface, scaled by how much the edge faces up/down. */
function extendRegion(s: Surf, top: number, bottom: number): Geo {
  const nv = s.pos.length / 3
  const o = new Float32Array(nv * 3)
  for (const [a, b] of s.boundary) {
    const e = norm(sub([s.pos[b * 3], s.pos[b * 3 + 1], s.pos[b * 3 + 2]], [s.pos[a * 3], s.pos[a * 3 + 1], s.pos[a * 3 + 2]]))
    const n = norm([s.vn[a * 3] + s.vn[b * 3], s.vn[a * 3 + 1] + s.vn[b * 3 + 1], s.vn[a * 3 + 2] + s.vn[b * 3 + 2]])
    const w = norm(cross(e, n)) // outward, in the surface plane
    for (const v of [a, b]) for (let k = 0; k < 3; k++) o[v * 3 + k] += w[k]
  }
  const vtx = new Set<number>()
  for (const [a, b] of s.boundary) { vtx.add(a); vtx.add(b) }
  const extra: number[] = [], map = new Map<number, number>()
  const pos = Array.from(s.pos), vn = Array.from(s.vn)
  for (const v of vtx) {
    const w = norm([o[v * 3], o[v * 3 + 1], o[v * 3 + 2]])
    const m = w[2] > 0 ? top * w[2] : bottom * -w[2]
    if (m < 1e-6) continue
    const id = pos.length / 3
    map.set(v, id)
    pos.push(s.pos[v * 3] + w[0] * m, s.pos[v * 3 + 1] + w[1] * m, s.pos[v * 3 + 2] + w[2] * m)
    vn.push(s.vn[v * 3], s.vn[v * 3 + 1], s.vn[v * 3 + 2])
  }
  const idx = Array.from(s.idx)
  for (const [u, v] of s.boundary) {
    const nu = map.get(u), nvv = map.get(v)
    // the strip contains the reverse edge v->u so winding stays consistent with the region
    if (nu !== undefined && nvv !== undefined) extra.push(v, u, nu, v, nu, nvv)
    else if (nu !== undefined) extra.push(v, u, nu)
    else if (nvv !== undefined) extra.push(v, u, nvv)
  }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from([...idx, ...extra]), vn: Float32Array.from(vn) }
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
function clampedOffsets(g: Geo, adj: ReturnType<typeof adjacency>, sn: Float32Array, D: number, T: number): Float32Array {
  const nv = g.pos.length / 3
  const lim = new Float32Array(nv).fill(D)
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

function followWall(s: Surf, P: HairParams): WallResult {
  const D = P.length, T = P.wallThickness
  const g = P.wallTop > 0 || P.wallBottom > 0 ? extendRegion(s, P.wallTop, P.wallBottom) : { pos: s.pos, idx: s.idx, vn: s.vn }
  const nv = g.pos.length / 3
  const adj = adjacency(g)
  const sn = smoothNormals(g, adj, Math.max(0.5, 0.4 * D))
  const off = clampedOffsets(g, adj, sn, D, T)
  const positions = new Float32Array(nv * 6)
  for (let v = 0; v < nv; v++) {
    for (let k = 0; k < 3; k++) {
      positions[v * 3 + k] = g.pos[v * 3 + k] + sn[v * 3 + k] * off[v]
      positions[(nv + v) * 3 + k] = g.pos[v * 3 + k] + sn[v * 3 + k] * (off[v] + T)
    }
  }
  return followResult(positions, g.idx)
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
export function buildWall(s: Surf, P: HairParams, raws: Raw[], axis: Axis): WallResult {
  const T = P.wallThickness
  if (P.wallMode === 'follow') return followWall(s, P)
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
    return { mesh: box([0, 0, 0], [U, V, N], [u0 - pad, v0 - P.wallBottom, off], [u1 + pad, v1 + P.wallTop, off + T]) }
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
  return { mesh: cylinderShell(o, a, R, R + T, z0 - P.wallBottom, z1 + P.wallTop) }
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
