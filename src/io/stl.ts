import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { TopoMesh } from '@/kernel/types'

export interface ParsedMesh { name: string; positions: Float32Array }

/** Parse binary or ASCII STL into a (non-indexed) triangle soup; the kernel welds vertices. */
export function parseStl(bytes: Uint8Array): ParsedMesh[] {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const geo = new STLLoader().parse(buf)
  const pos = geo.getAttribute('position')
  return [{ name: 'Mesh', positions: new Float32Array(pos.array as Float32Array) }]
}

/** Binary STL for one or more welded meshes. */
export function writeStl(meshes: TopoMesh[]): Uint8Array {
  const tris = meshes.reduce((n, m) => n + m.indices.length / 3, 0)
  const out = new ArrayBuffer(84 + tris * 50)
  const dv = new DataView(out)
  new TextEncoder().encodeInto('CADdy McCADFace binary STL', new Uint8Array(out, 0, 80))
  dv.setUint32(80, tris, true)
  let o = 84
  for (const m of meshes) {
    const p = m.positions
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const l = Math.hypot(nx, ny, nz) || 1
      nx /= l; ny /= l; nz /= l
      for (const v of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) {
        dv.setFloat32(o, v, true)
        o += 4
      }
      dv.setUint16(o, 0, true)
      o += 2
    }
  }
  return new Uint8Array(out)
}
