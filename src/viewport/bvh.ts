/** Installs three-mesh-bvh accelerated raycasting globally (import once, for side effects). */
import { BufferGeometry, Mesh } from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

/* eslint-disable @typescript-eslint/no-explicit-any */
;(BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree
;(BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree
;(Mesh.prototype as any).raycast = acceleratedRaycast

export function buildBvh(geo: BufferGeometry) {
  ;(geo as any).computeBoundsTree?.()
  return geo
}
