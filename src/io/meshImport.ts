/**
 * Mesh imports through the compute pool. The file is parsed, welded and turned into display data in a pool worker; the
 * kernel worker then adopts the welded topology so later features can use the body, and the viewport gets the display
 * arrays untouched (all moves are transfers, nothing is copied on the main thread).
 */
import * as Comlink from 'comlink'
import type { Body } from '@/kernel/types'
import { getKernel, noteBodyBounds } from '@/kernel/client'
import { getComputePool } from '@/kernel/pool'
import { useWarm } from '@/viewport/motion'

/** The File an import blob came from. Handing a File to a worker costs nothing (it is a handle), a Uint8Array would be copied. */
const sources = new WeakMap<Uint8Array, Blob>()
export const rememberSource = (bytes: Uint8Array, file: Blob) => void sources.set(bytes, file)
export const sourceOf = (bytes: Uint8Array): Blob | Uint8Array => sources.get(bytes) ?? bytes

/** Files at least this big take the pool route (smaller ones are quicker to parse in place). */
export const POOL_IMPORT_BYTES = 2 << 20

export interface MeshImportOptions {
  format: 'stl' | '3mf'
  scale: number
  creaseDeg: number
  baseName: string
  /** id of the n-th body (feature id based) */
  bodyId: (n: number) => string
}

export async function importMeshPooled(source: Blob | Uint8Array, o: MeshImportOptions): Promise<Body[]> {
  useWarm.setState({ on: true }) // the shaders link now, while the file is being read, not in the frame that first shows it
  try {
    return await importPooled(source, o)
  } finally {
    setTimeout(() => useWarm.setState({ on: false }), 1500)
  }
}

async function importPooled(source: Blob | Uint8Array, o: MeshImportOptions): Promise<Body[]> {
  const parts = await getComputePool().run((w) => w.importMesh({ source, format: o.format, scale: o.scale, creaseDeg: o.creaseDeg }))
  noteBodyBounds(parts.map((p) => ({ mesh: p.display })))
  const kernel = getKernel()
  return Promise.all(
    parts.map(async (part, i) => {
      const { topo } = part
      const key = await kernel.adoptMesh(Comlink.transfer({ topo, crease: o.creaseDeg }, [topo.positions.buffer as ArrayBuffer, topo.indices.buffer as ArrayBuffer]))
      return {
        id: o.bodyId(i),
        name: parts.length > 1 ? `${o.baseName} ${part.name}` : o.baseName,
        kind: 'mesh' as const,
        key,
        mesh: part.display,
      }
    }),
  )
}
