/**
 * Text outlines for the sketch Text tool: a small TrueType reader (TTF and WOFF containers, simple and composite glyphs,
 * cmap formats 4 and 12) over the fonts bundled with the app. Nothing is fetched from outside the app.
 */
import { unzlibSync } from 'fflate'
import interUrl from '@fontsource/inter/files/inter-latin-500-normal.woff?url'
import monoUrl from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff?url'
import type { Vec2 } from './types'

export type FontSeg = { k: 'l'; a: Vec2; b: Vec2 } | { k: 'q'; a: Vec2; c: Vec2; b: Vec2 }
/** Closed outline of a glyph part, in font units (y up). */
export type Contour = FontSeg[]

interface Glyph { contours: Contour[]; advance: number; yMax: number }
export interface Font {
  name: string
  unitsPerEm: number
  /** height of a capital letter in font units */
  capHeight: number
  glyphFor(code: number): Glyph
}

export const FONTS: Record<string, { label: string; url: string }> = {
  Inter: { label: 'Inter', url: interUrl },
  'JetBrains Mono': { label: 'JetBrains Mono', url: monoUrl },
}
export const DEFAULT_FONT = 'Inter'

// ------------------------------------------------------------------------------------------------ container

function tablesOf(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
  const out = new Map<string, Uint8Array>()
  if (tag(0) === 'wOFF') {
    const n = dv.getUint16(12)
    for (let i = 0; i < n; i++) {
      const e = 44 + i * 20
      const off = dv.getUint32(e + 4), comp = dv.getUint32(e + 8), orig = dv.getUint32(e + 12)
      const raw = buf.subarray(off, off + comp)
      out.set(tag(e), comp < orig ? unzlibSync(raw) : raw)
    }
    return out
  }
  const n = dv.getUint16(4)
  for (let i = 0; i < n; i++) {
    const e = 12 + i * 16
    out.set(tag(e), buf.subarray(dv.getUint32(e + 8), dv.getUint32(e + 8) + dv.getUint32(e + 12)))
  }
  return out
}

const view = (t: Uint8Array) => new DataView(t.buffer, t.byteOffset, t.byteLength)

// ------------------------------------------------------------------------------------------------ cmap

function cmapLookup(cmap: Uint8Array): (code: number) => number {
  const dv = view(cmap)
  const n = dv.getUint16(2)
  let best: { off: number; rank: number } | null = null
  for (let i = 0; i < n; i++) {
    const plat = dv.getUint16(4 + i * 8), enc = dv.getUint16(6 + i * 8), off = dv.getUint32(8 + i * 8)
    const fmt = dv.getUint16(off)
    const rank = plat === 3 && enc === 10 && fmt === 12 ? 4 : plat === 3 && enc === 1 && fmt === 4 ? 3 : plat === 0 && (fmt === 4 || fmt === 12) ? 2 : 0
    if (rank && (!best || rank > best.rank)) best = { off, rank }
  }
  if (!best) throw new Error('This font has no usable character map')
  const o = best.off
  if (dv.getUint16(o) === 12) {
    const groups = dv.getUint32(o + 12)
    return (code) => {
      for (let g = 0; g < groups; g++) {
        const s = dv.getUint32(o + 16 + g * 12), e = dv.getUint32(o + 20 + g * 12)
        if (code >= s && code <= e) return dv.getUint32(o + 24 + g * 12) + (code - s)
      }
      return 0
    }
  }
  const segX2 = dv.getUint16(o + 6)
  const endO = o + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2
  return (code) => {
    if (code > 0xffff) return 0
    for (let s = 0; s < segX2; s += 2) {
      if (code > dv.getUint16(endO + s)) continue
      const start = dv.getUint16(startO + s)
      if (code < start) return 0
      const ro = dv.getUint16(rangeO + s), delta = dv.getInt16(deltaO + s)
      if (ro === 0) return (code + delta) & 0xffff
      const g = dv.getUint16(rangeO + s + ro + (code - start) * 2)
      return g === 0 ? 0 : (g + delta) & 0xffff
    }
    return 0
  }
}

// ------------------------------------------------------------------------------------------------ glyphs

interface Pt { x: number; y: number; on: boolean }

function contourSegs(pts: Pt[]): Contour {
  if (pts.length < 2) return []
  // start on an on-curve point; if there is none, start at the middle of the first two off-curve points
  let start = pts.findIndex((p) => p.on)
  let rot = pts
  if (start < 0) {
    const m: Pt = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, on: true }
    rot = [m, ...pts.slice(1), pts[0]]
    start = 0
  } else rot = [...pts.slice(start), ...pts.slice(0, start)]
  const segs: Contour = []
  let cur = rot[0]
  let ctrl: Pt | null = null
  const pushTo = (p: Pt) => {
    if (ctrl) segs.push({ k: 'q', a: [cur.x, cur.y], c: [ctrl.x, ctrl.y], b: [p.x, p.y] })
    else if (Math.hypot(p.x - cur.x, p.y - cur.y) > 1e-9) segs.push({ k: 'l', a: [cur.x, cur.y], b: [p.x, p.y] })
    cur = p
    ctrl = null
  }
  for (let i = 1; i <= rot.length; i++) {
    const p = i === rot.length ? rot[0] : rot[i]
    if (p.on) pushTo(p)
    else {
      if (ctrl) pushTo({ x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2, on: true })
      ctrl = p
    }
  }
  if (ctrl) pushTo(rot[0])
  else if (Math.hypot(cur.x - rot[0].x, cur.y - rot[0].y) > 1e-9) pushTo(rot[0])
  return segs
}

export function parseFont(bytes: Uint8Array, name: string): Font {
  const t = tablesOf(bytes)
  const need = (k: string) => { const v = t.get(k); if (!v) throw new Error(`The font has no ${k} table`); return v }
  const head = view(need('head')), maxp = view(need('maxp')), hhea = view(need('hhea')), hmtx = view(need('hmtx'))
  const loca = view(need('loca')), glyf = need('glyf'), gv = view(glyf)
  const unitsPerEm = head.getUint16(18)
  const longLoca = head.getInt16(50) === 1
  const numGlyphs = maxp.getUint16(4)
  const nMetrics = hhea.getUint16(34)
  const lookup = cmapLookup(need('cmap'))
  const off = (i: number) => (longLoca ? loca.getUint32(i * 4) : loca.getUint16(i * 2) * 2)
  const advance = (g: number) => hmtx.getUint16(Math.min(g, nMetrics - 1) * 4)

  const outline = (g: number, depth = 0): Pt[][] => {
    if (g >= numGlyphs || depth > 6) return []
    const s = off(g), e = off(g + 1)
    if (e <= s) return []
    const nc = gv.getInt16(s)
    let p = s + 10
    if (nc >= 0) {
      const ends: number[] = []
      for (let i = 0; i < nc; i++) { ends.push(gv.getUint16(p)); p += 2 }
      const total = nc ? ends[nc - 1] + 1 : 0
      p += 2 + gv.getUint16(p) // instructions
      const flags: number[] = []
      while (flags.length < total) {
        const f = glyf[p++]
        flags.push(f)
        if (f & 8) { let r = glyf[p++]; while (r-- > 0) flags.push(f) }
      }
      const xs: number[] = [], ys: number[] = []
      let v = 0
      for (let i = 0; i < total; i++) {
        const f = flags[i]
        if (f & 2) { const d = glyf[p++]; v += f & 16 ? d : -d } else if (!(f & 16)) { v += gv.getInt16(p); p += 2 }
        xs.push(v)
      }
      v = 0
      for (let i = 0; i < total; i++) {
        const f = flags[i]
        if (f & 4) { const d = glyf[p++]; v += f & 32 ? d : -d } else if (!(f & 32)) { v += gv.getInt16(p); p += 2 }
        ys.push(v)
      }
      const out: Pt[][] = []
      let from = 0
      for (const end of ends) {
        out.push(Array.from({ length: end - from + 1 }, (_, k) => ({ x: xs[from + k], y: ys[from + k], on: (flags[from + k] & 1) === 1 })))
        from = end + 1
      }
      return out
    }
    // composite glyph
    const out: Pt[][] = []
    for (;;) {
      const fl = gv.getUint16(p), idx = gv.getUint16(p + 2)
      p += 4
      let dx = 0, dy = 0
      if (fl & 1) { if (fl & 2) { dx = gv.getInt16(p); dy = gv.getInt16(p + 2) } p += 4 } else { if (fl & 2) { dx = gv.getInt8(p); dy = gv.getInt8(p + 1) } p += 2 }
      let a = 1, b = 0, c = 0, d = 1
      if (fl & 8) { a = d = gv.getInt16(p) / 16384; p += 2 }
      else if (fl & 0x40) { a = gv.getInt16(p) / 16384; d = gv.getInt16(p + 2) / 16384; p += 4 }
      else if (fl & 0x80) { a = gv.getInt16(p) / 16384; b = gv.getInt16(p + 2) / 16384; c = gv.getInt16(p + 4) / 16384; d = gv.getInt16(p + 6) / 16384; p += 8 }
      for (const ct of outline(idx, depth + 1)) out.push(ct.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })))
      if (!(fl & 0x20)) break
    }
    return out
  }

  const cache = new Map<number, Glyph>()
  const glyphFor = (code: number): Glyph => {
    let g = cache.get(code)
    if (!g) {
      const gi = lookup(code)
      const cs = outline(gi)
      const contours = cs.map(contourSegs).filter((c) => c.length)
      let yMax = 0
      for (const c of contours) for (const s of c) yMax = Math.max(yMax, s.a[1], s.b[1])
      g = { contours, advance: advance(gi), yMax }
      cache.set(code, g)
    }
    return g
  }
  const capHeight = glyphFor(72).yMax || unitsPerEm * 0.7
  return { name, unitsPerEm, capHeight, glyphFor }
}

// ------------------------------------------------------------------------------------------------ loading

const loaded = new Map<string, Font>()
const loading = new Map<string, Promise<Font>>()

async function fetchBytes(url: string): Promise<Uint8Array> {
  if (typeof document === 'undefined') {
    // Node (unit tests): the bundler hands out a file path here
    const spec = 'node:fs/promises'
    const fs = (await import(/* @vite-ignore */ spec)) as typeof import('node:fs/promises')
    return new Uint8Array(await fs.readFile(url))
  }
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Could not load the font (${r.status})`)
  return new Uint8Array(await r.arrayBuffer())
}

/** Load (once) a bundled font. Resolves to the parsed font. */
export function loadFont(name: string = DEFAULT_FONT): Promise<Font> {
  const key = FONTS[name] ? name : DEFAULT_FONT
  const have = loaded.get(key)
  if (have) return Promise.resolve(have)
  let p = loading.get(key)
  if (!p) {
    p = fetchBytes(FONTS[key].url).then((b) => { const f = parseFont(b, key); loaded.set(key, f); return f })
    loading.set(key, p)
  }
  return p
}

/** The font if it is already loaded (the sketch code is synchronous; callers `await loadFont` before). */
export const fontNow = (name: string = DEFAULT_FONT): Font | undefined => loaded.get(FONTS[name] ? name : DEFAULT_FONT)

/** Register a parsed font by hand (tests). */
export function setFont(name: string, bytes: Uint8Array) { loaded.set(name, parseFont(bytes, name)) }

export interface TextLayout { contours: Contour[]; width: number; height: number }

/**
 * Outlines of `text` at cap height `h` (mm), baseline starting at the origin, y up. Several lines are stacked downwards.
 */
export function layoutText(font: Font, text: string, h: number): TextLayout {
  const s = h / font.capHeight
  const lineH = font.unitsPerEm * 1.25 * s
  const contours: Contour[] = []
  let width = 0
  text.split('\n').forEach((line, row) => {
    let x = 0
    for (const ch of line) {
      const g = font.glyphFor(ch.codePointAt(0)!)
      const dy = -row * lineH
      for (const c of g.contours) {
        contours.push(c.map((sg): FontSeg => (sg.k === 'l'
          ? { k: 'l', a: [(sg.a[0] + x) * s, sg.a[1] * s + dy], b: [(sg.b[0] + x) * s, sg.b[1] * s + dy] }
          : { k: 'q', a: [(sg.a[0] + x) * s, sg.a[1] * s + dy], c: [(sg.c[0] + x) * s, sg.c[1] * s + dy], b: [(sg.b[0] + x) * s, sg.b[1] * s + dy] })))
      }
      x += g.advance
    }
    width = Math.max(width, x * s)
  })
  const rows = text.split('\n').length
  return { contours, width, height: h + (rows - 1) * lineH }
}
