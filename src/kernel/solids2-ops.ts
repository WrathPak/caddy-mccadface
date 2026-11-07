/**
 * Worker ops for the second wave of solid tools: Rib / Web, Sphere, Torus, Coil, Pipe, advanced Sweep and Loft, Revolve extents,
 * advanced Fillet / Chamfer, per-face Shell thickness, parting line and step Draft, free body transforms (Move / Copy / Align)
 * and Scale. Every result keeps persistent face names (see naming.ts). This file only adds ops; the older ops are untouched.
 */
import {
  assembleWire, cast, getOC, isShape3D, makeBSplineApproximation, makeBaseBox, makeBezierCurve, makeCircle, makeHelix, makeLine, makePolygon,
  makeSphere, makeThreePointArc, measureArea, measureVolume, DEG2RAD, type AnyShape, type Face, type Wire,
} from 'replicad'
import { registerOp, getTopo } from './store'
import { boolNamed, eachInList, finalize, fuseNamed, indexer, inherit, shellNamed, rootNames, carryNames, type NShape } from './naming'
import { topoOf, type Shape } from './occ'
import { labelEdges, planeOf, profileFace, profileWires, type ProfileGroup } from './model-ops'
import { pathWire, type LoftSection, type PathSeg } from './solid-ops'
import { planeBasis } from './print-geom'
import { applyPoint, cross3, dot3, norm3, sub3, add3, mul3, type Xf } from './xform'
import { xformNamed, xformShape } from './modeling-ops'
import { profileIdOf, type Vec3 } from '../sketch/types'
import type { TopoMesh } from './types'
import { bodyFromTopo } from './store'

type Sh = Shape
const any = (s: NShape) => s.shape as unknown as AnyShape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oc = () => getOC() as any
const vol = (s: Sh | NShape | AnyShape) => {
  const sh = 'shape' in s ? (s as NShape).shape : s
  try { return Math.abs(measureVolume(sh as never)) } catch { return 0 }
}
const v3 = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const named = (p: NShape, fid: string, tag: string): NShape => ({ shape: p.shape, faces: finalize(p.shape as unknown as AnyShape, p.faces, fid, tag) })
const boundsOfShape = (s: Sh): [Vec3, Vec3] => (s as unknown as { boundingBox: { bounds: [Vec3, Vec3] } }).boundingBox.bounds
const diagOf = (s: Sh) => { const [a, b] = boundsOfShape(s); return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) }

/** A big block with one face on the plane through `origin` and the block on the `normal` side. */
export function halfSpace(origin: Vec3, normal: Vec3, size: number): Sh {
  const { u, v, n } = planeBasis(normal)
  const b = makeBaseBox(2 * size, 2 * size, size) as unknown as Sh
  // the box is centred on x and y with its bottom on z = 0: turn its axes onto (u, v, n) and put the middle of its bottom face on the origin
  const R = [u[0], v[0], n[0], u[1], v[1], n[1], u[2], v[2], n[2]]
  return xformShape(b, { t: 'rigid', R, p: origin })
}

// ================================================================================================ Sphere, Torus

export interface SphereArgs { id: string; name: string; radius: number; origin: Vec3 }
registerOp<SphereArgs>('sphereTool', (a, h) => {
  if (!(a.radius > 0)) throw new Error('The radius must be greater than zero')
  const s = (makeSphere(a.radius) as unknown as Sh).translate(a.origin[0], a.origin[1], a.origin[2]) as Sh
  return h.sendBody(h.bodyFromShape(a.id, a.name, s, topoOf(s as unknown as AnyShape).faces.map(() => [`${a.id}:sphere`])))
})

export interface TorusArgs { id: string; name: string; major: number; minor: number; origin: Vec3; dir: Vec3 }
registerOp<TorusArgs>('torusTool', (a, h) => {
  if (!(a.major > 0) || !(a.minor > 0)) throw new Error('Both radii must be greater than zero')
  if (a.minor >= a.major) throw new Error('The tube radius must be smaller than the ring radius, or the torus crosses itself')
  const o = oc()
  const ax = new o.gp_Ax2(new o.gp_Pnt(...a.origin), new o.gp_Dir(...norm3(a.dir)))
  const mk = new o.BRepPrimAPI_MakeTorus(ax, a.major, a.minor)
  try {
    const shape = cast(mk.Shape()) as unknown as Sh
    return h.sendBody(h.bodyFromShape(a.id, a.name, shape, topoOf(shape as unknown as AnyShape).faces.map(() => [`${a.id}:torus`])))
  } finally { ax.delete(); mk.delete() }
})

// ================================================================================================ pipe shell core

export type SectionKind = 'circle' | 'square' | 'triangle'

/** The wire of a section in the plane through `at` with the given normal: `size` is the diameter / side. */
export function sectionWire(kind: SectionKind, size: number, at: Vec3, normal: Vec3, xHint?: Vec3): Wire {
  const n = norm3(normal)
  const { u, v } = planeBasis(n)
  let x = u, y = v
  if (xHint) {
    const d = dot3(xHint, n)
    const px = norm3(sub3(xHint, mul3(n, d)))
    if (len(px) > 0.5) { x = px; y = cross3(n, px) }
  }
  const P = (a: number, b: number): Vec3 => add3(at, add3(mul3(x, a), mul3(y, b)))
  if (kind === 'circle') return assembleWire([makeCircle(size / 2, at, n)])
  const ring = (pts: Vec3[]): Wire => assembleWire(pts.map((p, i) => makeLine(p, pts[(i + 1) % pts.length])))
  if (kind === 'square') { const s = size / 2; return ring([P(-s, -s), P(s, -s), P(s, s), P(-s, s)]) }
  const R = size / Math.sqrt(3) // circumradius for side `size`
  return ring([P(0, R), P(-size / 2, -R / 2), P(size / 2, -R / 2)])
}

/** Start point and tangent of the first edge of a path. */
export function pathStart(path: PathSeg[]): { p: Vec3; t: Vec3 } {
  const w = pathWire(path)
  const e = w.edges[0]
  return { p: v3(e.startPoint), t: norm3(v3(e.tangentAt(0))) }
}

export interface PipeOpts {
  /** 'perpendicular' keeps the profile square to the path (corrected Frenet), 'parallel' keeps it parallel to where it started */
  orientation?: 'perpendicular' | 'parallel'
  /** a second curve that steers the profile's turn */
  guide?: PathSeg[]
  /** total twist in degrees along the path */
  twist?: number
  /** taper angle in degrees: positive makes the profile smaller toward the end */
  taper?: number
  /** the size (in mm) the taper shrinks, taken from the section radius */
  sectionRadius?: number
  frenet?: boolean
}

function pathLength(path: PathSeg[]): number {
  return pathWire(path).edges.reduce((s, e) => s + e.length, 0)
}

/** Points and tangents along a path (arc length steps over all edges). */
function sampleAlong(path: PathSeg[], n: number): { p: Vec3; t: Vec3; s: number }[] {
  const edges = pathWire(path).edges
  const lens = edges.map((e) => e.length)
  const total = lens.reduce((a, b) => a + b, 0)
  const out: { p: Vec3; t: Vec3; s: number }[] = []
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * total
    let acc = 0, k = 0
    while (k < edges.length - 1 && acc + lens[k] < s - 1e-9) { acc += lens[k]; k++ }
    const u = lens[k] > 0 ? Math.min(1, Math.max(0, (s - acc) / lens[k])) : 0
    out.push({ p: v3(edges[k].pointAt(u)), t: norm3(v3(edges[k].tangentAt(u))), s: s / (total || 1) })
  }
  return out
}

/** A curve whose offset from the path turns by `twist` degrees along it: steers the sweep to a twisted result. */
function twistGuide(path: PathSeg[], twist: number, radius: number, x0: Vec3): Wire {
  const N = Math.max(24, Math.min(160, Math.round(Math.abs(twist) / 6) + 24))
  const S = sampleAlong(path, N)
  let u = norm3(sub3(x0, mul3(S[0].t, dot3(x0, S[0].t))))
  const pts: Vec3[] = []
  S.forEach((q, i) => {
    if (i > 0) {
      // parallel transport of u onto the new tangent
      const t0 = S[i - 1].t, t1 = q.t
      const ax = cross3(t0, t1)
      const sn = len(ax), cs = dot3(t0, t1)
      if (sn > 1e-9) {
        const k = mul3(ax, 1 / sn)
        u = add3(add3(mul3(u, cs), mul3(cross3(k, u), sn)), mul3(k, dot3(k, u) * (1 - cs)))
      }
      u = norm3(sub3(u, mul3(t1, dot3(u, t1))))
    }
    const v = cross3(q.t, u)
    const phi = twist * DEG2RAD * q.s
    pts.push(add3(q.p, mul3(add3(mul3(u, Math.cos(phi)), mul3(v, Math.sin(phi))), radius)))
  })
  return assembleWire([makeBSplineApproximation(pts)])
}

/**
 * One profile wire swept along a path with persistent names (walls: the profile edge label + the path segment, caps: the profile id).
 * Orientation, a guide curve, twist and taper are the ways OpenCascade's pipe shell lets the profile change on the way.
 */
export function pipeNamed(wire: Wire, edgeLabels: string[], path: PathSeg[], o: PipeOpts, fid: string, pid: string, startFrame?: { p: Vec3; t: Vec3; x: Vec3 }): NShape {
  const oc_ = oc()
  const edges = wire.edges
  const spine = pathWire(path)
  const mk = new oc_.BRepOffsetAPI_MakePipeShell(spine.wrapped)
  const toDelete: { delete(): void }[] = [mk]
  try {
    mk.SetTransitionMode(oc_.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner)
    if (o.guide && o.guide.length) {
      const gw = pathWire(o.guide)
      mk.SetMode(gw.wrapped, false, oc_.BRepFill_TypeOfContact.BRepFill_NoContact)
    } else if (o.twist && Math.abs(o.twist) > 1e-9) {
      const f = startFrame ?? { ...pathStart(path), x: planeBasis(pathStart(path).t).u }
      const gw = twistGuide(path, o.twist, Math.max(1, (o.sectionRadius ?? 5) * 2), f.x)
      mk.SetMode(gw.wrapped, true, oc_.BRepFill_TypeOfContact.BRepFill_NoContact)
    } else if (o.orientation === 'parallel') {
      const f = startFrame ?? { ...pathStart(path), x: planeBasis(pathStart(path).t).u }
      const ax = new oc_.gp_Ax2(new oc_.gp_Pnt(...f.p), new oc_.gp_Dir(...f.t), new oc_.gp_Dir(...f.x))
      toDelete.push(ax)
      mk.SetMode(ax)
    } else if (o.frenet) mk.SetMode(true)
    if (o.taper && Math.abs(o.taper) > 1e-9) {
      const L = pathLength(path)
      const R = Math.max(1e-6, o.sectionRadius ?? 5)
      const end = 1 - (L * Math.tan(o.taper * DEG2RAD)) / R
      if (!(end > 0.02)) throw new Error('The taper is too steep: the profile would shrink to nothing before the end of the path')
      const law = new oc_.Law_Linear()
      law.Set(0, 1, L, end)
      const trimmed = law.Trim(0, L, 1e-6)
      toDelete.push(law)
      mk.SetLaw(wire.wrapped, trimmed, false, false)
    } else mk.Add(wire.wrapped, false, false)
    mk.Build()
    mk.MakeSolid()
    const shape = cast(mk.Shape()) as unknown as Sh
    if (!isShape3D(shape as never)) throw new Error('Could not sweep to a 3d shape')
    const topo = topoOf(shape as unknown as AnyShape)
    const find = indexer(topo.faces, topo.faceHashes)
    const claims: string[][] = topo.faces.map(() => [])
    const f0 = find(mk.FirstShape()), f1 = find(mk.LastShape())
    if (f0 >= 0) claims[f0].push(`${fid}:start:${pid}`)
    if (f1 >= 0) claims[f1].push(`${fid}:end:${pid}`)
    edges.forEach((e, i) => {
      const hit: number[] = []
      eachInList(mk.Generated(e.wrapped as never) as never, (sh) => hit.push(find(sh)))
      hit.forEach((j, k) => {
        const seg = hit.length === path.length ? path[k].id ?? String(k) : String(k)
        if (j >= 0) claims[j].push(`${fid}:side:${edgeLabels[i] || 'e' + i}:${seg}`)
      })
    })
    return { shape, faces: claims }
  } finally {
    toDelete.forEach((d) => { try { d.delete() } catch { /* already gone */ } })
  }
}

const valid = (s: Sh) => vol(s) > 1e-9

// ================================================================================================ Pipe and Coil

export interface PipeArgs { id: string; name: string; path: PathSeg[]; section: SectionKind; size: number; hollow: boolean; wall: number }
registerOp<PipeArgs>('pipeTool', (a, h) => {
  if (!(a.size > 0)) throw new Error('The section size must be greater than zero')
  if (a.hollow && !(a.wall > 0 && a.wall * 2 < a.size)) throw new Error('The wall must be thicker than zero and less than half the section size')
  const st = pathStart(a.path)
  const xHint = planeBasis(st.t).u
  const labels = (kind: SectionKind) => (kind === 'circle' ? ['wall'] : kind === 'square' ? ['a', 'b', 'c', 'd'] : ['a', 'b', 'c'])
  const outer = pipeNamed(sectionWire(a.section, a.size, st.p, st.t, xHint), labels(a.section), a.path, { sectionRadius: a.size / 2 }, a.id, 'o', { ...st, x: xHint })
  let solid = named(outer, a.id, 'o')
  if (a.hollow) {
    const innerSize = a.size - 2 * a.wall
    const inner = pipeNamed(sectionWire(a.section, innerSize, st.p, st.t, xHint), labels(a.section).map((l) => 'in' + l), a.path, { sectionRadius: innerSize / 2 }, a.id, 'i', { ...st, x: xHint })
    // lengthen the bore a little at both ends so the cut opens both ends cleanly
    solid = boolNamed('cut', solid, named(inner, a.id, 'h'), a.id)
  }
  if (!valid(solid.shape)) throw new Error('The pipe produced no solid; check that the path is smooth enough for this section size')
  return h.sendBody(h.bodyFromShape(a.id, a.name, solid.shape, solid.faces))
})

export interface CoilArgs {
  id: string; name: string; origin: Vec3; dir: Vec3
  /** helix diameter measured to the middle of the section */
  diameter: number
  pitch: number
  height: number
  section: SectionKind
  size: number
  hollow: boolean
  wall: number
  leftHand: boolean
}
registerOp<CoilArgs>('coilTool', (a, h) => {
  if (!(a.diameter > 0) || !(a.pitch > 0) || !(a.height > 0) || !(a.size > 0)) throw new Error('Diameter, pitch, height and section size must be greater than zero')
  if (a.size >= a.diameter) throw new Error('The section must be smaller than the coil diameter')
  if (a.size > a.pitch * 1.0001 && a.section !== 'circle') throw new Error('The section is taller than the pitch: the turns would overlap. Use a larger pitch or a smaller section')
  if (a.size > a.pitch * 1.0001) throw new Error('The section is thicker than the pitch: the turns would overlap. Use a larger pitch or a smaller section')
  const d = norm3(a.dir)
  const r = a.diameter / 2
  // helix about +Z from the origin, then turned onto the real axis
  const helix = makeHelix(a.pitch, a.height, r, [0, 0, 0], [0, 0, 1], a.leftHand)
  const e0 = helix.edges[0]
  const start = v3(e0.startPoint)
  const tan = norm3(v3(e0.tangentAt(0)))
  const oc_ = oc()
  const prof = sectionWire(a.section, a.size, start, tan, [Math.cos(0), 0, 0])
  const mk = new oc_.BRepOffsetAPI_MakePipeShell(helix.wrapped)
  const ax = new oc_.gp_Ax1(new oc_.gp_Pnt(0, 0, 0), new oc_.gp_Dir(0, 0, 1))
  let shape: Sh
  try {
    // a helix is a constant-curvature curve: the corrected Frenet frame holds the section square to it all the way
    mk.SetMode(true)
    mk.Add(prof.wrapped, false, false)
    mk.Build()
    mk.MakeSolid()
    shape = cast(mk.Shape()) as unknown as Sh
    if (!isShape3D(shape as never)) throw new Error('Could not make the coil')
  } finally { mk.delete(); ax.delete() }
  let out: NShape = { shape, faces: rootNames(shape as unknown as AnyShape, a.id, 'coil') }
  if (a.hollow) {
    if (!(a.wall > 0 && a.wall * 2 < a.size)) throw new Error('The wall must be thicker than zero and less than half the section size')
    const inner = sectionWire(a.section, a.size - 2 * a.wall, start, tan, [1, 0, 0])
    const mk2 = new oc_.BRepOffsetAPI_MakePipeShell(makeHelix(a.pitch, a.height, r, [0, 0, 0], [0, 0, 1], a.leftHand).wrapped)
    try {
      mk2.SetMode(true); mk2.Add(inner.wrapped, false, false); mk2.Build(); mk2.MakeSolid()
      const bore = cast(mk2.Shape()) as unknown as Sh
      out = boolNamed('cut', out, { shape: bore, faces: rootNames(bore as unknown as AnyShape, a.id, 'bore') }, a.id)
    } finally { mk2.delete() }
  }
  if (!valid(out.shape)) throw new Error('The coil produced no solid')
  // put the axis where the dialog says: Z -> dir, origin
  const R = rotZTo(d)
  const xf: Xf = { t: 'rigid', R, p: a.origin }
  const moved = xformNamed(out, xf, '')
  return h.sendBody(h.bodyFromShape(a.id, a.name, moved.shape, finalize(moved.shape as unknown as AnyShape, moved.faces, a.id, 'coil')))
})

/** Rotation matrix (row-major) taking +Z to `d`. */
function rotZTo(d: Vec3): number[] {
  const z: Vec3 = [0, 0, 1]
  const c = dot3(z, d)
  if (c > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  if (c < -1 + 1e-12) return [1, 0, 0, 0, -1, 0, 0, 0, -1]
  const k = norm3(cross3(z, d))
  const s = Math.sqrt(1 - c * c), t = 1 - c
  return [t * k[0] * k[0] + c, t * k[0] * k[1] - s * k[2], t * k[0] * k[2] + s * k[1], t * k[0] * k[1] + s * k[2], t * k[1] * k[1] + c, t * k[1] * k[2] - s * k[0], t * k[0] * k[2] - s * k[1], t * k[1] * k[2] + s * k[0], t * k[2] * k[2] + c]
}

// ================================================================================================ Sweep (advanced)

export interface SweepAdvArgs {
  id: string; name: string; groups: ProfileGroup[]; path: PathSeg[]
  orientation: 'perpendicular' | 'parallel'
  taper: number
  twist: number
  guide?: PathSeg[]
}
registerOp<SweepAdvArgs>('sweepAdv', (a, h) => {
  const parts: NShape[] = []
  for (const g of a.groups) {
    const plane = planeOf(g.plane)
    for (const pr of g.profiles) {
      const { outer, holes } = profileWires(plane, pr)
      const pid = profileIdOf(pr.outer) || 'p'
      const st = pathStart(a.path)
      // the section radius used by the taper and twist: that of the circle of equal area
      const face = profileFace(plane, pr)
      const A = Math.abs(measureArea(face))
      const R = Math.sqrt(A / Math.PI)
      const opts: PipeOpts = { orientation: a.orientation, taper: a.taper, twist: a.twist, guide: a.guide, sectionRadius: R }
      const frame = { ...st, x: planeBasis(st.t).u }
      let solid = named(pipeNamed(outer, labelEdges(g.plane, outer.edges, pr), a.path, opts, a.id, pid, frame), a.id, 'o')
      for (const hw of holes) {
        const cutter = named(pipeNamed(hw, labelEdges(g.plane, hw.edges, pr), a.path, opts, a.id, pid, frame), a.id, 'h')
        solid = boolNamed('cut', solid, cutter, a.id)
      }
      if (!valid(solid.shape)) throw new Error('The sweep produced no solid; check that the profile touches the path start')
      parts.push(named(solid, a.id, 'p' + parts.length))
    }
  }
  if (!parts.length) throw new Error('Nothing to sweep')
  const r = fuseNamed(parts, a.id)
  return h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))
})



// ================================================================================================ Loft (advanced)

export interface LoftAdvArgs {
  id: string; name: string; sections: LoftSection[]; ruled: boolean
  /** per end: 'free', 'normal' (leaves the profile square to its plane) or 'smooth' (C2 surface) */
  startCond: 'free' | 'normal' | 'smooth'
  endCond: 'free' | 'normal' | 'smooth'
  /** how far a 'normal' end holds square, as a fraction of the distance to its neighbour section (0..1) */
  startWeight: number
  endWeight: number
  rails?: PathSeg[][]
  centre?: PathSeg[]
}

function sectionCentre(w: Wire): Vec3 {
  const o = oc()
  const props = new o.GProp_GProps()
  try { o.BRepGProp.LinearProperties(w.wrapped, props, false, false); const c = props.CentreOfMass(); return [c.X(), c.Y(), c.Z()] } finally { props.delete() }
}
function moveWire(w: Wire, by: Vec3): Wire {
  return (w.clone() as unknown as { translate(x: number, y: number, z: number): Wire }).translate(by[0], by[1], by[2])
}

registerOp<LoftAdvArgs>('loftAdv', (a, h) => {
  if (a.sections.length < 2) throw new Error('A loft needs at least two profiles')
  const sets = a.sections.map((s) => profileWires(planeOf(s.plane), s.profile))
  const first = a.sections[0], last = a.sections[a.sections.length - 1]
  const startId = profileIdOf(first.profile.outer) || 'p', endId = profileIdOf(last.profile.outer) || 'p'
  const labelsOf = (w: Wire) => labelEdges(first.plane, w.edges, first.profile)
  const holeCount = sets[0].holes.length
  if (sets.some((s) => s.holes.length !== holeCount)) throw new Error('All loft profiles must have the same number of holes')
  const oc_ = oc()
  const build = (wires: Wire[], tag: string): NShape => {
    let ws = wires
    if (a.rails?.length || a.centre?.length) return railLoft(wires, a, tag, startId, endId)
    // end conditions: hold the end square to its profile by adding a section a little way in, along the profile normal
    const normalOf = (i: number) => norm3(a.sections[i].plane.normal)
    const centreOf = (w: Wire) => sectionCentre(w)
    const extra: { at: number; w: Wire }[] = []
    const holdEnd = (i: number, j: number, weight: number) => {
      const c0 = centreOf(wires[i]), c1 = centreOf(wires[j])
      const n = normalOf(i)
      const toward = dot3(sub3(c1, c0), n) >= 0 ? 1 : -1
      const dist = len(sub3(c1, c0)) * Math.min(0.9, Math.max(0.02, weight))
      extra.push({ at: i, w: moveWire(wires[i], mul3(n, toward * dist)) })
    }
    if (a.startCond === 'normal') holdEnd(0, 1, a.startWeight)
    if (a.endCond === 'normal') holdEnd(wires.length - 1, wires.length - 2, a.endWeight)
    if (extra.length) {
      ws = [...wires]
      const s = extra.find((e) => e.at === 0), e = extra.find((x) => x.at === wires.length - 1)
      if (e) ws.splice(ws.length - 1, 0, e.w)
      if (s) ws.splice(1, 0, s.w)
    }
    const mk = new oc_.BRepOffsetAPI_ThruSections(true, a.ruled, 1e-6)
    try {
      mk.SetMutableInput(false)
      if (a.startCond === 'smooth' || a.endCond === 'smooth') { mk.SetSmoothing(true); mk.SetContinuity(oc_.GeomAbs_Shape.GeomAbs_C2) }
      ws.forEach((w) => mk.AddWire(w.wrapped))
      mk.Build()
      const shape = cast(mk.Shape()) as unknown as Sh
      if (!isShape3D(shape as never)) throw new Error('Could not loft to a 3d shape')
      const topo = topoOf(shape as unknown as AnyShape)
      const find = indexer(topo.faces, topo.faceHashes)
      const claims: string[][] = topo.faces.map(() => [])
      const f0 = find(mk.FirstShape()), f1 = find(mk.LastShape())
      if (f0 >= 0) claims[f0].push(`${a.id}:start:${startId}`)
      if (f1 >= 0 && f1 !== f0) claims[f1].push(`${a.id}:end:${endId}`)
      wires[0].edges.forEach((e, i) => {
        const hit: number[] = []
        eachInList(mk.Generated(e.wrapped as never) as never, (sh) => hit.push(find(sh)))
        const lb = labelsOf(wires[0])
        hit.forEach((j, k) => { if (j >= 0) claims[j].push(`${a.id}:side:${lb[i] || 'e' + i}${hit.length > 1 ? ':s' + k : ''}`) })
      })
      return { shape, faces: claims }
    } finally { mk.delete() }
  }
  let solid = named(build(sets.map((s) => s.outer), 'o'), a.id, 'o')
  for (let i = 0; i < holeCount; i++) solid = boolNamed('cut', solid, named(build(sets.map((s) => s.holes[i]), 'h'), a.id, 'h'), a.id)
  if (!valid(solid.shape)) throw new Error('The loft produced no solid; check the profile order and positions')
  return h.sendBody(h.bodyFromShape(a.id, a.name, solid.shape, solid.faces))
})

/** A loft that follows rails or a centre line: a pipe shell whose spine is the (first) rail or the centre line, with a second rail steering the turn. */
function railLoft(wires: Wire[], a: LoftAdvArgs, _tag: string, startId: string, endId: string): NShape {
  const oc_ = oc()
  const spinePath = a.centre?.length ? a.centre : a.rails![0]
  const guidePath = !a.centre?.length && a.rails && a.rails.length > 1 ? a.rails[1] : undefined
  const spine = pathWire(spinePath)
  const mk = new oc_.BRepOffsetAPI_MakePipeShell(spine.wrapped)
  const keep: { delete(): void }[] = [mk]
  try {
    if (guidePath) mk.SetMode(pathWire(guidePath).wrapped, true, oc_.BRepFill_TypeOfContact.BRepFill_NoContact)
    else mk.SetMode(false)
    const verts: Vec3[] = [v3(spine.edges[0].startPoint), ...spine.edges.map((e) => v3(e.endPoint))]
    // sections sit where the spine passes closest to them: only the vertices of the spine can take a section
    const used = new Set<number>()
    wires.forEach((w) => {
      const c = sectionCentre(w)
      let best = 0, bd = Infinity
      verts.forEach((p, i) => { if (used.has(i)) return; const d = len(sub3(p, c)); if (d < bd) { bd = d; best = i } })
      const tol = Math.max(1e-3, diagOfWire(w) * 1.2)
      if (bd > tol) throw new Error('A profile is not at a corner or an end of the rail / centre line. Draw the line so that it ends in the middle of the first and last profile, with a corner at each profile in between')
      used.add(best)
      const vtx = oc_.BRepBuilderAPI_MakeVertex
      const mv = new vtx(new oc_.gp_Pnt(...verts[best]))
      keep.push(mv)
      mk.Add(w.wrapped, mv.Vertex(), false, false)
    })
    mk.Build()
    mk.MakeSolid()
    const shape = cast(mk.Shape()) as unknown as Sh
    if (!isShape3D(shape as never)) throw new Error('Could not loft along the rails')
    const topo = topoOf(shape as unknown as AnyShape)
    const find = indexer(topo.faces, topo.faceHashes)
    const claims: string[][] = topo.faces.map(() => [])
    const f0 = find(mk.FirstShape()), f1 = find(mk.LastShape())
    if (f0 >= 0) claims[f0].push(`${a.id}:start:${startId}`)
    if (f1 >= 0 && f1 !== f0) claims[f1].push(`${a.id}:end:${endId}`)
    return { shape, faces: claims }
  } finally { keep.forEach((d) => { try { d.delete() } catch { /* gone */ } }) }
}
const diagOfWire = (w: Wire) => { const b = (w as unknown as { boundingBox: { bounds: [Vec3, Vec3] } }).boundingBox.bounds; return Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]) }

// ================================================================================================ Revolve (extents)

export interface RevolveAdvArgs {
  id: string; name: string; groups: ProfileGroup[]; axisOrigin: Vec3; axisDir: Vec3
  /** degrees turned in the axis direction and the other way round (a symmetric revolve is two equal halves) */
  angle1: number
  angle2: number
}
registerOp<RevolveAdvArgs>('revolveAdv', (a, h) => {
  const total = a.angle1 + a.angle2
  if (!(a.angle1 >= 0) || !(a.angle2 >= 0) || total < 1e-9) throw new Error('The angle must be greater than zero')
  const parts: NShape[] = []
  for (const g of a.groups) {
    const plane = planeOf(g.plane)
    for (const pr of g.profiles) {
      let face = profileFace(plane, pr)
      // the profile first turns back by angle2, then the revolve runs the whole span forward
      if (a.angle2 > 1e-9) face = face.rotate(-a.angle2, a.axisOrigin, a.axisDir) as Face
      const sweep = Math.min(360, total)
      const o = oc()
      const ax = new o.gp_Ax1(new o.gp_Pnt(...a.axisOrigin), new o.gp_Dir(...norm3(a.axisDir)))
      const mk = new o.BRepPrimAPI_MakeRevol(face.wrapped, ax, sweep * DEG2RAD, false)
      try {
        const shape = cast(mk.Shape()) as unknown as Sh
        if (!isShape3D(shape as never)) throw new Error('Could not revolve to a 3d shape')
        const topo = topoOf(shape as unknown as AnyShape)
        const find = indexer(topo.faces, topo.faceHashes)
        const claims: string[][] = topo.faces.map(() => [])
        const pid = profileIdOf(pr.outer) || 'p'
        const f0 = find(mk.FirstShape() as never), f1 = find(mk.LastShape() as never)
        if (f0 >= 0 && sweep < 360) claims[f0].push(`${a.id}:start:${pid}`)
        if (f1 >= 0 && f1 !== f0 && sweep < 360) claims[f1].push(`${a.id}:end:${pid}`)
        const lb = labelEdges(g.plane, profileFace(plane, pr).edges, pr)
        face.edges.forEach((e, i) => eachInList(mk.Generated(e.wrapped) as never, (sh) => { const j = find(sh); if (j >= 0) claims[j].push(`${a.id}:rev:${lb[i] || 'e' + i}`) }))
        parts.push(named({ shape, faces: claims }, a.id, 'p' + parts.length))
      } finally { ax.delete(); mk.delete() }
    }
  }
  if (!parts.length) throw new Error('Nothing to revolve')
  const r = fuseNamed(parts, a.id)
  return h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))
})

// ================================================================================================ Rib and Web

export interface RibArgs {
  id: string; name: string; key: string
  segs: PathSeg[]
  /** the sketch plane normal */
  normal: Vec3
  thickness: number
  /** thickness on both sides of the curve (otherwise on one side, the flip side picks which) */
  symmetric: boolean
  /** 'plane': the rib grows from the curve inside the sketch plane, its thickness across it. 'normal': it grows along the plane normal, thickness within the plane */
  direction: 'plane' | 'normal'
  flip: boolean
  both: boolean
  /** 0: up to the next faces; otherwise this far */
  depth: number
  fid: string
}

function segDirection(s: PathSeg): Vec3 {
  if (s.k === 'l') return norm3(sub3(s.b, s.a))
  if (s.k === 'a') return norm3(sub3(s.b, s.a))
  return norm3(sub3(s.b, s.a))
}
function segEdge(s: PathSeg) {
  return s.k === 'l' ? makeLine(s.a, s.b) : s.k === 'b' ? makeBezierCurve([s.a, s.c1, s.c2, s.b]) : makeThreePointArc(s.a, s.m, s.b)
}
function prism(shape: { wrapped: unknown }, v: Vec3): Sh {
  const o = oc()
  const vec = new o.gp_Vec(...v)
  const mk = new o.BRepPrimAPI_MakePrism(shape.wrapped, vec, false, true)
  try { return cast(mk.Shape()) as unknown as Sh } finally { vec.delete(); mk.delete() }
}

registerOp<RibArgs>('ribTool', (a, h) => {
  if (!(a.thickness > 0)) throw new Error('The thickness must be greater than zero')
  if (!a.segs.length) throw new Error('Select a sketch with a line or curve')
  const body = h.getNamed(a.key)
  const N = norm3(a.normal)
  const diag = diagOf(body.shape) + a.segs.reduce((s, q) => s + len(sub3(q.b, q.a)), 0)
  const reach = a.depth > 0 ? a.depth : diag * 2 + 10
  const slabs: Sh[] = []
  const seeds: Vec3[] = []
  const sign = a.flip ? -1 : 1
  for (const s of a.segs) {
    const T = segDirection(s)
    let grow: Vec3, across: Vec3
    if (a.direction === 'plane') {
      grow = mul3(norm3(cross3(N, T)), sign) // in the sketch plane, square to the curve
      across = N // thickness across the sketch plane
    } else {
      grow = mul3(N, sign)
      across = norm3(cross3(N, T)) // thickness within the plane, square to the curve
    }
    if (len(grow) < 1e-9 || len(across) < 1e-9) continue
    const edge = segEdge(s)
    const lo = a.symmetric ? -a.thickness / 2 : 0
    const hi = a.symmetric ? a.thickness / 2 : a.thickness
    const sideSign = a.symmetric ? 1 : sign
    const grown = (e: { wrapped: unknown }, d: Vec3): Sh => prism(e, d)
    const fromEdge = (reachVec: Vec3) => {
      const face = grown(edge as never, reachVec)
      const start = (face as unknown as { translate(x: number, y: number, z: number): Sh }).translate(across[0] * lo * sideSign, across[1] * lo * sideSign, across[2] * lo * sideSign)
      return prism(start as never, mul3(across, (hi - lo) * sideSign))
    }
    slabs.push(fromEdge(mul3(grow, reach)))
    // both: the other way too (a web through the sketch plane)
    if (a.both) slabs.push(fromEdge(mul3(grow, -reach)))
    const mid = s.k === 'l' ? mul3(add3(s.a, s.b), 0.5) : s.k === 'a' ? s.m : mul3(add3(s.a, s.b), 0.5)
    const mc = add3(mid, mul3(across, ((lo + hi) / 2) * sideSign))
    seeds.push(add3(mc, mul3(grow, 0.02 * Math.min(1, a.thickness + 0.5))))
    if (a.both) seeds.push(add3(mc, mul3(grow, -0.02 * Math.min(1, a.thickness + 0.5))))
  }
  if (!slabs.length) throw new Error('The curves are too short to make a rib')
  let slab: NShape = { shape: slabs[0], faces: rootNames(slabs[0] as unknown as AnyShape, a.fid, 'rib0') }
  slabs.slice(1).forEach((s, i) => { slab = boolNamed('fuse', slab, { shape: s, faces: rootNames(s as unknown as AnyShape, a.fid, 'rib' + (i + 1)) }, a.fid) })
  // keep the part of the slab that is outside the body and reachable from the curve: that is the rib up to the next faces
  const rest = boolNamed('cut', slab, body, a.fid)
  const solids = (rest.shape as unknown as { solids: Sh[] }).solids
  const holds = (s: Sh, p: Vec3) => {
    const speck = makeBaseBox(0.006, 0.006, 0.006) as unknown as Sh
    try { return vol((s.clone() as Sh).intersect((speck.translate(p[0] - 0.003, p[1] - 0.003, p[2] - 0.003) as unknown) as never)) > 1e-12 } catch { return false }
  }
  const picked = a.depth > 0 && a.depth < diag * 2 ? solids : solids.filter((s) => seeds.some((p) => holds(s, p)))
  if (!picked.length) throw new Error('The rib has nothing to grow into. Draw the line inside the empty space of the part (or against a face) and check the direction')
  if (!(a.depth > 0 && a.depth < diag * 2)) {
    // up to the next face: a piece that sticks out of the body's box never met one
    const [blo, bhi] = boundsOfShape(body.shape)
    const tol = 1e-4
    for (const s of picked) {
      const [lo, hi] = boundsOfShape(s)
      if ([0, 1, 2].some((k) => lo[k] < blo[k] - tol || hi[k] > bhi[k] + tol)) throw new Error('The wall does not end on a face in that direction. Flip it, or give it a Distance')
    }
  }
  const topoRest = topoOf(rest.shape as unknown as AnyShape)
  const idx = indexer(topoRest.faces, topoRest.faceHashes)
  const parts: NShape[] = picked.map((s, i) => {
    const ft = topoOf(s as unknown as AnyShape)
    const faces = ft.faces.map((f) => { const j = idx(f.wrapped as never); return j >= 0 ? rest.faces[j] : [] })
    return { shape: s, faces: finalize(s as unknown as AnyShape, faces, a.fid, 'rib' + i) }
  })
  const rib = parts.length === 1 ? parts[0] : fuseNamed(parts, a.fid)
  const out = boolNamed('fuse', body, rib, a.fid)
  if (vol(out.shape) <= vol(body.shape) + 1e-9) throw new Error('The rib adds nothing: it does not reach the body')
  return h.sendBody(h.bodyFromShape(a.id, a.name, out.shape, out.faces))
})

// ================================================================================================ Fillet and Chamfer (advanced)

export interface EdgeAdvArgs {
  id: string; name: string; key: string; edges: number[]; fid: string
  mode: 'fillet' | 'chamfer'
  /** fillet radius laws */
  radiusType: 'constant' | 'variable' | 'chord'
  size: number
  endSize: number
  midSize: number
  midPos: number
  swap: boolean
  chord: number
  /** corner setback: the radius eases up over this length at corners where fillets meet */
  setback: number
  continuity: 'g1' | 'g2'
  /** which edges the rule picks, in addition to those given */
  rule: 'selected' | 'faceEdges' | 'convex' | 'concave' | 'all'
  /** chamfer */
  chamferType: 'equal' | 'twoDist' | 'distAngle'
  dist2: number
  angle: number
  flipFace: boolean
  faces?: number[]
}

function adjacentFaces(topo: ReturnType<typeof topoOf>, edgeIndex: number): number[] {
  const hash = topo.edgeHashes[edgeIndex]
  const out: number[] = []
  topo.faces.forEach((f, i) => { if (f.edges.some((e) => e.hashCode === hash)) out.push(i) })
  return out
}
function isConvexEdge(shape: Sh, topo: ReturnType<typeof topoOf>, ei: number): boolean | null {
  const fs = adjacentFaces(topo, ei)
  if (fs.length !== 2) return null
  const e = topo.edges[ei]
  const m = e.pointAt(0.5)
  const mid = v3(m)
  const n1 = v3(topo.faces[fs[0]].normalAt(mid)), n2 = v3(topo.faces[fs[1]].normalAt(mid))
  const probe = add3(mid, mul3(norm3(add3(n1, n2)), 0.02))
  if (len(add3(n1, n2)) < 1e-6) return null
  const speck = makeBaseBox(0.004, 0.004, 0.004) as unknown as Sh
  const inside = vol((shape.clone() as Sh).intersect((speck.translate(probe[0] - 0.002, probe[1] - 0.002, probe[2] - 0.002) as unknown) as never)) > 1e-12
  return !inside
}

registerOp<EdgeAdvArgs>('edgeModAdv', (a, h) => {
  const src = h.getNamed(a.key)
  const names = h.getNames(a.key)
  const topo = topoOf(src.shape as unknown as AnyShape)
  let edges = [...new Set(a.edges)]
  if (a.rule !== 'selected') {
    const extra = new Set<number>(edges)
    if (a.rule === 'faceEdges') {
      // every edge of the faces the picked edges lie on
      const faces = new Set<number>(a.faces ?? [])
      for (const e of edges) adjacentFaces(topo, e).forEach((f) => faces.add(f))
      for (const f of faces) for (const e of topo.faces[f].edges) { const i = topo.edgeHashes.indexOf(e.hashCode); if (i >= 0) extra.add(i) }
    } else {
      topo.edges.forEach((_, i) => {
        const c = isConvexEdge(src.shape, topo, i)
        if (c === null) return
        if (a.rule === 'all' || (a.rule === 'convex' && c) || (a.rule === 'concave' && !c)) extra.add(i)
      })
    }
    edges = [...extra]
  }
  if (!edges.length) throw new Error('No edges match the rule')
  const o = oc()
  const builder = a.mode === 'fillet' ? new o.BRepFilletAPI_MakeFillet(src.shape.wrapped, o.ChFi3d_FilletShape.ChFi3d_Rational) : new o.BRepFilletAPI_MakeChamfer(src.shape.wrapped)
  const del: { delete(): void }[] = [builder]
  try {
    const flat = (ei: number) => {
      const fs = adjacentFaces(topo, ei)
      const n1 = fs.length === 2 ? v3(topo.faces[fs[0]].normalAt(v3(topo.edges[ei].pointAt(0.5)))) : null
      const n2 = fs.length === 2 ? v3(topo.faces[fs[1]].normalAt(v3(topo.edges[ei].pointAt(0.5)))) : null
      return { fs, n1, n2 }
    }
    if (a.mode === 'fillet') {
      if (a.continuity === 'g2') builder.SetContinuity(o.GeomAbs_Shape.GeomAbs_C2, 0.01)
      // vertices where two or more picked edges meet (the corners a setback eases)
      const endCount = new Map<string, number>()
      const key = (p: Vec3) => p.map((x) => Math.round(x * 1e4)).join(',')
      for (const ei of edges) { const e = topo.edges[ei]; for (const p of [v3(e.startPoint), v3(e.endPoint)]) endCount.set(key(p), (endCount.get(key(p)) ?? 0) + 1) }
      for (const ei of edges) {
        const e = topo.edges[ei]
        const L = e.length
        let r1 = a.size, r2 = a.size
        if (a.radiusType === 'chord') {
          const { n1, n2 } = flat(ei)
          if (!n1 || !n2) throw new Error('A chord length fillet needs an edge between two faces')
          const turn = Math.acos(Math.max(-1, Math.min(1, dot3(n1, n2))))
          if (turn < 1e-3) throw new Error('A chord length fillet needs a sharp edge')
          r1 = r2 = a.chord / (2 * Math.sin(turn / 2))
        } else if (a.radiusType === 'variable') {
          r1 = a.swap ? a.endSize : a.size
          r2 = a.swap ? a.size : a.endSize
        }
        const cornerStart = (endCount.get(key(v3(e.startPoint))) ?? 0) > 1, cornerEnd = (endCount.get(key(v3(e.endPoint))) ?? 0) > 1
        const useSetback = a.setback > 0 && (cornerStart || cornerEnd)
        const hasMid = a.radiusType === 'variable' && a.midSize > 0
        if (useSetback || hasMid) {
          // a radius law along the edge: x = fraction of the edge, y = radius
          const pts: [number, number][] = []
          const sb = Math.min(0.45, a.setback / L)
          const eased = (r: number) => r * (1 + 0.5)
          if (useSetback && cornerStart) pts.push([0, eased(r1)], [sb, r1])
          else pts.push([0, r1])
          if (hasMid) pts.push([Math.min(0.9, Math.max(0.1, a.midPos)), a.midSize])
          if (useSetback && cornerEnd) pts.push([1 - sb, r2], [1, eased(r2)])
          else pts.push([1, r2])
          const arr = new o.NCollection_Array1_gp_Pnt2d(1, pts.length)
          pts.forEach((p, i) => arr.SetValue(i + 1, new o.gp_Pnt2d(p[0], p[1])))
          del.push(arr)
          builder.Add(arr, e.wrapped)
        } else if (Math.abs(r1 - r2) > 1e-9) builder.Add(r1, r2, e.wrapped)
        else builder.Add(r1, e.wrapped)
      }
    } else {
      for (const ei of edges) {
        const e = topo.edges[ei]
        const { fs } = flat(ei)
        if (a.chamferType === 'equal' || fs.length !== 2) { builder.Add(a.size, e.wrapped); continue }
        const face = topo.faces[fs[a.flipFace ? 1 : 0]]
        if (a.chamferType === 'twoDist') builder.Add(a.size, a.dist2, e.wrapped, face.wrapped)
        else builder.AddDA(a.size, a.angle * DEG2RAD, e.wrapped, face.wrapped)
      }
    }
    builder.Build()
    const shape = cast(builder.Shape()) as unknown as Sh
    if (!isShape3D(shape as never) || vol(shape) < 1e-9) throw new Error('empty result')
    const claims = inherit(builder as never, [src], shape as unknown as AnyShape, { fid: a.fid })
    const rt = topoOf(shape as unknown as AnyShape)
    const find = indexer(rt.faces, rt.faceHashes)
    for (const i of edges) eachInList(builder.Generated(topo.edges[i].wrapped as never), (s) => { const j = find(s); if (j >= 0) claims[j].push(`${a.fid}:${a.mode}:${names.edges[i]?.[0] ?? i}`) })
    const r = { shape, faces: finalize(shape as unknown as AnyShape, claims, a.fid) }
    return h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))
  } catch (e) {
    throw new Error(`${a.mode === 'fillet' ? 'Fillet' : 'Chamfer'} is not possible with these settings (${e instanceof Error ? e.message : e})`)
  } finally { del.forEach((d) => { try { d.delete() } catch { /* gone */ } }) }
})

// ================================================================================================ Shell with a thickness per face

export interface ShellAdvArgs {
  id: string; name: string; key: string; faces: number[]; thickness: number; side: 'inside' | 'outside'; fid: string
  /** faces with a thickness of their own */
  special: { index: number; thickness: number }[]
}
registerOp<ShellAdvArgs>('shellAdv', (a, h) => {
  if (!(a.thickness > 0)) throw new Error('Thickness must be greater than zero')
  const src = h.getNamed(a.key)
  const topo = topoOf(src.shape as unknown as AnyShape)
  const base = shellNamed(src, a.faces, a.side === 'inside' ? -a.thickness : a.thickness, 0.001, a.fid)
  if (!valid(base.shape)) throw new Error(`A shell of ${a.thickness} mm is not possible here`)
  if (!a.special.length) return h.sendBody(h.bodyFromShape(a.id, a.name, base.shape, base.faces))
  if (a.side !== 'inside') throw new Error('A thickness per face works with the Inside direction')
  // the void is the body minus the wall; each special flat face then moves the void's wall towards or away from itself
  let cavity = boolNamed('cut', src, base, a.fid)
  const size = diagOf(src.shape) * 3 + 10
  for (const sp of a.special) {
    const f = topo.faces[sp.index]
    if (!f) throw new Error('A face with its own thickness no longer exists')
    if (f.geomType !== 'PLANE') throw new Error('A thickness of its own works on flat faces; pick a flat face')
    if (a.faces.includes(sp.index)) throw new Error('A face that is removed has no thickness')
    const n = norm3(v3(f.normalAt())) // outward
    const c = v3(f.center)
    if (sp.thickness > a.thickness + 1e-9) {
      // thicker: take the void away from the face (everything closer than the new thickness)
      const slab = halfSpace(add3(c, mul3(n, -sp.thickness)), n, size)
      cavity = boolNamed('cut', cavity, { shape: slab, faces: rootNames(slab as unknown as AnyShape, a.fid, 'slab') }, a.fid)
    } else if (sp.thickness < a.thickness - 1e-9) {
      // thinner: grow the void towards the face by the difference, then keep it inside the body
      const extra = a.thickness - sp.thickness
      const grown = xformNamed(cavity, { t: 'rigid', R: [1, 0, 0, 0, 1, 0, 0, 0, 1], p: mul3(n, extra) }, '')
      cavity = boolNamed('fuse', cavity, { shape: grown.shape, faces: rootNames(grown.shape as unknown as AnyShape, a.fid, 'grow') }, a.fid)
      cavity = boolNamed('common', cavity, src, a.fid)
      const cap = halfSpace(add3(c, mul3(n, -sp.thickness)), n, size)
      cavity = boolNamed('cut', cavity, { shape: cap, faces: rootNames(cap as unknown as AnyShape, a.fid, 'cap') }, a.fid)
    }
  }
  const out = boolNamed('cut', src, cavity, a.fid)
  if (!valid(out.shape)) throw new Error('A shell with these thicknesses is not possible here')
  return h.sendBody(h.bodyFromShape(a.id, a.name, out.shape, out.faces))
})

// ================================================================================================ Draft: parting line and step

export interface DraftPartArgs {
  id: string; name: string; key: string
  /** the side faces to draft (indices), pull direction, a point on the parting line */
  faces: number[]
  dir: Vec3
  line: Vec3
  angle: number
  /** parting line: the other side tilts the same angle the other way (two sides). step: only the faces above the line tilt */
  type: 'parting' | 'step'
  flip: boolean
  fid: string
}

registerOp<DraftPartArgs>('draftParting', (a, h) => {
  const src = h.getNamed(a.key)
  const topo0 = topoOf(src.shape as unknown as AnyShape)
  const dir = norm3(a.dir)
  const o = oc()
  const faceSurface = (f: Face) => ({ type: f.geomType, n: f.geomType === 'PLANE' ? norm3(v3(f.normalAt())) : ([0, 0, 0] as Vec3), c: v3(f.center) })
  const picked = a.faces.map((i) => topo0.faces[i]).filter(Boolean)
  if (picked.length !== a.faces.length || !picked.length) throw new Error('Select the side faces to draft')
  for (const f of picked) {
    if (f.geomType === 'PLANE' && Math.abs(dot3(norm3(v3(f.normalAt())), dir)) > 1 - 1e-6) throw new Error('A face that faces along the pull direction cannot be drafted')
  }
  // split the body at the parting plane: the part on the pull side and the part behind it are drafted separately, then joined again
  const size = diagOf(src.shape) * 3 + 10
  const splitter = new o.BRepAlgoAPI_Splitter()
  let split: Sh
  const lists: { delete(): void }[] = []
  try {
    const args = new o.NCollection_List_TopoDS_Shape(); args.Append(src.shape.wrapped); lists.push(args)
    const tools = new o.NCollection_List_TopoDS_Shape()
    tools.Append(planeFaceShape(a.line, dir, size).wrapped); lists.push(tools)
    splitter.SetArguments(args); splitter.SetTools(tools)
    splitter.Build(new o.Message_ProgressRange())
    split = cast(splitter.Shape()) as unknown as Sh
  } finally { lists.forEach((l) => l.delete()); splitter.delete() }
  const solids = (split as unknown as { solids: Sh[] }).solids
  if (solids.length < 2) throw new Error('The parting line does not cross the part. Pick a point on the walls between its two ends')
  const same = (f: Face): boolean => picked.some((p) => {
    const s = faceSurface(p), t = faceSurface(f)
    if (s.type !== t.type) return false
    if (s.type === 'PLANE') return Math.abs(dot3(s.n, t.n)) > 1 - 1e-7 && Math.abs(dot3(sub3(t.c, s.c), s.n)) < 1e-5
    if ((s.type as string) === 'CYLINDRE') return sameCylinder(p, f)
    return false
  })
  const dp = new o.gp_Dir(...dir)
  const pl = new o.gp_Pln(new o.gp_Pnt(...a.line), dp)
  const halves: NShape[] = []
  try {
    for (const solid of solids) {
      const topo = topoOf(solid as unknown as AnyShape)
      const [lo, hi] = boundsOfShape(solid)
      const above = dot3(sub3(mul3(add3(lo, hi), 0.5), a.line), dir) > 0
      // each half is drafted as a mould half that pulls away from the line: the pull side along the direction, the other side against it
      // (a step draft leaves the other side straight)
      const ang = (a.flip ? -1 : 1) * a.angle
      const skip = a.type === 'step' && !above
      const builder = new o.BRepOffsetAPI_DraftAngle(solid.wrapped)
      const pull = new o.gp_Dir(...(above ? dir : mul3(dir, -1)))
      const neutral = new o.gp_Pln(new o.gp_Pnt(...a.line), pull)
      try {
        let n = 0
        if (!skip) {
          topo.faces.forEach((f) => {
            if (!same(f)) return
            builder.Add(f.wrapped, pull, ang * DEG2RAD, neutral, false)
            if (!builder.AddDone()) throw new Error('OpenCascade could not draft one of the faces at this angle; try a smaller angle')
            n++
          })
          if (!n) throw new Error('None of the selected faces cross the parting line')
          builder.Build(new o.Message_ProgressRange())
          if (!builder.IsDone()) throw new Error('OpenCascade could not draft these faces at this angle; try a smaller angle')
        }
        const shape = skip ? solid : (cast(builder.Shape()) as unknown as Sh)
            halves.push({ shape, faces: rootNames(shape as unknown as AnyShape, a.fid, 'half' + halves.length) })
      } finally { builder.delete(); pull.delete(); neutral.delete() }
    }
  } finally { dp.delete(); pl.delete() }
  const out = fuseNamed(halves, a.fid)
  if (!isShape3D(out.shape as never) || vol(out.shape) < 1e-9) throw new Error('The draft produced an empty shape')
  return h.sendBody(h.bodyFromShape(a.id, a.name, out.shape, out.faces))
})

function sameCylinder(a: Face, b: Face): boolean {
  const o = oc()
  const sa = new o.BRepAdaptor_Surface(a.wrapped, true), sb = new o.BRepAdaptor_Surface(b.wrapped, true)
  try {
    const cyA = sa.Cylinder(), cyB = sb.Cylinder()
    const ax = cyA.Axis(), bx = cyB.Axis()
    const da = ax.Direction(), db = bx.Direction()
    const la = ax.Location(), lb = bx.Location()
    const dd = [da.X(), da.Y(), da.Z()] as Vec3, ddb = [db.X(), db.Y(), db.Z()] as Vec3
    const diff: Vec3 = [lb.X() - la.X(), lb.Y() - la.Y(), lb.Z() - la.Z()]
    const perp = len(cross3(diff, dd))
    return Math.abs(dot3(dd, ddb)) > 1 - 1e-7 && perp < 1e-5 && Math.abs(cyA.Radius() - cyB.Radius()) < 1e-6
  } finally { sa.delete(); sb.delete() }
}

function planeFaceShape(origin: Vec3, normal: Vec3, size: number): Sh {
  const { u, v } = planeBasis(normal)
  const c = (p: number, q: number): Vec3 => add3(origin, add3(mul3(u, p * size), mul3(v, q * size)))
  return makePolygon([c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)]) as unknown as Sh
}

// ================================================================================================ free transforms (Move / Copy / Align) and Scale

export interface BodyXformArgs { id: string; name: string; key: string; xform: Xf; tag: string }
registerOp<BodyXformArgs>('bodyXform', (a, h) => {
  const stored = h.getNamed
  try {
    const src = stored(a.key)
    const r = xformNamed(src, a.xform, a.tag)
    return h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))
  } catch (e) {
    // a mesh body: move the vertices
    const topo = getTopo(a.key)
    if (a.xform.t !== 'rigid') throw e
    const x = a.xform
    const p = new Float32Array(topo.positions.length)
    for (let i = 0; i < p.length; i += 3) {
      const q = applyPoint(x, [topo.positions[i], topo.positions[i + 1], topo.positions[i + 2]])
      p[i] = q[0]; p[i + 1] = q[1]; p[i + 2] = q[2]
    }
    return h.sendBody(bodyFromTopo(a.id, a.name, { positions: p, indices: topo.indices.slice() }))
  }
})

export interface ScaleArgs { id: string; name: string; key: string; factors: Vec3; centre: Vec3 }
registerOp<ScaleArgs>('scaleBody', (a, h) => {
  if (a.factors.some((f) => !(f > 0))) throw new Error('Scale factors must be greater than zero')
  const uniform = Math.abs(a.factors[0] - a.factors[1]) < 1e-12 && Math.abs(a.factors[0] - a.factors[2]) < 1e-12
  let brep: NShape | null = null
  try { brep = h.getNamed(a.key) } catch { brep = null }
  if (brep && uniform) {
    const sh = (brep.shape.clone() as Sh).scale(a.factors[0], a.centre) as Sh
    return h.sendBody(h.bodyFromShape(a.id, a.name, sh, carryNames(brep.shape as unknown as AnyShape, brep.faces, sh as unknown as AnyShape, a.id)))
  }
  // a different factor per axis cannot stay a B-rep in this OpenCascade build (no general transform), so the result is a mesh body
  const t: TopoMesh = getTopo(a.key)
  const p = new Float32Array(t.positions.length)
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) p[i + k] = a.centre[k] + (t.positions[i + k] - a.centre[k]) * a.factors[k]
  return h.sendBody(bodyFromTopo(a.id, a.name, { positions: p, indices: t.indices.slice() }))
})
