/** SVG output of a sheet: real paths and text, one group per line style. */
import { FONT_STACK, LINE_STYLES } from '../styles'
import type { LineStyle, Prim } from '../types'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n = (v: number) => String(+v.toFixed(3))

export function pathData(pts: number[], h: number, closed?: boolean): string {
  let d = ''
  for (let i = 0; i < pts.length; i += 2) d += (i === 0 ? 'M' : 'L') + n(pts[i]) + ' ' + n(h - pts[i + 1])
  return closed ? d + 'Z' : d
}

/** A sheet of w x h mm as a standalone SVG document (millimetre units, y flipped to screen orientation). */
export function sheetToSvg(prims: Prim[], w: number, h: number, title = 'Drawing'): string {
  const groups = new Map<LineStyle, string[]>()
  const texts: string[] = []
  for (const p of prims) {
    if (p.k === 'path') {
      if (p.pick || p.pts.length < 4) continue
      const spec = LINE_STYLES[p.style]
      const fill = p.fill === 'solid' ? ' fill="#000" stroke="none"' : ''
      ;(groups.get(p.style) ?? groups.set(p.style, []).get(p.style)!).push(`<path d="${pathData(p.pts, h, p.closed)}"${fill}${spec.dash.length && !fill ? ` stroke-dasharray="${spec.dash.join(' ')}"` : ''}/>`)
    } else {
      const rot = p.rot ? ` transform="rotate(${n(-p.rot)} ${n(p.x)} ${n(h - p.y)})"` : ''
      texts.push(`<text x="${n(p.x)}" y="${n(h - p.y)}" font-size="${n(p.size)}" text-anchor="${p.anchor}"${p.bold ? ' font-weight="700"' : ''}${rot}>${esc(p.text)}</text>`)
    }
  }
  const out: string[] = []
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`)
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}mm" height="${n(h)}mm" viewBox="0 0 ${n(w)} ${n(h)}">`)
  out.push(`<title>${esc(title)}</title>`)
  out.push(`<rect width="${n(w)}" height="${n(h)}" fill="#fff"/>`)
  for (const [style, list] of groups) {
    const spec = LINE_STYLES[style]
    out.push(`<g id="${spec.layer.toLowerCase()}-${style}" fill="none" stroke="#000" stroke-width="${spec.width}" stroke-linecap="round" stroke-linejoin="round">`)
    out.push(...list)
    out.push('</g>')
  }
  out.push(`<g id="text" font-family="${esc(FONT_STACK)}" fill="#000">`)
  out.push(...texts)
  out.push('</g>')
  out.push('</svg>')
  return out.join('\n')
}
