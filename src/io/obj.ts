/** Wavefront OBJ: a reader that makes a triangle soup (polygons are fanned, negative indices count back, all objects join into one mesh) and a writer. */
import type { TopoMesh } from '@/kernel/types'
import type { ParsedMesh } from './stl'

export function parseObj(bytes: Uint8Array): ParsedMesh[] {
  const text = new TextDecoder().decode(bytes)
  const v: number[] = []
  const out: number[] = []
  let nv = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length < 2 || line[0] === '#') continue
    if (line[0] === 'v' && (line[1] === ' ' || line[1] === '\t')) {
      const p = line.slice(2).trim().split(/\s+/).map(Number)
      if (p.length >= 3 && p.every((x, i) => i > 2 || Number.isFinite(x))) { v.push(p[0], p[1], p[2]); nv++ }
    } else if (line[0] === 'f' && (line[1] === ' ' || line[1] === '\t')) {
      const ids = line.slice(2).trim().split(/\s+/).map((tok) => {
        const i = parseInt(tok.split('/')[0], 10)
        return i < 0 ? nv + i : i - 1
      })
      if (ids.length < 3 || ids.some((i) => !(i >= 0 && i < nv))) continue
      for (let k = 1; k + 1 < ids.length; k++) for (const i of [ids[0], ids[k], ids[k + 1]]) out.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2])
    }
  }
  if (!out.length) throw new Error('No triangles found in the OBJ file')
  return [{ name: 'Mesh', positions: Float32Array.from(out) }]
}

/** An OBJ with one object per mesh (units are whatever the model is in: millimetres here). */
export function writeObj(items: { name: string; mesh: TopoMesh }[]): Uint8Array {
  const lines: string[] = ['# CADdy McCADFace', '# units: millimetres']
  let base = 0
  for (const it of items) {
    lines.push(`o ${it.name.replace(/\s+/g, '_')}`)
    const p = it.mesh.positions
    for (let k = 0; k < p.length; k += 3) lines.push(`v ${+p[k].toFixed(6)} ${+p[k + 1].toFixed(6)} ${+p[k + 2].toFixed(6)}`)
    const ix = it.mesh.indices
    for (let k = 0; k < ix.length; k += 3) lines.push(`f ${ix[k] + 1 + base} ${ix[k + 1] + 1 + base} ${ix[k + 2] + 1 + base}`)
    base += p.length / 3
  }
  return new TextEncoder().encode(lines.join('\n') + '\n')
}
