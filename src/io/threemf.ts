import { strToU8, zipSync } from 'fflate'
import { Mesh } from 'three'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import type { TopoMesh } from '@/kernel/types'
import type { ParsedMesh } from './stl'

/** Parse a 3MF; each mesh object becomes its own mesh (build transforms baked in). */
export function parse3mf(bytes: Uint8Array): ParsedMesh[] {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const group = new ThreeMFLoader().parse(buf)
  group.updateMatrixWorld(true)
  const out: ParsedMesh[] = []
  group.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const g = o.geometry.clone().toNonIndexed()
    g.applyMatrix4(o.matrixWorld)
    out.push({ name: o.name || `Mesh${out.length + 1}`, positions: new Float32Array(g.getAttribute('position').array as Float32Array) })
  })
  if (!out.length) throw new Error('No mesh objects found in 3MF')
  return out
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)

/** Write a 3MF (core spec): one object per mesh, millimetres, all placed via <build>. */
export function write3mf(items: { name: string; mesh: TopoMesh }[]): Uint8Array {
  const objs = items.map((it, i) => {
    const p = it.mesh.positions
    const v: string[] = []
    for (let k = 0; k < p.length; k += 3) v.push(`<vertex x="${+p[k].toFixed(6)}" y="${+p[k + 1].toFixed(6)}" z="${+p[k + 2].toFixed(6)}"/>`)
    const t: string[] = []
    for (let k = 0; k < it.mesh.indices.length; k += 3) t.push(`<triangle v1="${it.mesh.indices[k]}" v2="${it.mesh.indices[k + 1]}" v3="${it.mesh.indices[k + 2]}"/>`)
    return `<object id="${i + 1}" type="model" name="${esc(it.name)}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`
  })
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Application">WeebCAD</metadata><resources>${objs.join('')}</resources>` +
    `<build>${items.map((_, i) => `<item objectid="${i + 1}"/>`).join('')}</build></model>`
  return zipSync({
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    ),
    '3D/3dmodel.model': strToU8(model),
  })
}
