/**
 * SVG and DXF import for sketches. Both parsers are written here (no libraries, nothing fetched): they produce a list of simple
 * shapes in millimetres with y pointing up, and `insertImported` turns those into sketch entities.
 */
import { arcBeziers, type Bez } from './bezier'
import { dist, TAU } from './geom'
import { addArc, addCircle, addEllipse, addLine, addPoint, addSpline } from './model'
import type { SketchModel, Vec2 } from './types'

export type Imp =
  | { k: 'line'; a: Vec2; b: Vec2 }
  | { k: 'arc'; c: Vec2; r: number; a0: number; a1: number }
  | { k: 'circle'; c: Vec2; r: number }
  | { k: 'ellipse'; c: Vec2; major: Vec2; minor: number }
  | { k: 'bez'; pts: Vec2[] }
  | { k: 'fit'; pts: Vec2[]; closed: boolean }
  | { k: 'point'; p: Vec2 }

export interface Imported { shapes: Imp[]; notes: string[] }

// ------------------------------------------------------------------------------------------------ affine maps

type Mat = [number, number, number, number, number, number] // a b c d e f: x' = a x + c y + e, y' = b x + d y + f
const I: Mat = [1, 0, 0, 1, 0, 0]
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
]
const ap = (m: Mat, p: Vec2): Vec2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]

/** True when the map keeps circles circular: equal scale on both axes, no skew. */
function similarity(m: Mat): { s: number; flip: boolean; rot: number } | null {
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3])
  if (Math.abs(sx - sy) > 1e-9 * Math.max(sx, sy, 1) || Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-9 * sx * sy) return null
  return { s: sx, flip: m[0] * m[3] - m[1] * m[2] < 0, rot: Math.atan2(m[1], m[0]) }
}

function parseTransform(t: string | undefined): Mat {
  let m = I
  if (!t) return m
  for (const part of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = part[2].split(/[\s,]+/).filter(Boolean).map(Number)
    let n: Mat = I
    switch (part[1]) {
      case 'matrix': if (v.length === 6) n = v as Mat; break
      case 'translate': n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break
      case 'scale': n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break
      case 'rotate': {
        const a = ((v[0] ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
        n = [c, s, -s, c, 0, 0]
        if (v.length >= 3) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]])
        break
      }
      case 'skewX': n = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break
      case 'skewY': n = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break
    }
    m = mul(m, n)
  }
  return m
}

// ------------------------------------------------------------------------------------------------ shapes in user space

type UShape =
  | { k: 'line'; a: Vec2; b: Vec2 }
  | { k: 'cubic'; p: Bez }
  | { k: 'arc'; c: Vec2; rx: number; ry: number; rot: number; a0: number; span: number }
  | { k: 'ellipse'; c: Vec2; rx: number; ry: number }

/** Ellipse (centre, radii, x-rotation) between angles a0 and a0 + span as cubic pieces. */
function ellipseArcCubics(c: Vec2, rx: number, ry: number, rot: number, a0: number, span: number): Bez[] {
  const unit = arcBeziers([0, 0], 1, a0, span)
  const cs = Math.cos(rot), sn = Math.sin(rot)
  const f = (p: Vec2): Vec2 => [c[0] + rx * p[0] * cs - ry * p[1] * sn, c[1] + rx * p[0] * sn + ry * p[1] * cs]
  return unit.map((b) => [f(b[0]), f(b[1]), f(b[2]), f(b[3])] as Bez)
}

/** SVG endpoint arc -> centre parameterisation (SVG 1.1 appendix F.6). */
function svgArc(p0: Vec2, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, p1: Vec2): UShape[] {
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn)
  if ((p0[0] === p1[0] && p0[1] === p1[1])) return []
  if (rx < 1e-12 || ry < 1e-12) return [{ k: 'line', a: p0, b: p1 }]
  const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi)
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam) }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  let co = Math.sqrt(Math.max(0, num / (den || 1)))
  if (large === sweep) co = -co
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx
  const cx = cp * cxp - sp * cyp + (p0[0] + p1[0]) / 2, cy = sp * cxp + cp * cyp + (p0[1] + p1[1]) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const a0 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
  let span = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
  if (!sweep && span > 0) span -= TAU
  else if (sweep && span < 0) span += TAU
  return [{ k: 'arc', c: [cx, cy], rx, ry, rot: phi, a0, span }]
}

function parsePath(d: string): UShape[] {
  const out: UShape[] = []
  const tokens: (string | number)[] = [...d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g)].map((t): string | number => t[1] ?? Number(t[2]))
  let i = 0, cmd = '', cur: Vec2 = [0, 0], start: Vec2 = [0, 0], lastC: Vec2 | null = null, lastQ: Vec2 | null = null
  const num = () => tokens[i++] as number
  const flag = () => {
    // arc flags may be written without separators ("a1 1 0 00 1 1"); numbers were tokenised greedily, so split a 2-digit token
    const t = tokens[i]
    if (typeof t === 'number' && t > 1 && Number.isInteger(t) && String(t).length > 1) {
      const s = String(t)
      tokens[i] = Number(s.slice(1))
      return Number(s[0])
    }
    return num()
  }
  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') cmd = tokens[i++] as string
    else if (!cmd) break
    const rel = cmd === cmd.toLowerCase()
    const pt = (x: number, y: number): Vec2 => (rel ? [cur[0] + x, cur[1] + y] : [x, y])
    switch (cmd.toUpperCase()) {
      case 'M': { const p = pt(num(), num()); cur = start = p; cmd = rel ? 'l' : 'L'; lastC = lastQ = null; break }
      case 'L': { const p = pt(num(), num()); out.push({ k: 'line', a: cur, b: p }); cur = p; lastC = lastQ = null; break }
      case 'H': { const x = num(); const p: Vec2 = [rel ? cur[0] + x : x, cur[1]]; out.push({ k: 'line', a: cur, b: p }); cur = p; lastC = lastQ = null; break }
      case 'V': { const y = num(); const p: Vec2 = [cur[0], rel ? cur[1] + y : y]; out.push({ k: 'line', a: cur, b: p }); cur = p; lastC = lastQ = null; break }
      case 'C': { const c1 = pt(num(), num()), c2 = pt(num(), num()), p = pt(num(), num()); out.push({ k: 'cubic', p: [cur, c1, c2, p] }); cur = p; lastC = c2; lastQ = null; break }
      case 'S': {
        const c1: Vec2 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur
        const c2 = pt(num(), num()), p = pt(num(), num())
        out.push({ k: 'cubic', p: [cur, c1, c2, p] }); cur = p; lastC = c2; lastQ = null; break
      }
      case 'Q': {
        const q = pt(num(), num()), p = pt(num(), num())
        out.push({ k: 'cubic', p: [cur, [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p] })
        cur = p; lastQ = q; lastC = null; break
      }
      case 'T': {
        const q: Vec2 = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur
        const p = pt(num(), num())
        out.push({ k: 'cubic', p: [cur, [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p] })
        cur = p; lastQ = q; lastC = null; break
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = flag() !== 0, sweep = flag() !== 0, p = pt(num(), num())
        out.push(...svgArc(cur, rx, ry, rot, large, sweep, p)); cur = p; lastC = lastQ = null; break
      }
      case 'Z': { if (dist(cur, start) > 1e-9) out.push({ k: 'line', a: cur, b: start }); cur = start; lastC = lastQ = null; break }
      default: i++
    }
  }
  return out
}

// ------------------------------------------------------------------------------------------------ SVG

const UNITS: Record<string, number> = { '': 25.4 / 96, px: 25.4 / 96, pt: 25.4 / 72, pc: 25.4 / 6, mm: 1, cm: 10, in: 25.4 }
function length(s: string | undefined): number | null {
  const m = /^\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(s ?? '')
  return m && m[2] !== '%' ? Number(m[1]) * (UNITS[m[2].toLowerCase()] ?? 25.4 / 96) : null
}

const attrs = (src: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const a of src.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[a[1]] = a[2] ?? a[3]
  return out
}

/** Read an SVG document: paths and basic shapes, with their transforms, in millimetres and y up. */
export function parseSvg(text: string): Imported {
  const notes: string[] = []
  const root = /<svg\b([^>]*)>/i.exec(text)
  if (!root) throw new Error('This is not an SVG file')
  const ra = attrs(root[1])
  const vb = (ra.viewBox ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
  const w = length(ra.width), h = length(ra.height)
  // user units per millimetre: from the viewBox and the stated size, else a user unit is a CSS pixel
  let k = 25.4 / 96
  if (vb.length === 4 && vb[2] > 0 && w !== null) k = w / vb[2]
  else if (vb.length === 4 && vb[3] > 0 && h !== null) k = h / vb[3]
  const base: Mat = vb.length === 4 ? [1, 0, 0, 1, -vb[0], -vb[1]] : I
  const shapes: Imp[] = []
  const stack: Mat[] = [mul([k, 0, 0, -k, 0, 0], base)]
  const skip: string[] = []
  for (const tag of text.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const closing = tag[1] === '/', name = tag[2].toLowerCase(), selfClose = tag[4] === '/'
    if (closing) {
      if (skip.length && skip[skip.length - 1] === name) skip.pop()
      else if (!skip.length && (name === 'g' || name === 'svg' || name === 'a' || name === 'symbol') && stack.length > 1) stack.pop()
      continue
    }
    if (skip.length) { if (!selfClose && (name === 'defs' || name === 'clippath' || name === 'mask' || name === 'pattern' || name === 'metadata')) skip.push(name); continue }
    if (name === 'defs' || name === 'clippath' || name === 'mask' || name === 'pattern' || name === 'metadata') { if (!selfClose) skip.push(name); continue }
    const a = attrs(tag[3])
    if (name === 'svg') continue
    const m = mul(stack[stack.length - 1], parseTransform(a.transform))
    if (name === 'g' || name === 'a' || name === 'symbol') { if (!selfClose) stack.push(m); continue }
    const us: UShape[] = []
    const n = (v: string | undefined, d = 0) => (v === undefined ? d : Number(v.replace(/[a-z%]+$/i, '')) || d)
    switch (name) {
      case 'path': us.push(...parsePath(a.d ?? '')); break
      case 'line': us.push({ k: 'line', a: [n(a.x1), n(a.y1)], b: [n(a.x2), n(a.y2)] }); break
      case 'polyline':
      case 'polygon': {
        const v = (a.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
        const pts: Vec2[] = []
        for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]])
        for (let i = 0; i + 1 < pts.length; i++) us.push({ k: 'line', a: pts[i], b: pts[i + 1] })
        if (name === 'polygon' && pts.length > 2) us.push({ k: 'line', a: pts[pts.length - 1], b: pts[0] })
        break
      }
      case 'rect': {
        const x = n(a.x), y = n(a.y), rw = n(a.width), rh = n(a.height)
        let rx = a.rx !== undefined ? n(a.rx) : a.ry !== undefined ? n(a.ry) : 0
        let ry = a.ry !== undefined ? n(a.ry) : rx
        rx = Math.min(rx, rw / 2); ry = Math.min(ry, rh / 2)
        if (rw <= 0 || rh <= 0) break
        if (rx <= 0 || ry <= 0) {
          const c: Vec2[] = [[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]]
          for (let i = 0; i < 4; i++) us.push({ k: 'line', a: c[i], b: c[(i + 1) % 4] })
        } else {
          const P = (px: number, py: number): Vec2 => [px, py]
          us.push({ k: 'line', a: P(x + rx, y), b: P(x + rw - rx, y) }, ...svgArc(P(x + rw - rx, y), rx, ry, 0, false, true, P(x + rw, y + ry)))
          us.push({ k: 'line', a: P(x + rw, y + ry), b: P(x + rw, y + rh - ry) }, ...svgArc(P(x + rw, y + rh - ry), rx, ry, 0, false, true, P(x + rw - rx, y + rh)))
          us.push({ k: 'line', a: P(x + rw - rx, y + rh), b: P(x + rx, y + rh) }, ...svgArc(P(x + rx, y + rh), rx, ry, 0, false, true, P(x, y + rh - ry)))
          us.push({ k: 'line', a: P(x, y + rh - ry), b: P(x, y + ry) }, ...svgArc(P(x, y + ry), rx, ry, 0, false, true, P(x + rx, y)))
        }
        break
      }
      case 'circle': if (n(a.r) > 0) us.push({ k: 'ellipse', c: [n(a.cx), n(a.cy)], rx: n(a.r), ry: n(a.r) }); break
      case 'ellipse': if (n(a.rx) > 0 && n(a.ry) > 0) us.push({ k: 'ellipse', c: [n(a.cx), n(a.cy)], rx: n(a.rx), ry: n(a.ry) }); break
      case 'text': case 'image': case 'use': notes.push(`<${name}> was skipped (convert it to paths first)`); break
      default: break
    }
    const sim = similarity(m)
    const run: Bez[] = []
    const flush = () => { if (run.length) { shapes.push({ k: 'bez', pts: [run[0][0], ...run.flatMap((b) => [b[1], b[2], b[3]])] }); run.length = 0 } }
    const addBez = (b: Bez) => {
      const t = b.map((p) => ap(m, p)) as Bez
      if (run.length && dist(run[run.length - 1][3], t[0]) > 1e-9) flush()
      run.push(t)
    }
    for (const s of us) {
      if (s.k !== 'cubic') flush()
      if (s.k === 'line') {
        const a2 = ap(m, s.a), b2 = ap(m, s.b)
        if (dist(a2, b2) > 1e-9) shapes.push({ k: 'line', a: a2, b: b2 })
      } else if (s.k === 'cubic') addBez(s.p)
      else if (s.k === 'ellipse') {
        if (sim && Math.abs(s.rx - s.ry) < 1e-9 * s.rx) shapes.push({ k: 'circle', c: ap(m, s.c), r: s.rx * sim.s })
        else {
          const cs = ellipseArcCubics(s.c, s.rx, s.ry, 0, 0, TAU).map((b) => b.map((p) => ap(m, p)) as Bez)
          shapes.push({ k: 'bez', pts: [cs[0][0], ...cs.flatMap((b) => [b[1], b[2], b[3]])] })
        }
      } else {
        if (sim && Math.abs(s.rx - s.ry) < 1e-9 * s.rx) {
          // a circular arc stays a circular arc under a similarity; a reflection reverses its sense
          const c2 = ap(m, s.c)
          const at = (a: number) => ap(m, [s.c[0] + s.rx * Math.cos(a + s.rot), s.c[1] + s.rx * Math.sin(a + s.rot)])
          const sp = at(s.a0), ep = at(s.a0 + s.span)
          // the page map flips y, so a positive sweep in SVG space runs clockwise on screen unless the map reflects again
          const ccw = (s.span > 0) === !sim.flip
          const aS = Math.atan2(sp[1] - c2[1], sp[0] - c2[0]), aE = Math.atan2(ep[1] - c2[1], ep[0] - c2[0])
          shapes.push(ccw ? { k: 'arc', c: c2, r: s.rx * sim.s, a0: aS, a1: aE } : { k: 'arc', c: c2, r: s.rx * sim.s, a0: aE, a1: aS })
        } else {
          for (const b of ellipseArcCubics(s.c, s.rx, s.ry, s.rot, s.a0, s.span)) addBez(b)
        }
      }
    }
    flush()
  }
  // normalise: arcs need a1 > a0
  for (const s of shapes) if (s.k === 'arc') { while (s.a1 <= s.a0 + 1e-12) s.a1 += TAU }
  if (!shapes.length) notes.push('No paths or shapes were found in this SVG')
  return { shapes, notes }
}

// ------------------------------------------------------------------------------------------------ DXF

interface Pair { c: number; v: string }
function pairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/)
  const out: Pair[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i].trim(), 10)
    if (Number.isNaN(c)) { i--; continue }
    out.push({ c, v: lines[i + 1].trim() })
  }
  return out
}

/** Arc through two vertices with a polyline bulge (tan of a quarter of the included angle), or a plain line when it is 0. */
function bulgeSeg(p: Vec2, q: Vec2, bulge: number): Imp | null {
  if (dist(p, q) < 1e-12) return null
  if (Math.abs(bulge) < 1e-9) return { k: 'line', a: p, b: q }
  const theta = 4 * Math.atan(bulge)
  const chord = dist(p, q), r = Math.abs(chord / (2 * Math.sin(theta / 2)))
  const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
  const d = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2))
  const nx = -(q[1] - p[1]) / chord, ny = (q[0] - p[0]) / chord
  // for a positive bulge (counter-clockwise) the centre lies to the left of the chord when the arc is under a half circle
  const sign = (bulge > 0) === (Math.abs(theta) < Math.PI) ? 1 : -1
  const c: Vec2 = [mid[0] + nx * d * sign, mid[1] + ny * d * sign]
  const a0 = Math.atan2(p[1] - c[1], p[0] - c[0]), a1 = Math.atan2(q[1] - c[1], q[0] - c[0])
  return bulge > 0 ? { k: 'arc', c, r, a0, a1 } : { k: 'arc', c, r, a0: a1, a1: a0 }
}

/** De Boor evaluation of a B-spline of the given degree. */
function nurbsAt(deg: number, knots: number[], P: Vec2[], u: number): Vec2 {
  let k = deg
  while (k < P.length - 1 && u >= knots[k + 1]) k++
  const d = P.slice(k - deg, k + 1).map((q) => [...q] as Vec2)
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const den = knots[j + 1 + k - r] - knots[j + k - deg]
      const a = den < 1e-12 ? 0 : (u - knots[j + k - deg]) / den
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]]
    }
  }
  return d[deg]
}

/** $INSUNITS code -> millimetres per unit */
const INS_SCALE: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 10: 914.4 }

/** Read an ASCII DXF: lines, circles, arcs, polylines (with bulges), ellipses, splines and points. */
export function parseDxf(text: string): Imported {
  const notes: string[] = []
  const ps = pairs(text)
  if (!ps.length || !/SECTION|ENTITIES|EOF/.test(text)) throw new Error('This is not an ASCII DXF file (binary DXF is not supported: save it as ASCII)')
  // units from the header
  let scale = 1
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].c === 9 && ps[i].v === '$INSUNITS') {
      const u = parseInt(ps[i + 1]?.v ?? '0', 10)
      if (INS_SCALE[u]) scale = INS_SCALE[u]
      break
    }
  }
  // entities section
  let i = ps.findIndex((p, n) => p.c === 2 && p.v === 'ENTITIES' && ps[n - 1]?.c === 0 && ps[n - 1].v === 'SECTION')
  if (i < 0) throw new Error('This DXF has no entities')
  const shapes: Imp[] = []
  const s = (v: Vec2): Vec2 => [v[0] * scale, v[1] * scale]
  const skipped = new Map<string, number>()
  const num = (rec: Pair[], code: number, d = 0) => { const f = rec.find((p) => p.c === code); return f ? Number(f.v) : d }
  const polyVerts: { p: Vec2; bulge: number }[] = []
  let poly: { closed: boolean } | null = null
  const flushPoly = () => {
    if (!poly) return
    const v = polyVerts.splice(0)
    const n = v.length
    for (let k = 0; k + 1 < n || (poly.closed && k < n); k++) {
      const seg = bulgeSeg(s(v[k].p), s(v[(k + 1) % n].p), v[k].bulge)
      if (seg) shapes.push(seg)
    }
    poly = null
  }
  for (i++; i < ps.length; ) {
    if (ps[i].c !== 0) { i++; continue }
    const type = ps[i].v
    if (type === 'ENDSEC') break
    let j = i + 1
    while (j < ps.length && ps[j].c !== 0) j++
    const rec = ps.slice(i + 1, j)
    i = j
    if (type === 'VERTEX' && poly) { polyVerts.push({ p: [num(rec, 10), num(rec, 20)], bulge: num(rec, 42) }); continue }
    if (type === 'SEQEND') { flushPoly(); continue }
    flushPoly()
    switch (type) {
      case 'LINE': { const a = s([num(rec, 10), num(rec, 20)]), b = s([num(rec, 11), num(rec, 21)]); if (dist(a, b) > 1e-9) shapes.push({ k: 'line', a, b }); break }
      case 'POINT': shapes.push({ k: 'point', p: s([num(rec, 10), num(rec, 20)]) }); break
      case 'CIRCLE': shapes.push({ k: 'circle', c: s([num(rec, 10), num(rec, 20)]), r: num(rec, 40) * scale }); break
      case 'ARC': {
        const a0 = (num(rec, 50) * Math.PI) / 180
        let a1 = (num(rec, 51) * Math.PI) / 180
        while (a1 <= a0 + 1e-12) a1 += TAU
        shapes.push({ k: 'arc', c: s([num(rec, 10), num(rec, 20)]), r: num(rec, 40) * scale, a0, a1 })
        break
      }
      case 'LWPOLYLINE': {
        const verts: { p: Vec2; bulge: number }[] = []
        for (const pr of rec) {
          if (pr.c === 10) verts.push({ p: [Number(pr.v), 0], bulge: 0 })
          else if (pr.c === 20 && verts.length) verts[verts.length - 1].p[1] = Number(pr.v)
          else if (pr.c === 42 && verts.length) verts[verts.length - 1].bulge = Number(pr.v)
        }
        const closed = (num(rec, 70) & 1) === 1
        const n = verts.length
        for (let k = 0; k < (closed ? n : n - 1); k++) {
          const seg = bulgeSeg(s(verts[k].p), s(verts[(k + 1) % n].p), verts[k].bulge)
          if (seg) shapes.push(seg)
        }
        break
      }
      case 'POLYLINE': poly = { closed: (num(rec, 70) & 1) === 1 }; polyVerts.length = 0; break
      case 'ELLIPSE': {
        const c = s([num(rec, 10), num(rec, 20)]), major: Vec2 = s([num(rec, 11), num(rec, 21)])
        const ratio = num(rec, 40, 1), t0 = num(rec, 41, 0), t1 = num(rec, 42, TAU)
        const a = Math.hypot(major[0], major[1])
        if (a < 1e-9) break
        if (Math.abs(t1 - t0 - TAU) < 1e-6 || Math.abs(t1 - t0) < 1e-9) shapes.push({ k: 'ellipse', c, major: [c[0] + major[0], c[1] + major[1]], minor: a * ratio })
        else {
          const rot = Math.atan2(major[1], major[0])
          let span = t1 - t0
          while (span <= 0) span += TAU
          const cs = ellipseArcCubics(c, a, a * ratio, rot, t0, span)
          shapes.push({ k: 'bez', pts: [cs[0][0], ...cs.flatMap((b) => [b[1], b[2], b[3]])] })
        }
        break
      }
      case 'SPLINE': {
        const knots = rec.filter((p) => p.c === 40).map((p) => Number(p.v))
        const deg = num(rec, 71, 3)
        const ctrl: Vec2[] = [], fit: Vec2[] = []
        let cur: Vec2[] | null = null
        for (const pr of rec) {
          if (pr.c === 10 || pr.c === 11) { cur = pr.c === 10 ? ctrl : fit; cur.push([Number(pr.v), 0]) }
          else if ((pr.c === 20 || pr.c === 21) && cur && cur.length) cur[cur.length - 1][1] = Number(pr.v)
        }
        const closed = (num(rec, 70) & 1) === 1
        if (fit.length >= 2) shapes.push({ k: 'fit', pts: fit.map(s), closed })
        else if (ctrl.length > deg && knots.length === ctrl.length + deg + 1) {
          const u0 = knots[deg], u1 = knots[ctrl.length]
          const N = Math.max(8, (ctrl.length - deg) * 8)
          const pts: Vec2[] = []
          for (let k = 0; k <= N; k++) pts.push(s(nurbsAt(deg, knots, ctrl, Math.min(u1 - 1e-12, u0 + ((u1 - u0) * k) / N))))
          shapes.push({ k: 'fit', pts, closed: false })
          notes.push('A spline was imported as a fit point spline through points sampled along it')
        } else notes.push('A spline with an unusual definition was skipped')
        break
      }
      default: skipped.set(type, (skipped.get(type) ?? 0) + 1)
    }
  }
  flushPoly()
  for (const [t, n] of skipped) notes.push(`${n} ${t} item${n === 1 ? '' : 's'} skipped (not supported)`)
  if (!shapes.length) notes.push('No supported entities were found in this DXF')
  return { shapes, notes }
}

// ------------------------------------------------------------------------------------------------ into a sketch

/** Lower-left corner of everything imported. */
export function boundsOfImport(imp: Imported): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const see = (p: Vec2) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
  for (const s of imp.shapes) {
    if (s.k === 'line') { see(s.a); see(s.b) }
    else if (s.k === 'point') see(s.p)
    else if (s.k === 'circle' || s.k === 'arc') { see([s.c[0] - s.r, s.c[1] - s.r]); see([s.c[0] + s.r, s.c[1] + s.r]) }
    else if (s.k === 'ellipse') { const a = dist(s.c, s.major); see([s.c[0] - a, s.c[1] - a]); see([s.c[0] + a, s.c[1] + a]) }
    else s.pts.forEach(see)
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null
}

/** Add the shapes to the sketch, sharing points where ends meet. Returns the ids of the entities made. */
export function insertImported(m: SketchModel, imp: Imported, offset: Vec2 = [0, 0], scale = 1): string[] {
  const made: string[] = []
  const ends = new Map<string, string>()
  const T = (p: Vec2): Vec2 => [p[0] * scale + offset[0], p[1] * scale + offset[1]]
  /** a point at p, shared with any end already at that place */
  const joint = (p: Vec2): string => {
    const q = T(p)
    const key = `${Math.round(q[0] * 2000)},${Math.round(q[1] * 2000)}`
    const have = ends.get(key)
    if (have) return have
    const id = addPoint(m, q[0], q[1])
    ends.set(key, id)
    return id
  }
  for (const s of imp.shapes) {
    switch (s.k) {
      case 'line': made.push(addLine(m, joint(s.a), joint(s.b)).id); break
      case 'point': addPoint(m, T(s.p)[0], T(s.p)[1]); break
      case 'circle': made.push(addCircle(m, addPoint(m, T(s.c)[0], T(s.c)[1]), s.r * scale).id); break
      case 'arc': {
        const c = T(s.c)
        const at = (a: number): Vec2 => [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]
        made.push(addArc(m, addPoint(m, c[0], c[1]), joint(at(s.a0)), joint(at(s.a1))).id)
        break
      }
      case 'ellipse': {
        const c = T(s.c)
        made.push(addEllipse(m, addPoint(m, c[0], c[1]), addPoint(m, T(s.major)[0], T(s.major)[1]), s.minor * scale).id)
        break
      }
      case 'bez': {
        const ids = s.pts.map((p, i) => {
          if (i % 3 === 0) return joint(p)
          const q = T(p)
          return addPoint(m, q[0], q[1])
        })
        made.push(addSpline(m, ids, 'bez').id)
        break
      }
      case 'fit': {
        const ids = s.pts.map((p) => { const q = T(p); return addPoint(m, q[0], q[1]) })
        // ends of an open spline meet other geometry: share them
        if (!s.closed) { ids[0] = joint(s.pts[0]); ids[ids.length - 1] = joint(s.pts[s.pts.length - 1]) }
        made.push(addSpline(m, ids, 'fit', s.closed).id)
        break
      }
    }
  }
  return made
}
