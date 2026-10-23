/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import { box, initOcc, readStep, writeStep, type Shape } from './occ'
import { initManifold, meshBoolean, type BoolOp } from './mesh'
import { weld } from './meshutil'
import {
  bodyFromShape, bodyFromTopo, gc, getBrep, getOp, getStored, getTopo, helpers, sendBodies, sendBody,
} from './store'
import { composeTransform, type Body, type TopoMesh, type TransformSpec, type Vec3 } from './types'
import './extra-ops'

export type { BoolOp }
export interface BodyMeta { id: string; name: string }

const api = {
  /** Warm up both WASM modules. */
  async init() {
    await Promise.all([initOcc(), initManifold()])
    return true
  },

  // ---- creation
  async makeBox(a: BodyMeta & { size: Vec3; position: Vec3 }): Promise<Body> {
    await initOcc()
    return sendBody(bodyFromShape(a.id, a.name, box(a.size, a.position)))
  },
  /** Create a mesh body from raw triangles (welded here). Input buffers are consumed. */
  async createMesh(a: BodyMeta & { positions: Float32Array; indices?: Uint32Array }): Promise<Body> {
    return sendBody(bodyFromTopo(a.id, a.name, weld(a.positions, a.indices)))
  },
  /** Import a STEP file as one B-rep body. */
  async importStep(a: BodyMeta & { bytes: ArrayBuffer }): Promise<Body> {
    await initOcc()
    return sendBody(bodyFromShape(a.id, a.name, await readStep(a.bytes)))
  },

  // ---- modification (all return a NEW body/handle; inputs are never mutated)
  async transform(a: BodyMeta & { key: string; spec: TransformSpec }): Promise<Body> {
    const s = getStored(a.key)
    if (s.kind === 'mesh') {
      const m = composeTransform(a.spec)
      const p = new Float32Array(s.topo.positions.length)
      for (let i = 0; i < p.length; i += 3) {
        const x = s.topo.positions[i], y = s.topo.positions[i + 1], z = s.topo.positions[i + 2]
        p[i] = m[0] * x + m[4] * y + m[8] * z + m[12]
        p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
        p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
      }
      return sendBody(bodyFromTopo(a.id, a.name, { positions: p, indices: s.topo.indices.slice() }))
    }
    await initOcc()
    const { pivot, rotate, scale, translate } = a.spec
    let sh: Shape = s.shape
    if (scale !== 1) sh = sh.scale(scale, pivot) as Shape
    if (rotate[0]) sh = sh.rotate(rotate[0], pivot, [1, 0, 0]) as Shape
    if (rotate[1]) sh = sh.rotate(rotate[1], pivot, [0, 1, 0]) as Shape
    if (rotate[2]) sh = sh.rotate(rotate[2], pivot, [0, 0, 1]) as Shape
    sh = sh.translate(translate[0], translate[1], translate[2]) as Shape
    return sendBody(bodyFromShape(a.id, a.name, sh))
  },

  /** B-rep boolean (all inputs must be B-reps). */
  async brepBoolean(a: BodyMeta & { op: BoolOp; base: string; tools: string[] }): Promise<Body> {
    await initOcc()
    let r = getBrep(a.base)
    for (const t of a.tools) {
      const tool = getBrep(t)
      r = (a.op === 'union' ? r.fuse(tool) : a.op === 'subtract' ? r.cut(tool) : r.intersect(tool)) as Shape
    }
    return sendBody(bodyFromShape(a.id, a.name, r))
  },
  /** Mesh boolean through manifold (B-rep inputs are tessellated first). Result is a mesh body. */
  async meshBoolean(a: BodyMeta & { op: BoolOp; base: string; tools: string[] }): Promise<Body> {
    const topo = await meshBoolean(a.op, getTopo(a.base), a.tools.map(getTopo))
    return sendBody(bodyFromTopo(a.id, a.name, topo))
  },
  /** B-rep when every input is a B-rep, otherwise manifold. */
  async boolean(a: BodyMeta & { op: BoolOp; base: string; tools: string[] }): Promise<Body> {
    const allBrep = [a.base, ...a.tools].every((k) => getStored(k).kind === 'brep')
    return allBrep ? api.brepBoolean(a) : api.meshBoolean(a)
  },
  /** Tessellate a B-rep into a (welded) mesh body. */
  async toMeshBody(a: BodyMeta & { key: string }): Promise<Body> {
    return sendBody(bodyFromTopo(a.id, a.name, getTopo(a.key)))
  },

  // ---- export
  /** Welded triangle meshes for STL/3MF export. */
  async exportMeshes(keys: string[]): Promise<TopoMesh[]> {
    const out = keys.map(getTopo).map((t) => ({ positions: t.positions.slice(), indices: t.indices.slice() }))
    return Comlink.transfer(out, out.flatMap((t) => [t.positions.buffer, t.indices.buffer]))
  },
  async exportStep(items: { key: string; name: string }[]): Promise<ArrayBuffer> {
    await initOcc()
    const buf = await writeStep(items.map((i) => ({ shape: getBrep(i.key), name: i.name })))
    return Comlink.transfer(buf, [buf])
  },

  // ---- housekeeping / extension
  /** Release every handle not in `live`. */
  gc(live: string[]) {
    gc(live)
  },
  /** Invoke an operation registered with registerOp (see extra-ops.ts). */
  async call(name: string, args: unknown): Promise<unknown> {
    const op = getOp(name)
    if (!op) throw new Error(`Unknown kernel op: ${name}`)
    await Promise.all([initOcc(), initManifold()])
    return op(args as never, helpers)
  },
  /** Helper for ops returning many bodies. */
  _sendBodies: sendBodies,
}

export type KernelApi = Omit<typeof api, '_sendBodies'>
Comlink.expose(api)
