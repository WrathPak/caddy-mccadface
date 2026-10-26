/**
 * Stateless compute API: pure functions on typed arrays. They run in the compute pool's workers (see pool.ts) so heavy,
 * independent jobs (parsing a 150 MB STL, decimating a mesh, a mesh boolean) never touch the main thread or the kernel
 * worker that owns the B-rep handles. Nothing here keeps state between calls, so any pool worker can take any job.
 */
import * as Comlink from 'comlink'
import { parse3mfFast, type RawMesh } from '@/io/threemfFast'
import { parseStlSoup, type MeshSource } from '@/io/stlStream'
import { meshBoolean as manifoldBoolean, type BoolOp } from './mesh'
import { DEFAULT_CREASE_DEG, meshDisplayAuto, weld } from './meshutil'
import { buildLod } from './bigmesh'
import { withBvh } from './bvhBuild'
import type { MeshData, MeshLod, TopoMesh } from './types'

export interface ImportedPart {
  name: string
  /** welded triangles, for the kernel that owns the body */
  topo: TopoMesh
  /** what the viewport draws */
  display: MeshData
}

export interface ImportArgs { source: MeshSource; format: 'stl' | '3mf'; scale: number; creaseDeg?: number }

const buffersOf = (m: MeshData): ArrayBuffer[] =>
  [...[m.positions, m.normals, m.indices, m.faceIds, m.edges, m.edgeIds, m.faceHashes, m.edgeHashes, m.lod?.positions, m.lod?.normals, m.lod?.indices, m.bvh?.indirect]
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => a.buffer as ArrayBuffer), ...(m.bvh?.roots ?? [])]

/** Parse an STL or 3MF, weld it and build its display data. */
export async function importMesh(a: ImportArgs): Promise<ImportedPart[]> {
  let raws: RawMesh[]
  if (a.format === 'stl') raws = [{ name: 'Mesh', positions: await parseStlSoup(a.source) }]
  else {
    const bytes = a.source instanceof Uint8Array ? a.source : new Uint8Array(await a.source.arrayBuffer())
    raws = parse3mfFast(bytes)
  }
  return raws.map((r) => {
    const p = r.positions
    if (a.scale !== 1) for (let k = 0; k < p.length; k++) p[k] *= a.scale
    const topo = weld(p, r.indices)
    if (!topo.indices.length) throw new Error('The file has no usable triangles')
    return { name: r.name, topo, display: withBvh(meshDisplayAuto(topo, a.creaseDeg ?? DEFAULT_CREASE_DEG)) }
  })
}

export const computeApi = {
  async importMesh(a: ImportArgs): Promise<ImportedPart[]> {
    const parts = await importMesh(a)
    return Comlink.transfer(parts, parts.flatMap((p) => [p.topo.positions.buffer as ArrayBuffer, p.topo.indices.buffer as ArrayBuffer, ...buffersOf(p.display)]))
  },
  /** Decimated copy for orbiting. */
  async lod(a: { positions: Float32Array; indices: Uint32Array; target?: number }): Promise<MeshLod> {
    const l = buildLod(a.positions, a.indices, a.target)
    return Comlink.transfer(l, [l.positions.buffer as ArrayBuffer, l.normals.buffer as ArrayBuffer, l.indices.buffer as ArrayBuffer])
  },
  /** Boolean on raw meshes through manifold; independent jobs can run side by side on different workers. */
  async meshBoolean(a: { op: BoolOp; base: TopoMesh; tools: TopoMesh[] }): Promise<TopoMesh> {
    const r = await manifoldBoolean(a.op, a.base, a.tools)
    return Comlink.transfer(r, [r.positions.buffer as ArrayBuffer, r.indices.buffer as ArrayBuffer])
  },
  /** Round trip used by the pool's tests and the status check. */
  async ping(): Promise<number> {
    return 1
  },
}

export type ComputeApi = typeof computeApi
