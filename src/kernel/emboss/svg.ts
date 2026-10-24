/**
 * Small SVG reader for logos: paths, rectangles, circles, ellipses, polygons, polylines and lines, nested groups with
 * transforms, fill / stroke styles. White fills count as empty (a white background does not become a slab). Pure code, no DOM.
 */
import { cleanLoop, flattenCubic, flattenQuad, type Artwork, type Shape2D, type Stroke, type V2 } from './shapes'

type M = [number, number, number, number, number, number] // a b c d e f: x' = a x + c y + e, y' = b x + d y + f
const ID: M = [1, 0, 0, 1, 0, 0]
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
]
const apply = (m: M, p: V2): V2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]
const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))

function parseTransform(t: string | undefined): M {
  let m = ID
  if (!t) return m
  for (const [, name, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number)
    let n: M = ID
    if (name === 'translate') n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
    else if (name === 'scale') n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]
    else if (name === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
      n = [c, s, -s, c, 0, 0]
      if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]])
    } else if (name === 'matrix' && a.length >= 6) n = [a[0], a[1], a[2], a[3], a[4], a[5]]
    else if (name === 'skewX') n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]
    else if (name === 'skewY') n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]
    m = mul(m, n)
  }
  return m
}

interface Style { fill: string; fillRule: 'NonZero' | 'EvenOdd'; stroke: string; strokeWidth: number; opacity: number }

const NAMED_WHITE = new Set(['white', '#fff', '#ffffff', '#fffffe', 'rgb(255,255,255)'])
function isEmptyPaint(c: string): boolean {
  const v = c.trim().toLowerCase().replace(/\s+/g, '')
  if (v === 'none' || v === 'transparent' || v === '') return true
  if (NAMED_WHITE.has(v)) return true
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((x) => x + x).join('') : hex[1]
    const lum = (parseInt(h.slice(0, 2), 16) * 0.299 + parseInt(h.slice(2, 4), 16) * 0.587 + parseInt(h.slice(4, 6), 16) * 0.114) / 255
    return lum > 0.94
  }
  return false
}

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [, k, a, b] of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[k] = a ?? b
  const st = out.style
  if (st) for (const decl of st.split(';')) { const i = decl.indexOf(':'); if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim() }
  return out
}

const num = (s: string | undefined, d = 0) => { const v = parseFloat(s ?? ''); return Number.isFinite(v) ? v : d }

/** Path data to subpaths: each a polyline with a closed flag. Curves are flattened to `tol` user units. */
export function pathPolylines(d: string, tol: number): { pts: V2[]; closed: boolean }[] {
  const out: { pts: V2[]; closed: boolean }[] = []
  let i = 0
  const n = d.length
  const skip = () => { while (i < n && /[\s,]/.test(d[i])) i++ }
  const number = (): number | null => {
    skip()
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(d.slice(i, i + 40))
    if (!m) return null
    i += m[0].length
    return parseFloat(m[0])
  }
  const flag = (): number | null => { skip(); if (d[i] === '0' || d[i] === '1') return +d[i++]; return null }
  let cur: V2 = [0, 0], start: V2 = [0, 0]
  let pts: V2[] = []
  let cmd = ''
  let lastC: V2 | null = null, lastQ: V2 | null = null
  const finish = (closed: boolean) => { if (pts.length > 1) out.push({ pts, closed }); pts = [] }
  while (true) {
    skip()
    if (i >= n) break
    if (/[a-zA-Z]/.test(d[i])) cmd = d[i++]
    else if (!cmd) break
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const P = (x: number, y: number): V2 => (rel ? [cur[0] + x, cur[1] + y] : [x, y])
    if (C === 'Z') { if (pts.length) { cur = start } finish(true); lastC = lastQ = null; cmd = ''; continue }
    if (C === 'M') {
      const x = number(), y = number()
      if (x === null || y === null) break
      finish(false)
      cur = P(x, y); start = cur; pts = [cur]
      cmd = rel ? 'l' : 'L'
      lastC = lastQ = null
      continue
    }
    if (C === 'L') { const x = number(), y = number(); if (x === null || y === null) break; cur = P(x, y); pts.push(cur); lastC = lastQ = null; continue }
    if (C === 'H') { const x = number(); if (x === null) break; cur = [rel ? cur[0] + x : x, cur[1]]; pts.push(cur); lastC = lastQ = null; continue }
    if (C === 'V') { const y = number(); if (y === null) break; cur = [cur[0], rel ? cur[1] + y : y]; pts.push(cur); lastC = lastQ = null; continue }
    if (C === 'C' || C === 'S') {
      let c1: V2
      if (C === 'C') { const a = number(), b = number(); if (a === null || b === null) break; c1 = P(a, b) } else c1 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur
      const a2 = number(), b2 = number(), x = number(), y = number()
      if (a2 === null || b2 === null || x === null || y === null) break
      const c2 = P(a2, b2), e = P(x, y)
      flattenCubic(cur, c1, c2, e, tol, pts)
      lastC = c2; lastQ = null; cur = e
      continue
    }
    if (C === 'Q' || C === 'T') {
      let c1: V2
      if (C === 'Q') { const a = number(), b = number(); if (a === null || b === null) break; c1 = P(a, b) } else c1 = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur
      const x = number(), y = number()
      if (x === null || y === null) break
      const e = P(x, y)
      flattenQuad(cur, c1, e, tol, pts)
      lastQ = c1; lastC = null; cur = e
      continue
    }
    if (C === 'A') {
      const rx0 = number(), ry0 = number(), rot = number(), fa = flag(), fs = flag(), x = number(), y = number()
      if (rx0 === null || ry0 === null || rot === null || fa === null || fs === null || x === null || y === null) break
      const e = P(x, y)
      arcPoints(cur, e, Math.abs(rx0), Math.abs(ry0), rot, !!fa, !!fs, tol, pts)
      cur = e; lastC = lastQ = null
      continue
    }
    break
  }
  finish(false)
  return out
}

/** SVG elliptical arc (endpoint form) as points after the start point. */
function arcPoints(p0: V2, p1: V2, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, tol: number, out: V2[]) {
  if (rx < 1e-9 || ry < 1e-9 || (p0[0] === p1[0] && p0[1] === p1[1])) { out.push(p1); return }
  const phi = (rotDeg * Math.PI) / 180, c = Math.cos(phi), s = Math.sin(phi)
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2
  const x1 = c * dx + s * dy, y1 = -s * dx + c * dy
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx
  const cx = c * cxp - s * cyp + (p0[0] + p1[0]) / 2, cy = s * cxp + c * cyp + (p0[1] + p1[1]) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const th1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
  let dth = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
  if (!sweep && dth > 0) dth -= 2 * Math.PI
  else if (sweep && dth < 0) dth += 2 * Math.PI
  const r = Math.max(rx, ry)
  const step = Math.max(0.05, Math.min(0.6, 2 * Math.acos(Math.max(0, 1 - tol / r))))
  const nseg = Math.max(2, Math.min(200, Math.ceil(Math.abs(dth) / step)))
  for (let k = 1; k <= nseg; k++) {
    const t = th1 + (dth * k) / nseg
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t)
    out.push([c * ex - s * ey + cx, s * ex + c * ey + cy])
  }
  out[out.length - 1] = p1
}

const ellipsePoly = (cx: number, cy: number, rx: number, ry: number, tol: number): V2[] => {
  const r = Math.max(rx, ry)
  const n = Math.max(16, Math.min(160, Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - tol / Math.max(r, 1e-9))))))
  return Array.from({ length: n }, (_, k) => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)] as V2)
}

const SKIP = new Set(['defs', 'clippath', 'mask', 'symbol', 'style', 'script', 'title', 'desc', 'metadata', 'pattern', 'marker', 'filter', 'lineargradient', 'radialgradient'])

/** Read an SVG document into filled loops (y up) and strokes. Throws a readable error when nothing drawable is found. */
export function parseSvg(text: string): Artwork {
  const root = /<svg\b([^>]*)>/i.exec(text)
  if (!root) throw new Error('This file is not an SVG image')
  const ra = attrsOf(root[1])
  const vb = (ra.viewBox ?? '').split(/[\s,]+/).map(Number)
  const size = vb.length === 4 && vb.every(Number.isFinite) ? Math.max(vb[2], vb[3]) : Math.max(num(ra.width, 1000), num(ra.height, 1000))
  const tol = Math.max(size, 1) / 4000
  const parts: Shape2D[] = []
  const strokes: Stroke[] = []
  const stack: { m: M; style: Style; skip: boolean; tag: string }[] = [{ m: ID, style: { fill: '#000', fillRule: 'NonZero', stroke: 'none', strokeWidth: 1, opacity: 1 }, skip: false, tag: 'svg' }]
  const toLoops = (m: M, pts: V2[]): V2[] => cleanLoop(pts.map((p) => apply(m, p)))
  const draw = (tag: string, a: Record<string, string>, top: (typeof stack)[number]) => {
    const m = top.m, st = top.style
    const polylines: { pts: V2[]; closed: boolean }[] = []
    if (tag === 'path') polylines.push(...pathPolylines(a.d ?? '', tol))
    else if (tag === 'rect') {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height)
      let rx = num(a.rx, num(a.ry)), ry = num(a.ry, rx)
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2)
      if (w <= 0 || h <= 0) return
      if (rx > 0 && ry > 0) {
        const d = `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
        polylines.push(...pathPolylines(d, tol))
      } else polylines.push({ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true })
    } else if (tag === 'circle') { const r = num(a.r); if (r > 0) polylines.push({ pts: ellipsePoly(num(a.cx), num(a.cy), r, r, tol), closed: true }) }
    else if (tag === 'ellipse') { const rx = num(a.rx), ry = num(a.ry); if (rx > 0 && ry > 0) polylines.push({ pts: ellipsePoly(num(a.cx), num(a.cy), rx, ry, tol), closed: true }) }
    else if (tag === 'polygon' || tag === 'polyline') {
      const v = (a.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
      const pts: V2[] = []
      for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]])
      if (pts.length > 1) polylines.push({ pts, closed: tag === 'polygon' })
    } else if (tag === 'line') polylines.push({ pts: [[num(a.x1), num(a.y1)], [num(a.x2), num(a.y2)]], closed: false })
    else return
    const fillOn = !isEmptyPaint(st.fill) && st.opacity > 0
    if (fillOn) {
      const loops = polylines.map((pl) => toLoops(m, pl.pts)).filter((l) => l.length >= 3)
      if (loops.length) parts.push({ loops, rule: st.fillRule })
    }
    const strokeOn = !isEmptyPaint(st.stroke) && st.strokeWidth > 0 && st.opacity > 0
    if (strokeOn) {
      const w = st.strokeWidth * scaleOf(m)
      for (const pl of polylines) {
        const pts = pl.pts.map((p) => apply(m, p))
        if (pts.length > 1) strokes.push({ points: pts, closed: pl.closed, width: w })
      }
    }
  }
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g
  let first = true
  for (const [, close, rawTag, rest, self] of text.matchAll(tagRe)) {
    const tag = rawTag.toLowerCase()
    if (close) {
      if (stack.length > 1 && stack[stack.length - 1].tag === tag) stack.pop()
      continue
    }
    const top = stack[stack.length - 1]
    const a = attrsOf(rest)
    if (tag === 'svg') {
      if (first) {
        first = false
        if (vb.length === 4 && vb.every(Number.isFinite)) {
          // the viewBox origin becomes the drawing origin (fitting to a width makes the scale irrelevant)
          stack[0] = { ...stack[0], m: [1, 0, 0, 1, -vb[0], -vb[1]] }
        }
      }
      continue
    }
    const style: Style = {
      fill: a.fill ?? top.style.fill,
      fillRule: (a['fill-rule'] ?? '') === 'evenodd' ? 'EvenOdd' : (a['fill-rule'] ?? '') === 'nonzero' ? 'NonZero' : top.style.fillRule,
      stroke: a.stroke ?? top.style.stroke,
      strokeWidth: a['stroke-width'] !== undefined ? num(a['stroke-width'], 1) : top.style.strokeWidth,
      opacity: a.opacity !== undefined ? num(a.opacity, 1) * top.style.opacity : top.style.opacity,
    }
    if ((a.display ?? '') === 'none' || (a.visibility ?? '') === 'hidden') style.opacity = 0
    const node = { m: mul(top.m, parseTransform(a.transform)), style, skip: top.skip || SKIP.has(tag), tag }
    if (!node.skip) draw(tag, a, node)
    if (!self) stack.push(node)
  }
  if (!parts.length && !strokes.length) throw new Error('No drawable shapes were found in the SVG (white and empty fills are ignored)')
  // SVG y points down
  const flip = (p: V2): V2 => [p[0], -p[1]]
  return {
    parts: parts.map((p) => ({ rule: p.rule, loops: p.loops.map((l) => l.map(flip)) })),
    strokes: strokes.map((s) => ({ ...s, points: s.points.map(flip) })),
  }
}
