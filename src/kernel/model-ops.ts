/** Worker ops for solid modelling: profile extrusion / revolution, face extrusion, fillet / chamfer. */
import { Plane, basicFaceExtrusion, draw, makeFace, revolution, Vector, type AnyShape, type Face } from 'replicad'
import { registerOp, type OpHelpers } from './store'
import type { Shape } from './occ'
import type { Loop, PlaneDef, Seg, Vec2, Vec3 } from '../sketch/types'
import { polyArea, loopPoly, reverseLoop } from '../sketch/geom'

export interface ProfileIn { outer: Loop; holes: Loop[] }
export interface ProfileGroup { plane: PlaneDef; profiles: ProfileIn[] }
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

/** Counter-clockwise copy of a loop. */
const ccw = (loop: Loop) => (polyArea(loopPoly(loop)) < 0 ? reverseLoop(loop) : loop)

function planeOf(p: PlaneDef) {
  return new Plane(p.origin, p.xDir, p.normal)
}

/** Planar face (with holes) for a profile on a plane. */
function profileFace(plane: Plane, pr: ProfileIn): Face {
  const wire = (l: Loop) => (loopDrawing(ccw(l)).sketchOnPlane(plane) as unknown as { wire: Parameters<typeof makeFace>[0] }).wire
  return makeFace(wire(pr.outer), pr.holes.map(wire))
}

const fuseAll = (shapes: Sh[]): Sh => shapes.slice(1).reduce((a, b) => a.fuse(b) as Sh, shapes[0])

/** Solid extruded from a face; `from`/`to` are signed offsets along `n` from the face. */
function prism(face: Face, n: Vec3, from: number, to: number): Sh {
  const f = from === 0 ? face : (face.translate(n[0] * from, n[1] * from, n[2] * from) as Face)
  const d = to - from
  return basicFaceExtrusion(f, new Vector([n[0] * d, n[1] * d, n[2] * d])) as unknown as Sh
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
}

function span(mode: string, d1: number, d2: number): [number, number] {
  if (mode === 'sym') return [-Math.abs(d1) / 2, Math.abs(d1) / 2]
  if (mode === 'two') return [-d2, d1]
  return d1 >= 0 ? [0, d1] : [d1, 0]
}

registerOp<ExtrudeArgs>('extrudeTool', (a, h: OpHelpers) => {
  const [from, to] = span(a.mode, a.d1, a.d2)
  if (Math.abs(to - from) < 1e-9) throw new Error('Distance must not be zero')
  const solids: Sh[] = []
  for (const g of a.groups) {
    const plane = planeOf(g.plane)
    for (const pr of g.profiles) solids.push(prism(profileFace(plane, pr), g.plane.normal, from, to))
  }
  for (const f of a.faces) {
    const body = h.getBrep(f.key)
    const face = (body as unknown as { faces: Face[] }).faces[f.index]
    if (!face) throw new Error('Face not found')
    const nv = face.normalAt()
    const n: Vec3 = [nv.x * a.faceDir, nv.y * a.faceDir, nv.z * a.faceDir]
    solids.push(prism(face, n, from, to))
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
  /** edge indices into the body's B-rep edge order (same as the display edge ids) */
  edges: number[]
  size: number
  mode: 'fillet' | 'chamfer'
}

registerOp<EdgeModArgs>('edgeMod', (a, h) => {
  const body = h.getBrep(a.key) as unknown as { edges: AnyShape[]; fillet(r: number, f: (e: never) => unknown): Sh; chamfer(r: number, f: (e: never) => unknown): Sh }
  const list = a.edges.map((i) => body.edges[i]).filter(Boolean)
  if (!list.length) throw new Error('No edges selected')
  const filter = (e: { inList(l: AnyShape[]): unknown }) => e.inList(list)
  const out = a.mode === 'fillet' ? body.fillet(a.size, filter as never) : body.chamfer(a.size, filter as never)
  return h.sendBody(h.bodyFromShape(a.id, a.name, out))
})
