/**
 * Worker ops for the Surface workspace: surface extrude / revolve / sweep / loft, patch, offset, trim, extend, stitch,
 * unstitch, thicken and delete face. A surface body is a B-rep with no solid in it (see `Body.surface`); every op here
 * keeps persistent face names (see naming.ts) so later features can keep pointing at "the same" face.
 */
import {
  assembleWire, cast, getOC, makeAx1, makeBSplineApproximation, makeBezierCurve, makeCompound, makeLine, makePolygon, makeThreePointArc, makeVertex,
  iterTopo, measureArea, measureDistanceBetween, measureVolume, DEG2RAD, Vector, type AnyShape, type Edge, type Face, type Wire,
} from 'replicad'
import { registerOp, type OpHelpers } from './store'
import { topoOf, type Shape } from './occ'
import { boolNamed, eachInList, finalize, indexer, inherit, openEdges, type NShape } from './naming'
import { pathWire, type PathSeg } from './solid-ops'
import { add3, cross3, dot3, mul3, norm3, sub3 } from './xform'
import type { Vec3 } from './types'

type Sh = Shape
const any = (s: Sh | NShape | AnyShape) => ('shape' in s ? s.shape : s) as unknown as AnyShape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oc = () => getOC() as any
const v3 = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z]
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// ------------------------------------------------------------------------------------------------ curve inputs

/** A connected run of sketch curves in world space (the main thread turns plane-local sketch segments into these). */
export interface ChainIn { kind: 'chain'; segs: PathSeg[]; closed: boolean; id: string }
/** Edges of an existing body, by B-rep edge index. */
export interface EdgesIn { kind: 'edges'; key: string; edges: number[] }
export type CurveIn = ChainIn | EdgesIn

/** `support`: a face of the body the edge belongs to (a patch can match its tangent to it) */
interface Item { edge: Edge; label: string; support?: Face }
interface Run { wire: Wire; items: Item[]; closed: boolean }

const SNAP = 1e-4

/** Groups loose edges into connected runs, each ordered end to start. */
function orderEdges(items: Item[]): { items: Item[]; closed: boolean }[] {
  const ends = items.map((it) => ({ a: v3(it.edge.startPoint), b: v3(it.edge.endPoint) }))
  const used = new Set<number>()
  const runs: { items: Item[]; closed: boolean }[] = []
  const same = (p: Vec3, q: Vec3) => dist3(p, q) < SNAP
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue
    used.add(i)
    const run = [i]
    let head = ends[i].b, tail = ends[i].a
    // grow at the head, then at the tail
    for (let grown = true; grown;) {
      grown = false
      for (let j = 0; j < items.length; j++) {
        if (used.has(j)) continue
        if (same(ends[j].a, head)) { run.push(j); head = ends[j].b }
        else if (same(ends[j].b, head)) { run.push(j); head = ends[j].a }
        else if (same(ends[j].b, tail)) { run.unshift(j); tail = ends[j].a }
        else if (same(ends[j].a, tail)) { run.unshift(j); tail = ends[j].b }
        else continue
        used.add(j)
        grown = true
      }
    }
    runs.push({ items: run.map((k) => items[k]), closed: same(head, tail) })
  }
  return runs
}

/** The wires a curve input makes: one for a chain, one per connected run of edges. */
function runsOf(c: CurveIn, h: OpHelpers): Run[] {
  if (c.kind === 'chain') {
    const segs = c.segs.filter((s) => (s.k === 'l' ? dist3(s.a, s.b) > 1e-9 : true))
    if (!segs.length) throw new Error('A curve is empty')
    const items: Item[] = segs.map((s, i) => ({
      edge: s.k === 'l' ? makeLine(s.a, s.b) : s.k === 'b' ? makeBezierCurve([s.a, s.c1, s.c2, s.b]) : makeThreePointArc(s.a, s.m, s.b),
      label: s.id ?? `${c.id}${i}`,
    }))
    return [{ wire: assembleWire(items.map((i) => i.edge)), items, closed: c.closed }]
  }
  const topo = topoOf(h.getBrep(c.key) as unknown as AnyShape)
  const names = h.getNames(c.key).edges
  const findEdge = indexer(topo.edges, topo.edgeHashes)
  const supports = new Map<number, Face>()
  topo.faces.forEach((f) => f.edges.forEach((fe) => { const j = findEdge(fe.wrapped as never); if (j >= 0 && !supports.has(j)) supports.set(j, f) }))
  const items: Item[] = c.edges.map((i) => {
    const e = topo.edges[i]
    if (!e) throw new Error('An edge you picked no longer exists')
    return { edge: e.clone() as Edge, label: names[i]?.[0] ?? `e${i}`, support: supports.get(i) }
  })
  return orderEdges(items).map((r) => ({ wire: assembleWire(r.items.map((i) => i.edge)), items: r.items, closed: r.closed }))
}

/**
 * Labels aligned with `wire.edges` (the edges of the wire are the ones OCC reports history for). Making the wire may copy
 * an edge to merge its vertices, so the match is by midpoint, not identity.
 */
function alignedItems(run: Run): Item[] {
  const mids = run.items.map((it) => v3(it.edge.pointAt(0.5)))
  return run.wire.edges.map((e, i) => {
    const m = v3(e.pointAt(0.5))
    let best = -1, bd = Infinity
    mids.forEach((p, k) => { const d = dist3(p, m); if (d < bd) { bd = d; best = k } })
    return best >= 0 ? run.items[best] : { edge: e, label: `e${i}` }
  })
}
const wireLabels = (run: Run) => alignedItems(run).map((it) => it.label)

// ------------------------------------------------------------------------------------------------ shape helpers

const area = (s: Sh | AnyShape) => { try { return Math.abs(measureArea(any(s) as never)) } catch { return 0 } }

/** Face names of several named parts, kept when the parts are put into one compound (faces are matched by shape hash). */
function mergeNamed(parts: NShape[], fid: string): NShape {
  if (parts.length === 1) return parts[0]
  const shape = makeCompound(parts.map((p) => any(p))) as unknown as Sh
  const topo = topoOf(shape as unknown as AnyShape)
  const find = indexer(topo.faces, topo.faceHashes)
  const claims: string[][] = topo.faces.map(() => [])
  for (const p of parts) {
    const pt = topoOf(any(p))
    pt.faces.forEach((f, i) => { const j = find(f.wrapped as never); if (j >= 0) claims[j].push(...(p.faces[i] ?? [])) })
  }
  return { shape, faces: finalize(shape as unknown as AnyShape, claims, fid) }
}

/** Throws unless the shape really holds faces (a failed OCC build can hand back an empty compound). */
function nonEmpty(s: Sh, what: string): Sh {
  if (!(topoOf(s as unknown as AnyShape).faces.length > 0) || !(area(s) > 1e-9)) throw new Error(what)
  return s
}

const send = (h: OpHelpers, a: { id: string; name: string }, r: NShape) => h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))

/** Names for the faces a builder generated from the labelled edges. */
function claimEdges(find: (raw: never) => number, claims: string[][], mk: { Generated(s: never): never }, edges: Edge[], labels: string[], tag: string, fid: string) {
  edges.forEach((e, i) => {
    const hit: number[] = []
    eachInList(mk.Generated(e.wrapped as never) as never, (sh) => hit.push(find(sh as never)))
    hit.forEach((j, k) => { if (j >= 0) claims[j].push(`${fid}:${tag}:${labels[i] || 'e' + i}${hit.length > 1 ? ':' + k : ''}`) })
  })
}

// ------------------------------------------------------------------------------------------------ extrude

export interface SurfaceExtrudeArgs {
  id: string
  name: string
  curves: CurveIn[]
  /** unit direction; null takes the normal of the plane the curves lie in */
  dir: Vec3 | null
  /** signed offsets along `dir` the surface spans (from <= to) */
  from: number
  to: number
}

/** The normal of the plane a set of runs lies in. */
function planeNormal(runs: Run[]): Vec3 {
  const pts = runs.flatMap((r) => r.items.flatMap((it) => [0, 0.25, 0.5, 0.75, 1].map((t) => v3(it.edge.pointAt(t)))))
  const f = planarity(pts)
  const size = Math.max(...pts.map((p) => dist3(p, f.origin)), 1e-6)
  // a straight line has no plane of its own; a bent curve that is not flat has none either
  if (pts.length < 3 || f.dev > 1e-4 * Math.max(1, size) || Math.hypot(...f.normal) < 0.5) throw new Error('These curves do not lie in one flat plane: pick X, Y or Z as the direction')
  return f.normal
}

registerOp<SurfaceExtrudeArgs>('surfaceExtrude', (a, h) => {
  if (!a.curves.length) throw new Error('Select the curves to extrude')
  if (Math.abs(a.to - a.from) < 1e-9) throw new Error('Distance must not be zero')
  const runs = a.curves.flatMap((c) => runsOf(c, h))
  const dir = a.dir ? norm3(a.dir) : planeNormal(runs)
  const parts: NShape[] = []
  for (const run of runs) {
    const labels = wireLabels(run)
    const wire = Math.abs(a.from) > 1e-12 ? (run.wire.clone().translate(mul3(dir, a.from)) as Wire) : run.wire
    const edges = wire.edges
    const vec = new Vector(mul3(dir, a.to - a.from))
    const mk = new (oc().BRepPrimAPI_MakePrism)(wire.wrapped, vec.wrapped, false, true)
    try {
      const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'The curve could not be extruded')
      const topo = topoOf(shape as unknown as AnyShape)
      const claims: string[][] = topo.faces.map(() => [])
      claimEdges(indexer(topo.faces, topo.faceHashes) as never, claims, mk, edges, labels, 'side', a.id)
      parts.push({ shape, faces: finalize(shape as unknown as AnyShape, claims, a.id, 'c' + parts.length) })
    } finally {
      mk.delete()
      vec.delete()
    }
  }
  return send(h, a, mergeNamed(parts, a.id))
})

// ------------------------------------------------------------------------------------------------ revolve

export interface SurfaceRevolveArgs { id: string; name: string; curves: CurveIn[]; axisOrigin: Vec3; axisDir: Vec3; angle: number }

registerOp<SurfaceRevolveArgs>('surfaceRevolve', (a, h) => {
  if (!a.curves.length) throw new Error('Select the curves to revolve')
  if (Math.abs(a.angle) < 1e-9) throw new Error('Angle must not be zero')
  const dir: Vec3 = a.angle < 0 ? mul3(a.axisDir, -1) : a.axisDir
  const parts: NShape[] = []
  for (const c of a.curves) {
    for (const run of runsOf(c, h)) {
      const labels = wireLabels(run)
      const edges = run.wire.edges
      const ax = makeAx1(a.axisOrigin, dir)
      const mk = new (oc().BRepPrimAPI_MakeRevol)(run.wire.wrapped, ax, Math.min(360, Math.abs(a.angle)) * DEG2RAD, false)
      try {
        const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'The curve could not be revolved (does it lie on the axis?)')
        const topo = topoOf(shape as unknown as AnyShape)
        const claims: string[][] = topo.faces.map(() => [])
        claimEdges(indexer(topo.faces, topo.faceHashes) as never, claims, mk, edges, labels, 'rev', a.id)
        parts.push({ shape, faces: finalize(shape as unknown as AnyShape, claims, a.id, 'c' + parts.length) })
      } finally {
        ax.delete()
        mk.delete()
      }
    }
  }
  return send(h, a, mergeNamed(parts, a.id))
})

// ------------------------------------------------------------------------------------------------ sweep

export interface SurfaceSweepArgs { id: string; name: string; profiles: CurveIn[]; path: PathSeg[] }

registerOp<SurfaceSweepArgs>('surfaceSweep', (a, h) => {
  if (!a.profiles.length) throw new Error('Select the profile curves to sweep')
  const parts: NShape[] = []
  for (const c of a.profiles) {
    for (const run of runsOf(c, h)) {
      const labels = wireLabels(run)
      const edges = run.wire.edges
      // the spine is consumed by the sweep: build a fresh one each time
      const mk = new (oc().BRepOffsetAPI_MakePipeShell)(pathWire(a.path).wrapped)
      try {
        mk.SetTransitionMode(oc().BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner)
        mk.Add(run.wire.wrapped, false, false)
        mk.Build()
        const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'Could not sweep the curve along the path (does the curve touch the start of the path?)')
        const topo = topoOf(shape as unknown as AnyShape)
        const find = indexer(topo.faces, topo.faceHashes)
        const claims: string[][] = topo.faces.map(() => [])
        edges.forEach((e, i) => {
          const hit: number[] = []
          eachInList(mk.Generated(e.wrapped as never) as never, (sh) => hit.push(find(sh as never)))
          hit.forEach((j, k) => {
            // the faces of one profile edge come back in path order: one per path segment
            const seg = hit.length === a.path.length ? a.path[k].id ?? String(k) : String(k)
            if (j >= 0) claims[j].push(`${a.id}:side:${labels[i] || 'e' + i}:${seg}`)
          })
        })
        parts.push({ shape, faces: finalize(shape as unknown as AnyShape, claims, a.id, 'c' + parts.length) })
      } finally {
        mk.delete()
      }
    }
  }
  return send(h, a, mergeNamed(parts, a.id))
})

// ------------------------------------------------------------------------------------------------ loft

export interface SurfaceLoftArgs {
  id: string
  name: string
  /** the sections in order; a body's edges that form several connected runs make several sections */
  sections: CurveIn[]
  ruled: boolean
}

registerOp<SurfaceLoftArgs>('surfaceLoft', (a, h) => {
  // every connected run of curves is one section (a body's edges can make several), in the order they were picked
  const runs = a.sections.flatMap((c) => runsOf(c, h))
  if (runs.length < 2) throw new Error('A loft needs at least two sections')
  if (runs.some((r) => r.closed !== runs[0].closed)) throw new Error('All loft sections must be closed, or all must be open')
  const labels = wireLabels(runs[0])
  const edges = runs[0].wire.edges
  const mk = new (oc().BRepOffsetAPI_ThruSections)(false, a.ruled, 1e-6)
  try {
    mk.SetMutableInput(false)
    runs.forEach((r) => mk.AddWire(r.wire.wrapped))
    mk.Build()
    const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'Could not loft through these sections')
    const topo = topoOf(shape as unknown as AnyShape)
    const claims: string[][] = topo.faces.map(() => [])
    claimEdges(indexer(topo.faces, topo.faceHashes) as never, claims, mk, edges, labels, 'loft', a.id)
    return send(h, a, { shape, faces: finalize(shape as unknown as AnyShape, claims, a.id) })
  } finally {
    mk.delete()
  }
})

// ------------------------------------------------------------------------------------------------ sewing

/**
 * Sew shapes into one, keeping the face names (a sewn face comes back through `Modified`). `free` is the number of edges
 * that still belong to a single face afterwards.
 */
function sewNamed(parts: NShape[], tol: number, fid: string): { out: NShape; free: number } {
  const sew = new (oc().BRepBuilderAPI_Sewing)(tol, true, true, true, false)
  try {
    for (const p of parts) sew.Add(any(p).wrapped)
    sew.Perform()
    const raw = sew.SewedShape()
    if (raw.IsNull()) throw new Error('Nothing to sew')
    const shape = cast(raw) as unknown as Sh
    const rt = topoOf(shape as unknown as AnyShape)
    const find = indexer(rt.faces, rt.faceHashes)
    const claims: string[][] = rt.faces.map(() => [])
    for (const p of parts) {
      topoOf(any(p)).faces.forEach((f, i) => {
        const names = p.faces[i]
        if (!names?.length) return
        const m = sew.IsModified(f.wrapped) ? sew.Modified(f.wrapped) : f.wrapped
        const j = find(m as never)
        if (j >= 0) claims[j].push(...names)
      })
    }
    return { out: { shape, faces: finalize(shape as unknown as AnyShape, claims, fid) }, free: sew.NbFreeEdges() }
  } finally {
    sew.delete()
  }
}

/** The faces of a named body as separate named parts (the shapes are shared, never altered). */
const facePart = (src: NShape, i: number): NShape => ({ shape: topoOf(any(src)).faces[i] as unknown as Sh, faces: [src.faces[i] ?? []] })

// ------------------------------------------------------------------------------------------------ patch

export interface SurfacePatchArgs {
  id: string
  name: string
  boundary: CurveIn[]
  /** how the patch meets the faces next to its boundary edges (only edges of a body can match a face) */
  continuity: 'g0' | 'g1' | 'g2'
}

/** Largest distance of the sample points from their best-fit plane (Newell normal), and that plane's origin / normal. */
function planarity(pts: Vec3[]): { dev: number; origin: Vec3; normal: Vec3 } {
  const n: Vec3 = [0, 0, 0]
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]
    n[0] += (p[1] - q[1]) * (p[2] + q[2])
    n[1] += (p[2] - q[2]) * (p[0] + q[0])
    n[2] += (p[0] - q[0]) * (p[1] + q[1])
  })
  const normal = norm3(n)
  const origin = mul3(pts.reduce((s, p) => add3(s, p), [0, 0, 0] as Vec3), 1 / pts.length)
  return { dev: Math.max(...pts.map((p) => Math.abs(dot3(sub3(p, origin), normal)))), origin, normal }
}

registerOp<SurfacePatchArgs>('surfacePatch', (a, h) => {
  const runs = a.boundary.flatMap((c) => runsOf(c, h))
  const edgesIn = runs.flatMap((r) => alignedItems(r))
  if (!edgesIn.length) throw new Error('Select the curves or edges that surround the patch')
  // the pieces may come from several curves: they have to join up into one closed loop
  const loops = runs.length === 1 ? runs : orderEdges(edgesIn).map((r) => ({ wire: assembleWire(r.items.map((i) => i.edge)), items: r.items, closed: r.closed }))
  if (loops.length !== 1 || !loops[0].closed) throw new Error('The boundary must be one closed loop: the curves have to meet end to end')
  const loop = loops[0]
  const items = alignedItems(loop)
  const samples: Vec3[] = items.flatMap((it) => [0, 0.25, 0.5, 0.75].map((t) => v3(it.edge.pointAt(t))))
  const flat = planarity(samples)
  const size = Math.max(...samples.map((p) => dist3(p, flat.origin)), 1e-6)

  let shape: Sh
  if (a.continuity === 'g0' && flat.dev < 1e-6 * Math.max(1, size)) {
    // a flat boundary gets an exact plane, not a fitted spline surface
    const f = oc().BRepBuilderAPI_MakeFace
    const mk = new f(loop.wire.wrapped, true)
    try {
      if (!mk.IsDone()) throw new Error('Could not fill the boundary')
      shape = cast(mk.Face()) as unknown as Sh
    } finally { mk.delete() }
  } else {
    const o = oc()
    const order = (e: Item) => (a.continuity === 'g2' && e.support ? o.GeomAbs_Shape.GeomAbs_G2 : a.continuity !== 'g0' && e.support ? o.GeomAbs_Shape.GeomAbs_G1 : o.GeomAbs_Shape.GeomAbs_C0)
    const mk = new o.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9)
    try {
      for (const it of items) {
        const ord = order(it)
        if (it.support && ord !== o.GeomAbs_Shape.GeomAbs_C0) mk.Add(it.edge.wrapped, it.support.wrapped, ord, true)
        else mk.Add(it.edge.wrapped, o.GeomAbs_Shape.GeomAbs_C0, true)
      }
      mk.Build()
      if (!mk.IsDone()) throw new Error('Could not fill the boundary')
      shape = cast(mk.Shape()) as unknown as Sh
      if (mk.G0Error() > 0.01 * Math.max(1, size)) throw new Error(`The patch does not follow its boundary (off by ${+mk.G0Error().toFixed(3)} mm); try a simpler boundary`)
    } catch (e) {
      throw new Error(e instanceof Error && /boundary|patch/.test(e.message) ? e.message : `Could not fill the boundary (${e instanceof Error ? e.message : e})`)
    } finally { mk.delete() }
  }
  nonEmpty(shape, 'Could not fill the boundary')
  const faces = topoOf(shape as unknown as AnyShape).faces.map(() => [`${a.id}:patch`])
  return send(h, a, { shape, faces: finalize(shape as unknown as AnyShape, faces, a.id) })
})

// ------------------------------------------------------------------------------------------------ offset

export interface SurfaceOffsetArgs {
  id: string
  name: string
  /** whole surface bodies, or some faces of a body */
  sources: { key: string; faces?: number[] }[]
  /** signed: positive goes the way the faces point */
  distance: number
}

registerOp<SurfaceOffsetArgs>('surfaceOffset', (a, h) => {
  if (!a.sources.length) throw new Error('Select the surfaces or faces to offset')
  if (Math.abs(a.distance) < 1e-9) throw new Error('Distance must not be zero')
  const parts: NShape[] = []
  for (const s of a.sources) {
    let src = h.getNamed(s.key)
    const topo = topoOf(any(src))
    if (s.faces?.length) {
      if (s.faces.some((i) => !topo.faces[i])) throw new Error('A face you picked no longer exists')
      src = sewNamed(s.faces.map((i) => facePart(src, i)), 1e-6, a.id).out
    } else if (any(src).solids.length) throw new Error('Offset Surface needs a surface or some faces of a body: pick faces of the solid')
    const o = oc()
    const mk = new o.BRepOffsetAPI_MakeOffsetShape()
    try {
      mk.PerformByJoin(any(src).wrapped, a.distance, 1e-4, o.BRepOffset_Mode.BRepOffset_Skin, false, false, o.GeomAbs_JoinType.GeomAbs_Arc, false)
      if (!mk.IsDone()) throw new Error('OpenCascade could not offset it')
      const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'The offset is empty')
      const claims = inherit(mk, [{ shape: any(src), faces: src.faces }], shape as unknown as AnyShape, { fid: a.id, genFace: 'off' })
      parts.push({ shape, faces: finalize(shape as unknown as AnyShape, claims, a.id, 'o' + parts.length) })
    } catch (e) {
      throw new Error(`An offset of ${a.distance} mm is not possible here (${e instanceof Error ? e.message : e})`)
    } finally { mk.delete() }
  }
  return send(h, a, mergeNamed(parts, a.id))
})

// ------------------------------------------------------------------------------------------------ trim

export type TrimTool =
  | { kind: 'plane'; origin: Vec3; normal: Vec3 }
  | { kind: 'body'; key: string }
  | { kind: 'faces'; key: string; faces: number[] }

export interface SurfaceTrimArgs {
  id: string
  name: string
  /** the surface body that is cut */
  key: string
  tool: TrimTool
  /** which side stays: the side the tool's normal points to (outside of a solid), or the other one */
  keep: 'front' | 'back'
}

const pntOf = (p: Vec3) => new (oc().gp_Pnt)(p[0], p[1], p[2])

/** A point well inside a face (the middle of its largest triangle): the centre of mass can fall outside a trimmed face. */
function insidePoint(f: Face): Vec3 {
  const m = f.mesh({ tolerance: 0.05, angularTolerance: 0.3 })
  let best = -1, bestArea = -1
  const P = (i: number): Vec3 => [m.vertices[i * 3], m.vertices[i * 3 + 1], m.vertices[i * 3 + 2]]
  for (let t = 0; t < m.triangles.length / 3; t++) {
    const p = P(m.triangles[t * 3]), q = P(m.triangles[t * 3 + 1]), r = P(m.triangles[t * 3 + 2])
    const ar = Math.hypot(...cross3(sub3(q, p), sub3(r, p)))
    if (ar > bestArea) { bestArea = ar; best = t }
  }
  if (best < 0) { const c = f.center; return [c.x, c.y, c.z] }
  const p = P(m.triangles[best * 3]), q = P(m.triangles[best * 3 + 1]), r = P(m.triangles[best * 3 + 2])
  return mul3(add3(add3(p, q), r), 1 / 3)
}

/** Signed distance of a point from the nearest tool face, along that face's normal (positive: in front). */
function sideOf(p: Vec3, tool: Face[]): number {
  const o = oc()
  const vtx = makeVertex(p)
  let best: { d: number; pt: Vec3; face: Face } | null = null
  for (const f of tool) {
    const ex = new o.BRepExtrema_DistShapeShape(vtx.wrapped, f.wrapped)
    try {
      if (!ex.IsDone() || ex.NbSolution() < 1) continue
      const d = ex.Value()
      if (!best || d < best.d - 1e-9) { const q = ex.PointOnShape2(1); best = { d, pt: [q.X(), q.Y(), q.Z()], face: f } }
    } finally { ex.delete() }
  }
  if (!best) return 0
  const n = v3(best.face.normalAt(best.pt))
  return dot3(sub3(p, best.pt), n)
}

registerOp<SurfaceTrimArgs>('surfaceTrim', (a, h) => {
  const target = h.getNamed(a.key)
  const tshape = any(target)
  if (tshape.solids.length) throw new Error('Trim works on surfaces: use Cut to trim a solid')
  const tool = a.tool
  let toolFaces: Face[] = []
  let solidTool: NShape | null = null
  if (tool.kind === 'plane') {
    const bb = (tshape as unknown as { boundingBox: { bounds: [Vec3, Vec3] } }).boundingBox.bounds
    const centre = mul3(add3(bb[0], bb[1]), 0.5)
    const n = norm3(tool.normal)
    const half = dist3(bb[0], bb[1]) * 1.5 + 1
    const c = sub3(centre, mul3(n, dot3(sub3(centre, tool.origin), n)))
    const u = norm3(cross3(n, Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]))
    const w = cross3(n, u)
    const corner = (s: number, t: number): Vec3 => add3(c, add3(mul3(u, s * half), mul3(w, t * half)))
    toolFaces = [makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]) as unknown as Face]
  } else {
    const body = h.getNamed(tool.key)
    const bs = any(body)
    const faces = topoOf(bs).faces
    if (tool.kind === 'faces') {
      toolFaces = tool.faces.map((i) => faces[i]).filter(Boolean)
      if (toolFaces.length !== tool.faces.length) throw new Error('A face of the trim tool no longer exists')
    } else if (bs.solids.length) solidTool = body
    else toolFaces = faces
  }

  if (solidTool) {
    // a solid cuts a surface by plain booleans: outside is what lies in front
    let r: NShape
    try { r = boolNamed(a.keep === 'front' ? 'cut' : 'common', target, solidTool, a.id) } catch (e) { throw new Error(`The solid does not trim this surface (${e instanceof Error ? e.message : e})`) }
    const before = area(tshape)
    nonEmpty(r.shape, 'Nothing is left on that side of the solid')
    if (Math.abs(area(r.shape) - before) < 1e-9 * Math.max(1, before)) throw new Error('The solid does not cross the surface')
    return send(h, a, r)
  }

  const o = oc()
  const sp = new o.BRepAlgoAPI_Splitter()
  const args = new o.NCollection_List_TopoDS_Shape()
  const tools = new o.NCollection_List_TopoDS_Shape()
  try {
    args.Append(tshape.wrapped)
    toolFaces.forEach((f) => tools.Append(f.wrapped))
    sp.SetArguments(args)
    sp.SetTools(tools)
    sp.Build()
    if (!sp.IsDone()) throw new Error('OpenCascade could not split the surface with that tool')
    const split = cast(sp.Shape()) as unknown as Sh
    const rt = topoOf(split as unknown as AnyShape)
    const claims = inherit(sp, [target], split as unknown as AnyShape, { fid: a.id })
    const keep: NShape[] = []
    rt.faces.forEach((f, i) => {
      const s = sideOf(insidePoint(f), toolFaces)
      if (a.keep === 'front' ? s >= -1e-9 : s <= 1e-9) keep.push({ shape: f as unknown as Sh, faces: [claims[i]] })
    })
    // a cut that does not divide any face (the tool misses, or stops half way across) leaves nothing to tell the two sides apart
    if (rt.faces.length === topoOf(tshape).faces.length) throw new Error('The trim tool does not cut the surface in two: it has to reach all the way across (a plane always does)')
    if (!keep.length) throw new Error('Nothing is left on that side of the tool')
    const sewn = sewNamed(keep, 1e-6, a.id).out
    return send(h, a, { shape: sewn.shape, faces: finalize(any(sewn), sewn.faces, a.id) })
  } finally {
    sp.delete()
    args.delete()
    tools.delete()
  }
})

// ------------------------------------------------------------------------------------------------ extend

export interface SurfaceExtendArgs {
  id: string
  name: string
  key: string
  /** free (boundary) edges of the surface */
  edges: number[]
  distance: number
  /** natural: keep following the surface; tangent: carry on straight along its tangent at the edge */
  mode: 'natural' | 'tangent'
}

registerOp<SurfaceExtendArgs>('surfaceExtend', (a, h) => {
  if (!(a.distance > 0)) throw new Error('The extension distance must be greater than zero')
  const src = h.getNamed(a.key)
  const names = h.getNames(a.key)
  const topo = topoOf(any(src))
  if (any(src).solids.length) throw new Error('Extend works on surfaces, not solids')
  const findEdge = indexer(topo.edges, topo.edgeHashes)
  const owners = new Map<number, number[]>()
  topo.faces.forEach((f, fi) => f.edges.forEach((e) => {
    const j = findEdge(e.wrapped as never)
    if (j >= 0 && !(owners.get(j) ?? []).includes(fi)) owners.set(j, [...(owners.get(j) ?? []), fi])
  }))
  const o = oc()
  const strips: NShape[] = []
  for (const ei of a.edges) {
    const edge = topo.edges[ei]
    if (!edge) throw new Error('An edge you picked no longer exists')
    const own = owners.get(ei) ?? []
    if (own.length !== 1) throw new Error('Only the open (boundary) edges of a surface can be extended')
    const face = topo.faces[own[0]]
    const reversed = edge.orientation === 'backward'
    const line = edge.geomType === 'LINE'
    const count = line ? 2 : Math.max(8, Math.min(48, Math.ceil(edge.length / Math.max(a.distance / 4, 1e-3))))
    const at = (k: number) => (reversed ? 1 - k / (count - 1) : k / (count - 1))
    const pts: Vec3[] = [], dirs: Vec3[] = []
    for (let k = 0; k < count; k++) {
      const p = v3(edge.pointAt(at(k)))
      const t = norm3(v3(edge.tangentAt(at(k))))
      const n = v3(face.normalAt(p))
      pts.push(p)
      dirs.push(norm3(cross3(n, t)))
    }
    // which way is out? the side of the edge that is not on the face
    const eps = Math.max(1e-3, Math.min(a.distance, edge.length) * 0.05)
    const mid = count >> 1
    const away = (s: number) => measureDistanceBetween(face as never, makeVertex(add3(pts[mid], mul3(dirs[mid], s * eps))) as never)
    const sign = away(1) >= away(-1) ? 1 : -1
    const out = dirs.map((d) => mul3(d, sign))
    const sections: Wire[] = [assembleWire([edge.clone() as Edge])]
    const through = (q: Vec3[]): Edge => (line && q.every((_, k) => dist3(sub3(q[k], pts[k]), sub3(q[0], pts[0])) < 1e-9) ? makeLine(q[0], q[q.length - 1]) : makeBSplineApproximation(q, { tolerance: 1e-5, smoothing: null, degMax: 8 } as never))
    if (a.mode === 'tangent') {
      sections.push(assembleWire([through(pts.map((p, k) => add3(p, mul3(out[k], a.distance))))]))
    } else {
      // natural: walk out over the surface the face sits on, a few steps, so the extension keeps its curvature
      const surf = o.BRep_Tool.Surface(face.wrapped)
      const steps = 4
      const walk = pts.map((p, k) => {
        const pp = new o.GeomAPI_ProjectPointOnSurf(pntOf(p), surf)
        if (!(pp.NbPoints() > 0)) throw new Error('Natural extension is not available for this surface: use Tangent')
        const uv = pp.LowerDistanceParameters()
        let u = uv.U, v = uv.V
        const path: Vec3[] = []
        for (let s = 1; s <= steps; s++) {
          const d1 = surf.EvalD1(u, v)
          const su = [d1.D1U.X(), d1.D1U.Y(), d1.D1U.Z()] as Vec3, sv = [d1.D1V.X(), d1.D1V.Y(), d1.D1V.Z()] as Vec3
          // least squares: (du, dv) so that su du + sv dv follows the outward direction
          const m11 = dot3(su, su), m12 = dot3(su, sv), m22 = dot3(sv, sv)
          const r1 = dot3(su, out[k]), r2 = dot3(sv, out[k])
          const det = m11 * m22 - m12 * m12
          if (Math.abs(det) < 1e-18) throw new Error('Natural extension is not available for this surface: use Tangent')
          const du = (r1 * m22 - r2 * m12) / det, dv = (m11 * r2 - m12 * r1) / det
          const stepLen = a.distance / steps
          const speed = Math.hypot(...add3(mul3(su, du), mul3(sv, dv))) || 1
          u += (du * stepLen) / speed
          v += (dv * stepLen) / speed
          const q = surf.EvalD0(u, v)
          path.push([q.X(), q.Y(), q.Z()])
        }
        return path
      })
      for (let s = 0; s < steps; s++) sections.push(assembleWire([through(walk.map((w) => w[s]))]))
    }
    const mk = new o.BRepOffsetAPI_ThruSections(false, a.mode === 'tangent', 1e-6)
    try {
      mk.SetMutableInput(false)
      sections.forEach((w) => mk.AddWire(w.wrapped))
      mk.Build()
      const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'Could not extend this edge')
      strips.push({ shape, faces: topoOf(shape as unknown as AnyShape).faces.map(() => [`${a.id}:ext:${names.edges[ei]?.[0] ?? ei}`]) })
    } finally { mk.delete() }
  }
  const tol = 1e-4 * Math.max(1, a.distance)
  const { out } = sewNamed([src, ...strips.map((s) => ({ shape: s.shape, faces: finalize(any(s), s.faces, a.id, 'x') }))], tol, a.id)
  return send(h, a, out)
})

// ------------------------------------------------------------------------------------------------ stitch / unstitch

export interface SurfaceStitchArgs {
  id: string
  name: string
  keys: string[]
  tolerance: number
  /** make a solid when the sewn surfaces close up */
  solid: boolean
}

/** A solid from a closed shell, oriented so that its volume is positive (null when the shape is not one single shell). */
function solidFromShell(shape: Sh): Sh | null {
  const shells = Array.from(iterTopo(any(shape).wrapped as never, 'shell'))
  if (shells.length !== 1) return null
  const fix = new (oc().ShapeFix_Solid)()
  try {
    const solid = cast(fix.SolidFromShell(shells[0])) as unknown as Sh
    return Math.abs(measureVolume(solid as never)) > 1e-9 ? solid : null
  } finally { fix.delete() }
}

/** The names of `from` for the faces of `to`, which holds the very same faces (a solid made of a shell). */
function carry(from: NShape, to: Sh): string[][] {
  const ft = topoOf(any(from))
  const find = indexer(ft.faces, ft.faceHashes)
  return topoOf(to as unknown as AnyShape).faces.map((f) => from.faces[find(f.wrapped as never)] ?? [])
}

registerOp<SurfaceStitchArgs>('surfaceStitch', (a, h) => {
  if (a.keys.length < 1) throw new Error('Select the surfaces to stitch')
  if (!(a.tolerance > 0)) throw new Error('The tolerance must be greater than zero')
  const parts = a.keys.map((k) => h.getNamed(k))
  if (parts.some((p) => any(p).solids.length)) throw new Error('Stitch joins surfaces; a solid is already closed')
  let { out, free } = sewNamed(parts, a.tolerance, a.id)
  if (a.solid && free === 0) {
    const solid = solidFromShell(out.shape)
    if (solid) out = { shape: solid, faces: carry(out, solid) }
  }
  return send(h, a, { shape: out.shape, faces: finalize(any(out), out.faces, a.id) })
})

export interface SurfaceUnstitchArgs {
  /** the first piece gets `id`, the others `${id}.${n}` */
  id: string
  name: string
  key: string
  /** pull out just these faces; the rest stays one surface. Absent: every face becomes its own body. */
  faces?: number[]
}

registerOp<SurfaceUnstitchArgs>('surfaceUnstitch', (a, h) => {
  const src = h.getNamed(a.key)
  const faces = topoOf(any(src)).faces
  if (faces.length < 2) throw new Error('There is only one face: nothing to unstitch')
  const pick = a.faces?.length ? a.faces : faces.map((_, i) => i)
  if (pick.some((i) => !faces[i])) throw new Error('A face you picked no longer exists')
  const rest = faces.map((_, i) => i).filter((i) => !pick.includes(i))
  const pieces: NShape[] = pick.map((i) => facePart(src, i))
  if (rest.length) pieces.push(sewNamed(rest.map((i) => facePart(src, i)), 1e-6, a.id).out)
  const bodies = pieces.map((p, n) => {
    const shape = p.shape
    return h.bodyFromShape(n ? `${a.id}.${n}` : a.id, `${a.name}${pieces.length > 1 ? ' ' + (n + 1) : ''}`, shape, finalize(any(p), p.faces, a.id))
  })
  return h.sendBodies(bodies)
})

// ------------------------------------------------------------------------------------------------ thicken

export interface SurfaceThickenArgs {
  id: string
  name: string
  key: string
  /** signed: positive grows the way the surface faces */
  distance: number
  /** 'sym' puts half the thickness on each side of the surface */
  sym: boolean
}

/** The edge as OCC walks it: where it starts and ends once its orientation is applied. */
const walked = (e: Edge): [Vec3, Vec3] => (e.orientation === 'forward' ? [v3(e.startPoint), v3(e.endPoint)] : [v3(e.endPoint), v3(e.startPoint)])

registerOp<SurfaceThickenArgs>('surfaceThicken', (a, h) => {
  if (Math.abs(a.distance) < 1e-9) throw new Error('Thickness must not be zero')
  let src = h.getNamed(a.key)
  if (any(src).solids.length) throw new Error('Thicken works on surfaces; a solid already has volume')
  const open0 = openEdges(any(src))
  if (!open0.length) throw new Error('This surface is closed: stitch it into a solid instead of thickening it')
  const o = oc()
  const offset = (s: NShape, d: number): NShape => {
    const mk = new o.BRepOffsetAPI_MakeOffsetShape()
    try {
      mk.PerformByJoin(any(s).wrapped, d, 1e-4, o.BRepOffset_Mode.BRepOffset_Skin, false, false, o.GeomAbs_JoinType.GeomAbs_Arc, false)
      if (!mk.IsDone()) throw new Error('OpenCascade could not offset the surface')
      const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'The offset is empty')
      return { shape, faces: finalize(shape as unknown as AnyShape, inherit(mk, [{ shape: any(s), faces: s.faces }], shape as unknown as AnyShape, { fid: a.id, genFace: 'off' }), a.id) }
    } finally { mk.delete() }
  }
  try {
    if (a.sym) src = offset(src, -a.distance / 2)
    const base = a.sym ? openEdges(any(src)) : open0
    const lid = offset(src, a.sym ? a.distance : a.distance)
    const far = openEdges(any(lid))
    if (far.length !== base.length) throw new Error('the offset surface lost part of its boundary')
    // a wall closes the gap between every open edge and its offset twin (the nearest open edge of the offset surface)
    const walls: NShape[] = []
    base.forEach((e0, k) => {
      const m = v3(e0.pointAt(0.5))
      let twin = far[0], bd = Infinity
      for (const f of far) { const d = dist3(m, v3(f.pointAt(0.5))); if (d < bd) { bd = d; twin = f } }
      // the twin has to run the same way as the edge for the wall not to twist
      const [s0] = walked(e0)
      let e1 = twin.clone() as Edge
      const [s1, t1] = walked(e1)
      if (dist3(s0, s1) > dist3(s0, t1)) e1 = cast(e1.flipOrientation() as never) as unknown as Edge
      const mk = new o.BRepOffsetAPI_ThruSections(false, true, 1e-6)
      try {
        mk.SetMutableInput(false)
        mk.AddWire(assembleWire([e0.clone() as Edge]).wrapped)
        mk.AddWire(assembleWire([e1]).wrapped)
        mk.Build()
        const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'could not close the edge')
        walls.push({ shape, faces: topoOf(shape as unknown as AnyShape).faces.map(() => [`${a.id}:wall:${k}`]) })
      } finally { mk.delete() }
    })
    const tol = 1e-4 * Math.max(1, Math.abs(a.distance))
    const sewn = sewNamed([src, lid, ...walls], tol, a.id)
    if (sewn.free > 0) throw new Error('the walls did not close up')
    const solid = solidFromShell(sewn.out.shape)
    if (!solid) throw new Error('the result is not a closed solid')
    return send(h, a, { shape: solid, faces: finalize(solid as unknown as AnyShape, carry(sewn.out, solid), a.id) })
  } catch (e) {
    throw new Error(`Thickening by ${Math.abs(a.distance)} mm is not possible here (${e instanceof Error ? e.message : e}); try a thinner thickness`)
  }
})

// ------------------------------------------------------------------------------------------------ delete face

export interface SurfaceDeleteFaceArgs { id: string; name: string; key: string; faces: number[] }

registerOp<SurfaceDeleteFaceArgs>('surfaceDeleteFace', (a, h) => {
  const src = h.getNamed(a.key)
  const faces = topoOf(any(src)).faces
  if (!a.faces.length) throw new Error('Select the faces to delete')
  if (a.faces.some((i) => !faces[i])) throw new Error('A face you picked no longer exists')
  const rest = faces.map((_, i) => i).filter((i) => !a.faces.includes(i))
  if (!rest.length) throw new Error('That would delete every face of the body')
  const { out } = sewNamed(rest.map((i) => facePart(src, i)), 1e-6, a.id)
  return send(h, a, out)
})
