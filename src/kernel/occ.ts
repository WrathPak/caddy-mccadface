/** OpenCascade (replicad) wrapper. Worker-only. WASM is bundled via ?url, never fetched from a CDN. */
import initOC from 'replicad-opencascadejs'
import ocWasm from 'replicad-opencascadejs/wasm?url'
import { exportSTEP, importSTEP, makeBaseBox, setOC, type AnyShape } from 'replicad'
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

/** Tessellate a B-rep into a MeshData with per-triangle face ids and per-segment edge ids. */
export function tessellate(shape: Shape, tolerance = 0.05, angularTolerance = 0.2): MeshData {
  const m = shape.mesh({ tolerance, angularTolerance })
  const e = shape.meshEdges({ tolerance, angularTolerance })
  const indices = Uint32Array.from(m.triangles)
  const faceIds = new Uint32Array(indices.length / 3)
  const fSum = m.faceGroups.reduce((n, g) => n + g.count, 0)
  const fu = fSum === indices.length ? 3 : 1 // group units: indices (3) or triangles (1)
  m.faceGroups.forEach((g, gi) => {
    const from = g.start / fu
    const n = g.count / fu
    for (let t = from; t < from + n; t++) faceIds[t] = gi
  })
  const lines = Float32Array.from(e.lines)
  const edgeIds = new Uint32Array(lines.length / 6)
  const eSum = e.edgeGroups.reduce((n, g) => n + g.count, 0)
  const eu = eSum * 3 === lines.length ? 1 : 3 // group units: vertices (1) or floats (3)
  e.edgeGroups.forEach((g, gi) => {
    const from = g.start / eu / 2, n = g.count / eu / 2
    for (let s = from; s < from + n; s++) edgeIds[s] = gi
  })
  return {
    positions: Float32Array.from(m.vertices),
    normals: Float32Array.from(m.normals),
    indices,
    faceIds,
    edges: lines,
    edgeIds,
  }
}

export async function readStep(bytes: ArrayBuffer): Promise<Shape> {
  return (await importSTEP(new Blob([bytes]))) as unknown as Shape
}

export async function writeStep(shapes: { shape: Shape; name: string }[]): Promise<ArrayBuffer> {
  const blob = exportSTEP(shapes.map((s) => ({ shape: s.shape as AnyShape, name: s.name })))
  return blob.arrayBuffer()
}
