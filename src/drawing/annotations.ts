/** Notes, leaders, tolerance frames, datums, surface finish symbols, balloons and the parts list as sheet primitives. */
import type { V2 } from '@/kernel/drawing-geom'
import type { Component } from './components'
import { arrowPrim, textWidth } from './dims'
import { GDT_GLYPHS } from './gdt'
import type { Annotation, DrawingSettings, Prim } from './types'

const seg = (pts: number[], owner: string): Prim => ({ k: 'path', pts, style: 'thin', owner })
const rect = (x: number, y: number, w: number, h: number, owner: string, style: 'thin' | 'visible' = 'thin'): Prim => ({ k: 'path', pts: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true, style, owner })
const circlePts = (cx: number, cy: number, r: number, n = 40): number[] => {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI))
  return out
}

export function partNumber(parts: Component[], key: string): number | null {
  const i = parts.findIndex((p) => p.key === key)
  return i < 0 ? null : i + 1
}

export const PARTS_COLS = [13, 12, 50, 34, 50]
export const PARTS_HEAD = ['ITEM', 'QTY', 'PART NAME', 'MATERIAL', 'DESCRIPTION']

/** The text cut to fit a cell (3 mm of padding), with dots where it was cut. */
export function fitText(text: string, size: number, width: number): string {
  const room = width - 3
  if (textWidth(text, size) <= room) return text
  let t = text
  while (t.length > 1 && textWidth(t + '...', size) > room) t = t.slice(0, -1)
  return t + '...'
}
export const PARTS_ROW = 7

export function annotationPrims(a: Annotation, st: DrawingSettings, parts: Component[]): Prim[] {
  const owner = 'note:' + a.id
  const out: Prim[] = []
  switch (a.kind) {
    case 'note': {
      a.text.split('\n').forEach((ln, i) => out.push({ k: 'text', x: a.pos[0], y: a.pos[1] - a.size * (1 + i * 1.4), text: ln, size: a.size, anchor: 'start', owner }))
      // an invisible box so the whole note is easy to pick
      const lines = a.text.split('\n')
      const w = Math.max(...lines.map((l) => textWidth(l, a.size)), a.size)
      out.push({ k: 'path', pts: [a.pos[0], a.pos[1], a.pos[0] + w, a.pos[1], a.pos[0] + w, a.pos[1] - a.size * (0.4 + lines.length * 1.4), a.pos[0], a.pos[1] - a.size * (0.4 + lines.length * 1.4)], closed: true, style: 'thin', owner, pick: true })
      return out
    }
    case 'leader': {
      if (a.pts.length < 2) return out
      const flat = a.pts.flatMap((p) => p)
      out.push({ k: 'path', pts: flat, style: 'thin', owner })
      const tip = a.pts[0], nx = a.pts[1]
      out.push(arrowPrim(tip, [nx[0] - tip[0], nx[1] - tip[1]], st.arrowSize, owner))
      const last = a.pts[a.pts.length - 1], prev = a.pts[a.pts.length - 2]
      const right = last[0] >= prev[0]
      a.text.split('\n').forEach((ln, i) => out.push({ k: 'text', x: last[0] + (right ? 1.2 : -1.2), y: last[1] - a.size * 0.35 - i * a.size * 1.4, text: ln, size: a.size, anchor: right ? 'start' : 'end', owner }))
      return out
    }
    case 'gdt': {
      const h = st.textHeight * 2
      const [x0, y0] = a.pos
      let x = x0
      const y = y0 - h / 2
      const cells: { w: number; draw: (cx: number) => Prim[] }[] = []
      cells.push({
        w: h,
        draw: (cx) => {
          const g = GDT_GLYPHS[a.symbol]
          return g.paths.map((p) => ({ k: 'path', pts: p.pts.map((v, i) => (i % 2 === 0 ? cx + v * h : y + v * h)), closed: p.closed, style: 'thin', fill: p.fill ? 'solid' : 'none', owner }) as Prim)
        },
      })
      const tolText = (a.diameter ? 'Ø' : '') + a.tol
      const modW = a.modifier ? h * 0.75 : 0
      const tw = textWidth(tolText, st.textHeight) + h * 0.6 + modW
      cells.push({
        w: tw,
        draw: (cx) => {
          const prims: Prim[] = [{ k: 'text', x: cx + h * 0.3, y: y + h / 2 - st.textHeight * 0.35, text: tolText, size: st.textHeight, anchor: 'start', owner }]
          if (a.modifier) {
            const mx = cx + h * 0.3 + textWidth(tolText, st.textHeight) + h * 0.35
            prims.push({ k: 'path', pts: circlePts(mx, y + h / 2, h * 0.28, 24), closed: true, style: 'thin', owner })
            prims.push({ k: 'text', x: mx, y: y + h / 2 - st.textHeight * 0.3, text: a.modifier, size: st.textHeight * 0.7, anchor: 'middle', owner })
          }
          return prims
        },
      })
      for (const d of a.datums.filter(Boolean)) {
        cells.push({ w: h, draw: (cx) => [{ k: 'text', x: cx + h / 2, y: y + h / 2 - st.textHeight * 0.35, text: d, size: st.textHeight, anchor: 'middle', owner }] })
      }
      const total = cells.reduce((s, c) => s + c.w, 0)
      out.push(rect(x0, y, total, h, owner))
      for (const c of cells) {
        out.push(...c.draw(x))
        x += c.w
        if (x < x0 + total - 1e-9) out.push(seg([x, y, x, y + h], owner))
      }
      if (a.tip) {
        // leader from the nearer end of the frame to the tip
        const fromRight = a.tip[0] > x0 + total / 2
        const from: V2 = [fromRight ? x0 + total : x0, y + h / 2]
        out.push(seg([from[0], from[1], a.tip[0], a.tip[1]], owner))
        out.push(arrowPrim(a.tip, [from[0] - a.tip[0], from[1] - a.tip[1]], st.arrowSize, owner))
      }
      return out
    }
    case 'datum': {
      const s = st.textHeight * 2
      const [x0, y0] = a.pos
      out.push(rect(x0 - s / 2, y0 - s / 2, s, s, owner))
      out.push({ k: 'text', x: x0, y: y0 - st.textHeight * 0.35, text: a.letter, size: st.textHeight, anchor: 'middle', owner })
      const tip = a.tip ?? [x0, y0 - s / 2 - 6]
      const from: V2 = Math.abs(tip[0] - x0) > Math.abs(tip[1] - y0) ? [tip[0] > x0 ? x0 + s / 2 : x0 - s / 2, y0] : [x0, tip[1] < y0 ? y0 - s / 2 : y0 + s / 2]
      const dx = tip[0] - from[0], dy = tip[1] - from[1]
      const l = Math.hypot(dx, dy) || 1
      const tl = Math.min(l, st.arrowSize * 1.4)
      const ux = dx / l, uy = dy / l
      // line from the box to the base of the triangle, triangle with its base on the feature
      const base: V2 = [tip[0] - ux * tl, tip[1] - uy * tl]
      out.push(seg([from[0], from[1], base[0], base[1]], owner))
      const w = tl * 0.6
      out.push({ k: 'path', pts: [tip[0], tip[1], base[0] - uy * w, base[1] + ux * w, base[0] + uy * w, base[1] - ux * w], closed: true, style: 'thin', fill: 'solid', owner })
      return out
    }
    case 'finish': {
      const H = st.textHeight * 2.4
      const [x0, y0] = a.pos // the tip of the check mark
      const k = Math.tan(Math.PI / 6)
      const closed = a.method !== 'any'
      const lh = closed ? H : H / 2
      const lx = x0 - k * lh, ly = y0 + lh
      const rx = x0 + k * H, ry = y0 + H
      const label = a.ra ? 'Ra ' + a.ra : ''
      const barEnd = rx + Math.max(textWidth(label, st.textHeight) + 2, H * 0.6)
      out.push(seg([lx, ly, x0, y0, rx, ry, barEnd, ry], owner))
      if (a.method === 'removal') out.push(seg([lx, ly, rx, ry], owner))
      if (a.method === 'prohibited') {
        out.push(seg([lx, ly, rx, ry], owner))
        out.push({ k: 'path', pts: circlePts(x0, y0 + H * 0.58, H * 0.2), closed: true, style: 'thin', owner })
      }
      if (label) out.push({ k: 'text', x: rx + 1, y: ry + 0.8, text: label, size: st.textHeight, anchor: 'start', owner })
      if (a.allowance) out.push({ k: 'text', x: lx - 1, y: ry + 0.8, text: a.allowance, size: st.textHeight, anchor: 'end', owner })
      if (a.lay) out.push({ k: 'text', x: rx + 1, y: ry - st.textHeight * 1.4, text: a.lay, size: st.textHeight, anchor: 'start', owner })
      out.push({ k: 'path', pts: [lx - 2, y0 - 1, barEnd, y0 - 1, barEnd, ry + st.textHeight * 1.4, lx - 2, ry + st.textHeight * 1.4], closed: true, style: 'thin', owner, pick: true })
      return out
    }
    case 'balloon': {
      const r = 5
      const n = partNumber(parts, a.item)
      const dx = a.tip[0] - a.pos[0], dy = a.tip[1] - a.pos[1]
      const l = Math.hypot(dx, dy) || 1
      out.push({ k: 'path', pts: circlePts(a.pos[0], a.pos[1], r), closed: true, style: 'thin', owner })
      out.push({ k: 'text', x: a.pos[0], y: a.pos[1] - st.textHeight * 0.35, text: n ? String(n) : '?', size: st.textHeight, anchor: 'middle', owner })
      out.push(seg([a.pos[0] + (dx / l) * r, a.pos[1] + (dy / l) * r, a.tip[0], a.tip[1]], owner))
      out.push({ k: 'path', pts: circlePts(a.tip[0], a.tip[1], 0.7, 12), closed: true, style: 'thin', fill: 'solid', owner })
      return out
    }
    case 'partsList': {
      const w = PARTS_COLS.reduce((s, c) => s + c, 0)
      const rows = parts.length + 1
      const h = rows * PARTS_ROW
      const [x0, y0] = a.pos // lower left
      out.push(rect(x0, y0, w, h, owner, 'visible'))
      let x = x0
      PARTS_COLS.forEach((cw, i) => {
        out.push({ k: 'text', x: x + 1.5, y: y0 + h - PARTS_ROW + 2, text: PARTS_HEAD[i], size: st.textHeight * 0.8, anchor: 'start', bold: true, owner })
        x += cw
        if (i < PARTS_COLS.length - 1) out.push(seg([x, y0, x, y0 + h], owner))
      })
      for (let r = 1; r < rows; r++) out.push(seg([x0, y0 + r * PARTS_ROW, x0 + w, y0 + r * PARTS_ROW], owner))
      parts.forEach((p, i) => {
        const y = y0 + h - (i + 2) * PARTS_ROW + 2
        let cx = x0
        const cells = [String(i + 1), String(p.qty), p.name, p.material, p.description]
        cells.forEach((t, k) => {
          if (t) out.push({ k: 'text', x: cx + 1.5, y, text: fitText(t, st.textHeight * 0.8, PARTS_COLS[k]), size: st.textHeight * 0.8, anchor: 'start', owner })
          cx += PARTS_COLS[k]
        })
      })
      return out
    }
  }
}
