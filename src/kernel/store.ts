/** Worker-side geometry store: B-reps and welded meshes keyed by handle. Worker-only. */
import * as Comlink from 'comlink'
import { DEFAULT_CREASE_DEG, meshDisplayAuto, weld } from './meshutil'
import { tessellate, type Shape } from './occ'
import { withBvh } from './bigmesh'
import { finalize, namesOf, rootNames, type NShape, type Names } from './naming'
import type { Body, MeshData, TopoMesh } from './types'

export type Stored = { kind: 'brep'; shape: Shape; names: Names } | { kind: 'mesh'; topo: TopoMesh; /** dihedral angle (deg) that separates faces */ crease: number }

const store = new Map<string, Stored>()
let counter = 0

export const getStored = (key: string): Stored => {
  const s = store.get(key)
  if (!s) throw new Error(`Kernel handle ${key} no longer exists (regenerate the document)`)
  return s
}
export function getBrep(key: string): Shape {
  const s = getStored(key)
  if (s.kind !== 'brep') throw new Error('Expected a B-rep body')
  return s.shape
}
/** The persistent face / edge names of a B-rep (see naming.ts), as a named shape. */
export function getNamed(key: string): NShape {
  const s = getStored(key)
  if (s.kind !== 'brep') throw new Error('Expected a B-rep body')
  return { shape: s.shape, faces: s.names.faces }
}
export const getNames = (key: string): Names => {
  const s = getStored(key)
  if (s.kind !== 'brep') throw new Error('Expected a B-rep body')
  return s.names
}
/** Welded triangle mesh for any body (B-reps are tessellated and welded). */
export function getTopo(key: string): TopoMesh {
  const s = getStored(key)
  if (s.kind === 'mesh') return s.topo
  const m = tessellate(s.shape, 0.02, 0.1)
  return weld(m.positions, m.indices)
}
export function putStored(s: Stored): string {
  const key = 'k' + ++counter
  store.set(key, s)
  return key
}
export function gc(live: string[]) {
  const keep = new Set(live)
  for (const k of [...store.keys()]) if (!keep.has(k)) store.delete(k)
}

const buffers = (m: MeshData): Transferable[] =>
  [m.positions.buffer, m.normals.buffer, m.indices.buffer, m.faceIds.buffer, m.edges.buffer, m.edgeIds?.buffer, m.faceHashes?.buffer, m.edgeHashes?.buffer, m.lod?.positions.buffer, m.lod?.normals.buffer, m.lod?.indices.buffer, m.bvh?.indirect.buffer, ...(m.bvh?.roots ?? [])].filter(
    (b): b is ArrayBuffer => !!b,
  )

/** Wrap a body for return to the main thread with its typed arrays transferred. */
export const sendBody = (b: Body) => Comlink.transfer(b, buffers(b.mesh))
export const sendBodies = (bs: Body[]) => Comlink.transfer(bs, bs.flatMap((b) => buffers(b.mesh)))

/**
 * Store a B-rep and tessellate it. `faces` are the persistent names of its faces (see naming.ts); when an op has no
 * history for its result they are rooted at `id` (`${id}:face:${k}`).
 */
export function bodyFromShape(id: string, name: string, shape: Shape, faces?: string[][]): Body {
  const fn = faces && faces.length === shape.faces.length ? finalize(shape, faces, id) : rootNames(shape, id)
  const names = namesOf(shape, fn)
  const key = putStored({ kind: 'brep', shape, names })
  return { id, name, kind: 'brep', key, mesh: withBvh(tessellate(shape, 0.05, 0.2, names)) }
}
export function bodyFromTopo(id: string, name: string, topo: TopoMesh, crease: number = DEFAULT_CREASE_DEG): Body {
  const key = putStored({ kind: 'mesh', topo, crease })
  return { id, name, kind: 'mesh', key, mesh: meshDisplayAuto(topo, crease) }
}

export type OpFn = (args: never, ctx: OpHelpers) => Promise<unknown> | unknown
export interface OpHelpers {
  getBrep: typeof getBrep
  getNamed: typeof getNamed
  getNames: typeof getNames
  getTopo: typeof getTopo
  bodyFromShape: typeof bodyFromShape
  bodyFromTopo: typeof bodyFromTopo
  sendBody: typeof sendBody
  sendBodies: typeof sendBodies
}
export const helpers: OpHelpers = { getBrep, getNamed, getNames, getTopo, bodyFromShape, bodyFromTopo, sendBody, sendBodies }

const ops = new Map<string, OpFn>()
/** Register a custom worker operation, callable from features as `ctx.kernel.call(name, args)`. */
export function registerOp<A = never, R = unknown>(name: string, fn: (args: A, ctx: OpHelpers) => Promise<R> | R) {
  ops.set(name, fn as OpFn)
}
export const getOp = (name: string) => ops.get(name)
