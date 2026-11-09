/** Plate thumbnails: an offscreen render of the placed bodies on the bed, and the PNG / QOI / JPG blocks slicers put in G-code. */
import {
  AmbientLight, BufferAttribute, BufferGeometry, DirectionalLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera,
  PlaneGeometry, Scene, WebGLRenderer, type Camera,
} from 'three'
import type { EngineObject } from '../engine/types'

export type RenderMode = 'lit' | 'flat' | 'top' | 'pick'

/** One image of the plate, RGBA, `size` pixels square; transparent behind the bed. */
export function renderPlate(objects: EngineObject[], bed: [number, number], colors: string[], size: number, mode: RenderMode): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const gl = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
  gl.setSize(size, size, false)
  gl.setClearColor(0x000000, 0)
  const scene = new Scene()
  const flat = mode !== 'lit'
  const solid = (hex: string) => (flat ? new MeshBasicMaterial({ color: hex }) : new MeshStandardMaterial({ color: hex, roughness: 0.6, metalness: 0 }))
  const bedMesh = new Mesh(new PlaneGeometry(bed[0], bed[1]), new MeshBasicMaterial({ color: mode === 'pick' ? '#000000' : '#d9d9d9' }))
  bedMesh.position.set(bed[0] / 2, bed[1] / 2, -0.05)
  scene.add(bedMesh)
  const pickColors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ff8800', '#8800ff']
  const geos: BufferGeometry[] = [bedMesh.geometry]
  objects.forEach((o, i) => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(o.positions, 3))
    g.setIndex(new BufferAttribute(o.indices, 1))
    if (!flat) g.computeVertexNormals()
    geos.push(g)
    const hex = mode === 'pick' ? pickColors[i % pickColors.length] : colors[(o.slots?.find((s) => s > 0) ?? 1) - 1] ?? colors[0] ?? '#f4f4f1'
    scene.add(new Mesh(g, solid(hex)))
  })
  if (!flat) {
    scene.add(new AmbientLight(0xffffff, 1.6))
    const sun = new DirectionalLight(0xffffff, 2.2)
    sun.position.set(-1, -2, 3)
    scene.add(sun)
  }
  const cx = bed[0] / 2, cy = bed[1] / 2
  const span = Math.max(bed[0], bed[1])
  let camera: Camera
  if (mode === 'top') {
    const c = new OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 1, 4000)
    c.position.set(cx, cy, 1000)
    c.up.set(0, 1, 0)
    c.lookAt(cx, cy, 0)
    camera = c
  } else {
    const c = new PerspectiveCamera(32, 1, 10, 6000)
    c.up.set(0, 0, 1)
    c.position.set(cx + span * 0.85, cy - span * 1.7, span * 1.45)
    c.lookAt(cx, cy, 0)
    camera = c
  }
  gl.render(scene, camera)
  const out = document.createElement('canvas')
  out.width = out.height = size
  const ctx = out.getContext('2d')!
  ctx.drawImage(canvas, 0, 0)
  const data = ctx.getImageData(0, 0, size, size)
  geos.forEach((g) => g.dispose())
  gl.dispose()
  gl.forceContextLoss()
  return data
}

/** An image scaled to w x h (aspect kept, centred, transparent around). */
export function scaleImage(src: ImageData, w: number, h: number): ImageData {
  const a = document.createElement('canvas')
  a.width = src.width; a.height = src.height
  a.getContext('2d')!.putImageData(src, 0, 0)
  const b = document.createElement('canvas')
  b.width = w; b.height = h
  const ctx = b.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  const k = Math.min(w / src.width, h / src.height)
  const dw = src.width * k, dh = src.height * k
  ctx.drawImage(a, (w - dw) / 2, (h - dh) / 2, dw, dh)
  return ctx.getImageData(0, 0, w, h)
}

async function canvasBytes(img: ImageData, type: string, quality?: number): Promise<Uint8Array> {
  const c = document.createElement('canvas')
  c.width = img.width; c.height = img.height
  const ctx = c.getContext('2d')!
  if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(await createImageBitmap(img), 0, 0) } else ctx.putImageData(img, 0, 0)
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, type, quality))
  if (!blob) throw new Error('could not encode the thumbnail')
  return new Uint8Array(await blob.arrayBuffer())
}
export const pngBytes = (img: ImageData) => canvasBytes(img, 'image/png')

/** QOI ("quite ok image") encoder, for the printers whose firmware reads QOI thumbnails (Prusa). */
export function qoiEncode(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const out: number[] = []
  const u32 = (n: number) => out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  out.push(0x71, 0x6f, 0x69, 0x66)
  u32(w); u32(h)
  out.push(4, 0)
  const index = new Uint32Array(64)
  let pr = 0, pg = 0, pb = 0, pa = 255, run = 0
  const n = w * h
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3]
    if (r === pr && g === pg && b === pb && a === pa) {
      if (++run === 62 || i === n - 1) { out.push(0xc0 | (run - 1)); run = 0 }
      continue
    }
    if (run > 0) { out.push(0xc0 | (run - 1)); run = 0 }
    const h64 = (r * 3 + g * 5 + b * 7 + a * 11) % 64
    const px = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
    if (index[h64] === px) out.push(h64)
    else {
      index[h64] = px
      if (a === pa) {
        const dr = ((r - pr + 128) & 255) - 128, dg = ((g - pg + 128) & 255) - 128, db = ((b - pb + 128) & 255) - 128
        const drg = dr - dg, dbg = db - dg
        if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) out.push(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2))
        else if (dg >= -32 && dg <= 31 && drg >= -8 && drg <= 7 && dbg >= -8 && dbg <= 7) out.push(0x80 | (dg + 32), ((drg + 8) << 4) | (dbg + 8))
        else out.push(0xfe, r, g, b)
      } else out.push(0xff, r, g, b, a)
    }
    pr = r; pg = g; pb = b; pa = a
  }
  out.push(0, 0, 0, 0, 0, 0, 0, 1)
  return Uint8Array.from(out)
}

export interface ThumbnailSpec { w: number; h: number; format: 'PNG' | 'QOI' | 'JPG' }

/** Orca's `thumbnails` setting ("16x16/QOI, 313x173/QOI, 640x480/PNG") as sizes and formats; formats this app cannot write (COLPIC) are left out. */
export function parseThumbnailSpec(text: string): ThumbnailSpec[] {
  const out: ThumbnailSpec[] = []
  for (const part of text.split(',')) {
    const m = /^\s*(\d+)\s*x\s*(\d+)\s*(?:\/\s*([A-Za-z]+))?\s*$/.exec(part)
    if (!m) continue
    const format = (m[3] ?? 'PNG').toUpperCase()
    if (format !== 'PNG' && format !== 'QOI' && format !== 'JPG') continue
    const w = +m[1], h = +m[2]
    if (w > 0 && h > 0) out.push({ w, h, format })
  }
  return out
}

const b64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** One thumbnail as the comment block slicers write in G-code: "; thumbnail begin WxH SIZE", base64 lines of 78 characters, "; thumbnail end". */
export function thumbnailBlock(spec: ThumbnailSpec, bytes: Uint8Array): string {
  const tag = spec.format === 'PNG' ? 'thumbnail' : `thumbnail_${spec.format}`
  const text = b64(bytes)
  const lines: string[] = []
  for (let i = 0; i < text.length; i += 78) lines.push(`; ${text.slice(i, i + 78)}`)
  return `; ${tag} begin ${spec.w}x${spec.h} ${text.length}\n${lines.join('\n')}\n; ${tag} end\n`
}

/** The thumbnail section of a G-code header, for the sizes the printer profile asks for. Empty when it asks for none. */
export async function thumbnailSection(specText: string, render: ImageData): Promise<string> {
  const specs = parseThumbnailSpec(specText)
  if (!specs.length) return ''
  const blocks: string[] = []
  for (const s of specs) {
    const img = scaleImage(render, s.w, s.h)
    const bytes = s.format === 'QOI' ? qoiEncode(img.data, s.w, s.h) : await canvasBytes(img, s.format === 'JPG' ? 'image/jpeg' : 'image/png', 0.92)
    blocks.push(thumbnailBlock(s, bytes))
  }
  return `; THUMBNAIL_BLOCK_START\n${blocks.join(';\n')}; THUMBNAIL_BLOCK_END\n\n`
}

/** Put a thumbnail section into G-code: after the header block when there is one, else at the top. */
export function insertThumbnails(gcode: string, section: string): string {
  if (!section) return gcode
  const end = gcode.indexOf('; HEADER_BLOCK_END')
  if (end < 0) return section + gcode
  const nl = gcode.indexOf('\n', end)
  return `${gcode.slice(0, nl + 1)}\n${section}${gcode.slice(nl + 1)}`
}
