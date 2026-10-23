/** Section analysis: the clipping plane for the current section state. */
import { Plane, Vector3 } from 'three'
import type { SectionState } from '@/store/ui'

const NORMALS = { X: new Vector3(1, 0, 0), Y: new Vector3(0, 1, 0), Z: new Vector3(0, 0, 1) }

/** Keeps the material on the negative side of the plane (the positive side with `flip`). */
export function sectionPlane(s: Pick<SectionState, 'axis' | 'offset' | 'flip'>): Plane {
  const n = NORMALS[s.axis].clone()
  return s.flip ? new Plane(n, -s.offset) : new Plane(n.negate(), s.offset)
}
