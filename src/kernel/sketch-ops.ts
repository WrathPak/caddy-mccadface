/** Worker ops that serve the sketcher: projecting B-rep edges / faces onto a sketch plane. */
import type { AnyShape, Edge, Face } from 'replicad'
import { registerOp } from './store'
import { topoOf } from './occ'
import type { PlaneDef, Vec2, Vec3 } from '../sketch/types'
import { circumcircle } from '../sketch/geom'

/** A projected curve in plane-local 2D. Arcs run counter-clockwise from `s` to `e` around `c`. */
export type ProjectedCurve =
  | { k: 'l'; a: Vec2; b: Vec2 }
  | { k: 'c'; c: Vec2; r: number }
  | { k: 'a'; c: Vec2; s: Vec2; e: Vec2; r: number }

export interface ProjectArgs {
  key: string
  plane: PlaneDef
  /** B-rep face / edge indices (positions in `topoOf(shape).faces` / `.edges`); a face contributes all its boundary edges */
  faces: number[]
  edges: number[]
  /** project every edge of the body */
  all?: boolean
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const pt = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z]

/** Orthographic projection of one edge into the plane's local coordinates. */
export function projectEdge(edge: Edge, plane: PlaneDef, tol = 1e-7): ProjectedCurve[] {
  const n = plane.normal
  const ex = plane.xDir
  const ey = cross3(n, ex)
  const local = (p: Vec3): Vec2 => {
    const d = sub3(p, plane.origin)
    return [dot3(d, ex), dot3(d, ey)]
  }
  const closed = edge.isClosed
  // replicad's CurveType typing omits 'LINE' (and spells nothing else differently), but that is what OCC reports
  const type = edge.geomType as string
  const s = pt(edge.startPoint), e = pt(edge.endPoint)
  if (type === 'LINE') {
    const a = local(s), b = local(e)
    return Math.hypot(a[0] - b[0], a[1] - b[1]) > tol ? [{ k: 'l', a, b }] : []
  }
  if (type === 'CIRCLE') {
    // normal of the circle's plane from three of its points
    const p0 = pt(edge.pointAt(0)), p1 = pt(edge.pointAt(closed ? 1 / 3 : 0.5)), p2 = pt(edge.pointAt(closed ? 2 / 3 : 1))
    const cn = cross3(sub3(p1, p0), sub3(p2, p0))
    const cl = len3(cn)
    if (cl > 1e-12 && Math.abs(dot3(cn, n)) / cl > 1 - 1e-9) {
      const cc = circumcircle(local(p0), local(p1), local(p2))
      if (cc) {
        if (closed) return [{ k: 'c', c: cc.c, r: cc.r }]
        const a = local(s), b = local(e), m = local(pt(edge.pointAt(0.5)))
        const ccw = (m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]) > 0
        return [ccw ? { k: 'a', c: cc.c, s: a, e: b, r: cc.r } : { k: 'a', c: cc.c, s: b, e: a, r: cc.r }]
      }
    }
  }
  // everything else (ellipses from tilted circles, B-splines, ...): dense polyline
  const N = type === 'LINE' ? 1 : 64
  const pts: Vec2[] = []
  for (let i = 0; i <= N; i++) pts.push(local(pt(edge.pointAt(i / N))))
  const out: ProjectedCurve[] = []
  for (let i = 0; i < N; i++) if (Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) > tol) out.push({ k: 'l', a: pts[i], b: pts[i + 1] })
  return out
}

registerOp<ProjectArgs, ProjectedCurve[]>('projectEdges', (a, h) => {
  const topo = topoOf(h.getBrep(a.key) as unknown as AnyShape)
  const picked = new Set<number>()
  if (a.all) topo.edges.forEach((_, i) => picked.add(i))
  for (const i of a.edges) if (topo.edges[i]) picked.add(i)
  for (const fi of a.faces) {
    const face: Face | undefined = topo.faces[fi]
    if (!face) continue
    for (const e of face.edges) {
      const idx = topo.edgeHashes.indexOf(e.hashCode)
      if (idx >= 0) picked.add(idx)
    }
  }
  const out: ProjectedCurve[] = []
  for (const i of picked) out.push(...projectEdge(topo.edges[i], a.plane))
  return out
})
