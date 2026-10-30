/**
 * Shared plumbing for the on-canvas drag handles of the tools: a distance arrow (or several) and a rotary angle handle that
 * edit number parameters of an open dialog. A tool describes where each handle stands; this turns that into viewport state
 * whose `onChange` writes the dragged value back into the dialog.
 */
import type { Body, Vec3 } from '@/kernel/types'
import type { ParamValues } from '@/ui/schema'
import { ANGLE_SLOTS, resetAngleManip } from '@/viewport/AngleManipulator'
import { MANIP_SLOTS, resetManip } from '@/viewport/preview'

export interface ArrowSpec {
  origin: Vec3
  /** direction the arrow points (the parameter grows along it) */
  dir: Vec3
  /** the number parameter it edits */
  key: string
  /** value = distance along the arrow * factor (2 when the arrow reaches half the parameter) */
  factor?: number
  /** smallest value a drag can give (the schema's own minimum, so a drag never leaves the legal range) */
  min?: number
  /** largest value a drag can give */
  max?: number
  label?: (v: number) => string
}

export interface AngleSpec {
  /** a point on the axis, level with the start of the arc */
  origin: Vec3
  axis: Vec3
  /** unit vector the angle is measured from (perpendicular to the axis) */
  start: Vec3
  radius: number
  key: string
  min?: number
  max?: number
  step?: number
  nonZero?: boolean
  /** the parameter is the arc's angle times this (2 when the arc shows the half angle of a cone and the parameter is the included angle) */
  scale?: number
}

type Apply = (patch: ParamValues) => void

/** Show the arrows in the first slots, one per spec (a null leaves its slot empty) and clear the rest. */
export function showArrows(specs: (ArrowSpec | null)[], p: ParamValues, apply: Apply) {
  MANIP_SLOTS.forEach((_, i) => showArrow(i, specs[i] ?? null, p, apply))
}

/** Show or clear one arrow slot, leaving the others as they are. */
export function showArrow(slot: number, s: ArrowSpec | null, p: ParamValues, apply: Apply) {
  const store = MANIP_SLOTS[slot]
  if (!s) { store.setState({ active: false, onChange: null }); return }
  const factor = s.factor ?? 1
  store.setState({
    active: true, origin: s.origin, dir: s.dir, tip: (p[s.key] as number) / factor, factor,
    label: s.label ?? ((v) => `${v.toFixed(2)} mm`),
    onChange: (v) => apply({ [s.key]: Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, v)) }),
  })
}

/** Show the angle handle in a slot for a spec, or remove it. */
export function showAngle(s: AngleSpec | null, p: ParamValues, apply: Apply, slot = 0) {
  const store = ANGLE_SLOTS[slot]
  if (!s) { store.setState({ active: false, onChange: null }); return }
  const k = s.scale ?? 1
  store.setState({
    active: true, origin: s.origin, axis: s.axis, start: s.start, radius: s.radius, angle: (p[s.key] as number) / k,
    min: (s.min ?? -360 * k) / k, max: (s.max ?? 360 * k) / k, step: s.step ?? 1, nonZero: s.nonZero ?? true, scale: k,
    onChange: (v) => apply({ [s.key]: +(v * k).toFixed(3) }),
  })
}

export function clearHandles() {
  resetManip()
  resetAngleManip()
}

/** Extent of the bodies' meshes: [min, max]. */
export function extentOf(bodies: Body[]): [Vec3, Vec3] | null {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const b of bodies) {
    const P = b.mesh.positions
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]) }
  }
  return Number.isFinite(lo[0]) ? [lo, hi] : null
}

/** A handy size for an arc handle in the scene: a tenth of the diagonal of what is there (at least 5 mm). */
export function arcRadius(bodies: Body[]): number {
  const e = extentOf(bodies)
  return e ? Math.max(5, Math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1], e[1][2] - e[0][2]) * 0.2) : 15
}

/**
 * The highest point of a body's surface above the middle of its footprint, with the way into the body there (down the triangle
 * normal). Falls back to the highest vertex and straight down when nothing lies above the middle (a hole, a torus).
 */
export function topPoint(b: Body): { point: Vec3; inward: Vec3 } | null {
  const m = b.mesh
  const P = m.positions, I = m.indices
  const e = extentOf([b])
  if (!e) return null
  const cx = (e[0][0] + e[1][0]) / 2, cy = (e[0][1] + e[1][1]) / 2
  let best: { z: number; n: Vec3 } | null = null
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, bb = I[t + 1] * 3, c = I[t + 2] * 3
    const ax = P[a], ay = P[a + 1], bx = P[bb], by = P[bb + 1], cx2 = P[c], cy2 = P[c + 1]
    const d = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2)
    if (Math.abs(d) < 1e-12) continue
    const u = ((by - cy2) * (cx - cx2) + (cx2 - bx) * (cy - cy2)) / d
    const v = ((cy2 - ay) * (cx - cx2) + (ax - cx2) * (cy - cy2)) / d
    const w = 1 - u - v
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue
    const z = u * P[a + 2] + v * P[bb + 2] + w * P[c + 2]
    if (best && z <= best.z) continue
    const ux = P[bb] - P[a], uy = P[bb + 1] - P[a + 1], uz = P[bb + 2] - P[a + 2]
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]
    let n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
    const l = Math.hypot(...n)
    if (l < 1e-12) continue
    n = [n[0] / l, n[1] / l, n[2] / l]
    best = { z, n }
  }
  if (best) return { point: [cx, cy, best.z], inward: best.n[2] > 0 ? [-best.n[0], -best.n[1], -best.n[2]] : best.n }
  let top = -Infinity, at: Vec3 = [cx, cy, e[1][2]]
  for (let i = 0; i < P.length; i += 3) if (P[i + 2] > top) { top = P[i + 2]; at = [P[i], P[i + 1], P[i + 2]] }
  return { point: at, inward: [0, 0, -1] }
}
