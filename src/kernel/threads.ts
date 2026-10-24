/**
 * Modeled threads. The thread is a profile swept along a true helix with OpenCascade, so it stays an exact B-rep:
 *  - external thread on a shaft: a helical groove is cut into the cylinder (and, with a printing clearance, the crest is
 *    turned down a little),
 *  - internal thread in a hole: the hole is opened up by the clearance and a helical ridge is fused into the wall.
 * The selected cylindrical face is always the nominal (major) diameter of the thread.
 *
 * All geometry is built about the +Z axis starting at z = 0 and then moved onto the real axis.
 */
import { Wire, cast, getOC, isShape3D, makeCylinder, makePolygon, type AnyShape } from 'replicad'
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

type V2 = [number, number]

/** Radius of the cylinder an external thread is turned down to before its tooth is added: the root of the thread. */
export const coreRadius = (b: ThreadBuild) => b.radius - b.profile.depth - b.clearance / 2

/**
 * The cross section swept along the helix, as (radius, z) points centred on z = 0: one tooth, buried a little in the material
 * it grows from.
 *  - External: the tooth of the bolt, standing on the turned-down core ({@link coreRadius}).
 *  - Internal: the ridge of the nut, standing on the wall of the opened-up bore.
 * Each part's material recedes by half the printing clearance, measured square to the flanks (the crest and root too).
 */
export function sectionOf(b: ThreadBuild): V2[] {
  const p = b.profile
  const t = Math.tan((p.angle * Math.PI) / 360), c = Math.cos((p.angle * Math.PI) / 360)
  const d = b.clearance / 2
  const R = b.radius
  // neighbouring turns of the sweep must stay clear of each other: never wider than 90% of the pitch
  const cap = 0.45 * p.pitch
  const embed = 0.5
  if (b.kind === 'external') {
    // half width of a tooth at radius r: half the crest flat at the crest level, wider toward the root
    const lin = (r: number) => p.crest / 2 + (R - r) * t - d / c
    const core = coreRadius(b)
    // the crest sits lower by the clearance; if the flanks meet before that, the tooth ends in a point just above where they meet
    const tip = R - (d / c - p.crest / 2) / t
    const top = d / c - p.crest / 2 > 0 ? Math.min(R - d, tip + 0.02) : R - d
    const rk = core - 0.1 // the flank is carried a little into the core so it crosses the core surface square, not along an edge
    const rb = core - embed
    const hk = Math.min(cap, lin(rk))
    const ht = Math.max(0.01, lin(top))
    return [[rb, -Math.min(hk, 0.4 * p.pitch)], [rk, -hk], [top, -ht], [top, ht], [rk, hk], [rb, Math.min(hk, 0.4 * p.pitch)]]
  }
  // internal: the groove between two ridges of the nut, cut outward into the wall of a bore that was first closed in to the minor radius
  const rr = R + d // root of the nut thread
  const g0 = p.crest / 2 + d / c
  const rm = boreRadius(b)
  const rIn = rm - 0.15 // the groove opens into the bore, which is air here
  let rCap = rr - (cap - g0) / t
  if (Math.abs(rCap - rm) < 0.04) rCap = rm - 0.05
  const gIn = Math.min(cap, g0 + (rr - rIn) * t)
  if (rCap > rIn) return [[rr, -g0], [rCap, -cap], [rIn, -cap], [rIn, cap], [rCap, cap], [rr, g0]]
  return [[rr, -g0], [rIn, -gIn], [rIn, gIn], [rr, g0]]
}

/** Radius of the bore of a nut thread before the groove is cut: the minor radius, crest of the ridge. */
export const boreRadius = (b: ThreadBuild) => b.radius - b.profile.depth + b.clearance / 2
/** Deviation allowed when the helix and the swept flanks are approximated by splines: far below the resolution of a printer. */
const SPLINE_TOL = 0.004

/** A helix wire about +Z (replicad's makeHelix with a tolerance we control; the default is far tighter than a print needs and much slower). */
function helixWire(pitch: number, height: number, radius: number, zStart: number, left: boolean): Wire {
  const oc = getOC() as unknown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const line = new oc.Geom2d_Line(new oc.gp_Pnt2d(0, 0), new oc.gp_Dir2d((left ? -1 : 1) * 2 * Math.PI, pitch))
  const a = line.Value(0), b = line.Value((height / pitch) * Math.sqrt((2 * Math.PI) ** 2 + pitch ** 2))
  const seg = new oc.GC_MakeSegment2d(a, b)
  const surf = new oc.Geom_CylindricalSurface(new oc.gp_Ax3(new oc.gp_Pnt(0, 0, zStart), new oc.gp_Dir(0, 0, 1)), radius)
  const e = new oc.BRepBuilderAPI_MakeEdge(seg.Value(), surf).Edge()
  const w = new oc.BRepBuilderAPI_MakeWire(e).Wire()
  oc.BRepLib.BuildCurves3d(w, SPLINE_TOL, oc.GeomAbs_Shape.GeomAbs_C1, 8, 400)
  return new Wire(w)
}

/**
 * Sweep the section along a helix; a screw motion, so the profile keeps its place relative to the axis all the way round.
 * With `trim` the ends are cut flat at z = 0 and z = length, otherwise the groove / ridge simply runs past them.
 */
export function helixSolid(b: ThreadBuild, trim = true): AnyShape {
  const P = b.profile.pitch
  const sec = sectionOf(b)
  const zStart = -P + (b.phase ?? 0) * P
  const turns = Math.ceil((b.length + 2.5 * P) / P)
  const r0 = sec.reduce((s, q) => s + q[0], 0) / sec.length
  const oc = getOC() as unknown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const wire = makePolygon(sec.map(([r, z]) => [r, 0, zStart + z] as [number, number, number])).outerWire()
  const mk = new oc.BRepOffsetAPI_MakePipeShell(helixWire(P, turns * P, r0, zStart, b.leftHand).wrapped)
  let sweep: Shape
  try {
    mk.SetMode(true) // Frenet frame: for a helix this is exactly the screw motion
    mk.SetTolerance(SPLINE_TOL, SPLINE_TOL, 1e-2)
    mk.Add(wire.wrapped, false, false)
    mk.Build()
    mk.MakeSolid()
    sweep = cast(mk.Shape()) as unknown as Shape
  } finally {
    mk.delete()
  }
  if (!isShape3D(sweep as never)) throw new Error('The thread profile could not be swept along the helix')
  if (!trim) return sweep as unknown as AnyShape
  const rmax = Math.max(...sec.map((q) => q[0])) + 1
  const slab = makeCylinder(rmax, b.length, [0, 0, 0], [0, 0, 1]) as unknown as Shape
  return sweep.intersect(slab as unknown as AnyShape)
}

/** A tube r in [r0, r1] over z in [0, length] (the clearance relief ring). */
export function ringSolid(r0: number, r1: number, length: number): AnyShape {
  const outer = makeCylinder(r1, length, [0, 0, 0], [0, 0, 1]) as unknown as Shape
  if (r0 <= 1e-9) return outer as unknown as AnyShape
  const inner = makeCylinder(r0, length, [0, 0, 0], [0, 0, 1])
  return outer.cut(inner as unknown as AnyShape)
}

// ---------------------------------------------------------------- fast mesh version (previews)

export type Fit = 'self' | 'bolt' | 'nut' | 'split'

/** How far the material of the modeled part recedes (mm) for a fit mode: Bolt / Nut give the clearance to that part only, Split halves it. */
export function recessionFor(fit: Fit, kind: 'external' | 'internal', clearance: number): number {
  if (fit === 'split') return clearance / 2
  if (fit === 'self') return clearance
  return (fit === 'bolt') === (kind === 'external') ? clearance : 0
}

const wrapU = (u: number, p: number) => u - p * Math.round(u / p)

/**
 * Polar outline (radius per angle at z = 0) of the threaded rod (external) or of the inner edge of the threaded tube (internal),
 * from the same profile maths as sectionOf. Twist-extruding it 360 degrees per pitch gives the thread as a mesh in milliseconds.
 */
export function polarOutline(b: ThreadBuild, n = 288): [number, number][] {
  const p = b.profile
  const t = Math.tan((p.angle * Math.PI) / 360), c = Math.cos((p.angle * Math.PI) / 360)
  const d = b.clearance / 2
  const R = b.radius
  const out: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n
    const u = Math.abs(wrapU(-(p.pitch * th) / (2 * Math.PI), p.pitch))
    let r: number
    if (b.kind === 'external') {
      r = Math.max(coreRadius(b), Math.min(R - d, R - (u + d / c - p.crest / 2) / t))
    } else {
      const rr = R + d, rm = boreRadius(b), g0 = p.crest / 2 + d / c
      r = u <= g0 ? rr : Math.max(rm, Math.min(rr, rr - (u - g0) / t))
    }
    out.push([r * Math.cos(th), r * Math.sin(th)])
  }
  return out
}