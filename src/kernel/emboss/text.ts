/** Text to outline loops with opentype.js. Layout is done here (per glyph advance and kerning) so no shaping tables are needed. */
import * as opentype from 'opentype.js'
import { cleanLoop, flattenCubic, flattenQuad, type Shape2D, type V2 } from './shapes'

export interface TextOptions {
  /** height of a capital letter, mm */
  size: number
  /** extra space between letters, as a fraction of the capital height (0 = the font's own) */
  letterSpacing: number
  /** line distance as a multiple of the capital height * 1.5 */
  lineSpacing: number
  align: 'left' | 'center' | 'right'
}

const cache = new Map<string, opentype.Font>()

/** Parsed font, cached by a cheap fingerprint of its bytes. */
export function loadFont(bytes: ArrayBuffer): opentype.Font {
  const u = new Uint8Array(bytes)
  const key = `${u.length}:${u[16] ?? 0}:${u[u.length >> 1] ?? 0}:${u[u.length - 1] ?? 0}:${u[u.length >> 2] ?? 0}`
  let f = cache.get(key)
  if (!f) { f = opentype.parse(bytes.slice(0)); cache.set(key, f) }
  return f
}

const capHeightOf = (font: opentype.Font): number => {
  const os2 = font.tables?.os2 as { sCapHeight?: number } | undefined
  if (os2?.sCapHeight && os2.sCapHeight > 0) return os2.sCapHeight
  const b = font.charToGlyph('H').getBoundingBox()
  return b.y2 - b.y1 || font.unitsPerEm * 0.7
}

export interface TextShape { shape: Shape2D; missing: string[] }

/** Outline loops of `text` (y up, mm, centred). Overlapping contours (script fonts) are resolved by the non-zero fill rule. */
export function textShape(fontBytes: ArrayBuffer, text: string, o: TextOptions): TextShape {
  const font = loadFont(fontBytes)
  const k = o.size / capHeightOf(font) // mm per font unit
  const em = font.unitsPerEm
  const lineGap = capHeightOf(font) * 1.5 * o.lineSpacing
  const lines = text.replace(/\r/g, '').split('\n')
  const missing = new Set<string>()
  const all: V2[][] = []
  const tol = 0.012 / k // curve flattening tolerance in font units
  lines.forEach((line, li) => {
    const glyphs: { g: opentype.Glyph; ch: string }[] = []
    for (const ch of line) {
      const g = font.charToGlyph(ch)
      if (g.index === 0 && ch.trim()) { missing.add(ch); continue }
      glyphs.push({ g, ch })
    }
    // pen positions in font units
    const pens: number[] = []
    let x = 0
    glyphs.forEach(({ g }, i) => {
      pens.push(x)
      x += g.advanceWidth ?? 0
      if (i + 1 < glyphs.length) x += font.getKerningValue(g, glyphs[i + 1].g) + o.letterSpacing * capHeightOf(font)
    })
    const width = x
    const shift = o.align === 'center' ? -width / 2 : o.align === 'right' ? -width : 0
    glyphs.forEach(({ g }, i) => {
      const path = g.getPath(0, 0, em) // scale 1: font units, y pointing down
      let cur: V2[] = []
      let pen: V2 = [0, 0]
      const flush = () => { if (cur.length > 2) all.push(cleanLoop(cur)); cur = [] }
      const place = (px: number, py: number): V2 => [(px + pens[i] + shift) * k, (-py - li * lineGap) * k]
      for (const c of path.commands) {
        if (c.type === 'M') { flush(); pen = [c.x, c.y]; cur = [place(c.x, c.y)] }
        else if (c.type === 'L') { pen = [c.x, c.y]; cur.push(place(c.x, c.y)) }
        else if (c.type === 'Q') {
          const pts: V2[] = []
          flattenQuad(pen, [c.x1, c.y1], [c.x, c.y], tol, pts)
          for (const p of pts) cur.push(place(p[0], p[1]))
          pen = [c.x, c.y]
        } else if (c.type === 'C') {
          const pts: V2[] = []
          flattenCubic(pen, [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y], tol, pts)
          for (const p of pts) cur.push(place(p[0], p[1]))
          pen = [c.x, c.y]
        } else if (c.type === 'Z') flush()
      }
      flush()
    })
  })
  const loops = all.filter((l) => l.length >= 3)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const l of loops) for (const [px, py] of l) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py) }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  return { shape: { rule: 'NonZero', loops: loops.map((l) => l.map(([px, py]) => [px - cx, py - cy] as V2)) }, missing: [...missing] }
}
