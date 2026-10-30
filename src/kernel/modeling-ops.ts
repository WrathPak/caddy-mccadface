/**
 * Worker ops for the modeling tools: patterns and mirror, holes, direct face edits (heal / offset / replace / split / draft)
 * and the geometry queries the construction tools need. Every result keeps persistent face names (see naming.ts).
 */
import {
  cast, getOC, makeAx1, makeCylinder, makePolygon, makeSphere, makeVertex, measureDistanceBetween, measureVolume, isShape3D, DEG2RAD,
  type AnyShape, type Face,
} from 'replicad'
import { registerOp, type OpHelpers } from './store'
import { topoOf, type Shape } from './occ'
import { boolNamed, finalize, indexer, inherit, rootNames, type NShape } from './naming'
import { applyPoint, axisAngle, cross3, dot3, norm3, sub3, add3, mul3, rotationBetween, type Xf } from './xform'
import type { Vec3 } from './types'
import { tapCutter as threadCutter, boreDia, type ThreadSpec } from './threads'

type Sh = Shape
const any = (s: NShape) => s.shape as unknown as AnyShape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oc = () => getOC() as any
const vol = (s: { shape: Sh } | Sh) => {
  const sh = 'shape' in s ? s.shape : s
  try { return Math.abs(measureVolume(sh as never)) } catch { return 0 }
}

// ------------------------------------------------------------------------------------------------ transforms with names

/** Transformed copy of a shape (the input is left alone: replicad consumes the receiver of translate / rotate / mirror). */
export function xformShape(s: Sh, x: Xf): Sh {
  const c = s.clone() as unknown as Sh
  if (x.t === 'mirror') return (c as unknown as { mirror(n: Vec3, o: Vec3): Sh }).mirror(norm3(x.normal), x.origin)
  const { axis, deg } = axisAngle(x.R)
  let out: Sh = c
  if (Math.abs(deg) > 1e-9) out = out.rotate(deg, [0, 0, 0], axis) as Sh
  if (Math.hypot(...x.p) > 1e-12) out = out.translate(x.p[0], x.p[1], x.p[2]) as Sh
  return out
}

const centerOf = (f: Face): Vec3 => { const c = f.center; return [c.x, c.y, c.z] }

/** A transformed copy keeping the face names (suffixed with `tag` so copies never share a name). */
export function xformNamed(src: NShape, x: Xf, tag: string): NShape {
  const shape = xformShape(src.shape, x)
  const a = topoOf(any(src)).faces, b = topoOf(shape as unknown as AnyShape).faces
  const want = a.map((f) => applyPoint(x, centerOf(f)))
  const scale = Math.max(1, ...want.map((w) => Math.hypot(...w)))
  const near = (i: number, j: number) => Math.hypot(...sub3(want[i], centerOf(b[j]))) < 1e-5 * scale
  let map: number[] | null = a.length === b.length && a.every((_, i) => near(i, i)) ? a.map((_, i) => i) : null
  if (!map) {
    // topology order changed: match every source face to the closest result face
    const used = new Set<number>()
    map = a.map((_, i) => {
      let best = -1, bd = Infinity
      b.forEach((_f, j) => { if (used.has(j)) return; const d = Math.hypot(...sub3(want[i], centerOf(b[j]))); if (d < bd) { bd = d; best = j } })
      if (best >= 0) used.add(best)
      return best
    })
  }
  const faces: string[][] = b.map(() => [])
  map.forEach((j, i) => { if (j >= 0 && src.faces[i]?.length) faces[j] = tag ? src.faces[i].map((n) => `${n}@${tag}`) : [...src.faces[i]] })
  return { shape, faces }
}

/** Frame (rotation + translation) taking +Z to `dir` with the local origin at `origin`. */
export function frameXf(origin: Vec3, dir: Vec3): Xf {
  return { t: 'rigid', R: rotationBetween([0, 0, 1], dir), p: origin }
}

// ------------------------------------------------------------------------------------------------ patterns and mirror

export interface PatternArgs {
  id: string
  name: string
  fid: string
  /** the body the instances are folded into */
  current: string
  /** features mode: the body before and after the repeated feature(s) */
  before?: string
  after?: string
  /** faces mode: the faces of `current` whose feature is repeated */
  faces?: number[]
  xforms: Xf[]
}

/** The material a feature added / removed, as solids: after - before and before - after. */
function deltaOf(before: NShape, after: NShape, fid: string): { add: NShape | null; remove: NShape | null } {
  const tool = (a: NShape, b: NShape) => {
    try {
      const r = boolNamed('cut', a, b, fid)
      return vol(r) > 1e-6 ? r : null
    } catch { return null }
  }
  return { add: tool(after, before), remove: tool(before, after) }
}

function applyInstances(cur: NShape, delta: { add: NShape | null; remove: NShape | null }, xforms: Xf[], fid: string): NShape {
  let r = cur
  xforms.forEach((x, k) => {
    const tag = `${fid}.${k + 1}`
    if (delta.add) r = boolNamed('fuse', r, xformNamed(delta.add, x, tag), fid)
    if (delta.remove) r = boolNamed('cut', r, xformNamed(delta.remove, x, tag), fid)
  })
  return r
}

registerOp<PatternArgs>('patternApply', (a, h) => {
  const cur = h.getNamed(a.current)
  let delta: { add: NShape | null; remove: NShape | null }
  if (a.faces?.length) {
    const healed = healFaces(cur, a.faces, a.fid)
    delta = deltaOf(healed, cur, a.fid)
  } else {
    if (!a.before || !a.after) throw new Error('Nothing to repeat')
    delta = deltaOf(h.getNamed(a.before), h.getNamed(a.after), a.fid)
  }
  if (!delta.add && !delta.remove) throw new Error('The selection does not add or remove any material, so there is nothing to repeat')
  const r = applyInstances(cur, delta, a.xforms, a.fid)
  return h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))
})

export interface CopyBodyArgs { id: string; name: string; key: string; xform: Xf; tag: string }
/** A transformed copy of a whole body (the Pattern / Mirror "bodies" modes). */
registerOp<CopyBodyArgs>('copyBody', (a, h) => {
  const r = xformNamed(h.getNamed(a.key), a.xform, a.tag)
  return h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))
})

/** Join a list of bodies into one (used to fold mirrored / patterned body copies back into the original). */
registerOp<{ id: string; name: string; keys: string[]; fid: string }>('joinBodies', (a, h) => {
  const parts = a.keys.map((k) => h.getNamed(k))
  let r = parts[0]
  for (const p of parts.slice(1)) r = boolNamed('fuse', r, p, a.fid)
  return h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))
})

// ------------------------------------------------------------------------------------------------ region edits

interface Geo {
  type: 'plane' | 'cylinder' | 'sphere' | 'other'
  /** plane: a point on it; cylinder: a point on the axis; sphere: the centre */
  origin: Vec3
  /** plane: outward face normal; cylinder: axis direction */
  dir: Vec3
  radius: number
  /** outward normal of the face at its centre */
  normal: Vec3
}

function geoOf(face: Face): Geo {
  const c = centerOf(face)
  const n = face.normalAt(face.pointOnSurface(0.5, 0.5)) as unknown as { x: number; y: number; z: number }
  const normal = norm3([n.x, n.y, n.z])
  const t = face.geomType as string
  if (t === 'PLANE') {
    const pn = face.normalAt() as unknown as { x: number; y: number; z: number }
    return { type: 'plane', origin: c, dir: norm3([pn.x, pn.y, pn.z]), radius: 0, normal: norm3([pn.x, pn.y, pn.z]) }
  }
  const ad = new (oc().BRepAdaptor_Surface)(face.wrapped, true)
  try {
    if (t === 'CYLINDRE') {
      const ax = ad.Cylinder().Axis()
      const l = ax.Location(), d = ax.Direction()
      const o: Vec3 = [l.X(), l.Y(), l.Z()]
      const res: Geo = { type: 'cylinder', origin: o, dir: norm3([d.X(), d.Y(), d.Z()]), radius: ad.Cylinder().Radius(), normal }
      l.delete(); d.delete(); ax.delete()
      return res
    }
    if (t === 'SPHERE') {
      const s = ad.Sphere()
      const l = s.Location()
      const res: Geo = { type: 'sphere', origin: [l.X(), l.Y(), l.Z()], dir: [0, 0, 1], radius: s.Radius(), normal }
      l.delete()
      return res
    }
  } finally {
    ad.delete()
  }
  return { type: 'other', origin: c, dir: normal, radius: 0, normal }
}

/** Bounding box of a shape: [min, max]. */
function boundsOf(s: Sh): [Vec3, Vec3] {
  const b = (s as unknown as { boundingBox: { bounds: [Vec3, Vec3] } }).boundingBox.bounds
  return [b[0], b[1]]
}

interface Work { c: Vec3; half: number }
const workOf = (s: Sh): Work => {
  const [mn, mx] = boundsOf(s)
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2])
  return { c: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], half: Math.max(diag, 1) * 2 }
}

/** A stand-in for a surface: `split` goes to the splitter, `surf` is the face cells must touch, `on` tells whether a face of the result lies on it. */
interface SurfTool { split: Sh; surf: Sh; on(f: Face): boolean }

const scaleOf = (w: Work) => Math.max(1, w.half)

function planeTool(origin: Vec3, n: Vec3, w: Work): SurfTool {
  const L = w.half * 2
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const u = norm3(cross3(n, ref)), v = cross3(n, u)
  const at = (a: number, b: number): Vec3 => add3(origin, add3(mul3(u, a * L), mul3(v, b * L)))
  const face = makePolygon([at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)]) as unknown as Sh
  const tol = 1e-6 * scaleOf(w)
  return {
    split: face, surf: face,
    on: (f) => { const g = geoOf(f); return g.type === 'plane' && Math.abs(dot3(g.dir, n)) > 1 - 1e-6 && Math.abs(dot3(sub3(g.origin, origin), n)) < tol },
  }
}

/** The surface a face lies on, grown by `grow` along its outward normal, as an oversized tool. */
function surfaceTool(face: Face, w: Work, grow = 0): SurfTool {
  const g = geoOf(face)
  const L = w.half * 2
  if (g.type === 'plane') return planeTool(add3(g.origin, mul3(g.dir, grow)), g.dir, w)
  const c = centerOf(face)
  const tol = 1e-6 * scaleOf(w)
  if (g.type === 'cylinder') {
    const rel = sub3(c, g.origin)
    const radial = norm3(sub3(rel, mul3(g.dir, dot3(rel, g.dir))))
    // for a convex face (normal pointing away from the axis) growing makes it wider
    const r = g.radius + (dot3(g.normal, radial) > 0 ? grow : -grow)
    if (r < 1e-6) throw new Error('The offset is larger than the radius of the face')
    const solid = makeCylinder(r, 2 * L, sub3(g.origin, mul3(g.dir, L)), g.dir) as unknown as Sh
    const lateral = (solid as unknown as { faces: Face[] }).faces.find((f) => String(f.geomType) === 'CYLINDRE')!
    return {
      split: solid, surf: lateral as unknown as Sh,
      on: (f) => {
        const q = geoOf(f)
        if (q.type !== 'cylinder' || Math.abs(q.radius - r) > tol || Math.abs(dot3(q.dir, g.dir)) < 1 - 1e-6) return false
        const d = sub3(q.origin, g.origin)
        return Math.hypot(...sub3(d, mul3(g.dir, dot3(d, g.dir)))) < tol
      },
    }
  }
  if (g.type === 'sphere') {
    const r = g.radius + (dot3(g.normal, sub3(c, g.origin)) > 0 ? grow : -grow)
    if (r < 1e-6) throw new Error('The offset is larger than the radius of the face')
    const solid = (makeSphere(r) as unknown as Sh).translate(g.origin[0], g.origin[1], g.origin[2]) as Sh
    return {
      split: solid, surf: (solid as unknown as { faces: Sh[] }).faces[0],
      on: (f) => { const q = geoOf(f); return q.type === 'sphere' && Math.abs(q.radius - r) < tol && Math.hypot(...sub3(q.origin, g.origin)) < tol },
    }
  }
  throw new Error(`Faces of this kind (${String(face.geomType).toLowerCase()}) cannot be extended or offset`)
}

const edgeKeys = (f: Face) => new Set(f.edges.map((e) => e.hashCode))

/** Faces that share an edge with the faces `S` but are not in it. */
function neighborsOf(faces: Face[], S: number[]): number[] {
  const inS = new Set(S)
  const sEdges = new Set<number>()
  S.forEach((i) => edgeKeys(faces[i]).forEach((h) => sEdges.add(h)))
  const out: number[] = []
  faces.forEach((f, i) => {
    if (inS.has(i)) return
    for (const h of edgeKeys(f)) if (sEdges.has(h)) { out.push(i); return }
  })
  return out
}

interface Cell { shape: Sh; vol: number; inside: boolean; bounded: boolean }

/** Split an oversized block around `body` by `tools` and classify the cells (inside the body or not, closed or running off to infinity). */
function cellsOf(body: Sh, tools: Sh[]): Cell[] {
  const w = workOf(body)
  const o = oc()
  const half = w.half
  const block = (makePolygonBox(w.c, half)) as Sh
  const sp = new o.BRepAlgoAPI_Splitter()
  const args = new o.NCollection_List_TopoDS_Shape()
  const tl = new o.NCollection_List_TopoDS_Shape()
  try {
    args.Append(block.wrapped)
    for (const t of tools) tl.Append(t.wrapped)
    sp.SetArguments(args)
    sp.SetTools(tl)
    sp.Build(new o.Message_ProgressRange())
    if (sp.HasErrors()) throw new Error('Could not work out the region to change')
    const res = cast(sp.Shape()) as unknown as { solids: Sh[] }
    const lo = sub3(w.c, [half, half, half]), hi = add3(w.c, [half, half, half])
    return res.solids.map((s) => {
      const v = vol(s)
      const [mn, mx] = boundsOf(s)
      const bounded = [0, 1, 2].every((k) => mn[k] > lo[k] + 1e-4 && mx[k] < hi[k] - 1e-4)
      let inside = false
      if (bounded) {
        try { inside = vol(s.clone().intersect(body.clone() as never) as unknown as Sh) > v * 0.5 } catch { inside = false }
      }
      return { shape: s, vol: v, inside, bounded }
    })
  } finally {
    sp.delete(); args.delete(); tl.delete()
  }
}

function makePolygonBox(c: Vec3, half: number): Sh {
  // an axis-aligned cube of side 2*half around c
  const o = oc()
  const mk = new o.BRepPrimAPI_MakeBox(half * 2, half * 2, half * 2)
  try {
    const s = cast(mk.Shape()) as unknown as Sh
    return s.translate(c[0] - half, c[1] - half, c[2] - half) as Sh
  } finally { mk.delete() }
}

const touches = (a: Sh, b: Sh, tol = 1e-4) => {
  try { return measureDistanceBetween(a as never, b as never) < tol } catch { return false }
}

/** Fold cells into the body: cells that lie inside the body are cut away, the others are added. */
function applyCells(cur: NShape, cells: Cell[], fid: string): NShape {
  let r = cur
  for (const c of cells) {
    const part: NShape = { shape: c.shape, faces: topoOf(c.shape as unknown as AnyShape).faces.map(() => []) }
    r = boolNamed(c.inside ? 'cut' : 'fuse', r, part, fid)
  }
  return r
}

/** Index of the face named like `names` (any alias), else the one closest to `c`. */
export function findFace(s: NShape, names: string[], c?: Vec3): number {
  for (let i = 0; i < s.faces.length; i++) if (s.faces[i].some((n) => names.includes(n))) return i
  if (!c) return -1
  const f = topoOf(any(s)).faces
  let best = -1, bd = Infinity
  f.forEach((x, i) => { const d = Math.hypot(...sub3(centerOf(x), c)); if (d < bd) { bd = d; best = i } })
  return best
}

/** Delete faces and heal: the neighbouring faces are extended until they close the gap (fillets, holes, bosses, pockets). */
export function healFaces(body: NShape, S: number[], fid: string): NShape {
  const faces = topoOf(any(body)).faces
  if (S.some((i) => !faces[i])) throw new Error('Some of the selected faces no longer exist')
  const nb = neighborsOf(faces, S)
  if (!nb.length) throw new Error('These faces have no neighbours to heal against')
  const w = workOf(body.shape)
  const tools: Sh[] = [...S.map((i) => faces[i] as unknown as Sh), ...nb.map((i) => surfaceTool(faces[i], w).split)]
  const cells = cellsOf(body.shape, tools).filter((c) => c.bounded && c.vol > 1e-6 && S.some((i) => touches(c.shape, faces[i] as unknown as Sh)))
  if (!cells.length) throw new Error('These faces cannot be deleted without leaving a hole: the faces around them do not close the gap')
  return applyCells(body, cells, fid)
}

/** Replace the surface of face `si` by `target`, keeping the neighbours attached. The moved face keeps its name. */
function moveFace(body: NShape, si: number, target: SurfTool, fid: string): NShape {
  const faces = topoOf(any(body)).faces
  const nb = neighborsOf(faces, [si])
  const w = workOf(body.shape)
  const tools: Sh[] = [faces[si] as unknown as Sh, target.split, ...nb.map((i) => surfaceTool(faces[i], w).split)]
  const cells = cellsOf(body.shape, tools).filter((c) => c.bounded && c.vol > 1e-6 && touches(c.shape, faces[si] as unknown as Sh) && touches(c.shape, target.surf))
  if (!cells.length) throw new Error('The face cannot move there: the faces around it do not close the gap')
  const r = applyCells(body, cells, fid)
  // the faces of the result that now lie on the target are the moved face: give them its name back
  const rf = topoOf(any(r)).faces
  const claims = r.faces.map((n, i) => (target.on(rf[i]) && (!n.length || n[0].startsWith(`${fid}:new:`)) ? [...body.faces[si]] : n))
  return { shape: r.shape, faces: finalize(any(r), claims, fid) }
}

export interface OffsetFaceArgs { id: string; name: string; key: string; faces: { index: number; names: string[] }[]; distance: number; fid: string }
registerOp<OffsetFaceArgs>('offsetFaces', (a, h) => {
  let cur = h.getNamed(a.key)
  for (const f of a.faces) {
    const faces = topoOf(any(cur)).faces
    const i = findFace(cur, f.names, centerOf(faces[Math.min(f.index, faces.length - 1)]))
    if (i < 0) throw new Error('A selected face no longer exists')
    const w = workOf(cur.shape)
    cur = moveFace(cur, i, surfaceTool(faces[i], w, a.distance), a.fid)
  }
  return h.sendBody(h.bodyFromShape(a.id, a.name, cur.shape, cur.faces))
})

export interface DeleteFaceArgs { id: string; name: string; key: string; faces: { index: number; names: string[] }[]; fid: string }
registerOp<DeleteFaceArgs>('deleteFaces', (a, h) => {
  const cur = h.getNamed(a.key)
  const faces = topoOf(any(cur)).faces
  const idx = a.faces.map((f) => findFace(cur, f.names, centerOf(faces[Math.min(f.index, faces.length - 1)])))
  if (idx.some((i) => i < 0)) throw new Error('A selected face no longer exists')
  const r = healFaces(cur, [...new Set(idx)], a.fid)
  return h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))
})

export type SurfaceTarget =
  | { kind: 'plane'; origin: Vec3; normal: Vec3 }
  | { kind: 'face'; key: string; index: number; names: string[] }
export interface ReplaceFaceArgs { id: string; name: string; key: string; faces: { index: number; names: string[] }[]; target: SurfaceTarget; fid: string }
registerOp<ReplaceFaceArgs>('replaceFaces', (a, h) => {
  let cur = h.getNamed(a.key)
  for (const f of a.faces) {
    const faces = topoOf(any(cur)).faces
    const i = findFace(cur, f.names, centerOf(faces[Math.min(f.index, faces.length - 1)]))
    if (i < 0) throw new Error('A selected face no longer exists')
    const w = workOf(cur.shape)
    let tool: SurfTool
    if (a.target.kind === 'plane') {
      tool = planeTool(a.target.origin, norm3(a.target.normal), w)
    } else {
      const tn = h.getNamed(a.target.key)
      const tf = topoOf(any(tn)).faces
      const ti = findFace(tn, a.target.names, centerOf(tf[Math.min(a.target.index, tf.length - 1)]))
      if (ti < 0) throw new Error('The target face no longer exists')
      tool = surfaceTool(tf[ti], w)
    }
    cur = moveFace(cur, i, tool, a.fid)
  }
  return h.sendBody(h.bodyFromShape(a.id, a.name, cur.shape, cur.faces))
})

// ------------------------------------------------------------------------------------------------ split

export type SplitTool =
  | { kind: 'plane'; origin: Vec3; normal: Vec3 }
  | { kind: 'face'; key: string; index: number; names: string[] }
  | { kind: 'body'; key: string }

function toolShape(t: SplitTool, h: OpHelpers, w: Work): Sh {
  if (t.kind === 'plane') return planeTool(t.origin, norm3(t.normal), w).split
  if (t.kind === 'body') return h.getBrep(t.key) as unknown as Sh
  const tn = h.getNamed(t.key)
  const tf = topoOf(any(tn)).faces
  const ti = findFace(tn, t.names, centerOf(tf[Math.min(t.index, tf.length - 1)]))
  if (ti < 0) throw new Error('The splitting face no longer exists')
  return surfaceTool(tf[ti], w).split
}

type Splitter = { Modified(s: never): never; Generated(s: never): never; IsDeleted(s: never): boolean; delete(): void }

function runSplitter(arg: Sh, tools: Sh[]): { shape: Sh; builder: Splitter } {
  const o = oc()
  const sp = new o.BRepAlgoAPI_Splitter()
  const args = new o.NCollection_List_TopoDS_Shape()
  const tl = new o.NCollection_List_TopoDS_Shape()
  args.Append(arg.wrapped)
  for (const t of tools) tl.Append(t.wrapped)
  sp.SetArguments(args)
  sp.SetTools(tl)
  sp.Build(new o.Message_ProgressRange())
  args.delete(); tl.delete()
  if (sp.HasErrors()) { sp.delete(); throw new Error('Could not split here') }
  return { shape: cast(sp.Shape()) as unknown as Sh, builder: sp }
}

export interface SplitBodyArgs { id: string; name: string; key: string; tool: SplitTool; fid: string }
/** Split a body into pieces. The pieces are returned in a stable order (by position) as bodies `id`, `id.1`, `id.2`... */
registerOp<SplitBodyArgs>('splitBody', (a, h) => {
  const src = h.getNamed(a.key)
  const w = workOf(src.shape)
  const { shape, builder } = runSplitter(src.shape, [toolShape(a.tool, h, w)])
  try {
    const solids = (shape as unknown as { solids: Sh[] }).solids
    if (solids.length < 2) throw new Error('The tool does not cut through the body')
    const claims = inherit(builder as never, [src], shape as unknown as AnyShape, { fid: a.fid })
    const all = topoOf(shape as unknown as AnyShape)
    const find = indexer(all.faces, all.faceHashes)
    const pieces = solids.map((s) => {
      const c = (s as unknown as { boundingBox: { center: Vec3 } }).boundingBox.center
      return { s, key: [Math.round(c[0] * 1000), Math.round(c[1] * 1000), Math.round(c[2] * 1000)] }
    }).sort((p, q) => p.key[0] - q.key[0] || p.key[1] - q.key[1] || p.key[2] - q.key[2])
    const bodies = pieces.map((p, n) => {
      const ft = topoOf(p.s as unknown as AnyShape)
      const names = ft.faces.map((f) => { const j = find(f.wrapped as never); return j >= 0 ? claims[j] : [] })
      const id = n === 0 ? a.id : `${a.fid}.${a.id}.${n}`
      return h.bodyFromShape(id, n === 0 ? a.name : `${a.name} ${n + 1}`, p.s, finalize(p.s as unknown as AnyShape, names, a.fid, 'piece' + n))
    })
    return h.sendBodies(bodies)
  } finally { builder.delete() }
})

export interface SplitFaceArgs { id: string; name: string; key: string; faces: { index: number; names: string[] }[]; tool: SplitTool; fid: string }
/** Split faces along a tool without splitting the body: the tool's intersection with the faces is imprinted on the solid. */
registerOp<SplitFaceArgs>('splitFaces', (a, h) => {
  const src = h.getNamed(a.key)
  const faces = topoOf(any(src)).faces
  const w = workOf(src.shape)
  const tool = toolShape(a.tool, h, w)
  const o = oc()
  const edges: Sh[] = []
  for (const f of a.faces) {
    const i = findFace(src, f.names, centerOf(faces[Math.min(f.index, faces.length - 1)]))
    if (i < 0) throw new Error('A selected face no longer exists')
    const sec = new o.BRepAlgoAPI_Section(faces[i].wrapped, tool.wrapped, true)
    sec.Build(new o.Message_ProgressRange())
    const res = cast(sec.Shape()) as unknown as { edges: Sh[] }
    sec.delete()
    edges.push(...res.edges)
  }
  if (!edges.length) throw new Error('The tool does not touch the selected faces')
  const { shape, builder } = runSplitter(src.shape, edges)
  try {
    const solids = (shape as unknown as { solids: Sh[] }).solids
    if (solids.length !== 1) throw new Error('The tool must stay on the face and not cut the body')
    const claims = inherit(builder as never, [src], shape as unknown as AnyShape, { fid: a.fid })
    const out = finalize(shape as unknown as AnyShape, claims, a.fid)
    if (out.length === src.faces.length) throw new Error('The tool does not divide the selected faces')
    return h.sendBody(h.bodyFromShape(a.id, a.name, shape, out))
  } finally { builder.delete() }
})

// ------------------------------------------------------------------------------------------------ draft

export interface DraftArgs {
  id: string; name: string; key: string
  faces: { index: number; names: string[] }[]
  /** pull direction and the neutral plane (the faces tilt about their intersection with it) */
  dir: Vec3
  neutral: Vec3
  angle: number
  fid: string
}
registerOp<DraftArgs>('draftFaces', (a, h) => {
  const src = h.getNamed(a.key)
  const faces = topoOf(any(src)).faces
  const o = oc()
  const dir = norm3(a.dir)
  const builder = new o.BRepOffsetAPI_DraftAngle(src.shape.wrapped)
  const pl = new o.gp_Pln(new o.gp_Pnt(a.neutral[0], a.neutral[1], a.neutral[2]), new o.gp_Dir(dir[0], dir[1], dir[2]))
  const d = new o.gp_Dir(dir[0], dir[1], dir[2])
  try {
    for (const f of a.faces) {
      const i = findFace(src, f.names, centerOf(faces[Math.min(f.index, faces.length - 1)]))
      if (i < 0) throw new Error('A selected face no longer exists')
      const g = geoOf(faces[i])
      if (g.type === 'plane' && Math.abs(dot3(g.normal, dir)) > 1 - 1e-9) throw new Error('A face that faces along the pull direction cannot be drafted')
      builder.Add(faces[i].wrapped, d, a.angle * DEG2RAD, pl, false)
      if (!builder.AddDone()) throw new Error('OpenCascade could not draft one of the faces at this angle; try a smaller angle')
    }
    builder.Build(new o.Message_ProgressRange())
    if (!builder.IsDone()) throw new Error('OpenCascade could not draft these faces at this angle; try a smaller angle')
    const shape = cast(builder.Shape()) as unknown as Sh
    if (!isShape3D(shape as never) || vol(shape) < 1e-9) throw new Error('The draft produced an empty shape')
    // the draft builder reports its result through ModifiedShape(): give inherit() the history interface it expects
    const lists: { delete(): void }[] = []
    const history = {
      Modified: (s: never) => { const l = new o.NCollection_List_TopoDS_Shape(); l.Append(builder.ModifiedShape(s)); lists.push(l); return l },
      Generated: () => { const l = new o.NCollection_List_TopoDS_Shape(); lists.push(l); return l },
      IsDeleted: () => false,
    }
    const claims = inherit(history as never, [src], shape as unknown as AnyShape, { fid: a.fid })
    lists.forEach((l) => l.delete())
    return h.sendBody(h.bodyFromShape(a.id, a.name, shape, finalize(shape as unknown as AnyShape, claims, a.fid)))
  } finally {
    pl.delete(); d.delete(); builder.delete()
  }
})

// ------------------------------------------------------------------------------------------------ holes

export interface HoleSpec {
  kind: 'simple' | 'cbore' | 'csink'
  dia: number
  /** null: through the whole body */
  depth: number | null
  /** cbore */
  cbDia?: number
  cbDepth?: number
  /** csink */
  cskDia?: number
  /** included angle of the countersink, degrees */
  cskAngle?: number
  /** included angle of the drill point at the bottom of a blind hole, degrees (0: flat bottom) */
  tip: number
  /** modeled internal thread, cut over `length` from the top */
  thread?: ThreadSpec & { length: number }
}
export interface HolePlace { k: string; origin: Vec3; dir: Vec3 }
export interface HoleArgs { id: string; name: string; key: string; holes: HolePlace[]; spec: HoleSpec; fid: string; /** return the volume the holes would remove instead of cutting it (for the live preview) */ toolOnly?: boolean }

interface Seg2 { a: [number, number]; b: [number, number]; role: string }

/** Cross-section (radius, depth below the surface) of a hole, as named segments, closed along the axis. */
export function holeProfile(spec: HoleSpec, through: number): Seg2[] {
  const r = spec.dia / 2
  const ext = 0.5 // the tool starts a little above the surface so the cut is clean
  const depth = spec.depth ?? through
  const tipH = spec.depth !== null && spec.tip > 0 ? r / Math.tan((spec.tip * DEG2RAD) / 2) : 0
  const poly: { p: [number, number]; role: string }[] = [{ p: [0, ext], role: 'axis' }]
  if (spec.kind === 'cbore' && spec.cbDia && spec.cbDepth) {
    if (spec.cbDepth >= depth) throw new Error('The counterbore must be shallower than the hole')
    const cr = spec.cbDia / 2
    poly.push({ p: [cr, ext], role: 'topcap' }, { p: [cr, -spec.cbDepth], role: 'cbwall' }, { p: [r, -spec.cbDepth], role: 'cbfloor' })
  } else if (spec.kind === 'csink' && spec.cskDia) {
    const cr = spec.cskDia / 2
    const half = ((spec.cskAngle ?? 90) * DEG2RAD) / 2
    const h = (cr - r) / Math.tan(half)
    if (h >= depth) throw new Error('The countersink is deeper than the hole')
    poly.push({ p: [cr + ext * Math.tan(half), ext], role: 'topcap' }, { p: [r, -h], role: 'csk' })
  } else poly.push({ p: [r, ext], role: 'topcap' })
  poly.push({ p: [r, -depth], role: 'wall' }, { p: [0, -depth - tipH], role: tipH > 0 ? 'tip' : 'floor' })
  const out: Seg2[] = []
  for (let i = 1; i < poly.length; i++) out.push({ a: poly[i - 1].p, b: poly[i].p, role: poly[i].role })
  out.push({ a: poly[poly.length - 1].p, b: poly[0].p, role: 'axis' })
  return out
}

/** The solid of one hole (axis +Z, opening at z = 0), faces named after their role. */
function holeTool(spec: HoleSpec, through: number, fid: string, k: string): NShape {
  const segs = holeProfile(spec, through)
  const pts = segs.map((s) => s.a)
  const face = makePolygon(pts.map(([r, z]) => [r, 0, z] as Vec3))
  const o = oc()
  const ax = makeAx1([0, 0, 0], [0, 0, 1])
  const mk = new o.BRepPrimAPI_MakeRevol(face.wrapped, ax, 2 * Math.PI, false)
  try {
    const shape = cast(mk.Shape()) as unknown as Sh
    const topo = topoOf(shape as unknown as AnyShape)
    const claims: string[][] = topo.faces.map(() => [])
    for (const s of segs) {
      if (s.role === 'axis' || s.role === 'topcap' || s.role === 'top' || s.role === 'cbtop' || s.role === 'csktop') continue
      const m: Vec3 = [(s.a[0] + s.b[0]) / 2, 0, (s.a[1] + s.b[1]) / 2]
      if (m[0] < 1e-9 && s.role !== 'floor') continue
      const v = makeVertex(m)
      let best = -1, bd = Infinity
      topo.faces.forEach((f, i) => {
        const d = measureDistanceBetween(f as never, v as never)
        if (d < bd - 1e-9) { bd = d; best = i }
      })
      if (best >= 0 && bd < 1e-6) claims[best].push(`${fid}:hole${k}:${s.role}`)
    }
    return { shape, faces: finalize(shape as unknown as AnyShape, claims, fid, 'hole' + k) }
  } finally {
    ax.delete(); mk.delete()
  }
}

registerOp<HoleArgs>('holes', (a, h) => {
  let cur = h.getNamed(a.key)
  const [mn, mx] = boundsOf(cur.shape)
  const through = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * 1.2 + 1
  if (a.spec.depth !== null && a.spec.depth <= 0) throw new Error('The hole depth must be greater than zero')
  if (a.spec.dia <= 0) throw new Error('The hole diameter must be greater than zero')
  if (a.spec.kind === 'cbore' && (!a.spec.cbDia || a.spec.cbDia <= a.spec.dia)) throw new Error('The counterbore must be wider than the hole')
  if (a.spec.kind === 'csink' && (!a.spec.cskDia || a.spec.cskDia <= a.spec.dia)) throw new Error('The countersink must be wider than the hole')
  const t = a.spec.thread
  // with a modeled thread the bore is a hair under the minor diameter, so it never shares a surface with the cutter
  const spec: HoleSpec = t ? { ...a.spec, dia: boreDia(t) } : a.spec
  if (a.toolOnly) {
    // the drills only, joined: shown as the material that will go
    let all: NShape | null = null
    for (const p of a.holes) {
      const tool = xformNamed(holeTool(spec, through, a.fid, p.k), frameXf(p.origin, norm3(p.dir)), '')
      all = all ? boolNamed('fuse', all, tool, a.fid) : tool
    }
    // only what the drills take out of the body: a through-all drill is far longer than the part, and its tail would show as a
    // cylinder sticking out of the other side
    try { all = boolNamed('common', cur, all!, a.fid) } catch { /* the drills miss the body: show them whole */ }
    return h.sendBody(h.bodyFromShape(a.id, a.name, all!.shape, all!.faces))
  }
  for (const p of a.holes) {
    const frame = frameXf(p.origin, norm3(p.dir))
    if (t) {
      const len = Math.min(t.length, a.spec.depth ?? t.length)
      // the cutter is built along +Z from 0 to len + 0.5; shift it so it spans the hole (z from -len to 0.5)
      const solid = (threadCutter(t, len + 0.5) as unknown as Sh).translate(0, 0, -len) as Sh
      const named = { shape: solid, faces: rootNames(solid as unknown as AnyShape, a.fid, `thread${p.k}`) }
      cur = boolNamed('cut', cur, xformNamed(named, frame, `t${p.k}`), a.fid)
    }
    cur = boolNamed('cut', cur, xformNamed(holeTool(spec, through, a.fid, p.k), frame, ''), a.fid)
  }
  return h.sendBody(h.bodyFromShape(a.id, a.name, cur.shape, cur.faces))
})

// ------------------------------------------------------------------------------------------------ queries

export interface FaceGeom { type: Geo['type']; origin: Vec3; dir: Vec3; radius: number; normal: Vec3; center: Vec3 }
/** Geometry of faces: plane / cylinder / sphere parameters (axis, radius), used by the construction tools. */
registerOp<{ key: string; faces: number[] }>('faceGeom', (a, h) => {
  const faces = topoOf(h.getBrep(a.key) as unknown as AnyShape).faces
  return a.faces.map((i): FaceGeom | null => {
    const f = faces[i]
    if (!f) return null
    const g = geoOf(f)
    return { type: g.type, origin: g.origin, dir: g.dir, radius: g.radius, normal: g.normal, center: centerOf(f) }
  })
})

export interface EdgeGeom { type: 'line' | 'circle' | 'other'; origin: Vec3; dir: Vec3; radius: number; start: Vec3; end: Vec3; mid: Vec3 }
/** Geometry of edges: straight lines and circles (centre, axis, radius). */
registerOp<{ key: string; edges: number[] }>('edgeGeom', (a, h) => {
  const edges = topoOf(h.getBrep(a.key) as unknown as AnyShape).edges
  return a.edges.map((i): EdgeGeom | null => {
    const e = edges[i]
    if (!e) return null
    const s = e.startPoint, t = e.endPoint, m = e.pointAt(0.5)
    const start: Vec3 = [s.x, s.y, s.z], end: Vec3 = [t.x, t.y, t.z], mid: Vec3 = [m.x, m.y, m.z]
    const ct = String(e.geomType)
    if (ct === 'LINE') return { type: 'line', origin: start, dir: norm3(sub3(end, start)), radius: 0, start, end, mid }
    if (ct === 'CIRCLE') {
      const ad = new (oc().BRepAdaptor_Curve)(e.wrapped)
      try {
        const c = ad.Circle()
        const ax = c.Axis()
        const l = ax.Location(), d = ax.Direction()
        const res: EdgeGeom = { type: 'circle', origin: [l.X(), l.Y(), l.Z()], dir: norm3([d.X(), d.Y(), d.Z()]), radius: c.Radius(), start, end, mid }
        l.delete(); d.delete(); ax.delete()
        return res
      } finally { ad.delete() }
    }
    return { type: 'other', origin: mid, dir: [0, 0, 1], radius: 0, start, end, mid }
  })
})


/** Centre of the region a feature changed (what it added or removed), used to anchor pattern markers. */
registerOp<{ before: string; after: string; fid: string }>('deltaCenter', (a, h) => {
  const d = deltaOf(h.getNamed(a.before), h.getNamed(a.after), a.fid)
  const parts = [d.add, d.remove].filter((x): x is NShape => !!x)
  if (!parts.length) return null
  const bs = parts.map((p) => boundsOf(p.shape))
  const mn = [0, 1, 2].map((k) => Math.min(...bs.map((b) => b[0][k])))
  const mx = [0, 1, 2].map((k) => Math.max(...bs.map((b) => b[1][k])))
  return [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2] as Vec3
})
