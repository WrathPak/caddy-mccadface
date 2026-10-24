/**
 * Shared solid-building stage of every surface generator (hair, fur, scales, spikes, grass): instances are collected as
 * closed meshes, each becomes a manifold, the manifolds are unioned, and the union is fused with the target body.
 * Pure manifold-3d code, no worker or DOM dependencies.
 */
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import type { Mesh3 } from '../../features/hair/wall'
import type { TopoMesh } from '../types'

/** Many closed meshes stored back to back. `ranges` is [firstVertex, vertexCount, firstIndex, indexCount] per instance. */
export interface InstanceSet {
  positions: Float32Array
  indices: Uint32Array
  ranges: Uint32Array
  count: number
}

/** Collects closed instance meshes (indices are local to each instance's own vertex list). */
export class InstanceBuilder {
  private pos: number[] = []
  private idx: number[] = []
  private ranges: number[] = []
  /** Appends one closed mesh given as flat positions and local triangle indices. */
  add(positions: ArrayLike<number>, indices: ArrayLike<number>) {
    const v0 = this.pos.length / 3, i0 = this.idx.length
    for (let i = 0; i < positions.length; i++) this.pos.push(positions[i])
    for (let i = 0; i < indices.length; i++) this.idx.push(indices[i] + v0)
    this.ranges.push(v0, positions.length / 3, i0, indices.length)
  }
  get count() { return this.ranges.length / 4 }
  build(): InstanceSet {
    return { positions: Float32Array.from(this.pos), indices: Uint32Array.from(this.idx), ranges: Uint32Array.from(this.ranges), count: this.ranges.length / 4 }
  }
}

const friendly = (what: string, status: string) =>
  `${what} is not a valid closed solid (${status}). Repair the mesh${what.includes('target') ? ' or turn off "Merge into target body"' : ''} and try again`

/** A validated manifold from a closed mesh; throws a readable error when the mesh is not a solid. */
export function solidOf(W: ManifoldToplevel, m3: Mesh3 | TopoMesh, what: string, own: (m: Manifold) => Manifold): Manifold {
  let m: Manifold
  try {
    m = own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: m3.positions.slice(), triVerts: m3.indices.slice() })))
  } catch (e) {
    throw new Error(friendly(what, e instanceof Error ? e.message : String(e)))
  }
  if (m.status() !== 'NoError' || m.isEmpty() || m.volume() <= 0) throw new Error(friendly(what, m.status()))
  return m
}

/** One manifold per instance (invalid ones are counted and skipped). */
export function instanceManifolds(W: ManifoldToplevel, set: InstanceSet, own: (m: Manifold) => Manifold): { solids: Manifold[]; bad: number } {
  const solids: Manifold[] = []
  let bad = 0
  for (let r = 0; r < set.count; r++) {
    const v0 = set.ranges[r * 4], vn = set.ranges[r * 4 + 1], i0 = set.ranges[r * 4 + 2], inn = set.ranges[r * 4 + 3]
    const ix = new Uint32Array(inn)
    for (let k = 0; k < inn; k++) ix[k] = set.indices[i0 + k] - v0
    try {
      const m = own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: set.positions.slice(v0 * 3, (v0 + vn) * 3), triVerts: ix })))
      if (m.status() === 'NoError' && !m.isEmpty() && m.volume() > 0) solids.push(m)
      else bad++
    } catch { bad++ }
  }
  return { solids, bad }
}

/** Union of all instances. Throws when no instance formed a closed solid. */
export function unionInstances(W: ManifoldToplevel, set: InstanceSet, own: (m: Manifold) => Manifold): { union: Manifold; bad: number } {
  const { solids, bad } = instanceManifolds(W, set, own)
  if (!solids.length) throw new Error('Geometry was invalid (no instance formed a closed solid)')
  return { union: own(W.Manifold.union(solids)), bad }
}

/** Interleaved positions / indices of a manifold (positions only; extra property channels are dropped). */
export function topoOfManifold(man: Manifold): TopoMesh {
  const mesh = man.getMesh()
  const np = mesh.numProp
  let positions: Float32Array
  if (np === 3) positions = mesh.vertProperties.slice()
  else {
    positions = new Float32Array((mesh.vertProperties.length / np) * 3)
    for (let i = 0, n = positions.length / 3; i < n; i++) positions.set(mesh.vertProperties.subarray(i * np, i * np + 3), i * 3)
  }
  return { positions, indices: mesh.triVerts.slice() }
}
