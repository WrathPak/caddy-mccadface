/**
 * The cutting plane of Plane Cut and Mesh Section Sketch: an axis, an origin / construction plane or a flat face, an offset along its
 * normal and a tilt about two axes of the plane (the angle handles in the viewport). `resolveCutPlane` turns the dialog values into
 * the plane as a point and a unit normal.
 */
import type { RefReport } from '@/doc/refs'
import type { Body, Vec3 } from '@/kernel/types'
import { add3, applyDir, cross3, dot3, mul3, norm3, rotationAbout, sub3 } from '@/kernel/xform'
import type { ParamDef, ParamValues } from '@/ui/schema'
import { arcRadius, showAngle, showArrows } from '../handleKit'
import { resolvePlane, type RefEnv } from '../modeling-tools/geo'

export const AXES: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }

const noPlane = (v: ParamValues) => !((v.plane as string[] | undefined)?.length)

/** The dialog fields that define the plane (shared). */
export const planeParams: ParamDef[] = [
  { type: 'selection-ref', key: 'plane', help: 'Cut along an origin plane, a construction plane or a flat face. Click this field, then the plane or face. Leave it empty to cut along an axis instead.', label: 'Plane or Face', accepts: ['plane', 'face'], pick: true, default: [] },
  { type: 'enum', key: 'axis', help: 'The direction the cutting plane faces: X, Y or Z.', label: 'Plane normal', display: 'segmented', default: 'Z', options: [{ value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }, { value: 'Z', label: 'Z' }], visibleWhen: noPlane },
  { type: 'number', key: 'offset', help: 'Where the cutting plane sits: along the axis, or away from the picked plane or face along its normal, in mm.', label: 'Offset', unit: 'mm', step: 1, default: 0 },
  {
    type: 'group', label: 'Tilt', collapsed: true, id: 'tilt', help: 'Turn the plane about two of its own axes. Drag the arcs in the viewport or type the angles.',
    children: [
      { type: 'number', key: 'tiltA', help: 'Turn the plane about its first in-plane axis, in degrees. The red arc in the viewport does the same.', label: 'Tilt about U', unit: 'deg', min: -180, max: 180, step: 5, default: 0 },
      { type: 'number', key: 'tiltB', help: 'Turn the plane about its second in-plane axis, in degrees. The green arc in the viewport does the same.', label: 'Tilt about V', unit: 'deg', min: -180, max: 180, step: 5, default: 0 },
    ],
  },
]

/** Two unit vectors that span the plane with normal n. */
export function planeBasis(n: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]
  const u = norm3(cross3(ref, n))
  const v = norm3(cross3(n, u))
  return [u, v]
}

export interface CutPlane { origin: Vec3; normal: Vec3; /** the plane before the tilt: its normal and the two axes the tilt turns about */ base: { normal: Vec3; u: Vec3; v1: Vec3; n1: Vec3 } }

const R = (axis: Vec3, deg: number, v: Vec3): Vec3 => applyDir(rotationAbout([0, 0, 0], axis, deg), v)

/** The plane the values describe. */
export async function resolveCutPlane(p: ParamValues, env: RefEnv, report?: RefReport): Promise<CutPlane> {
  const ref = (p.plane as string[] | undefined)?.[0]
  let origin: Vec3, n0: Vec3
  if (ref) {
    const pl = await resolvePlane(ref, env, report)
    origin = pl.origin
    n0 = norm3(pl.normal)
  } else {
    n0 = AXES[p.axis as string] ?? AXES.Z
    origin = [0, 0, 0]
  }
  const off = (p.offset as number) ?? 0
  const at = add3(origin, mul3(n0, off))
  const a = (p.tiltA as number) ?? 0, b = (p.tiltB as number) ?? 0
  const [u, v] = planeBasis(n0)
  const n1 = a ? R(u, a, n0) : n0
  const v1 = a ? R(u, a, v) : v
  const n2 = b ? norm3(R(v1, b, n1)) : n1
  return { origin: at, normal: n2, base: { normal: n0, u, v1, n1 } }
}

/** { normal, offset } of the plane in the form the kernel takes: normal . p = offset. */
export const planeEq = (c: CutPlane): { normal: Vec3; offset: number } => ({ normal: c.normal, offset: dot3(c.normal, c.origin) })

/** The handles of the plane: an arrow for the offset, two arcs for the tilt. */
export async function showPlaneHandles(p: ParamValues, bodies: Body[], env: RefEnv, apply: (patch: ParamValues) => void) {
  const c = await resolveCutPlane(p, env)
  const list = bodies.length ? bodies : env.bodies
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const b of list) {
    const m = b.mesh.bounds
    const pp = b.mesh.positions
    if (m) { for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.min[k]); hi[k] = Math.max(hi[k], m.max[k]) } continue }
    for (let i = 0; i < pp.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pp[i + k]); hi[k] = Math.max(hi[k], pp[i + k]) }
  }
  if (!Number.isFinite(lo[0])) return
  const mid: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const n0 = c.base.normal
  // the offset arrow stands where the offset is 0 (the picked plane or the origin) and carries the plane with it
  const zero = add3(c.origin, mul3(n0, -((p.offset as number) ?? 0)))
  const slide = sub3(mid, mul3(n0, dot3(n0, sub3(mid, zero))))
  showArrows([{ origin: slide, dir: n0, key: 'offset' }], p, apply)
  // the tilt arcs stand in the middle of the plane over the body
  const pos = sub3(mid, mul3(c.normal, dot3(c.normal, sub3(mid, c.origin))))
  const r = arcRadius(list)
  // the two arcs stand apart so their knobs and labels do not sit on each other
  const [u, v] = planeBasis(n0)
  showAngle({ origin: add3(pos, mul3(v, r * 0.7)), axis: c.base.u, start: n0, radius: r, key: 'tiltA', min: -180, max: 180, nonZero: false }, p, apply, 0)
  showAngle({ origin: sub3(pos, mul3(u, r * 0.7)), axis: c.base.v1, start: c.base.n1, radius: r, key: 'tiltB', min: -180, max: 180, nonZero: false }, p, apply, 1)
}
