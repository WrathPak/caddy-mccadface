/** The border and title block of a sheet as primitives. */
import { scaleText, sheetDims } from './sheets'
import type { Prim, Sheet, TitleBlockTemplate } from './types'

const rectPts = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h]

/** The text a cell shows: built-in values are filled in, the rest come from the sheet's title block values. */
export function cellValue(key: string, sheet: Sheet, index: number, count: number): string {
  switch (key) {
    case 'sheet': return `${index + 1} / ${count}`
    case 'scale': return scaleText(sheet.scale)
    default: return sheet.titleBlock[key] ?? ''
  }
}

/** First / third angle projection symbol: a cone seen from the side and from the end. */
export function projectionSymbol(cx: number, cy: number, size: number, third: boolean): Prim[] {
  const small = size * 0.32, big = size * 0.62
  const owner = 'titleblock'
  const circle = (x: number, y: number, r: number): Prim => {
    const pts: number[] = []
    for (let i = 0; i < 32; i++) pts.push(x + r * Math.cos((i / 32) * 2 * Math.PI), y + r * Math.sin((i / 32) * 2 * Math.PI))
    return { k: 'path', pts, closed: true, style: 'thin', owner }
  }
  const wid = size * 1.15
  const ox = third ? cx - wid * 0.9 : cx + wid * 0.1
  const cone: Prim = { k: 'path', pts: [ox, cy - big / 2, ox + wid * 0.8, cy - small / 2, ox + wid * 0.8, cy + small / 2, ox, cy + big / 2], closed: true, style: 'thin', owner }
  const rx = third ? cx + wid * 0.55 : cx - wid * 0.55
  return [
    cone,
    { k: 'path', pts: [ox + wid * 0.4, cy - big / 2 - 1.5, ox + wid * 0.4, cy + big / 2 + 1.5], style: 'thin', owner, pick: true },
    circle(rx, cy, big / 2),
    circle(rx, cy, small / 2),
    { k: 'path', pts: [rx - big / 2 - 1.5, cy, rx + big / 2 + 1.5, cy], style: 'center', owner },
    { k: 'path', pts: [rx, cy - big / 2 - 1.5, rx, cy + big / 2 + 1.5], style: 'center', owner },
  ]
}

export function borderPrims(sheet: Sheet): Prim[] {
  const { w, h } = sheetDims(sheet)
  const m = sheet.margin
  return [{ k: 'path', pts: rectPts(m, m, w - 2 * m, h - 2 * m), closed: true, style: 'border', owner: 'border' }]
}

export function titleBlockPrims(sheet: Sheet, t: TitleBlockTemplate, index: number, count: number): Prim[] {
  const { w } = sheetDims(sheet)
  const x0 = w - sheet.margin - t.w, y0 = sheet.margin
  const owner = 'titleblock'
  const out: Prim[] = [{ k: 'path', pts: rectPts(x0, y0, t.w, t.h), closed: true, style: 'visible', owner }]
  for (const c of t.cells) {
    const cx = x0 + c.x, cy = y0 + c.y
    out.push({ k: 'path', pts: rectPts(cx, cy, c.w, c.h), closed: true, style: 'thin', owner })
    out.push({ k: 'text', x: cx + 1, y: cy + c.h - 2.6, text: c.label.toUpperCase(), size: 1.8, anchor: 'start', owner, style: 'thin' })
    const v = cellValue(c.key, sheet, index, count)
    if (v) out.push({ k: 'text', x: cx + 1.5, y: cy + Math.max(1.5, (c.h - 2.6 - c.size) / 2), text: v, size: c.size, anchor: 'start', bold: !!c.big, owner })
  }
  if (t.showProjection) out.push(...projectionSymbol(x0 - 16, y0 + 9, 10, sheet.projection === 'third'))
  return out
}
