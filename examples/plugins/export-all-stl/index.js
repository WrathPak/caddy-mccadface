// @ts-check
/// <reference path="../../../src/api/caddy-api.d.ts" />

// Export all bodies as STLs: one command, on the Solid tab. Every body of the document becomes a binary STL; with more than one
// they come as a single zip (so the browser does not ask about downloading several files). The plugin only asks for the
// "download" permission: reading the document and the triangles is always allowed.

/** binary STL of a welded triangle mesh */
function stlBytes(/** @type {CaddyMeshData} */ mesh) {
  const { positions: p, indices: ix } = mesh
  const tris = ix.length / 3
  const out = new Uint8Array(84 + tris * 50)
  const dv = new DataView(out.buffer)
  out.set(new TextEncoder().encode('Exported by the export-all-stl plugin'), 0)
  dv.setUint32(80, tris, true)
  let o = 84
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    for (const v of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) { dv.setFloat32(o, v, true); o += 4 }
    o += 2 // attribute byte count
  }
  return out
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (/** @type {Uint8Array} */ b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

/** a zip with the files stored as they are (STL does not squeeze much, and this keeps the code short) */
function zip(/** @type {{ name: string; data: Uint8Array }[]} */ files) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true) // 0x0800: names are UTF-8
    local.setUint32(14, crc, true); local.setUint32(18, f.data.length, true); local.setUint32(22, f.data.length, true); local.setUint16(26, name.length, true)
    parts.push(new Uint8Array(local.buffer), name, f.data)
    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true)
    cd.setUint32(16, crc, true); cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), name)
    offset += 30 + name.length + f.data.length
  }
  const size = central.reduce((n, c) => n + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of all) { out.set(c, o); o += c.length }
  return out
}

const safe = (/** @type {string} */ s) => s.replace(/[^\w.-]+/g, '_') || 'body'

/** @param {CaddyApi} caddy */
export function activate(caddy) {
  caddy.commands.register({
    id: 'export-all',
    label: 'Export all bodies as STLs',
    tip: 'Save every body of the document as its own STL file (as one zip when there are several)',
    icon: 'download',
    ribbon: { tab: 'solid', group: 'Export' },
    async run() {
      const bodies = await caddy.document.bodies()
      if (!bodies.length) return caddy.ui.toast('There are no bodies to export', 'error')
      const doc = (await caddy.document.info()).name
      const used = new Set()
      const files = []
      for (const b of bodies) {
        let name = safe(b.name)
        for (let n = 2; used.has(name); n++) name = `${safe(b.name)}_${n}`
        used.add(name)
        files.push({ name: name + '.stl', data: stlBytes(await caddy.kernel.triangles(b)) })
      }
      if (files.length === 1) await caddy.io.download(files[0].name, files[0].data, 'model/stl')
      else await caddy.io.download(`${safe(doc)}-stls.zip`, zip(files), 'application/zip')
      caddy.ui.toast(`Exported ${files.length} ${files.length === 1 ? 'body' : 'bodies'}`)
    },
  })
}
