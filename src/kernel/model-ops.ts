/** Worker ops for solid modelling: profile extrusion (with taper) / revolution, face extrusion, fillet / chamfer, edge frames. */
import { Plane, asDir, basicFaceExtrusion, cast, draw, getOC, loft, makeFace, makePln, measureVolume, revolution, Vector, type AnyShape, type Face } from 'replicad'
import { registerOp, type OpHelpers } from './store'
import { topoOf, type Shape } from './occ'
import type { Loop, PlaneDef, Seg, Vec2, Vec3 } from '../sketch/types'
import { polyArea, loopPoly, reverseLoop } from '../sketch/geom'
import { offsetChain, offsetCircle } from '../sketch/offset'

export interface ProfileIn { outer: Loop; holes: Loop[] }
export interface ProfileGroup { plane: PlaneDef; profiles: ProfileIn[] }
/** `index` is a B-rep face index: a position in `topoOf(shape).faces` (the same index as `MeshData.faceIds`). */
export interface FaceIn { key: string; index: number }

type Sh = Shape

const start = (s: Seg): Vec2 => (s.k === 'c' ? [s.c[0] + s.r, s.c[1]] : s.a)

/** Closed replicad Drawing from a loop of segments. */
function loopDrawing(loop: Loop) {
  if (loop.length === 1 && loop[0].k === 'c') {
    const { c, r } = loop[0]
    return draw([c[0] + r, c[1]]).threePointsArcTo([c[0] - r, c[1]], [c[0], c[1] + r]).threePointsArcTo([c[0] + r, c[1]], [c[0], c[1] - r]).close()
  }
  let pen = draw(start(loop[0]))
  for (const s of loop) {
    if (s.k === 'l') pen = pen.lineTo(s.b)
    else if (s.k === 'a') pen = pen.threePointsArcTo(s.b, s.m)
  }
  return pen.close()
}

const isCcw = (loop: Loop) => polyArea(loopPoly(loop)) >= 0
/** Loop with the requested winding (outer boundaries counter-clockwise, holes clockwise: OCC needs opposite windings). */
const oriented = (loop: Loop, ccw: boolean) => (isCcw(loop) === ccw ? loop : reverseLoop(loop))

function planeOf(p: PlaneDef) {
  return new Plane(p.origin, p.xDir, p.normal)
}

/** Planar face (with holes) for a profile on a plane. */
export function profileFace(plane: Plane, pr: ProfileIn): Face {
  const wire = (l: Loop, ccw: boolean) => (loopDrawing(oriented(l, ccw)).sketchOnPlane(plane) as unknown as { wire: Parameters<typeof makeFace>[0] }).wire
  return makeFace(wire(pr.outer, true), pr.holes.map((h) => wire(h, false)))
}

const fuseAll = (shapes: Sh[]): Sh => shapes.slice(1).reduce((a, b) => a.fuse(b) as Sh, shapes[0])

const norm3 = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Plain prism: the face swept along `n * d` (d signed). */
function sweep(face: Face, n: Vec3, d: number): Sh {
  return basicFaceExtrusion(face, new Vector([n[0] * d, n[1] * d, n[2] * d])) as unknown as Sh
}

/**
 * Prism of an EXISTING planar face along `n * h` with drafted side walls (positive `angle` = the section shrinks going
 * away from the face, so holes grow), via OCC's draft-angle builder. Throws if OCC cannot draft the walls.
 */
function draftedFacePrism(face: Face, n: Vec3, h: number, angle: number): Sh {
  if (face.geomType !== 'PLANE') throw new Error('Taper needs a planar profile or face')
  const prism = sweep(face, n, h)
  const dir: Vec3 = h >= 0 ? n : [-n[0], -n[1], -n[2]]
  const c = face.center
  const origin: Vec3 = [c.x, c.y, c.z]
  const innerEdgeHashes = new Set<number>()
  // replicad's innerWires() consumes the face object it is called on, hence the clone
  for (const w of face.clone().innerWires()) for (const e of w.edges) innerEdgeHashes.add(e.hashCode)
  const walls = prism.faces.filter((f) => !(f.geomType === 'PLANE' && Math.abs(dot3(norm3(vec(f.normalAt())), dir)) > 1 - 1e-9))
  if (!walls.length) throw new Error('Nothing to taper')

  const oc = getOC()
  const builder = new oc.BRepOffsetAPI_DraftAngle(prism.wrapped)
  const plane = makePln(origin, dir)
  const direction = asDir(dir)
  try {
    for (const w of walls) builder.Add(w.wrapped, direction, (angle * Math.PI) / 180, plane, false)
    builder.Build()
    if (!builder.IsDone()) throw new Error('OCC could not apply the taper')
    const out = cast(builder.ModifiedShape(prism.wrapped)) as unknown as Sh
    if (!(Math.abs(measureVolume(out as never)) > 1e-9) || !new oc.BRepCheck_Analyzer(out.wrapped, true, false).IsValid()) throw new Error('invalid result')
    return out
  } catch (e) {
    throw new Error(`A taper of ${angle}° is not possible on this face (${e instanceof Error ? e.message : e}); try a smaller angle`)
  } finally {
    builder.delete()
    plane.delete()
    direction.delete()
  }
}
const vec = (v: Vector): Vec3 => [v.x, v.y, v.z]

const TOO_BIG = 'The taper is too large for this profile (part of it collapses)'

/** One boundary ring offset by `d` towards the material (outer rings are counter-clockwise, holes clockwise). */
function taperRing(loop: Loop, hole: boolean, d: number): Loop {
  const ring = oriented(loop, !hole)
  if (ring.length === 1 && ring[0].k === 'c') {
    const r = offsetCircle(ring[0].r, hole ? d : -d)
    if (r === null) throw new Error(TOO_BIG)
    return [{ k: 'c', c: ring[0].c, r }]
  }
  const res = offsetChain(ring as Parameters<typeof offsetChain>[0], true, d, 'miter')
  if (!res || res.length !== ring.length || res.some((r) => r.corner)) throw new Error(TOO_BIG)
  return res.map((r) => r.seg)
}

/**
 * Solid for a sketch profile extruded `u` (signed) along the plane normal with drafted walls: a ruled loft between the
 * profile and its offset (outer rings shrink, holes grow for positive angles). Holes are cut with cutters that run
 * slightly past both ends so the caps stay clean.
 */
function taperedProfileSide(plane: Plane, g: PlaneDef, pr: ProfileIn, u: number, angle: number): Sh {
  const tan = Math.tan((angle * Math.PI) / 180)
  const sgn = u >= 0 ? 1 : -1
  const s = Math.abs(u)
  const wireAt = (loop: Loop, dist: number) => {
    const o = g.origin, n = g.normal, z = sgn * dist
    const pl = new Plane([o[0] + n[0] * z, o[1] + n[1] * z, o[2] + n[2] * z], g.xDir, g.normal)
    return (loopDrawing(loop).sketchOnPlane(pl) as unknown as { wire: Parameters<typeof makeFace>[0] }).wire
  }
  const ruled = (loop: Loop, hole: boolean, u0: number, u1: number) =>
    loft([wireAt(taperRing(loop, hole, u0 * tan), u0), wireAt(taperRing(loop, hole, u1 * tan), u1)], { ruled: true }) as unknown as Sh
  void plane
  let solid = ruled(pr.outer, false, 0, s)
  const ext = Math.max(1, s * 0.1)
  for (const h of pr.holes) solid = solid.cut(ruled(h, true, -ext, s + ext) as unknown as AnyShape) as Sh
  const oc = getOC()
  if (!(Math.abs(measureVolume(solid as never)) > 1e-9) || !new oc.BRepCheck_Analyzer(solid.wrapped, true, false).IsValid()) throw new Error(TOO_BIG)
  return solid
}

type Spanned = (side: number) => Sh
/** Union of the +/- sides of a span around the base plane, each built by `side(signed distance)`. */
function bothSides(from: number, to: number, side: Spanned): Sh {
  const parts: Sh[] = []
  if (to > 1e-9) parts.push(side(to))
  if (from < -1e-9) parts.push(side(from))
  if (!parts.length) throw new Error('Taper needs a span that includes the sketch plane')
  return fuseAll(parts)
}

/** Solid swept from `face` between the signed offsets [from, to] (0 lies inside the span) along `n`, optionally tapered. */
function prism(face: Face, n: Vec3, from: number, to: number, taper = 0): Sh {
  if (!taper) {
    const f = from === 0 ? face : (face.translate(n[0] * from, n[1] * from, n[2] * from) as Face)
    return sweep(f, n, to - from)
  }
  return bothSides(from, to, (h) => draftedFacePrism(face, n, h, taper))
}

function profilePrism(g: ProfileGroup, pr: ProfileIn, from: number, to: number, taper: number): Sh {
  const plane = planeOf(g.plane)
  if (!taper) return prism(profileFace(plane, pr), g.plane.normal, from, to)
  // straight-edged profiles: OCC's draft keeps the walls exact planes. Anything else (arcs, circles) or a draft OCC
  // refuses is built as a ruled loft between the profile and its offset (cones for circles).
  if ([pr.outer, ...pr.holes].every((l) => l.every((s) => s.k === 'l'))) {
    try { return bothSides(from, to, (u) => draftedFacePrism(profileFace(plane, pr), g.plane.normal, u, taper)) } catch { /* use the loft */ }
  }
  return bothSides(from, to, (u) => taperedProfileSide(plane, g.plane, pr, u, taper))
}

export interface ExtrudeArgs {
  id: string
  name: string
  groups: ProfileGroup[]
  faces: FaceIn[]
  /** 'one' | 'sym' | 'two' */
  mode: string
  d1: number
  d2: number
  /** 1 extrudes along the face normal, -1 into the body (faces only) */
  faceDir: 1 | -1
  /** draft angle in degrees (positive shrinks the section away from the profile); 0 = straight */
  taper?: number
}

function span(mode: string, d1: number, d2: number): [number, number] {
  if (mode === 'sym') return [-Math.abs(d1) / 2, Math.abs(d1) / 2]
  if (mode === 'two') return [-d2, d1]
  return d1 >= 0 ? [0, d1] : [d1, 0]
}

registerOp<ExtrudeArgs>('extrudeTool', (a, h: OpHelpers) => {
  const [from, to] = span(a.mode, a.d1, a.d2)
  if (Math.abs(to - from) < 1e-9) throw new Error('Distance must not be zero')
  const taper = a.taper ?? 0
  if (Math.abs(taper) >= 89) throw new Error('Taper angle must be between -89° and 89°')
  const solids: Sh[] = []
  for (const g of a.groups) {
    for (const pr of g.profiles) solids.push(profilePrism(g, pr, from, to, taper))
  }
  for (const f of a.faces) {
    const body = h.getBrep(f.key)
    // topology faces are cached and shared: work on a clone, because replicad's translate() / innerWires() consume their receiver
    const face = topoOf(body as unknown as AnyShape).faces[f.index]?.clone()
    if (!face) throw new Error('Face not found')
    const nv = face.normalAt()
    const n: Vec3 = [nv.x * a.faceDir, nv.y * a.faceDir, nv.z * a.faceDir]
    solids.push(prism(face, n, from, to, taper))
  }
  if (!solids.length) throw new Error('Nothing to extrude')
  return h.sendBody(h.bodyFromShape(a.id, a.name, fuseAll(solids)))
})

export interface RevolveArgs {
  id: string
  name: string
  groups: ProfileGroup[]
  /** world-space axis */
  axisOrigin: Vec3
  axisDir: Vec3
  angle: number
}

registerOp<RevolveArgs>('revolveTool', (a, h) => {
  if (Math.abs(a.angle) < 1e-9) throw new Error('Angle must not be zero')
  const solids: Sh[] = []
  for (const g of a.groups) {
    const plane = planeOf(g.plane)
    for (const pr of g.profiles) {
      const face = profileFace(plane, pr)
      const dir: Vec3 = a.angle < 0 ? [-a.axisDir[0], -a.axisDir[1], -a.axisDir[2]] : a.axisDir
      solids.push(revolution(face, a.axisOrigin, dir, Math.min(360, Math.abs(a.angle))) as unknown as Sh)
    }
  }
  if (!solids.length) throw new Error('Nothing to revolve')
  return h.sendBody(h.bodyFromShape(a.id, a.name, fuseAll(solids)))
})

export interface EdgeModArgs {
  id: string
  name: string
  key: string
  /** B-rep edge indices: positions in `topoOf(shape).edges` (the same index as `MeshData.edgeIds`) */
  edges: number[]
  size: number
  mode: 'fillet' | 'chamfer'
}

registerOp<EdgeModArgs>('edgeMod', (a, h) => {
  const shape = h.getBrep(a.key)
  const body = shape as unknown as { fillet(r: number, f: (e: never) => unknown): Sh; chamfer(r: number, f: (e: never) => unknown): Sh }
  const all = topoOf(shape as unknown as AnyShape).edges
  const list = a.edges.map((i) => all[i]).filter(Boolean)
  if (!list.length || list.length !== a.edges.length) throw new Error('Some of the selected edges no longer exist')
  const filter = (e: { inList(l: AnyShape[]): unknown }) => e.inList(list)
  let out: Sh
  try {
    out = a.mode === 'fillet' ? body.fillet(a.size, filter as never) : body.chamfer(a.size, filter as never)
  } catch (e) {
    throw new Error(`${a.mode === 'fillet' ? 'Fillet' : 'Chamfer'} of ${a.size} mm is not possible on the selected edges (${e instanceof Error ? e.message : e})`)
  }
  return h.sendBody(h.bodyFromShape(a.id, a.name, out))
})

export interface EdgeFrame { mid: Vec3; /** outward bisector of the faces meeting at the edge */ dir: Vec3 }

/** For each B-rep edge index: its midpoint and the outward bisector of its adjacent faces (anchor for the fillet arrow). */
registerOp<{ key: string; edges: number[] }>('edgeFrames', (a, h) => {
  const topo = topoOf(h.getBrep(a.key) as unknown as AnyShape)
  const faceEdgeHashes = topo.faces.map((f) => new Set(f.edges.map((e) => e.hashCode)))
  const out: (EdgeFrame | null)[] = a.edges.map((i) => {
    const edge = topo.edges[i]
    if (!edge) return null
    const m = edge.pointAt(0.5)
    const mid: Vec3 = [m.x, m.y, m.z]
    let s: Vec3 = [0, 0, 0]
    topo.faces.forEach((f, fi) => {
      if (!faceEdgeHashes[fi].has(topo.edgeHashes[i])) return
      const n = vec(f.normalAt(mid))
      s = [s[0] + n[0], s[1] + n[1], s[2] + n[2]]
    })
    if (Math.hypot(...s) < 1e-6) {
      const f = topo.faces.find((_, fi) => faceEdgeHashes[fi].has(topo.edgeHashes[i]))
      if (f) s = vec(f.normalAt(mid))
    }
    return { mid, dir: norm3(s) }
  })
  return out
})

import './sketch-ops'
