/**
 * Join / Cut that follows the Extrude arrow, like Fusion: drag a profile (or a face) into the body and the operation becomes Cut,
 * drag it back out and it is Join again.
 *
 * "Into the body" is decided once per profile, with no kernel round trip: find which side of the profile plane the material lies on
 * (`bodySide`), then compare it with the world direction the extrusion goes (`worldDir`). Material is found by a ray parity test
 * against the body meshes, on points a hair off the plane on each side of it. For a face the answer needs no test at all: a face
 * normal points out of the body, so the material is on the -normal side.
 */
import { Matrix4, Vector3 } from 'three'
import type { Body } from '@/kernel/types'
import type { Vec3 } from '@/kernel/types'
import type { Loop, PlaneDef, Vec2 } from '@/sketch/types'
import { toWorld } from '@/sketch/plane'

/** How far off the plane the probe points sit, in mm. */
export const PROBE = 0.01
// an odd direction, so a ray never runs along a grid-aligned edge or face of a typical model
const RAY: Vec3 = [0.5773, 0.5774, 0.5775]

/** Inside test for a closed triangle mesh: an odd number of crossings along a ray means inside (Moller-Trumbore). */
export function pointInMesh(pos: ArrayLike<number>, idx: ArrayLike<number>, p: Vec3, dir: Vec3 = RAY): boolean {
  let hits = 0
  const [dx, dy, dz] = dir
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2]
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2]
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-12) continue
    const inv = 1 / det
    const tx = p[0] - pos[a], ty = p[1] - pos[a + 1], tz = p[2] - pos[a + 2]
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < 0 || u > 1) continue
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < 0 || u + v > 1) continue
    if ((e2x * qx + e2y * qy + e2z * qz) * inv > 1e-9) hits++
  }
  return hits % 2 === 1
}

/** Is the world point inside any solid body? (bodies that sit in a component carry a placement matrix.) */
export function insideAnyBody(bodies: Body[], p: Vec3): boolean {
  for (const b of bodies) {
    if (b.surface || !b.mesh.indices.length) continue
    let q = p, d = RAY
    if (b.placement) {
      const inv = new Matrix4().fromArray(b.placement).invert()
      q = new Vector3(...p).applyMatrix4(inv).toArray() as Vec3
      d = new Vector3(...RAY).transformDirection(inv).toArray() as Vec3
    }
    if (pointInMesh(b.mesh.positions, b.mesh.indices, q, d)) return true
  }
  return false
}

/** Points on the profile plane that lie inside the profile's outline (its middle, and its corners pulled towards the middle). */
export function profileSamples(plane: PlaneDef, outer: Loop): Vec3[] {
  const pts: Vec2[] = outer.slice(0, 16).flatMap((s): Vec2[] => (s.k === 'c' ? [[s.c[0] + s.r, s.c[1]], [s.c[0] - s.r, s.c[1]], [s.c[0], s.c[1] + s.r], [s.c[0], s.c[1] - s.r]] : [s.a]))
  if (!pts.length) return []
  const mid: Vec2 = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
  return [mid, ...pts.map((p): Vec2 => [mid[0] + (p[0] - mid[0]) * 0.7, mid[1] + (p[1] - mid[1]) * 0.7])].map((p) => toWorld(plane, p))
}

/** Which side of the plane (+1 along `normal`, -1 against it) the material lies on; 0 when there is none, or on both sides. */
export function bodySide(bodies: Body[], samples: Vec3[], normal: Vec3): -1 | 0 | 1 {
  const off = (s: Vec3, k: number): Vec3 => [s[0] + normal[0] * PROBE * k, s[1] + normal[1] * PROBE * k, s[2] + normal[2] * PROBE * k]
  const ahead = samples.some((s) => insideAnyBody(bodies, off(s, 1)))
  const behind = samples.some((s) => insideAnyBody(bodies, off(s, -1)))
  return ahead === behind ? 0 : ahead ? 1 : -1
}

export interface AutoIn {
  /** every input is a face of a body (not a sketch profile) */
  facesOnly: boolean
  side: -1 | 0 | 1
  operation: string
  distance: number
}
export interface AutoOut { operation: string; distance: number }

/** World direction (+1 along the normal) an extrusion with this operation and distance goes. Faces extrude against the normal in Cut. */
export const worldDir = (facesOnly: boolean, operation: string, distance: number) => Math.sign(distance) * (facesOnly && operation === 'cut' ? -1 : 1)

/**
 * The operation the arrow position calls for, or null when it should stay as it is. Join and Cut only: when the operation flips on a
 * face, the distance changes sign with it (a face's Cut measures inwards) so the extrusion, and the arrow, stay where they are.
 */
export function autoOperation({ facesOnly, side, operation, distance }: AutoIn): AutoOut | null {
  if (side === 0 || distance === 0 || (operation !== 'join' && operation !== 'cut')) return null
  const want = worldDir(facesOnly, operation, distance) === side ? 'cut' : 'join'
  if (want === operation) return null
  return { operation: want, distance: facesOnly ? -distance : distance }
}
