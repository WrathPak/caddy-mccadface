/**
 * The extra options of the older solid tools (Sweep, Loft, Revolve, Fillet, Chamfer, Shell, Draft, Hole): the parameter lists
 * the tools append to their schemas and the helpers that run the extended kernel ops. Each tool still takes its old path when
 * none of these options is used, so existing documents regenerate exactly as before.
 */
import { decodeRef, edgeSigs, faceSigs, resolveEdge, resolveFace, RefError, RefReport } from '@/doc/refs'
import type { KernelClient } from '@/kernel/client'
import type { EdgeAdvArgs, LoftAdvArgs, RevolveAdvArgs, ShellAdvArgs, SweepAdvArgs } from '@/kernel/solids2-ops'
import type { LoftSection, PathSeg } from '@/kernel/solid-ops'
import type { ProfileGroup } from '@/kernel/model-ops'
import type { Body, Vec3 } from '@/kernel/types'
import { add3, cross3, dot3, mul3, norm3, sub3 } from '@/kernel/xform'
import { isPlanarFace } from '@/sketch/create'
import type { ParamDef, ParamValues } from '@/ui/schema'
import { RefEnv, resolvePlane } from '../modeling-tools/geo'
import type { Env } from '../modeling'
import { sketchDataOf, sketchPath } from './kit'

type Kernel = Pick<KernelClient, 'call'>
const num = (p: ParamValues, k: string, d = 0) => (typeof p[k] === 'number' ? (p[k] as number) : d)

// ================================================================================================ Sweep

export const sweepExtraParams: ParamDef[] = [
  { type: 'selection-ref', key: 'guide', help: 'An optional second sketch curve that steers the profile: the profile turns so it follows this guide rail along the path.', label: 'Guide rail', accepts: ['sketch'], pick: true, default: [] },
  { type: 'enum', key: 'orientation', help: 'Perpendicular: the profile stays square to the path as it bends. Parallel: the profile keeps the direction it started in and just slides along the path.', label: 'Orientation', display: 'segmented', default: 'perpendicular', options: [{ value: 'perpendicular', label: 'Perpendicular' }, { value: 'parallel', label: 'Parallel' }], visibleWhen: (v) => !((v.guide as string[] | undefined)?.length) },
  { type: 'number', key: 'taper', help: 'Makes the profile shrink (positive) or grow (negative) along the path by this angle, scaling about the middle of the profile. A circle tapers exactly by this angle; other shapes taper in proportion.', label: 'Taper angle', unit: 'deg', min: -45, max: 45, step: 0.5, default: 0 },
  { type: 'number', key: 'twist', help: 'Turns the profile this many degrees about the path from start to end.', label: 'Twist angle', unit: 'deg', step: 5, default: 0, visibleWhen: (v) => !((v.guide as string[] | undefined)?.length) },
]

export const sweepIsAdvanced = (p: ParamValues) => !!((p.guide as string[] | undefined)?.length) || num(p, 'taper') !== 0 || num(p, 'twist') !== 0 || p.orientation === 'parallel'

export async function sweepAdvanced(kernel: Kernel, p: ParamValues, env: Env, groups: ProfileGroup[], path: PathSeg[], id: string, name: string): Promise<Body> {
  const guideRefs = (p.guide as string[] | undefined) ?? []
  const args: SweepAdvArgs = {
    id, name, groups, path,
    orientation: p.orientation === 'parallel' ? 'parallel' : 'perpendicular', taper: num(p, 'taper'), twist: num(p, 'twist'),
    ...(guideRefs.length ? { guide: sketchPath(sketchDataOf(guideRefs, env, 'guide rail')) } : {}),
  }
  return (await kernel.call('sweepAdv', args)) as Body
}

// ================================================================================================ Loft

const COND = [{ value: 'free', label: 'Free' }, { value: 'normal', label: 'Normal to profile' }, { value: 'smooth', label: 'Smooth (C2)' }]
export const loftExtraParams: ParamDef[] = [
  { type: 'selection-ref', key: 'rails', help: 'Optional guide rails: sketch curves that run from the first profile to the last and shape the sides. One rail steers the loft, a second rail also steers its turn. The profiles must sit at the ends of the rails.', label: 'Guide rails', accepts: ['sketch'], multiple: true, pick: true, default: [] },
  { type: 'selection-ref', key: 'centre', help: 'Optional center line: a sketch curve the profiles are centred on. It needs a corner at each profile and ends in the middle of the first and last profile.', label: 'Center line', accepts: ['sketch'], pick: true, default: [] },
  { type: 'enum', key: 'startCond', help: 'Free: the loft leaves the first profile on its own. Normal to profile: it leaves square to the profile plane (a tangent-like start). Smooth: the whole surface is built smooth (C2) through the profiles.', label: 'Start condition', display: 'select', default: 'free', options: COND },
  { type: 'number', key: 'startWeight', help: 'How long the loft holds square to the first profile, as a fraction of the distance to the next one.', label: 'Start weight', min: 0.02, max: 0.9, step: 0.05, default: 0.3, visibleWhen: (v) => v.startCond === 'normal' },
  { type: 'enum', key: 'endCond', help: 'Free: the loft arrives at the last profile on its own. Normal to profile: it arrives square to the profile plane. Smooth: the whole surface is built smooth (C2).', label: 'End condition', display: 'select', default: 'free', options: COND },
  { type: 'number', key: 'endWeight', help: 'How long the loft holds square to the last profile, as a fraction of the distance to the one before it.', label: 'End weight', min: 0.02, max: 0.9, step: 0.05, default: 0.3, visibleWhen: (v) => v.endCond === 'normal' },
]

export const loftIsAdvanced = (p: ParamValues) =>
  !!((p.rails as string[] | undefined)?.length) || !!((p.centre as string[] | undefined)?.length) || (p.startCond ?? 'free') !== 'free' || (p.endCond ?? 'free') !== 'free'

export async function loftAdvanced(kernel: Kernel, p: ParamValues, env: Env, sections: LoftSection[], id: string, name: string): Promise<Body> {
  const railRefs = ((p.rails as string[] | undefined) ?? []).filter(Boolean)
  const centreRefs = (p.centre as string[] | undefined) ?? []
  const args: LoftAdvArgs = {
    id, name, sections, ruled: !!p.ruled,
    startCond: (p.startCond as LoftAdvArgs['startCond']) ?? 'free', endCond: (p.endCond as LoftAdvArgs['endCond']) ?? 'free',
    startWeight: num(p, 'startWeight', 0.3), endWeight: num(p, 'endWeight', 0.3),
    ...(railRefs.length ? { rails: railRefs.map((r) => sketchPath(sketchDataOf([r], env, 'rail'))) } : {}),
    ...(centreRefs.length ? { centre: sketchPath(sketchDataOf(centreRefs, env, 'center line')) } : {}),
  }
  return (await kernel.call('loftAdv', args)) as Body
}

// ================================================================================================ Revolve

export const revolveExtraParams: ParamDef[] = [
  { type: 'enum', key: 'extent', help: 'Angle: turn by the angle below. To object: turn until the profile reaches a flat face or a plane.', label: 'Extent', display: 'segmented', default: 'angle', options: [{ value: 'angle', label: 'Angle' }, { value: 'toObject', label: 'To object' }] },
  { type: 'selection-ref', key: 'toFace', help: 'The flat face or plane the revolve stops at. Click it in the viewport.', label: 'To object', accepts: ['face', 'plane'], required: true, pick: true, default: [], visibleWhen: (v) => v.extent === 'toObject' },
  { type: 'enum', key: 'direction', help: 'One side: turn one way from the profile. Symmetric: the angle is shared, half each way. Two sides: a separate angle for each way.', label: 'Direction', display: 'segmented', default: 'one', options: [{ value: 'one', label: 'One side' }, { value: 'symmetric', label: 'Symmetric' }, { value: 'two', label: 'Two sides' }], visibleWhen: (v) => v.extent !== 'toObject' },
  { type: 'number', key: 'angle2', help: 'How far to turn the other way from the profile, in degrees.', label: 'Second angle', unit: 'deg', min: 0, max: 360, step: 5, default: 90, visibleWhen: (v) => v.extent !== 'toObject' && v.direction === 'two' },
]

export const revolveIsAdvanced = (p: ParamValues) => (p.extent ?? 'angle') === 'toObject' || (p.direction ?? 'one') !== 'one'

/** The point of the profiles farthest from the axis. */
function farthest(groups: ProfileGroup[], origin: Vec3, dir: Vec3): Vec3 | null {
  let best = 1e-9, at: Vec3 | null = null
  const d = norm3(dir)
  const world = (g: ProfileGroup, q: [number, number]): Vec3 => {
    const y = norm3(cross3(g.plane.normal, g.plane.xDir))
    return add3(g.plane.origin, add3(mul3(g.plane.xDir, q[0]), mul3(y, q[1])))
  }
  for (const g of groups) for (const pr of g.profiles) for (const sg of pr.outer) {
    const pts: [number, number][] = sg.k === 'c' ? [[sg.c[0] + sg.r, sg.c[1]], [sg.c[0] - sg.r, sg.c[1]], [sg.c[0], sg.c[1] + sg.r], [sg.c[0], sg.c[1] - sg.r]] : [sg.a]
    for (const q of pts) {
      const w = sub3(world(g, q), origin)
      const rad = sub3(w, mul3(d, dot3(w, d)))
      const r = Math.hypot(...rad)
      if (r > best) { best = r; at = world(g, q) }
    }
  }
  return at
}

/** Degrees to turn about the axis (in the axis direction) for the profile's far point to reach the plane, or null. */
export function angleToPlane(point: Vec3, axisOrigin: Vec3, axisDir: Vec3, planeOrigin: Vec3, planeNormal: Vec3): number | null {
  const d = norm3(axisDir), n = norm3(planeNormal)
  const rel = sub3(point, axisOrigin)
  const along = dot3(rel, d)
  const w = sub3(rel, mul3(d, along))
  const A = dot3(n, w), B = dot3(n, cross3(d, w))
  const C = dot3(n, sub3(planeOrigin, add3(axisOrigin, mul3(d, along))))
  const R = Math.hypot(A, B)
  if (R < 1e-9 || Math.abs(C) > R + 1e-9) return null
  const base = Math.atan2(B, A), off = Math.acos(Math.max(-1, Math.min(1, C / R)))
  const cands = [base + off, base - off].map((t) => ((t * 180) / Math.PI + 720) % 360).filter((t) => t > 1e-3)
  return cands.length ? Math.min(...cands) : null
}

export async function revolveAdvanced(kernel: Kernel, a: { id: string; name: string; groups: ProfileGroup[]; axisOrigin: Vec3; axisDir: Vec3; angle: number }, p: ParamValues, env: RefEnv): Promise<Body> {
  let { axisDir } = a
  let angle1: number, angle2 = 0
  if (p.extent === 'toObject') {
    const ref = ((p.toFace as string[]) ?? [])[0]
    if (!ref) throw new Error('Pick the face or plane to revolve to')
    const rep = new RefReport()
    const pl = await resolvePlane(ref, env, rep)
    const far = farthest(a.groups, a.axisOrigin, axisDir)
    if (!far) throw new Error('The profile lies on the axis, so it cannot be revolved')
    const t = angleToPlane(far, a.axisOrigin, axisDir, pl.origin, pl.normal)
    if (t === null) throw new Error('The revolve never reaches that face or plane. Pick one the profile turns into, or use an angle')
    angle1 = t
  } else if (p.direction === 'symmetric') {
    angle1 = Math.abs(a.angle) / 2
    angle2 = angle1
  } else if (p.direction === 'two') {
    angle1 = Math.abs(a.angle)
    angle2 = Math.max(0, num(p, 'angle2', 90))
  } else {
    angle1 = Math.abs(a.angle)
  }
  if (a.angle < 0 && p.extent !== 'toObject') axisDir = mul3(axisDir, -1)
  const args: RevolveAdvArgs = { id: a.id, name: a.name, groups: a.groups, axisOrigin: a.axisOrigin, axisDir, angle1: Math.min(360, angle1), angle2: Math.min(360, angle2) }
  return (await kernel.call('revolveAdv', args)) as Body
}

// ================================================================================================ Fillet and Chamfer

export const edgeExtraParams = (mode: 'fillet' | 'chamfer'): ParamDef[] => mode === 'fillet'
  ? [
    { type: 'enum', key: 'radiusType', help: 'Constant: one radius all along the edge. Variable: a radius at each end (and an optional one in the middle) that blends along the edge. Chord length: you give the straight distance between the two lines where the round leaves the faces.', label: 'Radius type', display: 'segmented', default: 'constant', options: [{ value: 'constant', label: 'Constant' }, { value: 'variable', label: 'Variable' }, { value: 'chord', label: 'Chord length' }] },
    { type: 'number', key: 'endSize', help: 'Radius at the far end of the edge, in mm. The Radius above is the start.', label: 'End radius', unit: 'mm', min: 0.001, step: 0.25, default: 2, visibleWhen: (v) => v.radiusType === 'variable' },
    { type: 'number', key: 'midSize', help: 'Radius part way along the edge, in mm. 0 leaves it out (a straight blend between the ends).', label: 'Middle radius', unit: 'mm', min: 0, step: 0.25, default: 0, visibleWhen: (v) => v.radiusType === 'variable' },
    { type: 'number', key: 'midPos', help: 'Where the middle radius sits along the edge, from 0 (start) to 1 (end).', label: 'Middle position', min: 0.1, max: 0.9, step: 0.05, default: 0.5, visibleWhen: (v) => v.radiusType === 'variable' && (v.midSize as number) > 0 },
    { type: 'bool', key: 'swap', help: 'Swap which end of the edge gets the start radius and which the end radius.', label: 'Swap ends', default: false, visibleWhen: (v) => v.radiusType === 'variable' },
    { type: 'number', key: 'chord', help: 'The straight distance, in mm, between the two lines where the fillet leaves the faces. The radius is worked out from it and the angle of each edge.', label: 'Chord length', unit: 'mm', min: 0.001, step: 0.25, default: 2, visibleWhen: (v) => v.radiusType === 'chord' },
    { type: 'number', key: 'setback', help: 'Corner setback: where two or more rounded edges meet at a corner, the radius eases up over this length so the corner patch is rounder and softer. 0 leaves the plain rolling-ball corner. (OpenCascade has no true vertex setback blend; this is the nearest it can do.)', label: 'Corner setback', unit: 'mm', min: 0, step: 0.5, default: 0 },
    { type: 'enum', key: 'continuity', help: 'G1: the round meets the faces tangentially (OpenCascade rolling ball). G2: the round surface itself is built curvature-smooth (C2). OpenCascade cannot make the join to the faces curvature-continuous, so G2 is a smoother surface, not a G2 join.', label: 'Continuity', display: 'segmented', default: 'g1', options: [{ value: 'g1', label: 'G1 (tangent)' }, { value: 'g2', label: 'G2 (smooth)' }] },
    { type: 'enum', key: 'rule', help: 'Rule fillet: which edges are rounded besides the ones you picked. Selected edges: just those. Edges of the faces: every edge of the faces the picked edges lie on. All convex / concave / all: every outside / inside / any sharp edge of the body.', label: 'Rule', display: 'select', default: 'selected', options: [{ value: 'selected', label: 'Selected edges' }, { value: 'faceEdges', label: 'All edges of their faces' }, { value: 'convex', label: 'All convex edges' }, { value: 'concave', label: 'All concave edges' }, { value: 'all', label: 'All edges' }] },
  ]
  : [
    { type: 'enum', key: 'chamferType', help: 'Equal distance: the same distance on both faces. Two distances: a different distance on each face. Distance and angle: a distance on one face and the angle of the bevel from it.', label: 'Chamfer type', display: 'select', default: 'equal', options: [{ value: 'equal', label: 'Equal distance' }, { value: 'twoDist', label: 'Two distances' }, { value: 'distAngle', label: 'Distance and angle' }] },
    { type: 'number', key: 'dist2', help: 'The distance on the other face, in mm.', label: 'Distance 2', unit: 'mm', min: 0.001, step: 0.25, default: 1, visibleWhen: (v) => v.chamferType === 'twoDist' },
    { type: 'number', key: 'angle', help: 'The angle the bevel makes with the first face, in degrees.', label: 'Angle', unit: 'deg', min: 1, max: 89, step: 1, default: 45, visibleWhen: (v) => v.chamferType === 'distAngle' },
    { type: 'bool', key: 'flipFace', help: 'Measure the first distance on the other face of the edge.', label: 'Flip side', default: false, visibleWhen: (v) => v.chamferType === 'twoDist' || v.chamferType === 'distAngle' },
  ]

export const edgeIsAdvanced = (mode: 'fillet' | 'chamfer', p: ParamValues) => mode === 'fillet'
  ? (p.radiusType ?? 'constant') !== 'constant' || num(p, 'setback') > 0 || p.continuity === 'g2' || (p.rule ?? 'selected') !== 'selected'
  : (p.chamferType ?? 'equal') !== 'equal'

/** The dialog values the preview is running with (the bisection that finds the largest size calls the kernel without them). */
export const edgeExtras: { current: ParamValues | null } = { current: null }

export function edgeModArgs(mode: 'fillet' | 'chamfer', p: ParamValues, base: { id: string; name: string; key: string; edges: number[]; fid: string; faces?: number[] }, size: number): EdgeAdvArgs {
  return {
    ...base, mode, size,
    radiusType: (p.radiusType as EdgeAdvArgs['radiusType']) ?? 'constant', endSize: num(p, 'endSize', size), midSize: num(p, 'midSize'), midPos: num(p, 'midPos', 0.5), swap: !!p.swap,
    chord: num(p, 'chord', 2), setback: num(p, 'setback'), continuity: p.continuity === 'g2' ? 'g2' : 'g1', rule: (p.rule as EdgeAdvArgs['rule']) ?? 'selected',
    chamferType: (p.chamferType as EdgeAdvArgs['chamferType']) ?? 'equal', dist2: num(p, 'dist2', size), angle: num(p, 'angle', 45), flipFace: !!p.flipFace,
  }
}

/** Fillet / chamfer of one body: the plain op, or the extended one when a Fusion option is set. */
export async function edgeModCall(kernel: Kernel, mode: 'fillet' | 'chamfer', p: ParamValues | null, base: { id: string; name: string; key: string; edges: number[]; fid: string; faces?: number[] }, size: number): Promise<Body> {
  if (p && edgeIsAdvanced(mode, p)) return (await kernel.call('edgeModAdv', edgeModArgs(mode, p, base, size))) as Body
  return (await kernel.call('edgeMod', { ...base, size, mode })) as Body
}

// ================================================================================================ Shell

export const shellExtraParams: ParamDef[] = [
  { type: 'bool', key: 'individual', help: 'Give some faces a wall thickness of their own. They are picked below; every other face keeps the Thickness above.', label: 'Individual thickness', default: false },
  { type: 'selection-ref', key: 'thickFaces', help: 'The flat faces that get their own wall thickness. Click them in the viewport.', label: 'Faces with own thickness', accepts: ['face'], multiple: true, pick: true, default: [], visibleWhen: (v) => !!v.individual },
  { type: 'number', key: 'faceThickness', help: 'The wall thickness of those faces, in mm.', label: 'Face thickness', unit: 'mm', min: 0.001, step: 0.5, default: 4, visibleWhen: (v) => !!v.individual },
]

export const shellIsAdvanced = (p: ParamValues) => !!p.individual && !!((p.thickFaces as string[] | undefined)?.length)

/** Shell of one body with the thicknesses of the picked faces, in the order the kernel op wants them. */
export function shellSpecial(p: ParamValues, body: Body, bodies: Body[], report = new RefReport()): { index: number; thickness: number }[] {
  const out: { index: number; thickness: number }[] = []
  for (const s of (p.thickFaces as string[]) ?? []) {
    const ref = decodeRef(s)
    const hit = ref && ref.kind === 'face' ? resolveFace(ref, bodies, report) : null
    if (!hit) throw new RefError('A face with its own thickness no longer exists. Pick it again.', report.lostRefs)
    if (hit.body.id === body.id) out.push({ index: hit.index, thickness: num(p, 'faceThickness', 4) })
  }
  return out
}

export const shellAdvArgs = (base: Omit<ShellAdvArgs, 'special'>, special: ShellAdvArgs['special']): ShellAdvArgs => ({ ...base, special })

// ================================================================================================ Draft

export const draftExtraParams: ParamDef[] = [
  { type: 'enum', key: 'draftType', help: 'Plane: tilt faces about a neutral plane. Parting line: the faces are split at a line and each half tilts away from it, like the halves of a mould. Step: only the faces on the pull side of the line tilt; the other side stays straight.', label: 'Draft type', display: 'segmented', default: 'plane', options: [{ value: 'plane', label: 'Plane' }, { value: 'parting', label: 'Parting line' }, { value: 'step', label: 'Step' }] },
  { type: 'selection-ref', key: 'partingLine', help: 'An edge on the part that marks the parting line: the faces are split at the level of this edge, square to the pull direction. Click an edge.', label: 'Parting line', accepts: ['edge'], required: true, pick: true, default: [], visibleWhen: (v) => v.draftType === 'parting' || v.draftType === 'step' },
]

// ================================================================================================ Hole

export const holeExtraParams: ParamDef[] = [
  { type: 'selection-ref', key: 'edgeA', help: 'Optional: an edge of the face that the first hole is measured from. Click an edge, then type the offset below.', label: 'Edge 1', accepts: ['edge'], pick: true, default: [] },
  { type: 'number', key: 'offA', help: 'How far the first hole sits from Edge 1, measured square to the edge, in mm.', label: 'Offset from edge 1', unit: 'mm', min: 0, step: 0.5, default: 10, visibleWhen: (v) => !!((v.edgeA as string[] | undefined)?.length) },
  { type: 'selection-ref', key: 'edgeB', help: 'Optional: a second edge of the face, for the other direction.', label: 'Edge 2', accepts: ['edge'], pick: true, default: [] },
  { type: 'number', key: 'offB', help: 'How far the first hole sits from Edge 2, measured square to the edge, in mm.', label: 'Offset from edge 2', unit: 'mm', min: 0, step: 0.5, default: 10, visibleWhen: (v) => !!((v.edgeB as string[] | undefined)?.length) },
]

/** Move the point `at` on a face (normal `n`) so it sits `off` mm from each picked edge, on the side it is on now. */
export function placeFromEdges(at: Vec3, n: Vec3, p: ParamValues, bodies: Body[], report: RefReport): Vec3 {
  const lines: { nrm: Vec3; c: number }[] = []
  for (const [key, offKey] of [['edgeA', 'offA'], ['edgeB', 'offB']] as const) {
    const s = ((p[key] as string[] | undefined) ?? [])[0]
    if (!s) continue
    const ref = decodeRef(s)
    const hit = ref && ref.kind === 'edge' ? resolveEdge(ref, bodies, report) : null
    if (!hit) { report.lost.set(s, 'An edge the hole is measured from no longer exists'); continue }
    const sg = edgeSigs(hit.body)[hit.index]
    const flat = sub3(sg.direction, mul3(n, dot3(sg.direction, n)))
    if (Math.hypot(...flat) < 1e-6) throw new Error('Edge ' + (key === 'edgeA' ? '1' : '2') + ' is square to the face, so a distance from it means nothing here. Pick an edge that lies in the face')
    const nrm = norm3(cross3(n, norm3(flat)))
    const side = dot3(nrm, sub3(at, sg.midpoint))
    const sgn = side < 0 ? -1 : 1
    lines.push({ nrm, c: dot3(nrm, sg.midpoint) + sgn * num(p, offKey, 10) })
  }
  if (!lines.length) return at
  if (lines.length === 1) {
    const l = lines[0]
    return add3(at, mul3(l.nrm, l.c - dot3(l.nrm, at)))
  }
  const [a, b] = lines
  const k = dot3(a.nrm, b.nrm)
  const det = 1 - k * k
  if (det < 1e-6) throw new Error('The two edges are parallel, so they cannot fix a position. Pick two edges that meet at an angle')
  const ra = a.c - dot3(a.nrm, at), rb = b.c - dot3(b.nrm, at)
  const x = (ra - k * rb) / det, y = (rb - k * ra) / det
  return add3(at, add3(mul3(a.nrm, x), mul3(b.nrm, y)))
}

void faceSigs
void isPlanarFace
