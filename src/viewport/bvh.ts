/** Installs three-mesh-bvh accelerated raycasting globally (import once, for side effects). */
import { BufferGeometry, Mesh } from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

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
