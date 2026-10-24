/**
 * Queries on the selected surface shared by the surface tools: closest point, and a height field along a chosen direction
 * (used to lay text and instances onto curved faces).
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { normalAt, patchNormalAt, type Surf } from '../../features/hair/sampling'
import type { V3 } from '../../features/hair/schema'
import { add, cross, dot, mul, norm, perp, sub } from '../../features/hair/vec'

export interface Frame {
  o: V3
  /** unit tangent axes and the unit direction the height is measured along */
  x: V3
  y: V3
  n: V3
}

/** Right-handed frame at `o` with normal n. x is `ref` projected into the tangent plane (falls back to any perpendicular). */
export function frameAt(o: V3, n: V3, ref: V3 = [0, 0, 1]): Frame {
  const nn = norm(n)
  let y = sub(ref, mul(nn, dot(ref, nn)))
  if (Math.hypot(...y) < 1e-3) y = sub([0, 1, 0], mul(nn, nn[1]))
  y = norm(y)
  if (!y.some(Boolean)) y = perp(nn)
  const x = norm(cross(y, nn))
  return { o, x, y, n: nn }
}

/** Rotate a frame about its normal by `deg` degrees. */
export function spin(f: Frame, deg: number): Frame {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180)
  return { o: f.o, n: f.n, x: add(mul(f.x, c), mul(f.y, s)), y: add(mul(f.y, c), mul(f.x, -s)) }
}

export const toWorld = (f: Frame, x: number, y: number, h: number): V3 => [
  f.o[0] + f.x[0] * x + f.y[0] * y + f.n[0] * h,
  f.o[1] + f.x[1] * x + f.y[1] * y + f.n[1] * h,
  f.o[2] + f.x[2] * x + f.y[2] * y + f.n[2] * h,
]

export class SurfaceProbe {
  readonly bvh: MeshBVH
  private geo: BufferGeometry
  private ray = new Ray()
  /** bounding radius of the surface about its centre, used to start rays outside it */
  readonly reach: number
  constructor(readonly s: Surf) {
    this.geo = new BufferGeometry()
    this.geo.setAttribute('position', new BufferAttribute(s.pos, 3))
    // the BVH build reorders triangles unless it is indirect: keep the surface's own index untouched
    this.geo.setIndex(new BufferAttribute(s.idx.slice(), 1))
    this.bvh = new MeshBVH(this.geo, { indirect: true })
    this.geo.computeBoundingSphere()
    this.reach = this.geo.boundingSphere!.radius * 2 + 1
  }

  /** Nearest point on the surface. */
  closest(p: V3): { point: V3; dist: number; tri: number } {
    const r = this.bvh.closestPointToPoint(new Vector3(p[0], p[1], p[2]))
    if (!r) throw new Error('The selected surface is empty')
    return { point: [r.point.x, r.point.y, r.point.z], dist: r.distance, tri: r.faceIndex }
  }

  /** Smooth surface normal (within its patch) at a point of triangle `tri`. */
  normal(tri: number, p: V3): V3 { return patchNormalAt(this.s, tri, p) }
  /** Normal smoothed across the whole region (no creases). */
  smoothNormal(tri: number, p: V3): V3 { return normalAt(this.s, tri, p) }

  /**
   * Height of the surface above the plane of `f` at tangent coordinates (x, y), measured along f.n. Of several layers the one
   * closest to `ref` wins. Off the surface the nearest surface point's height is used and `inside` is false.
   */
  height(f: Frame, x: number, y: number, ref = 0): { h: number; tri: number; inside: boolean } {
    const top = this.reach
    const o = toWorld(f, x, y, top)
    this.ray.origin.set(o[0], o[1], o[2])
    this.ray.direction.set(-f.n[0], -f.n[1], -f.n[2])
    const hits = this.bvh.raycast(this.ray, DoubleSide) as { distance: number; faceIndex?: number }[]
    let best: { h: number; tri: number } | null = null
    for (const h of hits) {
      const hh = top - h.distance
      if (!best || Math.abs(hh - ref) < Math.abs(best.h - ref)) best = { h: hh, tri: h.faceIndex ?? 0 }
    }
    if (best) return { ...best, inside: true }
    const c = this.closest(toWorld(f, x, y, ref))
    return { h: dot(sub(c.point, f.o), f.n), tri: c.tri, inside: false }
  }
}
