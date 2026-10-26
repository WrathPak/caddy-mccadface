import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'

/**
 * Binary STL of a bumpy square terrain, `cells` x `cells` quads, two triangles each (cells = 1225 gives 3.0 million
 * triangles, about 150 MB). Written to the OS temp folder and reused between runs.
 */
export function writeBigStl(cells = 1225, size = 200): string {
  const file = path.join(os.tmpdir(), `caddy-e2e-terrain-${cells}.stl`)
  const tris = cells * cells * 2
  if (fs.existsSync(file) && fs.statSync(file).size === 84 + tris * 50) return file
  const buf = Buffer.alloc(84 + tris * 50)
  buf.write('caddy e2e terrain', 0)
  buf.writeUInt32LE(tris, 80)
  const h = (x: number, y: number) => 6 * Math.sin(x / 17) * Math.cos(y / 13) + 1.5 * Math.sin(x / 3.1 + y / 4.3)
  let o = 84
  const w = (v: number) => { buf.writeFloatLE(v, o); o += 4 }
  const tri = (a: number[], b: number[], c: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    w(nx); w(ny); w(nz)
    for (const p of [a, b, c]) { w(p[0]); w(p[1]); w(p[2]) }
    o += 2
  }
  const step = size / cells
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const x0 = i * step, x1 = x0 + step, y0 = j * step, y1 = y0 + step
      const p00 = [x0, y0, h(x0, y0)], p10 = [x1, y0, h(x1, y0)], p11 = [x1, y1, h(x1, y1)], p01 = [x0, y1, h(x0, y1)]
      tri(p00, p10, p11)
      tri(p00, p11, p01)
    }
  }
  fs.writeFileSync(file, buf)
  return file
}

/**
 * A 3MF of the same kind of terrain: `cells` x `cells` quads (2 * cells^2 triangles) as one object, scaled by a build
 * transform so the reader has to apply it. Stays above the size where imports go through the compute pool.
 */
export function writeBig3mf(cells = 350, size = 100): string {
  const file = path.join(os.tmpdir(), `caddy-e2e-terrain-${cells}.3mf`)
  if (fs.existsSync(file)) return file
  const h = (x: number, y: number) => 3 * Math.sin(x / 11) * Math.cos(y / 9)
  const w = cells + 1
  const v: string[] = []
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) v.push(`<vertex x="${((i / cells) * size).toFixed(4)}" y="${((j / cells) * size).toFixed(4)}" z="${h((i / cells) * size, (j / cells) * size).toFixed(4)}"/>`)
  const t: string[] = []
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const a = j * w + i, b = a + 1, c = a + w, d = c + 1
    t.push(`<triangle v1="${a}" v2="${b}" v3="${d}"/>`, `<triangle v1="${a}" v2="${d}" v3="${c}"/>`)
  }
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>` +
    `<object id="1" type="model" name="Terrain"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object></resources>` +
    `<build><item objectid="1" transform="2 0 0 0 2 0 0 0 2 10 20 30"/></build></model>`
  fs.writeFileSync(file, zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  }))
  return file
}
