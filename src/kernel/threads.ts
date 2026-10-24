/**
 * Modeled threads, the one implementation behind the Thread feature and the Hole tool. A thread is the twisted extrusion of ONE
 * cross-section (a disc whose radius follows the thread profile around the circumference: two arcs and two spiral flanks), which
 * OpenCascade turns into exact helical faces with a single sweep, so one boolean is all it takes:
 *  - external thread on a shaft: the shaft is turned down to the root, then the twisted tooth is fused on,
 *  - internal thread in a hole: the hole is closed in to the crest, then the twisted groove is cut out.
 * The selected cylindrical face is the nominal (major) diameter. polarOutline gives the same outline as a manifold mesh for instant
 * previews. Geometry is built about +Z from z = 0 and then moved onto the real axis.
 */
import { draw, drawCircle, makeCylinder, type AnyShape, type Solid } from 'replicad'
import type { Shape } from './occ'
import type { Vec3 } from './types'

/** ISO 261 metric sizes with their coarse pitch and the usual fine pitch (mm). */
export const ISO_SIZES: { d: number; coarse: number; fine: number }[] = [
  { d: 3, coarse: 0.5, fine: 0.35 }, { d: 4, coarse: 0.7, fine: 0.5 }, { d: 5, coarse: 0.8, fine: 0.5 }, { d: 6, coarse: 1, fine: 0.75 },
  { d: 8, coarse: 1.25, fine: 1 }, { d: 10, coarse: 1.5, fine: 1.25 }, { d: 12, coarse: 1.75, fine: 1.5 }, { d: 14, coarse: 2, fine: 1.5 },
  { d: 16, coarse: 2, fine: 1.5 }, { d: 18, coarse: 2.5, fine: 1.5 }, { d: 20, coarse: 2.5, fine: 1.5 }, { d: 24, coarse: 3, fine: 2 },
  { d: 27, coarse: 3, fine: 2 }, { d: 30, coarse: 3.5, fine: 2 }, { d: 36, coarse: 4, fine: 3 },
]

/** The ISO size nearest to a diameter, and how far off it is. */
export function nearestIso(diameter: number): { size: (typeof ISO_SIZES)[number]; off: number } {
  let best = ISO_SIZES[0]
  for (const s of ISO_SIZES) if (Math.abs(s.d - diameter) < Math.abs(best.d - diameter)) best = s
  return { size: best, off: Math.abs(best.d - diameter) }
}

export interface ThreadProfile {
  pitch: number
  /** full flank angle, degrees (60 for ISO metric) */
  angle: number
  /** radial depth from the crest to the root, mm */
  depth: number
  /** width of the flat on the crest, mm */
  crest: number
}

/** The basic ISO metric profile: 60 degree flanks, depth 5/8 of the fundamental triangle, crest flat of 1/8 pitch. */
export function isoProfile(pitch: number): ThreadProfile {
  const H = (Math.sqrt(3) / 2) * pitch
  return { pitch, angle: 60, depth: (5 / 8) * H, crest: pitch / 8 }
}

/** Width of the flat at the root implied by the flanks. */
export const rootFlat = (p: ThreadProfile) => p.crest + 2 * p.depth * Math.tan((p.angle * Math.PI) / 360)

export function checkProfile(p: ThreadProfile): string | null {
  if (!(p.pitch > 0.1)) return 'The pitch must be at least 0.1 mm'
  if (!(p.angle > 5 && p.angle < 120)) return 'The flank angle must be between 5 and 120 degrees'
  if (!(p.depth > 0.02)) return 'The thread depth must be greater than zero'
  if (!(p.crest >= 0)) return 'The crest flat cannot be negative'
  if (rootFlat(p) > 0.95 * p.pitch) return `With these flanks the thread is wider than its pitch (${rootFlat(p).toFixed(2)} mm of ${p.pitch} mm). Use a smaller depth, a smaller angle or a larger pitch`
  return null
}

const rot = (shape: AnyShape, from: Vec3, to: Vec3): AnyShape => {
  const [a, b] = [from, to]
  const k: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const kl = Math.hypot(...k)
  const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  if (kl < 1e-9) return cos > 0 ? shape : (shape as unknown as Shape).rotate(180, [0, 0, 0], [1, 0, 0])
  return (shape as unknown as Shape).rotate((Math.atan2(kl, cos) * 180) / Math.PI, [0, 0, 0], k)
}

/** Move a shape built about +Z from the origin onto the axis through `origin` along `dir`. */
export function placeOnAxis(shape: AnyShape, origin: Vec3, dir: Vec3): AnyShape {
  const l = Math.hypot(...dir)
  const d: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l]
  const r = rot(shape, [0, 0, 1], d)
  return (r as unknown as Shape).translate(origin[0], origin[1], origin[2])
}

export interface ThreadBuild {
  kind: 'external' | 'internal'
  /** major radius: the radius of the selected face */
  radius: number
  profile: ThreadProfile
  /** total printing clearance between a bolt and a nut thread (each takes half), mm */
  clearance: number
  /** length of the threaded stretch, along +Z from 0 */
  length: number
  leftHand: boolean
  /** turns the thread about its axis, as a fraction of a turn (0 = the tooth is on the start angle at the start of the thread). The thread is the same helix for any value; the OCC boolean is fragile for some, see threadFace */
  phase?: number
}

/** Radius of the cylinder an external thread is turned down to before its tooth is added: the root of the thread. */
export const coreRadius = (b: ThreadBuild) => b.radius - b.profile.depth - b.clearance / 2

/** Radius of the bore of a nut thread before the groove is cut: the minor radius, crest of the ridge. */
export const boreRadius = (b: ThreadBuild) => b.radius - b.profile.depth + b.clearance / 2

const halfAngle = (p: ThreadProfile) => ({ t: Math.tan((p.angle * Math.PI) / 360), c: Math.cos((p.angle * Math.PI) / 360) })

/**
 * The radius of the thread's outline at axial offset `s` from the centre of the tooth (external) or of the groove (internal), in mm.
 * External: the radius of the threaded rod. Internal: the radius of the void (the hole with its grooves). Each part's material
 * recedes by half the clearance, measured square to the flanks (the crest and root too). `floor` is how deep the flank may run.
 */
export function radiusAt(b: ThreadBuild, s: number, floor?: number): number {
  const p = b.profile
  const { t, c } = halfAngle(p)
  const d = b.clearance / 2
  const R = b.radius
  s = Math.abs(s)
  if (b.kind === 'external') {
    return Math.max(floor ?? coreRadius(b), Math.min(R - d, R - (s + d / c - p.crest / 2) / t))
  }
  const rr = R + d, g0 = p.crest / 2 + d / c
  return s <= g0 ? rr : Math.max(floor ?? boreRadius(b), Math.min(rr, rr - (s - g0) / t))
}

/** Axial offsets where the outline changes from arc to flank to arc, within 0..pitch/2. */
function breaks(b: ThreadBuild, floor: number): number[] {
  const p = b.profile
  const { t, c } = halfAngle(p)
  const d = b.clearance / 2
  const R = b.radius
  const half = p.pitch / 2
  const clamp = (x: number) => Math.min(half, Math.max(0, x))
  if (b.kind === 'external') {
    const raw = (r: number) => t * (R - r) - d / c + p.crest / 2
    return [0, clamp(raw(R - d)), clamp(raw(floor)), half]
  }
  const g0 = p.crest / 2 + d / c
  return [0, clamp(g0), clamp(g0 + t * (R + d - floor)), half]
}

type P2 = [number, number]

/**
 * The twisted solid of a thread along +Z over `length`: the rod with its tooth (external) or the void with its grooves (internal).
 * `floor` is the radius the flank runs down to (a little past the root / crest so surfaces cross cleanly instead of touching).
 */
export function twistedThread(b: ThreadBuild, floor: number, phase = 0, around = 0): Solid {
  const P = b.profile.pitch
  const bk = breaks(b, floor)
  const rs = bk.map((s) => radiusAt(b, s, floor))
  const pt = (r: number, u: number): P2 => [r * Math.cos(2 * Math.PI * u), r * Math.sin(2 * Math.PI * u)]
  const segs: { a: P2; mid: P2 | null; ctl: [P2, P2] | null; b: P2 }[] = []
  /** one piece from (rA at uA) to (rB at uB): an arc of constant radius or a spiral flank as three cubic Beziers */
  const piece = (rA: number, rB: number, uA: number, uB: number) => {
    if (Math.abs(uB - uA) < 1e-9) return
    if (Math.abs(rA - rB) < 1e-7) { segs.push({ a: pt(rA, uA), mid: pt(rA, (uA + uB) / 2), ctl: null, b: pt(rB, uB) }); return }
    const r = (u: number) => rA + ((rB - rA) * (u - uA)) / (uB - uA)
    const rp = (rB - rA) / (uB - uA)
    const d = (u: number): P2 => {
      const a = 2 * Math.PI * u
      return [rp * Math.cos(a) - r(u) * 2 * Math.PI * Math.sin(a), rp * Math.sin(a) + r(u) * 2 * Math.PI * Math.cos(a)]
    }
    const n = 1
    for (let i = 0; i < n; i++) {
      const u0 = uA + ((uB - uA) * i) / n, u1 = uA + ((uB - uA) * (i + 1)) / n
      const h = (u1 - u0) / 3
      const p0 = pt(r(u0), u0), p3 = pt(r(u1), u1), d0 = d(u0), d3 = d(u1)
      segs.push({ a: p0, mid: null, ctl: [[p0[0] + d0[0] * h, p0[1] + d0[1] * h], [p3[0] - d3[0] * h, p3[1] - d3[1] * h]], b: p3 })
    }
  }
  // counter-clockwise from the middle of the tooth: out to half a pitch, then back the other way round
  for (let i = 0; i + 1 < bk.length; i++) piece(rs[i], rs[i + 1], bk[i] / P, bk[i + 1] / P)
  for (let i = bk.length - 2; i >= 0; i--) piece(rs[i + 1], rs[i], 1 - bk[i + 1] / P, 1 - bk[i] / P)
  let pen = draw(segs[0].a)
  for (const sg of segs) pen = sg.mid ? pen.threePointsArcTo(sg.b, sg.mid) : pen.cubicBezierCurveTo(sg.b, sg.ctl![0], sg.ctl![1])
  const twist = (b.leftHand ? -1 : 1) * (b.length / P) * 360
  const outline = pen.close()
  // round > 0: the ring of material outside the outline instead of the disc inside it
  const face = around > 0 ? drawCircle(around).cut(outline) : outline
  let solid = face.sketchOnPlane('XY').extrude(b.length, { twistAngle: twist }) as unknown as AnyShape
  if (phase) solid = (solid as unknown as { rotate(a: number, p: Vec3, d: Vec3): AnyShape }).rotate(phase * 360, [0, 0, 0], [0, 0, 1])
  return solid as unknown as Solid
}

/** A tube r in [r0, r1] over z in [0, length] (r0 = 0 gives a solid cylinder). */
export function ringSolid(r0: number, r1: number, length: number): AnyShape {
  const outer = makeCylinder(r1, length, [0, 0, 0], [0, 0, 1]) as unknown as Shape
  if (r0 <= 1e-9) return outer as unknown as AnyShape
  const inner = makeCylinder(r0, length, [0, 0, 0], [0, 0, 1])
  return outer.cut(inner as unknown as AnyShape)
}

/** How far the twisted flank runs below the root / past the crest, so it crosses the neighbouring cylinder instead of touching it. */
const OVERRUN = 0.25

/** The material an external thread removes from a shaft: the ring outside the thread outline (one cut makes the thread). */
export const externalVoid = (b: ThreadBuild, phase = 0) => twistedThread({ ...b, kind: 'external' }, coreRadius(b), phase, b.radius + 0.5)
/** The void of an internal thread (cut out of a body whose hole was first closed in to {@link boreRadius}). */
export const internalVoid = (b: ThreadBuild, phase = 0) => twistedThread({ ...b, kind: 'internal' }, boreRadius(b) - 0.05, phase)

// ---------------------------------------------------------------- the Hole tool's tapped threads

export interface ThreadSpec {
  /** distance between crests, mm */
  pitch: number
  /** nominal (major) diameter, mm */
  major: number
  /** left-handed thread */
  left?: boolean
}

/** Minor diameter of an ISO metric internal thread (the tap drill size). */
export const minorDia = (s: ThreadSpec) => s.major - 1.0825 * s.pitch

/** Diameter of the bore that goes with the cutter: a hair under the minor diameter, so the two never share a surface. */
export const boreDia = (s: ThreadSpec) => minorDia(s) - 0.08

/** The material a tap removes: an internal ISO thread of `length` along +Z from z = 0 (the caller places it). */
export function tapCutter(s: ThreadSpec, length: number): Solid {
  if (!(length > 0)) throw new Error('The thread length must be greater than zero')
  const profile = isoProfile(s.pitch)
  if (!(s.pitch > 0) || !(s.major / 2 - profile.depth > 0.2)) throw new Error('This thread size is not valid')
  // the cutter's crest sits a hair inside the bore, so the grooves open into it without leaving a skin
  const b: ThreadBuild = { kind: 'internal', radius: s.major / 2, profile, clearance: 0, length, leftHand: !!s.left }
  return twistedThread(b, boreDia(s) / 2 - 0.03)
}

export type Fit = 'self' | 'bolt' | 'nut' | 'split'

/** How far the material of the modeled part recedes (mm) for a fit mode: Bolt / Nut give the clearance to that part only, Split halves it. */
export function recessionFor(fit: Fit, kind: 'external' | 'internal', clearance: number): number {
  if (fit === 'split') return clearance / 2
  if (fit === 'self') return clearance
  return (fit === 'bolt') === (kind === 'external') ? clearance : 0
}

const wrapU = (u: number, p: number) => u - p * Math.round(u / p)

/** The outline as polygon points (radius per angle at z = 0): twist-extruded with manifold it is the thread mesh, for previews. */
export function polarOutline(b: ThreadBuild, n = 288): [number, number][] {
  const P = b.profile.pitch
  const out: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n
    const r = radiusAt(b, wrapU(-(P * th) / (2 * Math.PI), P))
    out.push([r * Math.cos(th), r * Math.sin(th)])
  }
  return out
}
