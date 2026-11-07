/** Worker ops that serve the sketcher: projecting B-rep edges / faces onto a sketch plane. */
import { cast, getOC, makePolygon, type AnyShape, type Edge, type Face } from 'replicad'
import { registerOp } from './store'
import { topoOf } from './occ'
import type { PlaneDef, Vec2, Vec3 } from '../sketch/types'
import { circumcircle } from '../sketch/geom'

/** A projected curve in plane-local 2D. Arcs run counter-clockwise from `s` to `e` around `c`. */
export type ProjectedCurve =
  | { k: 'l'; a: Vec2; b: Vec2 }
  | { k: 'c'; c: Vec2; r: number }
  | { k: 'a'; c: Vec2; s: Vec2; e: Vec2; r: number }
  /** a point: a vertex, or an edge that stands square to the plane */
  | { k: 'p'; p: Vec2 }

export type ProjectMode = 'project' | 'intersect' | 'include3d' | 'surface'

export interface ProjectArgs {
  key: string
  plane: PlaneDef
  /** B-rep face / edge indices (positions in `topoOf(shape).faces` / `.edges`); a face contributes all its boundary edges */
  faces: number[]
  edges: number[]
  /** project every edge of the body */
  all?: boolean
  /**
   * project: the edges flattened onto the plane (an edge square to the plane becomes a point).
   * intersect: the curves where the plane cuts the picked faces / body.
   * include3d: project, plus a point for every vertex of what was picked.
   */
  mode?: ProjectMode
  /** join arcs that make up a whole circle into one circle (projections made before this existed keep their half arcs) */
  merge?: boolean
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

const TAU = Math.PI * 2

/** Counter-clockwise sweep of an arc, 0..2pi. */
function sweepOf(c: Extract<ProjectedCurve, { k: 'a' }>): number {
  const a0 = Math.atan2(c.s[1] - c.c[1], c.s[0] - c.c[0]), a1 = Math.atan2(c.e[1] - c.c[1], c.e[0] - c.c[0])
  let d = a1 - a0
  while (d <= 1e-12) d += TAU
  return d
}

const near2 = (a: Vec2, b: Vec2, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol

/** Drop repeated curves (a side face seen edge on projects its top and bottom edges onto one line) and, optionally, join the arcs of a whole circle into a circle. */
export function tidyCurves(curves: ProjectedCurve[], merge: boolean, tol = 1e-6): ProjectedCurve[] {
  let list = curves
  if (merge) {
    const arcs = list.filter((c): c is Extract<ProjectedCurve, { k: 'a' }> => c.k === 'a')
    const used = new Set<ProjectedCurve>()
    const made = new Map<ProjectedCurve, ProjectedCurve>()
    for (const a of arcs) {
      if (used.has(a)) continue
      const group = arcs.filter((b) => !used.has(b) && near2(a.c, b.c, 1e-5) && Math.abs(a.r - b.r) < 1e-5)
      if (group.length < 2) continue
      const total = group.reduce((t, g) => t + sweepOf(g), 0)
      if (Math.abs(total - TAU) > 1e-5) continue
      group.forEach((g) => used.add(g))
      made.set(group[0], { k: 'c', c: a.c, r: a.r })
    }
    if (used.size) list = list.flatMap((c) => (made.has(c) ? [made.get(c)!] : used.has(c) ? [] : [c]))
  }
  const out: ProjectedCurve[] = []
  const dup = (a: ProjectedCurve, b: ProjectedCurve) => {
    if (a.k !== b.k) return false
    if (a.k === 'l' && b.k === 'l') return (near2(a.a, b.a, tol) && near2(a.b, b.b, tol)) || (near2(a.a, b.b, tol) && near2(a.b, b.a, tol))
    if (a.k === 'p' && b.k === 'p') return near2(a.p, b.p, tol)
    if (a.k === 'c' && b.k === 'c') return near2(a.c, b.c, tol) && Math.abs(a.r - b.r) < tol
    if (a.k === 'a' && b.k === 'a') return near2(a.c, b.c, tol) && near2(a.s, b.s, tol) && near2(a.e, b.e, tol)
    return false
  }
  for (const c of list) if (!out.some((o) => dup(o, c))) out.push(c)
  return out
}

/** Edges where the plane cuts the shape, flattened into the plane (they lie in it already). */
function sectionEdges(shape: AnyShape, plane: PlaneDef, only?: Face[]): Edge[] {
  const o = getOC() as unknown as { BRepAlgoAPI_Section: new (a: unknown, b: unknown, c: boolean) => { Build(r: unknown): void; Shape(): never; delete(): void }; Message_ProgressRange: new () => unknown }
  const bb = (shape as unknown as { boundingBox: { bounds: [Vec3, Vec3] } }).boundingBox.bounds
  const diag = Math.hypot(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2])
  const L = Math.max(diag, 1) * 3 + Math.hypot(plane.origin[0], plane.origin[1], plane.origin[2])
  const ex = plane.xDir, ey = cross3(plane.normal, plane.xDir)
  const at = (u: number, v: number): Vec3 => [plane.origin[0] + (ex[0] * u + ey[0] * v) * L, plane.origin[1] + (ex[1] * u + ey[1] * v) * L, plane.origin[2] + (ex[2] * u + ey[2] * v) * L]
  const tool = makePolygon([at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)]) as unknown as { wrapped: unknown }
  const out: Edge[] = []
  for (const target of only ?? [shape as unknown as Face]) {
    const sec = new o.BRepAlgoAPI_Section((target as unknown as { wrapped: unknown }).wrapped, tool.wrapped, true)
    try {
      sec.Build(new o.Message_ProgressRange())
      out.push(...(cast(sec.Shape()) as unknown as { edges: Edge[] }).edges)
    } finally { sec.delete() }
  }
  return out
}

registerOp<ProjectArgs, ProjectedCurve[]>('projectEdges', (a, h) => {
  const shape = h.getBrep(a.key) as unknown as AnyShape
  const topo = topoOf(shape)
  const mode = a.mode ?? 'project'
  const n = a.plane.normal
  const ex = a.plane.xDir, ey = cross3(n, ex)
  const local = (p: Vec3): Vec2 => { const d = sub3(p, a.plane.origin); return [dot3(d, ex), dot3(d, ey)] }
  const out: ProjectedCurve[] = []
  if (mode === 'intersect') {
    // the curves where the plane cuts the picked faces, or the whole body
    const faces = a.all || (!a.faces.length && !a.edges.length) ? undefined : a.faces.map((i) => topo.faces[i]).filter(Boolean)
    for (const e of sectionEdges(shape, a.plane, faces)) out.push(...projectEdge(e, a.plane))
    return tidyCurves(out, true)
  }
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
  const verts: Vec2[] = []
  for (const i of picked) {
    const e = topo.edges[i]
    const c = projectEdge(e, a.plane)
    if (c.length) out.push(...c)
    else if ((e.geomType as string) === 'LINE' && len3(sub3(pt(e.endPoint), pt(e.startPoint))) > 1e-7) out.push({ k: 'p', p: local(pt(e.startPoint)) }) // square to the plane: a point
    if (mode === 'include3d') { verts.push(local(pt(e.startPoint))); if (!e.isClosed) verts.push(local(pt(e.endPoint))) }
  }
  for (const v of verts) out.push({ k: 'p', p: v })
  return tidyCurves(out, !!a.merge)
})

export interface FaceCirclesArgs { key: string; face: number; plane: PlaneDef }
/**
 * The round holes and bosses on a flat face: every circle among the face's edges (a circle that was cut in halves counts as one),
 * as centre and radius in the plane's local coordinates. The Hole tool snaps a click near one of them to its centre.
 */
registerOp<FaceCirclesArgs, { c: Vec2; r: number }[]>('faceCircles', (a, h) => {
  const topo = topoOf(h.getBrep(a.key) as unknown as AnyShape)
  const face = topo.faces[a.face]
  if (!face) return []
  const curves: ProjectedCurve[] = []
  for (const e of face.edges) curves.push(...projectEdge(e, a.plane))
  return tidyCurves(curves, true).filter((c): c is Extract<ProjectedCurve, { k: 'c' }> => c.k === 'c').map((c) => ({ c: c.c, r: c.r }))
})
