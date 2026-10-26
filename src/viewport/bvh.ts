/** Installs three-mesh-bvh accelerated raycasting globally (import once, for side effects). */
import { BufferGeometry, Mesh } from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH } from 'three-mesh-bvh'
import type { MeshBvh } from '@/kernel/types'

/* eslint-disable @typescript-eslint/no-explicit-any */
;(BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree
;(BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree
;(Mesh.prototype as any).raycast = acceleratedRaycast

/**
 * `indirect` keeps the geometry's index buffer in its original order: the default build reorders it IN PLACE, and the
 * mesh's per-triangle `faceIds` (B-rep face indices, hence the persistent face names) are indexed by the original triangle
 * order, so a reordered buffer would make every pick, highlight and face subset point at the wrong face.
 */
export function buildBvh(geo: BufferGeometry) {
  ;(geo as any).computeBoundsTree?.({ indirect: true })
  return geo
}

/** Attach a BVH that a worker already built (cheap: the node buffers are used as they are). */
export function attachBvh(geo: BufferGeometry, bvh: MeshBvh) {
  const index = geo.getIndex()!.array
  ;(geo as any).boundsTree = MeshBVH.deserialize({ version: 1, roots: bvh.roots, index, indirectBuffer: bvh.indirect } as never, geo, { setIndex: false })
  return geo
}
