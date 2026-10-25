/**
 * Picking BVH built off the main thread. Lives apart from bigmesh.ts because it pulls in three.js, which the kernel worker
 * (B-rep ops, startup) does not load: only the compute pool builds BVHs. Bodies the kernel makes itself get theirs on the main thread.
 */
import { BufferAttribute, BufferGeometry } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { MeshBvh, MeshData } from './types'

/** Bodies with more triangles than this come with a worker built BVH when the pool made them. */
export const BVH_WORKER_TRIS = 30_000

/** Build the picking BVH for an indexed mesh (indirect, so `indices` is left untouched). */
export function buildMeshBvh(positions: Float32Array, indices: Uint32Array): MeshBvh {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(positions, 3))
  g.setIndex(new BufferAttribute(indices, 1))
  const bvh = new MeshBVH(g, { indirect: true })
  const s = MeshBVH.serialize(bvh, { cloneBuffers: false })
  return { roots: s.roots as ArrayBuffer[], indirect: s.indirectBuffer as Uint32Array }
}

export function withBvh(m: MeshData): MeshData {
  if (!m.bvh && m.indices.length / 3 > BVH_WORKER_TRIS) m.bvh = buildMeshBvh(m.positions, m.indices)
  return m
}
