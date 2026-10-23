/** Sketch plane math. */
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { PlaneDef, Vec2, Vec3 } from './types'

const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

export type OriginPlaneName = 'XY' | 'XZ' | 'YZ'

export function originPlane(name: OriginPlaneName): PlaneDef {
  switch (name) {
    case 'XY': return { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
    case 'XZ': return { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] }
    case 'YZ': return { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }
  }
}

/** Plane for a planar face: x axis horizontal (no camera roll), y = normal x x. */
export function planeFromNormal(origin: Vec3, normalIn: Vec3): PlaneDef {
  const normal = norm3(normalIn)
  const xDir: Vec3 = Math.abs(normal[2]) > 0.9999 ? [1, 0, 0] : norm3(cross3([0, 0, 1], normal))
  return { origin, xDir, normal }
}

export const yDirOf = (p: PlaneDef): Vec3 => norm3(cross3(p.normal, p.xDir))

export function toWorld(p: PlaneDef, [x, y]: Vec2): Vec3 {
  const yd = yDirOf(p)
  return [p.origin[0] + p.xDir[0] * x + yd[0] * y, p.origin[1] + p.xDir[1] * x + yd[1] * y, p.origin[2] + p.xDir[2] * x + yd[2] * y]
}
export function toLocal(p: PlaneDef, w: Vec3): Vec2 {
  const d: Vec3 = [w[0] - p.origin[0], w[1] - p.origin[1], w[2] - p.origin[2]]
  return [dot3(d, p.xDir), dot3(d, yDirOf(p))]
}
/** Direction (not point) from local to world. */
export function dirToWorld(p: PlaneDef, [x, y]: Vec2): Vec3 {
  const yd = yDirOf(p)
  return [p.xDir[0] * x + yd[0] * y, p.xDir[1] * x + yd[1] * y, p.xDir[2] * x + yd[2] * y]
}

/** Matrix mapping plane-local (x, y, z) to world. */
export function planeMatrix(p: PlaneDef): Matrix4 {
  const y = yDirOf(p)
  return new Matrix4().makeBasis(new Vector3(...p.xDir), new Vector3(...y), new Vector3(...p.normal)).setPosition(new Vector3(...p.origin))
}
export const planeQuaternion = (p: PlaneDef) => new Quaternion().setFromRotationMatrix(planeMatrix(p))

/** Re-anchor a stored plane onto a (possibly moved) face plane: keep the in-plane position, follow the offset. */
export function reanchor(old: PlaneDef, face: PlaneDef): PlaneDef {
  const d = dot3([old.origin[0] - face.origin[0], old.origin[1] - face.origin[1], old.origin[2] - face.origin[2]], face.normal)
  return {
    origin: [old.origin[0] - face.normal[0] * d, old.origin[1] - face.normal[1] * d, old.origin[2] - face.normal[2] * d],
    xDir: face.xDir,
    normal: face.normal,
  }
}

export const originPlaneId = (name: OriginPlaneName) => 'plane' + name
