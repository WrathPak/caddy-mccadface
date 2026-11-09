/**
 * Whole flat faces for Lay on face. A click lands on one triangle; the face the user means is the whole planar region around it
 * (the way Bambu Studio highlights flat facets). B-rep bodies: every triangle of the clicked B-rep face when it is planar. Meshes
 * (and B-rep faces split into several coplanar faces): connected triangles on the same plane, normals within ~1.5 degrees.
 */
import type { Vec3 } from '@/kernel/types'

export interface FaceMesh { positions: ArrayLike<number>; indices: ArrayLike<number>; faceIds?: ArrayLike<number>; faceCount?: number }
export interface FaceRegion {
  /** triangle indices of the region */
  tris: number[]
  /** outward unit normal of the region, in the mesh's own space */
  normal: Vec3
  area: number
}

const NORMAL_TOL = Math.cos((1.5 * Math.PI) / 180)
const BREP_PLANAR_TOL = Math.cos((2 * Math.PI) / 180)
const PLANE_TOL = 0.03

interface Topo { n: Float32Array; area: Float32Array; adj: number[][] }
const cache = new WeakMap<object, { idx: object; topo: Topo }>()

function topoOf(m: FaceMesh): Topo {
  const hit = cache.get(m.positions as object)
  if (hit && hit.idx === (m.indices as object)) return hit.topo
  const p = m.positions, ix = m.indices
  const T = ix.length / 3, V = p.length / 3
  // weld vertices by position so a mesh whose triangles do not share indices still has neighbours
  const weld = new Int32Array(V)
  const seen = new Map<string, number>()
  for (let v = 0; v < V; v++) {
    const k = `${Math.round(p[v * 3] * 1e4)},${Math.round(p[v * 3 + 1] * 1e4)},${Math.round(p[v * 3 + 2] * 1e4)}`
    let id = seen.get(k)
    if (id === undefined) { id = seen.size; seen.set(k, id) }
    weld[v] = id
  }
  const W = seen.size + 1
  const n = new Float32Array(T * 3), area = new Float32Array(T)
  const edges = new Map<number, number[]>()
  for (let t = 0; t < T; t++) {
    const a = ix[t * 3], b = ix[t * 3 + 1], c = ix[t * 3 + 2]
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z)
    area[t] = l / 2
    if (l > 1e-12) { n[t * 3] = x / l; n[t * 3 + 1] = y / l; n[t * 3 + 2] = z / l }
    const w = [weld[a], weld[b], weld[c]]
    for (let e = 0; e < 3; e++) {
      const i = w[e], j = w[(e + 1) % 3]
      if (i === j) continue
      const key = Math.min(i, j) * W + Math.max(i, j)
      const list = edges.get(key)
      if (list) list.push(t); else edges.set(key, [t])
    }
  }
  const adj: number[][] = Array.from({ length: T }, () => [])
  for (const list of edges.values()) for (const s of list) for (const o of list) if (s !== o) adj[s].push(o)
  const topo = { n, area, adj }
  cache.set(m.positions as object, { idx: m.indices as object, topo })
  return topo
}

/** The planar region around triangle `tri`, or null when the click is on a curved B-rep face (nothing flat to lay on). */
export function faceRegion(m: FaceMesh, tri: number): FaceRegion | null {
  const T = m.indices.length / 3
  if (tri < 0 || tri >= T) return null
  const { n, area, adj } = topoOf(m)
  const p = m.positions, ix = m.indices
  const brep = !!m.faceIds && m.faceCount !== undefined
  let seeds: number[] = [tri]
  if (brep) {
    const id = m.faceIds![tri]
    seeds = []
    for (let t = 0; t < T; t++) if (m.faceIds![t] === id) seeds.push(t)
  }
  // the normal of the seed set, weighted by area (a sliver's own normal is noisy)
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, sa = 0
  for (const t of seeds) {
    const a = area[t]
    nx += n[t * 3] * a; ny += n[t * 3 + 1] * a; nz += n[t * 3 + 2] * a
    for (let k = 0; k < 3; k++) { const v = ix[t * 3 + k] * 3; cx += p[v] * a / 3; cy += p[v + 1] * a / 3; cz += p[v + 2] * a / 3 }
    sa += a
  }
  const nl = Math.hypot(nx, ny, nz)
  if (nl < 1e-12 || sa < 1e-12) return null
  const N: Vec3 = [nx / nl, ny / nl, nz / nl]
  if (brep) for (const t of seeds) if (area[t] > 1e-9 && n[t * 3] * N[0] + n[t * 3 + 1] * N[1] + n[t * 3 + 2] * N[2] < BREP_PLANAR_TOL) return null
  const d0 = (cx * N[0] + cy * N[1] + cz * N[2]) / sa
  const onPlane = (t: number) => {
    for (let k = 0; k < 3; k++) {
      const v = ix[t * 3 + k] * 3
      if (Math.abs(p[v] * N[0] + p[v + 1] * N[1] + p[v + 2] * N[2] - d0) > PLANE_TOL) return false
    }
    return true
  }
  const inRegion = new Set<number>(seeds)
  const queue = [...seeds]
  while (queue.length) {
    const t = queue.pop()!
    for (const o of adj[t]) {
      if (inRegion.has(o) || !onPlane(o)) continue
      if (area[o] > 1e-9 && n[o * 3] * N[0] + n[o * 3 + 1] * N[1] + n[o * 3 + 2] * N[2] < NORMAL_TOL) continue
      inRegion.add(o); queue.push(o)
    }
  }
  const tris = [...inRegion]
  return { tris, normal: N, area: tris.reduce((s, t) => s + area[t], 0) }
}
