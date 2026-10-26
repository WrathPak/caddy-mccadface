/**
 * Persistent topological naming (worker only).
 *
 * Every B-rep face carries a stable name that is derived from where it came from, not from where it sits in the
 * topology list. Names are composed down the operation history (OCC `Modified()` / `Generated()` / `IsDeleted()` of the
 * builder that made the result), so the name of "the top face of the box" is still that name after the box is resized,
 * filleted, extruded onto, and so on:
 *
 *   box face                       `${feature}:zmax`, `${feature}:xmin`, ...
 *   extrude side / caps            `${feature}:side:${sketch entity id}`, `${feature}:start|end:${profile id}`
 *   revolve                        `${feature}:rev:${sketch entity id}`, `${feature}:start|end:${profile id}`
 *   fillet / chamfer face          `${feature}:fillet:${edge name}`
 *   shell inner wall               `${feature}:inner:${name of the face it mirrors}`
 *   a face that survives an op     the same name (a merged face keeps all the merged names; the first is the primary)
 *   a face split by an op          `${name}~0`, `${name}~1`, ... (ordered by a geometric key) that still carry `${name}` as alias
 *   anything else                  `${feature}:new:${k}` / `${feature}:face:${k}` (k ordered by a geometric key)
 *
 * Edges are named from the faces they join (`A&B`, with every alias combination), so a fillet on "the edge between the
 * top face and the front face" stays on it without any edge history. Vertices are not named (no feature references them).
 *
 * A face name list is `string[]`: the primary name first, then aliases. All lists are indexed like `topoOf(shape).faces`.
 */
import { HASH_CODE_MAX, Vertex, cast, getOC, isShape3D, iterTopo, type AnyShape } from 'replicad'
import { topoOf, type Shape } from './occ'

export interface Names { faces: string[][]; edges: string[][]; /** vertices, named from the faces that meet there */ vertices: string[][]; /** xyz of every vertex, 3 numbers each */ vertexPos: number[] }
/** A shape together with the face names of its topology. */
export interface NShape { shape: Shape; faces: string[][] }

// minimal views of the OCC classes used here
interface OCList { Size(): number; First(): never; RemoveFirst(): void; delete(): void }
interface Raw { IsSame(o: Raw): boolean }
const hashOf = (raw: Raw): number => (getOC() as unknown as { ReplicadShapeHasher: { HashCode(s: Raw, max: number): number } }).ReplicadShapeHasher.HashCode(raw, HASH_CODE_MAX)
interface History {
  Modified(s: never): OCList
  Generated(s: never): OCList
  IsDeleted(s: never): boolean
}

/** Calls `cb` for every shape of an OCC list (the list is copied: draining it would clear the builder's own). */
export function eachInList(list: OCList, cb: (s: Raw) => void) {
  const oc = getOC() as unknown as { NCollection_List_TopoDS_Shape: new (l: OCList) => OCList }
  const copy = new oc.NCollection_List_TopoDS_Shape(list)
  try {
    while (copy.Size() > 0) {
      cb(copy.First() as unknown as Raw)
      copy.RemoveFirst()
    }
  } finally {
    copy.delete()
  }
}

/** Index lookup of a raw OCC sub-shape in a topology list (by hash, confirmed with IsSame). */
export function indexer(items: { wrapped: unknown }[], hashes: number[]) {
  const by = new Map<number, number[]>()
  hashes.forEach((h, i) => (by.get(h) ?? by.set(h, []).get(h)!).push(i))
  return (raw: Raw): number => {
    const c = by.get(hashOf(raw))
    if (!c) return -1
    for (const i of c) if ((items[i].wrapped as Raw).IsSame(raw)) return i
    return -1
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
/** Deterministic geometric ordering key of a face: centre, then area-ish extent. */
function faceKeys(shape: AnyShape): number[][] {
  return topoOf(shape).faces.map((f, i) => {
    const c = f.center
    return [r3(c.x), r3(c.y), r3(c.z), i]
  })
}

/**
 * Turn raw claims (names inherited through the history, [] for faces nobody claimed) into final names: unclaimed faces
 * get `${fid}:${tag}:${k}`, and a primary name shared by several faces becomes `${name}~${k}` (the shared name stays as alias).
 */
export function finalize(shape: AnyShape, claims: string[][], fid: string, tag = 'new'): string[][] {
  const keys = faceKeys(shape)
  const out = claims.map((c) => [...new Set(c)])
  const order = out.map((_, i) => i).sort((a, b) => cmp(keys[a], keys[b]))
  let k = 0
  for (const i of order) if (!out[i].length) out[i] = [`${fid}:${tag}:${k++}`]
  const groups = new Map<string, number[]>()
  out.forEach((n, i) => (groups.get(n[0]) ?? groups.set(n[0], []).get(n[0])!).push(i))
  for (const [p, idx] of groups) {
    if (idx.length < 2) continue
    idx.sort((a, b) => cmp(keys[a], keys[b]))
    idx.forEach((i, j) => (out[i] = [`${p}~${j}`, p, ...out[i].slice(1).filter((x) => x !== p)]))
  }
  return out
}

/** Names inherited by the faces of `result` from `sources` through a builder's history. Unclaimed faces get []. */
export function inherit(
  h: History,
  sources: { shape: AnyShape; faces: string[][] }[],
  result: AnyShape,
  opts: { fid: string; /** tag for faces `Generated()` from faces (e.g. shell walls); default none */ genFace?: string } = { fid: '' },
): string[][] {
  const rt = topoOf(result)
  const find = indexer(rt.faces, rt.faceHashes)
  const claims: string[][] = rt.faces.map(() => [])
  sources.forEach((src) => {
    const st = topoOf(src.shape)
    st.faces.forEach((f, i) => {
      const names = src.faces[i]
      if (!names?.length) return
      const raw = f.wrapped as unknown as never
      if (h.IsDeleted(raw)) return
      const hit: number[] = []
      eachInList(h.Modified(raw), (s) => { const j = find(s); if (j >= 0) hit.push(j) })
      if (!hit.length) { const j = find(raw as unknown as Raw); if (j >= 0) hit.push(j) }
      for (const j of hit) claims[j].push(...names)
      if (opts.genFace) eachInList(h.Generated(raw), (s) => { const j = find(s); if (j >= 0) claims[j].push(`${opts.fid}:${opts.genFace}:${names[0]}`) })
    })
  })
  return claims
}

/**
 * The open boundary of a shape: edges that bound exactly one face and are neither a seam (a cylinder's cut line) nor a
 * degenerate point edge. A closed shell has none.
 */
export function openEdges(shape: AnyShape): import('replicad').Edge[] {
  const topo = topoOf(shape)
  const find = indexer(topo.edges, topo.edgeHashes)
  const bt = (getOC() as unknown as { BRep_Tool: { IsClosed(e: unknown, f: unknown): boolean; Degenerated(e: unknown): boolean } }).BRep_Tool
  const owners = new Map<number, number[]>()
  topo.faces.forEach((f, fi) => {
    for (const e of f.edges) {
      const j = find(e.wrapped as unknown as Raw)
      if (j >= 0) owners.set(j, [...(owners.get(j) ?? []), fi])
    }
  })
  return topo.edges.filter((e, j) => {
    const fs = owners.get(j) ?? []
    return fs.length === 1 && !bt.Degenerated(e.wrapped) && !bt.IsClosed(e.wrapped, topo.faces[fs[0]].wrapped)
  })
}

/** Edge names derived from the faces an edge joins (all alias combinations; primary first). */
export function deriveEdgeNames(shape: AnyShape, faceNames: string[][]): string[][] {
  const topo = topoOf(shape)
  const find = indexer(topo.edges, topo.edgeHashes)
  const adj: number[][] = topo.edges.map(() => [])
  topo.faces.forEach((f, fi) => {
    for (const e of f.edges) {
      const ei = find(e.wrapped as unknown as Raw)
      if (ei >= 0 && !adj[ei].includes(fi)) adj[ei].push(fi)
    }
  })
  return adj.map((fs, ei) => {
    if (!fs.length) return [`free:${ei}`]
    const lists = fs.map((f) => faceNames[f] ?? [`?${f}`]).slice(0, 2)
    let combos: string[][] = [[]]
    for (const l of lists) combos = combos.flatMap((c) => l.slice(0, 4).map((n) => [...c, n]))
    const names = combos.map((c) => (c.length === 1 ? `seam(${c[0]})` : [...c].sort().join('&')))
    return [...new Set(names)]
  })
}

/**
 * Vertex names: the faces meeting at the vertex, e.g. `f1:xmax&f1:ymax&f1:zmax` (all alias combinations, primary first).
 * Also returns the vertex positions (xyz triples) so refs can carry a signature.
 */
export function deriveVertexNames(shape: AnyShape, faceNames: string[][]): { names: string[][]; pos: number[] } {
  const topo = topoOf(shape)
  const verts = Array.from(iterTopo((shape as unknown as { wrapped: unknown }).wrapped as never, 'vertex')) as unknown as Raw[]
  const find = indexer(verts.map((v) => ({ wrapped: v })), verts.map((v) => hashOf(v)))
  const adj: number[][] = verts.map(() => [])
  topo.faces.forEach((f, fi) => {
    for (const v of iterTopo((f as unknown as { wrapped: unknown }).wrapped as never, 'vertex') as Iterable<Raw>) {
      const vi = find(v)
      if (vi >= 0 && !adj[vi].includes(fi)) adj[vi].push(fi)
    }
  })
  const pos: number[] = []
  const names = verts.map((v, vi) => {
    pos.push(...new Vertex(v as never).asTuple())
    const lists = adj[vi].map((f) => faceNames[f]?.slice(0, 3) ?? [`?${f}`]).slice(0, 4)
    if (!lists.length) return [`free:${vi}`]
    let combos: string[][] = [[]]
    for (const l of lists) combos = combos.flatMap((c) => l.map((n) => [...c, n])).slice(0, 12)
    return [...new Set(combos.map((c) => [...new Set(c)].sort().join('&')))]
  })
  return { names, pos }
}

export function namesOf(shape: AnyShape, faces: string[][]): Names {
  const v = deriveVertexNames(shape, faces)
  return { faces, edges: deriveEdgeNames(shape, faces), vertices: v.names, vertexPos: v.pos }
}

/** Root names for a freshly imported / otherwise anonymous shape. */
export const rootNames = (shape: AnyShape, fid: string, tag = 'face'): string[][] => finalize(shape, topoOf(shape).faces.map(() => []), fid, tag)

/** Box-like primitives: name faces by the axis direction they face (`xmin`, `xmax`, `ymin`, ... ). */
export function boxNames(shape: AnyShape, fid: string): string[][] {
  const topo = topoOf(shape)
  const claims = topo.faces.map((f) => {
    const n = f.normalAt()
    const ax = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)]
    const k = ax.indexOf(Math.max(...ax))
    const v = [n.x, n.y, n.z][k]
    return [`${fid}:${'xyz'[k]}${v < 0 ? 'min' : 'max'}`]
  })
  return finalize(shape, claims, fid)
}

/** Same topology after a rigid / uniform-scale transform: names carry over by position in the topology list. */
export function carryNames(from: AnyShape, names: string[][], to: AnyShape, fid: string): string[][] {
  const a = topoOf(from).faces, b = topoOf(to).faces
  const ok = a.length === b.length && a.every((f, i) => f.geomType === b[i].geomType)
  return ok ? names.map((n) => [...n]) : rootNames(to, fid)
}

// ---------------------------------------------------------------- builders with history

type Builder = History & { Build(): void; Shape(): never; SimplifyResult?(a: boolean, b: boolean, c: number): void; delete(): void }

/** Run a BOP (fuse / cut / common) with history and return the result with inherited names. */
export function boolNamed(op: 'fuse' | 'cut' | 'common', a: NShape, b: NShape, fid: string): NShape {
  const oc = getOC() as unknown as Record<string, new (x: unknown, y: unknown) => Builder>
  const ctor = op === 'fuse' ? oc.BRepAlgoAPI_Fuse : op === 'cut' ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common
  const builder = new ctor(a.shape.wrapped, b.shape.wrapped)
  try {
    builder.Build()
    builder.SimplifyResult!(true, true, 0.001)
    const shape = cast(builder.Shape()) as unknown as Shape
    if (!isShape3D(shape as never)) throw new Error(`Could not ${op} as a 3d shape`)
    const claims = inherit(builder, [a, b], shape as AnyShape, { fid })
    return { shape, faces: finalize(shape as AnyShape, claims, fid) }
  } finally {
    builder.delete()
  }
}

/** Fuse a list of named solids left to right. */
export function fuseNamed(parts: NShape[], fid: string): NShape {
  return parts.slice(1).reduce((acc, p) => boolNamed('fuse', acc, p, fid), parts[0])
}

/** Fillet / chamfer of the given edges (indices into the input topology) with history. */
export function edgeModNamed(src: NShape, srcEdgeNames: string[][], edges: number[], size: number, mode: 'fillet' | 'chamfer', fid: string): NShape {
  const oc = getOC() as unknown as Record<string, new (...a: unknown[]) => Builder & { Add(...a: unknown[]): void }> & { ChFi3d_FilletShape: { ChFi3d_Rational: unknown } }
  const topo = topoOf(src.shape as AnyShape)
  const builder = mode === 'fillet' ? new oc.BRepFilletAPI_MakeFillet(src.shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational) : new oc.BRepFilletAPI_MakeChamfer(src.shape.wrapped)
  try {
    for (const i of edges) builder.Add(size, topo.edges[i].wrapped)
    builder.Build()
    const shape = cast(builder.Shape()) as unknown as Shape
    if (!isShape3D(shape as never)) throw new Error(`Could not ${mode} as a 3d shape`)
    const claims = inherit(builder, [src], shape as AnyShape, { fid })
    // the face a fillet / chamfer builds along an edge is `Generated` from that edge
    const rt = topoOf(shape as AnyShape)
    const find = indexer(rt.faces, rt.faceHashes)
    for (const i of edges) eachInList(builder.Generated(topo.edges[i].wrapped as never), (s) => { const j = find(s); if (j >= 0) claims[j].push(`${fid}:${mode}:${srcEdgeNames[i]?.[0] ?? i}`) })
    return { shape, faces: finalize(shape as AnyShape, claims, fid) }
  } finally {
    builder.delete()
  }
}

/** Hollow a solid by removing the given faces (indices into its topology); `offset` is the signed OCC offset. */
export function shellNamed(src: NShape, remove: number[], offset: number, tolerance: number, fid: string): NShape {
  const oc = getOC() as unknown as {
    NCollection_List_TopoDS_Shape: new () => OCList & { Append(s: unknown): void }
    BRepOffsetAPI_MakeThickSolid: new () => Builder & { MakeThickSolidByJoin(...a: unknown[]): void }
    BRepOffset_Mode: { BRepOffset_Skin: unknown }
    GeomAbs_JoinType: { GeomAbs_Arc: unknown }
  }
  const topo = topoOf(src.shape as AnyShape)
  const list = new oc.NCollection_List_TopoDS_Shape()
  const builder = new oc.BRepOffsetAPI_MakeThickSolid()
  try {
    for (const i of remove) list.Append(topo.faces[i].wrapped)
    builder.MakeThickSolidByJoin(src.shape.wrapped, list, offset, tolerance, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false)
    const shape = cast(builder.Shape()) as unknown as Shape
    if (!isShape3D(shape as never)) throw new Error('Could not shell as a 3d shape')
    const claims = inherit(builder, [src], shape as AnyShape, { fid, genFace: 'inner' })
    return { shape, faces: finalize(shape as AnyShape, claims, fid) }
  } finally {
    list.delete()
    builder.delete()
  }
}
