/** Minimum clearance between two sets of placed meshes (triangle to triangle, through a BVH). */
import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { Vec3 } from '@/kernel/types'
import type { Mat4 } from './matrix'

export interface PlacedMesh { positions: Float32Array; indices: Uint32Array; matrix: Mat4 }

function worldGeometry(m: PlacedMesh): BufferGeometry {
  const p = new Float32Array(m.positions.length)
  const k = m.matrix
  for (let i = 0; i < p.length; i += 3) {
    const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2]
    p[i] = k[0] * x + k[4] * y + k[8] * z + k[12]
    p[i + 1] = k[1] * x + k[5] * y + k[9] * z + k[13]
    p[i + 2] = k[2] * x + k[6] * y + k[10] * z + k[14]
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(p, 3))
  g.setIndex(new BufferAttribute(m.indices.slice(), 1))
  return g
}

export interface Closest { distance: number; pa: Vec3; pb: Vec3 }

/**
 * Smallest distance between any mesh of `a` and any mesh of `b`, with the closest points. 0 when they touch or overlap.
 * The distance is measured on the tessellation (within the tessellation tolerance of the exact surfaces).
 */
export function minClearance(a: PlacedMesh[], b: PlacedMesh[]): Closest | null {
  if (!a.length || !b.length) return null
  let best: Closest | null = null
  const identity = new Matrix4()
  const bg = b.map(worldGeometry)
  for (const am of a) {
    const ag = worldGeometry(am)
    const bvh = new MeshBVH(ag)
    for (const g of bg) {
      if (bvh.intersectsGeometry(g, identity)) {
        // overlapping: report where, with zero distance
        g.computeBoundingBox()
        const c = new Vector3()
        g.boundingBox!.getCenter(c)
        return { distance: 0, pa: [c.x, c.y, c.z], pb: [c.x, c.y, c.z] }
      }
      const t1: { point?: Vector3 } = {}, t2: { point?: Vector3 } = {}
      const r = bvh.closestPointToGeometry(g, identity, t1 as never, t2 as never, 0, best ? best.distance : Infinity)
      if (r && (!best || r.distance < best.distance)) {
        const p1 = (t1.point ?? r.point) as Vector3, p2 = (t2.point ?? new Vector3()) as Vector3
        best = { distance: r.distance, pa: [p1.x, p1.y, p1.z], pb: [p2.x, p2.y, p2.z] }
      }
    }
    ag.dispose()
  }
  for (const g of bg) g.dispose()
  return best
}
