/** manifold-3d wrapper. Worker-only. */
import Module from 'manifold-3d'
import manifoldWasm from 'manifold-3d/manifold.wasm?url'
import type { Manifold, Mesh } from 'manifold-3d'
import type { TopoMesh } from './types'

type Toplevel = Awaited<ReturnType<typeof Module>>
let ready: Promise<Toplevel> | null = null

export function initManifold(): Promise<Toplevel> {
  return (ready ??= (async () => {
    const wasm = await Module({ locateFile: () => manifoldWasm })
    wasm.setup()
    return wasm
  })())
}

/** Welded triangle mesh -> Manifold (caller must `.delete()` it). */
export async function toManifold(m: TopoMesh): Promise<Manifold> {
  const w = await initManifold()
  const mesh = new w.Mesh({ numProp: 3, vertProperties: m.positions.slice(), triVerts: m.indices.slice() })
  return w.Manifold.ofMesh(mesh as Mesh)
}

export function fromManifold(man: Manifold): TopoMesh {
  const mesh = man.getMesh()
  // numProp may be > 3 when property channels exist; we only ever create 3
  const np = mesh.numProp
  let positions: Float32Array
  if (np === 3) positions = mesh.vertProperties.slice()
  else {
    positions = new Float32Array((mesh.vertProperties.length / np) * 3)
    for (let i = 0, n = positions.length / 3; i < n; i++) positions.set(mesh.vertProperties.subarray(i * np, i * np + 3), i * 3)
  }
  return { positions, indices: mesh.triVerts.slice() }
}

export type BoolOp = 'union' | 'subtract' | 'intersect'

/** Boolean of `a` with each of `tools` (subtract/intersect chain; union folds all). */
export async function meshBoolean(op: BoolOp, a: TopoMesh, tools: TopoMesh[]): Promise<TopoMesh> {
  let acc = await toManifold(a)
  try {
    for (const t of tools) {
      const tm = await toManifold(t)
      const next = op === 'union' ? acc.add(tm) : op === 'subtract' ? acc.subtract(tm) : acc.intersect(tm)
      tm.delete()
      acc.delete()
      acc = next
    }
    return fromManifold(acc)
  } finally {
    acc.delete()
  }
}
