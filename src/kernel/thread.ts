/**
 * Modeled internal threads: a small, self-contained helper. The cutter of an ISO metric thread is a twisted extrusion of
 * one cross-section (a disc whose radius follows the thread profile around the circumference), so no helical sweep is needed.
 * The section is built from two circular arcs (root and crest) and two spiral flanks (cubic Beziers), eight edges in all.
 */
import { draw, type Solid } from 'replicad'

export interface ThreadSpec {
  /** distance between crests, mm */
  pitch: number
  /** nominal (major) diameter, mm */
  major: number
  /** left-handed thread */
  left?: boolean
}

/** Diameter of the bore that goes with the cutter: a hair under the minor diameter, so the two never share a surface. */
export const boreDia = (s: ThreadSpec) => s.major - 1.0825 * s.pitch - 0.08

/** Minor diameter of an ISO metric internal thread (the tap drill size). */
export const minorDia = (s: ThreadSpec) => s.major - 1.0825 * s.pitch

type P = [number, number]
const ROOT = 0.125, FLANK = 0.3125, CREST = 0.25

/** The pieces of the cross-section, in counter-clockwise order: ['arc', start, mid, end] or ['bez', start, c1, c2, end]. */
export function threadSection(s: ThreadSpec): (['arc', P, P, P] | ['bez', P, P, P, P])[] {
  const rMaj = s.major / 2, rMin = minorDia(s) / 2 - 0.02 // a hair inside the bore, so the cutter never shares a surface with it
  if (!(s.pitch > 0) || !(rMin > 0) || rMin >= rMaj) throw new Error('This thread size is not valid')
  const pt = (r: number, u: number): P => [r * Math.cos(2 * Math.PI * u), r * Math.sin(2 * Math.PI * u)]
  const arc = (r: number, u0: number, u1: number): ['arc', P, P, P] => ['arc', pt(r, u0), pt(r, (u0 + u1) / 2), pt(r, u1)]
  /** spiral flank r(u) linear from r0 at u0 to r1 at u1, as three Bezier pieces */
  const flank = (r0: number, r1: number, u0: number, u1: number) => {
    const out: ['bez', P, P, P, P][] = []
    const n = 3
    const r = (u: number) => r0 + ((r1 - r0) * (u - u0)) / (u1 - u0)
    const rp = (r1 - r0) / (u1 - u0) // dr/du
    const d = (u: number): P => {
      const a = 2 * Math.PI * u
      // d/du of (r cos a, r sin a)
      return [rp * Math.cos(a) - r(u) * 2 * Math.PI * Math.sin(a), rp * Math.sin(a) + r(u) * 2 * Math.PI * Math.cos(a)]
    }
    for (let i = 0; i < n; i++) {
      const a = u0 + ((u1 - u0) * i) / n, b = u0 + ((u1 - u0) * (i + 1)) / n
      const h = (b - a) / 3
      const p0 = pt(r(a), a), p3 = pt(r(b), b), d0 = d(a), d3 = d(b)
      out.push(['bez', p0, [p0[0] + d0[0] * h, p0[1] + d0[1] * h], [p3[0] - d3[0] * h, p3[1] - d3[1] * h], p3])
    }
    return out
  }
  return [
    arc(rMaj, 0, ROOT),
    ...flank(rMaj, rMin, ROOT, ROOT + FLANK),
    arc(rMin, ROOT + FLANK, ROOT + FLANK + CREST),
    ...flank(rMin, rMaj, ROOT + FLANK + CREST, 1),
  ]
}

/** The material a tap removes: an internal thread of `length` along +Z from z = 0 (the caller places it). */
export function thread(s: ThreadSpec, length: number): Solid {
  if (!(length > 0)) throw new Error('The thread length must be greater than zero')
  const parts = threadSection(s)
  let pen = draw(parts[0][1])
  for (const p of parts) {
    if (p[0] === 'arc') pen = pen.threePointsArcTo(p[3], p[2])
    else pen = pen.cubicBezierCurveTo(p[4], p[2], p[3])
  }
  const turns = length / s.pitch
  const twist = (s.left ? -1 : 1) * turns * 360
  return pen.close().sketchOnPlane('XY').extrude(length, { twistAngle: twist }) as unknown as Solid
}
