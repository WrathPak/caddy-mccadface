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

/** What a failed build says: OpenCascade throws bare WebAssembly exceptions with no message at all. */
const why = (e: unknown) => (e instanceof Error ? e.message : 'OpenCascade could not build it')

/** Registers a surface op. A failure that is not an Error (an OpenCascade exception) becomes a sentence with a hint, so the feature can show it. */
function surfaceOp<A>(name: string, what: string, hint: string, fn: (a: A, h: OpHelpers) => unknown) {
  registerOp<A>(name, (a, h) => {
    try {
      return fn(a, h)
    } catch (e) {
      if (e instanceof Error) throw e
      throw new Error(`${what} failed inside OpenCascade (${hint})`)
    }
  })
}

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

surfaceOp<SurfaceExtrudeArgs>('surfaceExtrude', 'Extrude Surface', 'check the curves and the direction', (a, h) => {
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

surfaceOp<SurfaceRevolveArgs>('surfaceRevolve', 'Revolve Surface', 'the curves must not cross the axis', (a, h) => {
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

surfaceOp<SurfaceSweepArgs>('surfaceSweep', 'Sweep Surface', 'the profile has to touch the start of the path', (a, h) => {
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

surfaceOp<SurfaceLoftArgs>('surfaceLoft', 'Loft Surface', 'the sections may be too different, try Ruled', (a, h) => {
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

surfaceOp<SurfacePatchArgs>('surfacePatch', 'Patch', 'the boundary may be too twisted or not meet end to end', (a, h) => {
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
      throw new Error(e instanceof Error && /boundary|patch/.test(e.message) ? e.message : `Could not fill the boundary (${why(e)})`)
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

surfaceOp<SurfaceOffsetArgs>('surfaceOffset', 'Offset Surface', 'the distance may be too large for the curvature', (a, h) => {
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
      throw new Error(`An offset of ${a.distance} mm is not possible here (${why(e)})`)
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

surfaceOp<SurfaceTrimArgs>('surfaceTrim', 'Trim', 'the tool may only touch the surface', (a, h) => {
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
    try { r = boolNamed(a.keep === 'front' ? 'cut' : 'common', target, solidTool, a.id) } catch (e) { throw new Error(`The solid does not trim this surface (${why(e)})`) }
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

surfaceOp<SurfaceExtendArgs>('surfaceExtend', 'Extend', 'try the other type, or a smaller distance', (a, h) => {
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
  /** what a corner needs to know about each strip: the edge's two ends, where they end up, and the way out */
  const info: StripInfo[] = []
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
    // (tested at the middle of the edge: its ends can touch other faces of the surface)
    const pm = v3(edge.pointAt(0.5))
    const dm = norm3(cross3(v3(face.normalAt(pm)), norm3(v3(edge.tangentAt(0.5)))))
    const away = (s: number) => measureDistanceBetween(face as never, makeVertex(add3(pm, mul3(dm, s * eps))) as never)
    const sign = away(1) >= away(-1) ? 1 : -1
    const out = dirs.map((d) => mul3(d, sign))
    const sections: Wire[] = [assembleWire([edge.clone() as Edge])]
    let far: Vec3[] = []
    const through = (q: Vec3[]): Edge => (line && q.every((_, k) => dist3(sub3(q[k], pts[k]), sub3(q[0], pts[0])) < 1e-9) ? makeLine(q[0], q[q.length - 1]) : makeBSplineApproximation(q, { tolerance: 1e-5, smoothing: null, degMax: 8 } as never))
    if (a.mode === 'tangent') {
      far = pts.map((p, k) => add3(p, mul3(out[k], a.distance)))
      sections.push(assembleWire([through(far)]))
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
      far = walk.map((w) => w[steps - 1])
    }
    const mk = new o.BRepOffsetAPI_ThruSections(false, a.mode === 'tangent', 1e-6)
    try {
      mk.SetMutableInput(false)
      sections.forEach((w) => mk.AddWire(w.wrapped))
      mk.Build()
      const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'Could not extend this edge')
      info.push({ shape, face, ends: [pts[0], pts[count - 1]], far: [far[0], far[count - 1]], out: [out[0], out[count - 1]], label: String(names.edges[ei]?.[0] ?? ei) })
    } finally { mk.delete() }
  }
  const tol = 1e-4 * Math.max(1, a.distance)
  const fills = cornerFills(info, a, tol)
  const strips = info.map((i) => {
    const faces = topoOf(i.shape as unknown as AnyShape).faces.map(() => [`${a.id}:ext:${i.label}`])
    return { shape: i.shape, faces: finalize(i.shape as unknown as AnyShape, faces, a.id, 'x') }
  })
  const parts = [src, ...strips, ...fills]
  const { out } = sewNamed(parts, tol, a.id)
  return send(h, a, out)
})

interface StripInfo {
  /** the strip; a reflex corner replaces it with the mitred strip */
  shape: Sh
  face: Face
  /** the edge's walked start and end, the far corners of the strip at each, and the way out at each */
  ends: [Vec3, Vec3]
  far: [Vec3, Vec3]
  out: [Vec3, Vec3]
  label: string
}

/** The edge of `shape` that runs between the two points (either way round), if any. */
function edgeBetween(shape: Sh, p: Vec3, q: Vec3): Edge | null {
  for (const e of topoOf(shape as unknown as AnyShape).edges) {
    const s = v3(e.startPoint), t = v3(e.endPoint)
    if ((dist3(s, p) < SNAP && dist3(t, q) < SNAP) || (dist3(s, q) < SNAP && dist3(t, p) < SNAP)) return e
  }
  return null
}

/**
 * A reflex corner (the surface wraps round it, as at the inside of an L): the two strips overlap there, so each is cut
 * along the mitre plane through the corner (the bisector of the two ways out, standing on the surface) and they meet on
 * one shared edge, like a picture frame. The planes' sides are picked from where each strip's other end is.
 */
function mitre(A: StripInfo, B: StripInfo, ea: 0 | 1, eb: 0 | 1, P: Vec3, a: SurfaceExtendArgs, o: ReturnType<typeof oc>) {
  const m = norm3(sub3(A.out[ea], B.out[eb]))
  const bis = norm3(add3(A.out[ea], B.out[eb]))
  const n = norm3(cross3(m, bis))
  const reach = 50 * (a.distance + Math.max(dist3(A.ends[0], A.ends[1]), dist3(B.ends[0], B.ends[1])))
  const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([x, y]) => add3(P, add3(mul3(bis, x * reach), mul3(n, y * reach))))
  const cut = (S: StripInfo, dir: Vec3) => {
    const slab = prismNamed(makePolygon(corners) as unknown as Sh, mul3(dir, reach))
    const com = new o.BRepAlgoAPI_Common(S.shape.wrapped, any(slab).wrapped)
    try {
      com.Build()
      S.shape = nonEmpty(cast(com.Shape()) as unknown as Sh, 'Could not mitre the corner between the extended edges')
    } finally { com.delete() }
  }
  cut(A, mul3(m, -1))
  cut(B, m)
}

/**
 * Fusion's corner: where two extended edges meet at a convex corner the two strips leave a notch between them, so a
 * patch closes it. Its four sides are the two strips' side edges at the corner (shared, so it sews on) and two new edges
 * out to the corner a parallelogram completes; a natural extension lays those on the surface the faces sit on, so a
 * cylinder or sphere corner stays on it. The patch is a plate fitted to the four sides, so it is C0 with both strips.
 * Corners that are flat (the strips already meet along one side edge) or reflex (the strips overlap) need no patch.
 */
function cornerFills(info: StripInfo[], a: SurfaceExtendArgs, tol: number): NShape[] {
  const o = oc()
  const fills: NShape[] = []
  const reach = Math.max(1e-3, 4 * tol)
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      for (const ea of [0, 1] as const) {
        for (const eb of [0, 1] as const) {
          const A = info[i], B = info[j]
          const P = A.ends[ea]
          if (dist3(P, B.ends[eb]) > SNAP) continue
          const PA = A.far[ea], PB = B.far[eb]
          if (dist3(PA, PB) < reach) continue
          // convex only: A's way out has to point away from B's edge and the other way round, or the strips overlap
          const toA = sub3(A.ends[1 - ea], P), toB = sub3(B.ends[1 - eb], P)
          const dA = dot3(A.out[ea], toB), dB = dot3(B.out[eb], toA)
          const eps = 1e-6 * Math.max(1, a.distance)
          if (dA > eps && dB > eps) { mitre(A, B, ea, eb, P, a, o); continue }
          if (dA >= 0 || dB >= 0) continue
          const sideA = edgeBetween(A.shape, P, PA), sideB = edgeBetween(B.shape, P, PB)
          if (!sideA || !sideB) throw new Error('Could not close the corner between the extended edges')
          // the corner point a parallelogram completes, and the rim curves out to it
          let onSurface = (q: Vec3): Vec3 => q
          if (a.mode === 'natural') {
            const surf = o.BRep_Tool.Surface(A.face.wrapped)
            onSurface = (q) => {
              const pp = new o.GeomAPI_ProjectPointOnSurf(pntOf(q), surf)
              if (!(pp.NbPoints() > 0)) throw new Error('Natural extension is not available for this surface: use Tangent')
              const r = pp.NearestPoint()
              return [r.X(), r.Y(), r.Z()]
            }
          }
          const PC = onSurface(sub3(add3(PA, PB), P))
          const rim = (from: Vec3, by: Vec3): Edge => {
            if (a.mode !== 'natural') return makeLine(from, PC)
            const n = 8
            const q: Vec3[] = []
            for (let k = 0; k <= n; k++) q.push(k === n ? PC : k === 0 ? from : onSurface(add3(from, mul3(by, k / n))))
            return makeBSplineApproximation(q, { tolerance: 1e-6, smoothing: null, degMax: 8 } as never)
          }
          const rimA = rim(PA, sub3(PB, P)), rimB = rim(PB, sub3(PA, P))
          const mk = new o.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9)
          try {
            for (const e of [sideA, sideB, rimA, rimB]) mk.Add(e.wrapped, o.GeomAbs_Shape.GeomAbs_C0, true)
            mk.Build()
            if (!mk.IsDone()) throw new Error('Could not close the corner between the extended edges')
            const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'Could not close the corner between the extended edges')
            const faces = topoOf(shape as unknown as AnyShape).faces.map(() => [`${a.id}:corner:${A.label}:${B.label}`])
            fills.push({ shape, faces: finalize(shape as unknown as AnyShape, faces, a.id, 'c') })
          } finally { mk.delete() }
        }
      }
    }
  }
  return fills
}

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

surfaceOp<SurfaceStitchArgs>('surfaceStitch', 'Stitch', 'try a larger tolerance', (a, h) => {
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

surfaceOp<SurfaceUnstitchArgs>('surfaceUnstitch', 'Unstitch', 'the body may be damaged', (a, h) => {
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

/** `s` offset along its face normals by `d` (positive: the way the faces point). */
function offsetNamed(s: NShape, d: number, fid: string, join: 'arc' | 'intersection' = 'arc'): NShape {
  const o = oc()
  const mk = new o.BRepOffsetAPI_MakeOffsetShape()
  try {
    mk.PerformByJoin(any(s).wrapped, d, 1e-4, o.BRepOffset_Mode.BRepOffset_Skin, false, false, join === 'arc' ? o.GeomAbs_JoinType.GeomAbs_Arc : o.GeomAbs_JoinType.GeomAbs_Intersection, false)
    if (!mk.IsDone()) throw new Error('OpenCascade could not offset the surface')
    const shape = nonEmpty(cast(mk.Shape()) as unknown as Sh, 'The offset is empty')
    return { shape, faces: finalize(shape as unknown as AnyShape, inherit(mk, [{ shape: any(s), faces: s.faces }], shape as unknown as AnyShape, { fid, genFace: 'off' }), fid) }
  } finally { mk.delete() }
}

/** The volume a closed shell encloses, signed: positive when its faces point outward, negative when they point inward. */
function signedVolume(shell: unknown): number {
  const o = oc()
  const props = new o.GProp_GProps()
  try {
    o.BRepGProp.VolumeProperties(shell, props, false, false, false)
    return props.Mass()
  } finally { props.delete() }
}

/**
 * A closed shell gets a hollow solid: the shell itself and its offset become the outer and inner walls. The side the
 * thickness grows to follows the faces (positive: the way they point; for a box of outward faces that is outward). With a
 * sharp-cornered shell the offset walls keep sharp corners where OpenCascade can do it, rounded otherwise.
 */
function thickenClosed(src: NShape, a: SurfaceThickenArgs): NShape {
  const o = oc()
  const t = Math.abs(a.distance)
  // the two walls, as offsets along the face normals: lo <= hi
  const [lo, hi] = a.sym ? [-t / 2, t / 2] : a.distance > 0 ? [0, t] : [-t, 0]
  const wall = (d: number): NShape => {
    if (d === 0) return src
    try { return offsetNamed(src, d, a.id, 'intersection') } catch { return offsetNamed(src, d, a.id, 'arc') }
  }
  const shellOf = (n: NShape): never => {
    const shells = Array.from(iterTopo(any(n).wrapped as never, 'shell'))
    if (shells.length !== 1) throw new Error('the offset is not a single closed shell')
    return shells[0] as never
  }
  const name = (n: NShape, d: number): NShape => (d === 0 ? n : { shape: n.shape, faces: n.faces.map((f) => (f.length ? [`${a.id}:off:${f[0]}`] : [])) })
  const wl = name(wall(lo), lo), wh = name(wall(hi), hi)
  const sl = shellOf(wl), sh = shellOf(wh)
  // the walls face the way of the source: an outward-facing source has its larger offset outside, an inward-facing one its smaller
  const faces = Math.sign(signedVolume(shellOf(src)))
  const outward = faces > 0
  // an offset past the shape's reach turns it inside out: it then faces the other way
  for (const w of [sl, sh]) if (Math.sign(signedVolume(w)) !== faces) throw new Error('the shape cannot be offset that far without folding over itself')
  const [outer, inner] = outward ? [{ n: wh, s: sh }, { n: wl, s: sl }] : [{ n: wl, s: sl }, { n: wh, s: sh }]
  // every point of a wall has to be at least its offset away from the source: closer means the offset ran into itself
  const srcFaces = topoOf(any(src)).faces
  for (const [w, d] of [[wl, lo], [wh, hi]] as const) {
    if (d === 0) continue
    const wt = topoOf(any(w))
    const probes: Vec3[] = wt.faces.flatMap((f) => [v3(f.pointOnSurface(0.5, 0.5)), v3(f.pointOnSurface(0.25, 0.25)), v3(f.pointOnSurface(0.75, 0.75))])
    for (const v of iterTopo(any(w).wrapped as never, 'vertex')) { const p = o.BRep_Tool.Pnt(v); probes.push([p.X(), p.Y(), p.Z()]) }
    for (const q of probes) if (distToFaces(q, srcFaces) < Math.abs(d) * (1 - 1e-2)) throw new Error('the offset wall runs into the surface itself')
  }
  const vo = Math.abs(signedVolume(outer.s)), vi = Math.abs(signedVolume(inner.s))
  if (!(vi < vo * (1 - 1e-6))) throw new Error('the inner wall does not fit inside the outer one')
  const fix = new o.ShapeFix_Solid()
  const mk = new o.BRepBuilderAPI_MakeSolid(fix.SolidFromShell(outer.s))
  try {
    // the inner shell is a cavity: its faces have to point into it, away from the material
    mk.Add(signedVolume(inner.s) > 0 ? cast((inner.s as { Reversed(): never }).Reversed()).wrapped : inner.s)
    if (!mk.IsDone()) throw new Error('the walls do not make a solid')
    const shape = cast(mk.Solid()) as unknown as Sh
    const rt = topoOf(shape as unknown as AnyShape)
    const find = indexer(rt.faces, rt.faceHashes)
    const claims: string[][] = rt.faces.map(() => [])
    for (const part of [outer.n, inner.n]) {
      topoOf(any(part)).faces.forEach((f, i) => {
        const j = find(f.wrapped as never)
        if (j >= 0) claims[j].push(...(part.faces[i] ?? []))
      })
    }
    const vol = measureVolume(shape as never)
    if (!(vol > 1e-9) || Math.abs(vol - (vo - vi)) > 1e-3 * vo) throw new Error('the walls do not make a valid solid')
    return { shape, faces: finalize(shape as unknown as AnyShape, claims, a.id) }
  } finally {
    fix.delete()
    mk.delete()
  }
}

surfaceOp<SurfaceThickenArgs>('surfaceThicken', 'Thicken', 'try a thinner thickness', (a, h) => {
  if (Math.abs(a.distance) < 1e-9) throw new Error('Thickness must not be zero')
  let src = h.getNamed(a.key)
  if (any(src).solids.length) throw new Error('Thicken works on surfaces; a solid already has volume')
  const open0 = openEdges(any(src))
  if (!open0.length) {
    try {
      return send(h, a, thickenClosed(src, a))
    } catch (e) {
      throw new Error(`Thickening this closed surface by ${Math.abs(a.distance)} mm is not possible (${why(e)}); try a thinner thickness`)
    }
  }
  const o = oc()
  const offset = (s: NShape, d: number): NShape => offsetNamed(s, d, a.id)
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
    throw new Error(`Thickening by ${Math.abs(a.distance)} mm is not possible here (${why(e)}); try a thinner thickness`)
  }
})

// ------------------------------------------------------------------------------------------------ delete face

export interface SurfaceDeleteFaceArgs { id: string; name: string; key: string; faces: number[] }

surfaceOp<SurfaceDeleteFaceArgs>('surfaceDeleteFace', 'Delete Face', 'the body may be damaged', (a, h) => {
  const src = h.getNamed(a.key)
  const faces = topoOf(any(src)).faces
  if (!a.faces.length) throw new Error('Select the faces to delete')
  if (a.faces.some((i) => !faces[i])) throw new Error('A face you picked no longer exists')
  const rest = faces.map((_, i) => i).filter((i) => !a.faces.includes(i))
  if (!rest.length) throw new Error('That would delete every face of the body')
  const { out } = sewNamed(rest.map((i) => facePart(src, i)), 1e-6, a.id)
  return send(h, a, out)
})

// ------------------------------------------------------------------------------------------------ replace face

export interface SurfaceReplaceFaceArgs {
  id: string
  name: string
  /** the solid */
  key: string
  /** the faces of the solid that move onto the target */
  faces: number[]
  /** what they move onto: a plane, a surface body, or faces of some body */
  target: TrimTool
}

const volume = (s: Sh | AnyShape) => { try { return Math.abs(measureVolume(any(s) as never)) } catch { return 0 } }

/** The prism of a face (or shape) along `v`, with the face it started from named `name`. */
function prismNamed(src: Sh, v: Vec3, name?: string, sides?: string): NShape {
  const o = oc()
  const vec = new Vector(v)
  const mk = new o.BRepPrimAPI_MakePrism(any(src).wrapped, vec.wrapped, false, true)
  try {
    const shape = cast(mk.Shape()) as unknown as Sh
    const topo = topoOf(shape as unknown as AnyShape)
    const claims: string[][] = topo.faces.map(() => [])
    if (name) {
      const j = indexer(topo.faces, topo.faceHashes)(mk.FirstShape() as never)
      if (j >= 0) claims[j].push(name)
    }
    if (sides) {
      // the walls the sweep builds along the edges of the face
      const find = indexer(topo.faces, topo.faceHashes)
      for (const e of (any(src) as unknown as { edges: Edge[] }).edges) eachInList(mk.Generated(e.wrapped as never) as never, (sh) => { const j = find(sh as never); if (j >= 0) claims[j].push(sides) })
    }
    return { shape, faces: claims }
  } finally { mk.delete(); vec.delete() }
}

/** A boolean that may come out empty (disjoint inputs): `null` then, instead of an error. */
function tryBool(op: 'fuse' | 'cut' | 'common', a: NShape, b: NShape, fid: string): NShape | null {
  let r: NShape
  try { r = boolNamed(op, a, b, fid) } catch { return null }
  return volume(r.shape) > 1e-9 ? r : null
}

const fuseAll = (parts: NShape[], fid: string): NShape => parts.slice(1).reduce((acc, p) => boolNamed('fuse', acc, p, fid), parts[0])

/** Distance from a point to the nearest of some faces. */
function distToFaces(p: Vec3, faces: Face[]): number {
  const vtx = makeVertex(p)
  let best = Infinity
  for (const f of faces) {
    const ex = new (oc().BRepExtrema_DistShapeShape)(vtx.wrapped, f.wrapped)
    try { if (ex.IsDone() && ex.NbSolution() > 0) best = Math.min(best, ex.Value()) } finally { ex.delete() }
  }
  return best
}

surfaceOp<SurfaceReplaceFaceArgs>('surfaceReplaceFace', 'Fit to Surface', 'the target may be too far from the faces or too tangled', (a, h) => {
  const src = h.getNamed(a.key)
  const solid = any(src)
  if (solid.solids.length !== 1) throw new Error('Fit to Surface needs a solid body: a surface has no inside to grow or cut')
  const faces = topoOf(solid).faces
  if (!a.faces.length) throw new Error('Select the faces to replace')
  if (a.faces.some((i) => !faces[i])) throw new Error('A face you picked no longer exists')
  const boundsOf = (s: AnyShape) => (s as unknown as { boundingBox: { bounds: [Vec3, Vec3] } }).boundingBox.bounds
  const sbb = boundsOf(solid)
  const sCentre = mul3(add3(sbb[0], sbb[1]), 0.5)
  const sDiag = dist3(sbb[0], sbb[1])

  // the target, as faces (a plane is made big enough for every face once that face's direction is known)
  const t = a.target
  let tFaces: Face[] = []
  let tCentre: Vec3 = sCentre, tDiag = 0
  if (t.kind !== 'plane') {
    const body = any(h.getNamed(t.key))
    if (t.kind === 'body' && body.solids.length) throw new Error('The target has to be a surface, a plane or faces: a solid body has no single surface to move onto')
    const all = topoOf(body).faces
    tFaces = t.kind === 'faces' ? t.faces.map((i) => all[i]).filter(Boolean) : all
    if (!tFaces.length || (t.kind === 'faces' && tFaces.length !== t.faces.length)) throw new Error('The target surface no longer exists')
    const tb = boundsOf(body)
    tCentre = mul3(add3(tb[0], tb[1]), 0.5)
    tDiag = dist3(tb[0], tb[1])
  } else {
    const n = norm3(t.normal)
    tCentre = sub3(sCentre, mul3(n, dot3(sub3(sCentre, t.origin), n)))
  }
  // far enough to span the solid, the target and the gap between them
  const L = 4 * (sDiag + tDiag) + 2 * dist3(sCentre, tCentre) + 10

  let cur: NShape = src
  // every normal is taken before the solid changes
  const dirs = a.faces.map((i) => norm3(v3(faces[i].normalAt(insidePoint(faces[i]) as never))))
  a.faces.forEach((fi, k) => {
    const d = dirs[k]
    const fc = faces[fi]
    let tf = tFaces
    if (t.kind === 'plane') {
      const n = norm3(t.normal)
      const nd = dot3(n, d)
      if (Math.abs(nd) < 1e-3) throw new Error('The plane runs along the face, so it never meets it: pick a plane that crosses the face')
      const fcen = v3(fc.center)
      const c = add3(fcen, mul3(d, dot3(sub3(t.origin, fcen), n) / nd))
      const half = (sDiag * 4 + 1) / Math.max(Math.abs(nd), 0.05)
      const u = norm3(cross3(n, Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]))
      const w = cross3(n, u)
      const corner = (s: number, q: number): Vec3 => add3(c, add3(mul3(u, s * half), mul3(w, q * half)))
      tf = [makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]) as unknown as Face]
    }
    const name = `${a.id}:replace`
    const SIDE = `${a.id}:tside`
    const sweepAll = (v: Vec3) => fuseAll(tf.map((x) => prismNamed(x as unknown as Sh, v, name, SIDE)), a.id)

    // the region the solid's walls allow: the column over the face when the walls run along its normal, otherwise the walls
    // are extended as planes (so a slanted wall carries straight on up to the target)
    const pF = insidePoint(fc)
    const nbrs: { n: Vec3; pe: Vec3; planar: boolean; along: boolean }[] = []
    const mine = new Set(fc.edges.map((e) => e.hashCode))
    faces.forEach((nf, j) => {
      if (j === fi) return
      const shared = nf.edges.find((e) => mine.has(e.hashCode))
      if (!shared) return
      const pe = v3(shared.pointAt(0.5))
      const n = norm3(v3(nf.normalAt(pe as never)))
      const planar = String(nf.geomType) === 'PLANE'
      const along = Math.abs(dot3(n, d)) < 1e-3 && (planar || Math.abs(dot3(norm3(v3(nf.normalAt(insidePoint(nf) as never))), d)) < 1e-3)
      nbrs.push({ n, pe, planar, along })
    })
    let wallFull: NShape, wallUp: NShape
    if (nbrs.every((x) => x.along)) {
      wallFull = prismNamed(fc.clone().translate(-d[0] * L, -d[1] * L, -d[2] * L) as unknown as Sh, mul3(d, 2 * L))
      wallUp = prismNamed(fc.clone() as unknown as Sh, mul3(d, L))
    } else if (String(fc.geomType) === 'PLANE' && nbrs.every((x) => x.planar)) {
      const H = 2 * L
      const halfSpace = (p: Vec3, s: Vec3): NShape => {
        const c = sub3(sCentre, mul3(s, dot3(sub3(sCentre, p), s)))
        const u = norm3(cross3(s, Math.abs(s[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]))
        const w = cross3(s, u)
        const corner = (x: number, y: number): Vec3 => add3(c, add3(mul3(u, x * H), mul3(w, y * H)))
        return prismNamed(makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]) as unknown as Sh, mul3(s, H))
      }
      const hs = nbrs.filter((x) => Math.abs(dot3(x.n, d)) < 1 - 1e-9).map((x) => halfSpace(x.pe, dot3(sub3(pF, x.pe), x.n) <= 0 ? mul3(x.n, -1) : x.n))
      wallFull = hs.reduce((acc, x) => boolNamed('common', acc, x, a.id))
      wallUp = boolNamed('common', wallFull, halfSpace(pF, d), a.id)
    } else {
      throw new Error('The faces next to the one you picked are curved and lean away from its direction, so they cannot be carried on to the new surface: pick a face whose neighbours are flat (or run straight along it)')
    }
    // the target has to reach over the whole region: a wall of its sweep that stands free inside the region means it falls short
    const rim = topoOf(any(wallFull)).faces
    const rimUp = topoOf(any(wallUp)).faces
    const short = (r: NShape, against: Face[]) => {
      const rt = topoOf(any(r))
      return rt.faces.some((f, i) => (r.faces[i] ?? []).some((nm) => nm.includes(':tside')) && area(f as unknown as Sh) > 1e-6 && distToFaces(insidePoint(f), against) > 1e-3 * Math.max(1, sDiag))
    }
    const TOO_SMALL = "The target does not cover the face: seen along the face's normal it has to reach over the whole face and the walls that carry on from it (extend the surface, or use a plane)"
    // where the target is below the face the solid is cut back to it, where it is above the solid grows up to it
    const aboveT = sweepAll(mul3(d, 3 * L)), belowT = sweepAll(mul3(d, -3 * L))
    // first of all it has to lie over the face itself
    const column = prismNamed(fc.clone().translate(-d[0] * L, -d[1] * L, -d[2] * L) as unknown as Sh, mul3(d, 2 * L))
    const overlap = (t: NShape) => { const r = tryBool('common', t, column, a.id); return r ? volume(r.shape) : 0 }
    const over = overlap(aboveT) + overlap(belowT)
    if (!(over > (1 - 1e-5) * volume(column.shape))) throw new Error(TOO_SMALL)
    const cut = tryBool('common', aboveT, wallFull, a.id)
    if (cut) {
      const hit = tryBool('common', cur, cut, a.id)
      if (hit && short(hit, rim)) throw new Error(TOO_SMALL)
      if (hit) cur = boolNamed('cut', cur, cut, a.id)
    }
    const grow = tryBool('common', belowT, wallUp, a.id)
    if (grow) {
      if (short(grow, rimUp)) throw new Error(TOO_SMALL)
      cur = boolNamed('fuse', cur, grow, a.id)
    }
  })

  const out = any(cur)
  if (out.solids.length !== 1) throw new Error(out.solids.length ? 'The target would split the solid into separate pieces' : 'Nothing is left of the solid')
  if (!(volume(out) > 1e-9) || !new (oc().BRepCheck_Analyzer)(out.wrapped, true, false).IsValid()) throw new Error('The result is not a valid solid: try a target that is not so close to the edges of the face')
  if (openEdges(out).length) throw new Error('The result has gaps: the target has to cover the whole face')
  return send(h, a, cur)
})
