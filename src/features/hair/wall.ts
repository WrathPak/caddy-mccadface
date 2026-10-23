/** Sacrificial wall: closed watertight shells (follow-surface / planar / cylindrical) plus a ray caster. */
import { BufferAttribute, BufferGeometry, DoubleSide, Ray } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { HairParams, V3 } from './schema'
import { boundaryEdges, smoothNormals, type Surf } from './sampling'
import type { Plan } from './strands'
import { add, basis, cross, dot, mul, norm, sub } from './vec'

export interface Mesh3 { positions: Float32Array; indices: Uint32Array }
export interface Axis { o: V3; d: V3 }
export type Caster = (origin: V3, dir: V3, maxDist: number) => number | null

/** Distance to the first wall hit along a segment, or null. */
export function makeCaster(m: Mesh3): Caster {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(m.positions, 3))
  g.setIndex(new BufferAttribute(m.indices, 1))
  const bvh = new MeshBVH(g)
  const ray = new Ray()
  return (o, d, far) => {
    ray.origin.set(o[0], o[1], o[2])
    ray.direction.set(d[0], d[1], d[2])
    const h = bvh.raycastFirst(ray, DoubleSide, 0, far)
    return h ? h.distance : null
  }
}

/** Offset the region along smoothed vertex normals by D, thicken by T, close along the open boundary. */
function followWall(s: Surf, D: number, T: number): Mesh3 {
  const nv = s.pos.length / 3
  const sn = smoothNormals(s, 4)
  const positions = new Float32Array(nv * 6)
  for (let v = 0; v < nv; v++) {
    for (let k = 0; k < 3; k++) {
      positions[v * 3 + k] = s.pos[v * 3 + k] + sn[v * 3 + k] * D
      positions[(nv + v) * 3 + k] = s.pos[v * 3 + k] + sn[v * 3 + k] * (D + T)
    }
  }
  const edges = boundaryEdges(s)
  const idx: number[] = []
  for (let t = 0; t < s.idx.length; t += 3) {
    const a = s.idx[t], b = s.idx[t + 1], c = s.idx[t + 2]
    idx.push(a + nv, b + nv, c + nv, a, c, b)
  }
  for (const [u, v] of edges) idx.push(u, v, v + nv, u, v + nv, u + nv)
  return { positions, indices: new Uint32Array(idx) }
}

/** Box from an origin and three orthonormal axes with extents [lo, hi] along each. */
function box(o: V3, ax: [V3, V3, V3], lo: V3, hi: V3): Mesh3 {
  const positions = new Float32Array(24)
  for (let i = 0; i < 8; i++) {
    let p = o
    for (let k = 0; k < 3; k++) p = add(p, mul(ax[k], (i >> k) & 1 ? hi[k] : lo[k]))
    positions.set(p, i * 3)
  }
  // quads as vertex index cycles; orientation is fixed against the box center
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
  // ring layout: 0 inner-bottom, 1 inner-top, 2 outer-bottom, 3 outer-top
  for (let k = 0; k < M; k++) {
    const ang = (2 * Math.PI * k) / M
    put(k, r0, z0, ang); put(M + k, r0, z1, ang); put(2 * M + k, r1, z0, ang); put(3 * M + k, r1, z1, ang)
  }
  const idx: number[] = []
  for (let k = 0; k < M; k++) {
    const j = (k + 1) % M
    const ib = k, ibn = j, it = M + k, itn = M + j, ob = 2 * M + k, obn = 2 * M + j, ot = 3 * M + k, otn = 3 * M + j
    idx.push(ob, obn, otn, ob, otn, ot) // outer, faces out
    idx.push(ib, itn, ibn, ib, it, itn) // inner, faces the axis
    idx.push(it, ot, otn, it, otn, itn) // top annulus
    idx.push(ib, ibn, obn, ib, obn, ob) // bottom annulus
  }
  return { positions, indices: new Uint32Array(idx) }
}

export function buildWall(s: Surf, P: HairParams, plan: Plan, axis: Axis): Mesh3 {
  const D = P.length, T = P.wallThickness
  if (P.wallMode === 'follow') return followWall(s, D, T)
  const live: number[] = []
  for (let i = 0; i < plan.count; i++) if (!plan.drop[i]) live.push(i)
  if (!live.length) throw new Error('No strands to build a wall for')
  const pt = (i: number): V3 => [plan.p[i * 3], plan.p[i * 3 + 1], plan.p[i * 3 + 2]]
  const dr = (i: number): V3 => [plan.dir[i * 3], plan.dir[i * 3 + 1], plan.dir[i * 3 + 2]]
  const tip = (i: number) => add(pt(i), mul(dr(i), D))

  if (P.wallMode === 'planar') {
    let N: V3 = norm(P.wallDir)
    const mean = live.reduce((a, i) => add(a, dr(i)), [0, 0, 0] as V3)
    if (!norm(N).some(Boolean)) N = norm(mean)
    if (!N.some(Boolean)) throw new Error('Cannot infer the wall plane; set the plane normal')
    if (dot(N, mean) < 0) N = mul(N, -1)
    let V = sub([0, 0, 1], mul(N, N[2]))
    V = len3(V) > 1e-3 ? norm(V) : norm(sub([0, 1, 0], mul(N, N[1])))
    const U = cross(V, N)
    const off = live.reduce((a, i) => a + dot(tip(i), N), 0) / live.length
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    for (const i of live) for (const q of [pt(i), tip(i)]) {
      u0 = Math.min(u0, dot(q, U)); u1 = Math.max(u1, dot(q, U))
      v0 = Math.min(v0, dot(q, V)); v1 = Math.max(v1, dot(q, V))
    }
    const pad = Math.max(2, 0.06 * (u1 - u0))
    return box([0, 0, 0], [U, V, N], [u0 - pad, v0 - P.wallBottom, off], [u1 + pad, v1 + P.wallTop, off + T])
  }

  // cylindrical
  let o = axis.o, a = norm(axis.d)
  if (P.dirMode !== 'radial' || !a.some(Boolean)) {
    a = [0, 0, 1]
    o = live.reduce((acc, i) => add(acc, pt(i)), [0, 0, 0] as V3).map((x) => x / live.length) as V3
  }
  const dist = (q: V3) => {
    const w = sub(q, o)
    return len3(sub(w, mul(a, dot(w, a))))
  }
  const R = live.reduce((acc, i) => acc + dist(tip(i)), 0) / live.length
  if (R < 1) throw new Error('Cylindrical wall radius is too small; use a different axis or wall mode')
  let z0 = Infinity, z1 = -Infinity
  for (const i of live) for (const q of [pt(i), tip(i)]) {
    z0 = Math.min(z0, dot(sub(q, o), a)); z1 = Math.max(z1, dot(sub(q, o), a))
  }
  return cylinderShell(o, a, R, R + T, z0 - P.wallBottom, z1 + P.wallTop)
}

const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2])
