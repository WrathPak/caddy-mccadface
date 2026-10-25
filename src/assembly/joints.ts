/** Joint types: their degrees of freedom, defaults and the motion each one allows. */
import { chain, DEG, frameMatrix, identity, rotateX, rotateY, rotateZ, rotation, translation, type Frame, type Mat4 } from './matrix'
import type { Joint, JointType, Limit } from './types'

export interface Dof { key: string; label: string; unit: 'mm' | 'deg'; defaultMin: number; defaultMax: number }

const ANGLE = (key: string, label: string): Dof => ({ key, label, unit: 'deg', defaultMin: -180, defaultMax: 180 })
const SLIDE = (key: string, label: string): Dof => ({ key, label, unit: 'mm', defaultMin: -100, defaultMax: 100 })

export const JOINT_TYPES: { type: JointType; label: string; help: string; dofs: Dof[] }[] = [
  { type: 'rigid', label: 'Rigid', help: 'The two components are fixed to each other.', dofs: [] },
  { type: 'revolute', label: 'Revolute', help: 'Turns about the joint axis, like a hinge.', dofs: [ANGLE('angle', 'Angle')] },
  { type: 'slider', label: 'Slider', help: 'Slides along the joint axis.', dofs: [SLIDE('distance', 'Distance')] },
  { type: 'cylindrical', label: 'Cylindrical', help: 'Turns about the joint axis and slides along it.', dofs: [ANGLE('angle', 'Angle'), SLIDE('distance', 'Distance')] },
  { type: 'pinSlot', label: 'Pin-slot', help: 'Turns about the joint axis and slides along its X direction.', dofs: [ANGLE('angle', 'Angle'), SLIDE('slide', 'Slide')] },
  { type: 'planar', label: 'Planar', help: 'Slides in the joint plane (X and Y) and turns about its normal.', dofs: [SLIDE('x', 'Slide X'), SLIDE('y', 'Slide Y'), ANGLE('angle', 'Angle')] },
  { type: 'ball', label: 'Ball', help: 'Turns freely about the joint origin.', dofs: [ANGLE('roll', 'Roll'), ANGLE('pitch', 'Pitch'), ANGLE('yaw', 'Yaw')] },
]

export const jointInfo = (t: JointType) => JOINT_TYPES.find((j) => j.type === t)!
export const dofsOf = (t: JointType): Dof[] => jointInfo(t).dofs

export const defaultLimits = (t: JointType): Record<string, Limit> =>
  Object.fromEntries(dofsOf(t).map((d) => [d.key, { enabled: false, min: d.defaultMin, max: d.defaultMax, rest: 0 }]))
export const defaultValues = (t: JointType): Record<string, number> => Object.fromEntries(dofsOf(t).map((d) => [d.key, 0]))

/** Value held inside the limits (when they are on). */
export function clampValue(j: Pick<Joint, 'limits'>, key: string, v: number): number {
  const l = j.limits[key]
  return l?.enabled ? Math.min(l.max, Math.max(l.min, v)) : v
}

/** The motion transform of a joint for the given values, written in the joint frame. */
export function motionMatrix(type: JointType, v: Record<string, number>): Mat4 {
  const g = (k: string) => v[k] ?? 0
  switch (type) {
    case 'rigid': return identity()
    case 'revolute': return rotateZ(g('angle') * DEG)
    case 'slider': return translation([0, 0, g('distance')])
    case 'cylindrical': return chain(translation([0, 0, g('distance')]), rotateZ(g('angle') * DEG))
    case 'pinSlot': return chain(translation([g('slide'), 0, 0]), rotateZ(g('angle') * DEG))
    case 'planar': return chain(translation([g('x'), g('y'), 0]), rotateZ(g('angle') * DEG))
    case 'ball': return chain(rotateZ(g('yaw') * DEG), rotateY(g('pitch') * DEG), rotateX(g('roll') * DEG))
  }
}

/** The part before the motion: the offset and an extra turn about Z. */
export function staticMatrix(j: Pick<Joint, 'offset' | 'angle'>): Mat4 {
  return chain(translation(j.offset), rotateZ(j.angle * DEG))
}

/** The flip is a half turn about X after the motion, so the motion axes stay the first origin's and only the second component turns over. */
export const flipMatrix = (flip: boolean): Mat4 => (flip ? rotation([1, 0, 0], Math.PI) : identity())

/**
 * Where the second origin's frame sits relative to the first origin's frame: static part, then the motion.
 * (frame B in the space of frame A)
 */
export function jointTransform(j: Pick<Joint, 'type' | 'offset' | 'angle' | 'flip'>, values: Record<string, number>): Mat4 {
  return chain(staticMatrix(j), motionMatrix(j.type, values), flipMatrix(j.flip))
}

export const originMatrix = (f: Frame): Mat4 => frameMatrix(f)

/** The values a joint has when it is moved to its "rest" (limits' rest value, else 0). */
export function restValues(j: Pick<Joint, 'type' | 'limits'>): Record<string, number> {
  return Object.fromEntries(dofsOf(j.type).map((d) => [d.key, j.limits[d.key]?.enabled ? j.limits[d.key].rest : 0]))
}
