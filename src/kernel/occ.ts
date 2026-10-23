/** OpenCascade (replicad) wrapper. Worker-only. WASM is bundled via ?url, never fetched from a CDN. */
import initOC from 'replicad-opencascadejs'
import ocWasm from 'replicad-opencascadejs/wasm?url'
import { exportSTEP, importSTEP, makeBaseBox, setOC, type AnyShape, type Edge, type Face } from 'replicad'
import type { MeshData, Vec3 } from './types'

let ready: Promise<void> | null = null
export function initOcc() {
  return (ready ??= (async () => {
    const oc = await initOC({ locateFile: () => ocWasm })
    setOC(oc as never)
  })())
}

export type Shape = AnyShape & {
  fuse(o: AnyShape): AnyShape
  cut(o: AnyShape): AnyShape
  intersect(o: AnyShape): AnyShape
  translate(x: number, y: number, z: number): AnyShape
  rotate(angle: number, pos?: Vec3, dir?: Vec3): AnyShape
  scale(s: number, c?: Vec3): AnyShape
  mesh(o?: { tolerance?: number; angularTolerance?: number }): {
    triangles: number[]; vertices: number[]; normals: number[]; faceGroups: { start: number; count: number; faceId: number }[]
  }
  meshEdges(o?: { tolerance?: number; angularTolerance?: number }): { lines: number[]; edgeGroups: { start: number; count: number; edgeId: number }[] }
}

export function box(size: Vec3, pos: Vec3): Shape {
  return (makeBaseBox(size[0], size[1], size[2]) as unknown as Shape).translate(pos[0], pos[1], pos[2]) as Shape
}

/**
 * The topology of a B-rep as ordered face / edge lists plus their OCC shape hashes.
 *
 * THIS is the single source of truth for face / edge indices: `MeshData.faceIds` / `edgeIds`, selections in the
 * viewport, `FaceRef.index` / `EdgeRef.index` and every worker op (extrude from a face, fillet / chamfer edges,
 * projection) address `topoOf(shape).faces[i]` / `.edges[i]`. The tessellator reports each triangle group under the
 * face hash and each edge polyline under the edge hash; `tessellate` maps hash -> index through this table instead of
 * trusting that the mesh groups come out in topology order.
 */
export interface Topo {
  faces: Face[]
  edges: Edge[]
  faceHashes: number[]
  edgeHashes: number[]
}
const topoCache = new WeakMap<object, Topo>()
export function topoOf(shape: AnyShape): Topo {
  let t = topoCache.get(shape)
  if (!t) {
    const faces = shape.faces, edges = shape.edges
    t = { faces, edges, faceHashes: faces.map((f) => f.hashCode), edgeHashes: edges.map((e) => e.hashCode) }
    topoCache.set(shape, t)
  }
  return t
}

/**
 * Resolves group hashes to topology indices. Hash collisions (two different faces with one hash) are resolved by
 * consuming the candidates in order, so the result is still a bijection onto the topology list.
 */
function indexResolver(hashes: number[]) {
  const byHash = new Map<number, number[]>()
  hashes.forEach((h, i) => (byHash.get(h) ?? byHash.set(h, []).get(h)!).push(i))
  return (hash: number): number => {
    const c = byHash.get(hash)
    if (!c || !c.length) throw new Error(`Tessellation reported a shape (hash ${hash}) that is not in the B-rep topology`)
    return c.length > 1 ? c.shift()! : c[0]
  }
}

/** Tessellate a B-rep into a MeshData with per-triangle B-rep face indices and per-segment B-rep edge indices. */
export function tessellate(shape: Shape, tolerance = 0.05, angularTolerance = 0.2): MeshData {
  const topo = topoOf(shape)
  const m = shape.mesh({ tolerance, angularTolerance })
  const e = shape.meshEdges({ tolerance, angularTolerance })
  const indices = Uint32Array.from(m.triangles)
  const faceIds = new Uint32Array(indices.length / 3)
  const fSum = m.faceGroups.reduce((n, g) => n + g.count, 0)
  const fu = fSum === indices.length ? 3 : 1 // group units: indices (3) or triangles (1)
  const faceOf = indexResolver(topo.faceHashes)
  for (const g of m.faceGroups) {
    const idx = faceOf(g.faceId)
    const from = g.start / fu
    const n = g.count / fu
    for (let t = from; t < from + n; t++) faceIds[t] = idx
  }
  const lines = Float32Array.from(e.lines)
  const edgeIds = new Uint32Array(lines.length / 6)
  const eSum = e.edgeGroups.reduce((n, g) => n + g.count, 0)
  const eu = eSum * 3 === lines.length ? 1 : 3 // group units: vertices (1) or floats (3)
  const edgeOf = indexResolver(topo.edgeHashes)
  for (const g of e.edgeGroups) {
    const idx = edgeOf(g.edgeId)
    const from = g.start / eu / 2, n = g.count / eu / 2
    for (let s = from; s < from + n; s++) edgeIds[s] = idx
  }
  return {
    positions: Float32Array.from(m.vertices),
    normals: Float32Array.from(m.normals),
    indices,
    faceIds,
    edges: lines,
    edgeIds,
    faceCount: topo.faces.length,
    edgeCount: topo.edges.length,
    faceHashes: Uint32Array.from(topo.faceHashes),
    edgeHashes: Uint32Array.from(topo.edgeHashes),
  }
}

export async function readStep(bytes: ArrayBuffer): Promise<Shape> {
  return (await importSTEP(new Blob([bytes]))) as unknown as Shape
}

export async function writeStep(shapes: { shape: Shape; name: string }[]): Promise<ArrayBuffer> {
  const blob = exportSTEP(shapes.map((s) => ({ shape: s.shape as AnyShape, name: s.name })))
  return blob.arrayBuffer()
}
