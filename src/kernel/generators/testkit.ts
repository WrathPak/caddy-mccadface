/** Helpers shared by the unit tests of the surface tools (real manifold in Node). Not imported by the app. */
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import type { TopoMesh } from '../types'

export interface Soup { positions: Float32Array; indices: Uint32Array }

export function meshOf(m: Manifold): TopoMesh {
  const mesh = m.getMesh()
  return { positions: Float32Array.from(mesh.vertProperties), indices: Uint32Array.from(mesh.triVerts) }
}

export function triNormal(m: TopoMesh, t: number): [number, number, number] {
  const p = (k: number) => [m.positions[m.indices[t * 3 + k] * 3], m.positions[m.indices[t * 3 + k] * 3 + 1], m.positions[m.indices[t * 3 + k] * 3 + 2]]
  const a = p(0), b = p(1), c = p(2)
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0]
  const l = Math.hypot(x, y, z) || 1
  return [x / l, y / l, z / l]
}

export const centroid = (m: TopoMesh, t: number): [number, number, number] => {
  const c: [number, number, number] = [0, 0, 0]
  for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) c[a] += m.positions[m.indices[t * 3 + k] * 3 + a] / 3
  return c
}

/** Triangles accepted by `pick` as an unwelded soup, and the rest of the mesh as another. */
export function split(m: TopoMesh, pick: (n: [number, number, number], c: [number, number, number]) => boolean): { region: Soup; others: Soup } {
  const sel: number[] = [], rest: number[] = []
  for (let t = 0; t < m.indices.length / 3; t++) (pick(triNormal(m, t), centroid(m, t)) ? sel : rest).push(t)
  const soup = (ts: number[]): Soup => {
    const p: number[] = []
    for (const t of ts) for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) p.push(m.positions[m.indices[t * 3 + k] * 3 + a])
    return { positions: Float32Array.from(p), indices: Uint32Array.from({ length: p.length / 3 }, (_, i) => i) }
  }
  return { region: soup(sel), others: soup(rest) }
}

export function cube(W: ManifoldToplevel, size: [number, number, number], at: [number, number, number] = [0, 0, 0]): Manifold {
  return W.Manifold.cube(size).translate(at)
}

export function cylinder(W: ManifoldToplevel, r: number, h: number, segs = 96): Manifold {
  return W.Manifold.cylinder(h, r, r, segs)
}
