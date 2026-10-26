/** Dimension geometry: turns a dimension and the current model into lines, arrows and text on the sheet. */
import { locate, locateCircle } from './model3d'
import { viewAxes, toSheet } from './views'
import { viewBasis, type V2 } from '@/kernel/drawing-geom'
import type { Body } from '@/kernel/types'
import type { Dimension, DrawingSettings, DrawingView, Prim, Sheet } from './types'

export const textWidth = (t: string, size: number) => t.length * size * 0.58

export function arrowPrim(tip: V2, dir: V2, size: number, owner: string): Prim {
  const l = Math.hypot(dir[0], dir[1]) || 1
  const ux = dir[0] / l, uy = dir[1] / l // from the tip back along the arrow body
  const bx = tip[0] + ux * size, by = tip[1] + uy * size
  const w = size / 6
  return { k: 'path', pts: [tip[0], tip[1], bx - uy * w, by + ux * w, bx + uy * w, by - ux * w], style: 'dim', closed: true, fill: 'solid', owner }
}

const line = (a: V2, b: V2, owner: string, style: 'dim' | 'thin' = 'dim'): Prim => ({ k: 'path', pts: [a[0], a[1], b[0], b[1]], style, owner })
const norm = (v: V2): V2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l] }

export function formatValue(v: number, precision: number): string {
  return v.toFixed(Math.max(0, precision))
}

/** Text shown for a dimension: its own text with `<>` replaced by the value, else the value with its prefix. */
export function dimText(d: Dimension, value: number): string {
  const prefix = d.type === 'diameter' ? 'Ø' : d.type === 'radius' ? 'R' : ''
  const suffix = d.type === 'angular' ? '°' : ''
  const v = prefix + formatValue(value, d.precision) + suffix
  return d.text ? (d.text.includes('<>') ? d.text.replace('<>', v) : d.text) : v
}

export interface DimResult {
  prims: Prim[]
  /** the measured value (model units, degrees for angles) */
  value: number | null
  /** why nothing is drawn, when the model lost one of the points */
  broken?: string
  /** dragging the dimension by this vector (sheet mm) moves it away from the part by that much: offset += dot(drag, delta) */
  drag?: V2
}

function tolPrims(d: Dimension, x: number, y: number, size: number, anchor: 'start' | 'middle' | 'end', owner: string): Prim[] {
  if (!d.tolPlus && !d.tolMinus) return []
  const s = size * 0.65
  const out: Prim[] = []
  if (d.tolPlus) out.push({ k: 'text', x, y: y + s * 0.55, text: d.tolPlus, size: s, anchor, owner })
  if (d.tolMinus) out.push({ k: 'text', x, y: y - s * 0.55, text: d.tolMinus, size: s, anchor, owner })
  return out
}

export function dimPrims(d: Dimension, view: DrawingView, sheet: Pick<Sheet, 'views'>, bodies: Body[], st: DrawingSettings): DimResult {
  const owner = 'dim:' + d.id
  const ax = viewAxes(view, sheet)
  const basis = viewBasis(ax.eye, ax.right)
  const pts: V2[] = []
  for (const pr of d.pts) {
    if (d.type === 'radius' || d.type === 'diameter') break
    const loc = locate(pr, bodies, basis)
    if (!loc) return { prims: [], value: null, broken: 'A point this dimension measures no longer exists in the model' }
    pts.push(toSheet(view, loc.p2))
  }
  const size = st.textHeight
  const arrow = st.arrowSize
  const gap = 1, over = 2
  const prims: Prim[] = []
  const sc = view.scale

  if (d.type === 'radius' || d.type === 'diameter') {
    const c = locateCircle(d.pts[0], bodies, basis)
    if (!c) return { prims: [], value: null, broken: 'The circle this dimension measures no longer exists in the model' }
    const C = toSheet(view, c.center)
    const R = c.radius * sc
    const a = (d.angle * Math.PI) / 180
    const u: V2 = [Math.cos(a), Math.sin(a)]
    const value = d.type === 'radius' ? c.radius : c.radius * 2
    const text = dimText(d, value)
    const tw = textWidth(text, size)
    if (d.type === 'radius') {
      const P: V2 = [C[0] + u[0] * R, C[1] + u[1] * R]
      const ext = Math.max(d.offset, 0)
      const Q: V2 = [P[0] + u[0] * ext, P[1] + u[1] * ext]
      prims.push(line(C, Q, owner), arrowPrim(P, [-u[0], -u[1]], arrow, owner))
      const right = u[0] >= -1e-9
      const tx = Q[0] + (right ? 1.2 : -1.2)
      prims.push({ k: 'text', x: tx, y: Q[1] - size * 0.35, text, size, anchor: right ? 'start' : 'end', owner })
      prims.push(...tolPrims(d, tx + (right ? tw + 1 : -tw - 1), Q[1] - size * 0.35, size, right ? 'start' : 'end', owner))
    } else {
      const P1: V2 = [C[0] - u[0] * R, C[1] - u[1] * R], P2: V2 = [C[0] + u[0] * R, C[1] + u[1] * R]
      if (2 * R > 2 * arrow + tw + 4) {
        prims.push(line(P1, P2, owner), arrowPrim(P1, u, arrow, owner), arrowPrim(P2, [-u[0], -u[1]], arrow, owner))
        let rot = (a * 180) / Math.PI
        if (rot > 90) rot -= 180
        if (rot <= -90) rot += 180
        const th = (rot * Math.PI) / 180
        const lift = size * 0.35 + 0.8
        prims.push({ k: 'text', x: C[0] - Math.sin(th) * lift, y: C[1] + Math.cos(th) * lift, text, size, anchor: 'middle', rot: rot === 0 ? undefined : rot, owner })
      } else {
        const ext = Math.max(d.offset, 2 * arrow)
        const Q: V2 = [P2[0] + u[0] * ext, P2[1] + u[1] * ext]
        prims.push(line([P1[0] - u[0] * arrow, P1[1] - u[1] * arrow], Q, owner), arrowPrim(P1, [-u[0], -u[1]], arrow, owner), arrowPrim(P2, u, arrow, owner))
        const right = u[0] >= -1e-9
        prims.push({ k: 'text', x: Q[0] + (right ? 1.2 : -1.2), y: Q[1] - size * 0.35, text, size, anchor: right ? 'start' : 'end', owner })
      }
      prims.push(...tolPrims(d, P2[0] + u[0] * (arrow + tw + 4), P2[1], size, 'start', owner))
    }
    return { prims, value, drag: u }
  }

  if (d.type === 'angular') {
    if (pts.length < 3) return { prims: [], value: null, broken: 'Pick a vertex and two points' }
    const [V, A, B] = pts
    const a0 = Math.atan2(A[1] - V[1], A[0] - V[0]), a1 = Math.atan2(B[1] - V[1], B[0] - V[0])
    let sweep = a1 - a0
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep < -Math.PI) sweep += 2 * Math.PI
    const value = (Math.abs(sweep) * 180) / Math.PI
    const rad = Math.max(d.offset, 8)
    const n = Math.max(8, Math.ceil(Math.abs(sweep) / 0.08))
    const arc: number[] = []
    for (let i = 0; i <= n; i++) {
      const t = a0 + (sweep * i) / n
      arc.push(V[0] + Math.cos(t) * rad, V[1] + Math.sin(t) * rad)
    }
    prims.push({ k: 'path', pts: arc, style: 'dim', owner })
    for (const [P, ang] of [[A, a0], [B, a1]] as [V2, number][]) {
      const dist = Math.hypot(P[0] - V[0], P[1] - V[1])
      const u: V2 = [Math.cos(ang), Math.sin(ang)]
      const from = Math.min(dist + gap, rad)
      if (rad + over > from) prims.push(line([V[0] + u[0] * from, V[1] + u[1] * from], [V[0] + u[0] * (rad + over), V[1] + u[1] * (rad + over)], owner))
      const sgn = P === A ? Math.sign(sweep) : -Math.sign(sweep)
      const tip: V2 = [V[0] + u[0] * rad, V[1] + u[1] * rad]
      const tdir: V2 = [-u[1] * sgn, u[0] * sgn] // tangent pointing into the arc
      prims.push(arrowPrim(tip, tdir, arrow, owner))
    }
    const mid = a0 + sweep / 2
    const text = dimText(d, value)
    // the text sits just outside the arc: clear of it whichever way the angle opens
    const tw = textWidth(text, size)
    const tr = rad + 1.5 + (tw / 2) * Math.abs(Math.cos(mid)) + (size / 2) * Math.abs(Math.sin(mid))
    prims.push({ k: 'text', x: V[0] + Math.cos(mid) * tr, y: V[1] + Math.sin(mid) * tr - size * 0.35, text, size, anchor: 'middle', owner })
    return { prims, value, drag: [Math.cos(mid), Math.sin(mid)] }
  }

  // point based, measured along an axis or along the line between the points
  if (pts.length < 2) return { prims: [], value: null, broken: 'Pick two points' }

  if (d.type === 'ordinate') {
    const [O, P] = pts
    const h = d.axis === 'h'
    const value = (h ? Math.abs(P[0] - O[0]) : Math.abs(P[1] - O[1])) / sc
    const text = dimText(d, value)
    if (h) {
      const level = O[1] + d.offset
      const dir = d.offset >= 0 ? 1 : -1
      prims.push(line([P[0], P[1] + (level >= P[1] ? gap : -gap)], [P[0], level], owner))
      prims.push({ k: 'text', x: P[0] - size * 0.35, y: level + (dir > 0 ? 1 : -1), text, size, anchor: dir > 0 ? 'start' : 'end', rot: 90, owner })
    } else {
      const level = O[0] + d.offset
      const dir = d.offset >= 0 ? 1 : -1
      prims.push(line([P[0] + (level >= P[0] ? gap : -gap), P[1]], [level, P[1]], owner))
      prims.push({ k: 'text', x: level + (dir > 0 ? 1 : -1), y: P[1] - size * 0.35, text, size, anchor: dir > 0 ? 'start' : 'end', owner })
    }
    return { prims, value, drag: h ? [0, 1] : [1, 0] }
  }

  const targets = d.type === 'baseline' ? pts.slice(1) : [pts[1]]
  const base = pts[0]
  let first = 0
  let drag: V2 = [0, 1]
  // baseline dimensions stack away from the outermost of all their points
  const acrossOf = (p: V2) => (d.axis === 'h' ? p[1] : p[0])
  const all = d.type === 'baseline' ? pts.map(acrossOf) : []
  const common = all.length ? (d.offset >= 0 ? Math.max(...all) : Math.min(...all)) : undefined
  targets.forEach((T, i) => {
    const off = d.type === 'baseline' ? d.offset + (d.offset >= 0 ? 1 : -1) * i * size * 2.6 : d.offset
    const r = linearOne(d, base, T, off, sc, size, arrow, gap, over, owner, i === 0 || d.type !== 'baseline', common)
    prims.push(...r.prims)
    if (i === 0) { first = r.value; drag = r.drag }
  })
  return { prims, value: first, drag }
}

function linearOne(d: Dimension, A: V2, B: V2, offset: number, sc: number, size: number, arrow: number, gap: number, over: number, owner: string, extA: boolean, commonExtent?: number): { prims: Prim[]; value: number; drag: V2 } {
  const prims: Prim[] = []
  // frame: u along the dimension line, n across it (towards the dimension line when the offset is positive)
  let u: V2, n: V2
  if (d.type === 'aligned') {
    u = norm([B[0] - A[0], B[1] - A[1]])
    n = [-u[1], u[0]]
  } else if (d.axis === 'h') {
    u = [B[0] >= A[0] ? 1 : -1, 0]
    n = [0, 1]
  } else {
    u = [0, B[1] >= A[1] ? 1 : -1]
    // vertical dimension lines sit to the right for a positive offset
    n = [1, 0]
  }
  const sgn = offset >= 0 ? 1 : -1
  const along = (p: V2, from: V2) => (p[0] - from[0]) * u[0] + (p[1] - from[1]) * u[1]
  const across = (p: V2) => p[0] * n[0] + p[1] * n[1]
  const extent = commonExtent ?? (sgn > 0 ? Math.max(across(A), across(B)) : Math.min(across(A), across(B)))
  const levelAcross = extent + offset
  const value = Math.abs(along(B, A)) / sc
  const onLevel = (p: V2): V2 => {
    const k = levelAcross - across(p)
    return [p[0] + n[0] * k, p[1] + n[1] * k]
  }
  const LA = onLevel(A), LB = onLevel(B)
  // extension lines
  const ext = (P: V2, L: V2) => {
    const dir = norm([L[0] - P[0], L[1] - P[1]])
    if (Math.hypot(L[0] - P[0], L[1] - P[1]) < 1e-6) return
    prims.push(line([P[0] + dir[0] * gap, P[1] + dir[1] * gap], [L[0] + dir[0] * over, L[1] + dir[1] * over], owner))
  }
  if (extA) ext(A, LA)
  ext(B, LB)
  const text = dimText(d, value)
  const tw = textWidth(text, size)
  const len = Math.abs(along(LB, LA))
  const inside = len >= 2 * arrow + tw + 2
  const uAB: V2 = [(LB[0] - LA[0]) / (len || 1), (LB[1] - LA[1]) / (len || 1)]
  const drag: V2 = [n[0] * sgn, n[1] * sgn]
  if (len < 1e-9) return { prims, value, drag }
  if (inside || len >= 2 * arrow + 1) {
    prims.push(line(LA, LB, owner), arrowPrim(LA, uAB, arrow, owner), arrowPrim(LB, [-uAB[0], -uAB[1]], arrow, owner))
  } else {
    // arrows outside, pointing in
    prims.push(line([LA[0] - uAB[0] * arrow * 1.3, LA[1] - uAB[1] * arrow * 1.3], [LB[0] + uAB[0] * arrow * 1.3, LB[1] + uAB[1] * arrow * 1.3], owner))
    prims.push(arrowPrim(LA, [-uAB[0], -uAB[1]], arrow, owner), arrowPrim(LB, uAB, arrow, owner))
  }
  // text: above the line, readable
  let rot = (Math.atan2(uAB[1], uAB[0]) * 180) / Math.PI
  if (rot > 90) rot -= 180
  if (rot <= -90) rot += 180
  const th = (rot * Math.PI) / 180
  const textNormal: V2 = [-Math.sin(th), Math.cos(th)]
  const mid: V2 = [(LA[0] + LB[0]) / 2, (LA[1] + LB[1]) / 2]
  let tx: number, ty: number
  const lift = size * 0.35 + 0.8
  if (inside) {
    tx = mid[0] + textNormal[0] * lift
    ty = mid[1] + textNormal[1] * lift
    // keep the baseline above the dimension line
    prims.push({ k: 'text', x: tx, y: ty, text, size, anchor: 'middle', rot: rot === 0 ? undefined : rot, owner })
    prims.push(...tolPrims(d, tx + Math.cos(th) * (tw / 2 + 1), ty, size, 'start', owner).map((p) => ({ ...p, rot: rot === 0 ? undefined : rot }) as Prim))
  } else {
    // beside the far arrow
    const far: V2 = [LB[0] + uAB[0] * (arrow * 1.3 + 1.5), LB[1] + uAB[1] * (arrow * 1.3 + 1.5)]
    tx = far[0] + textNormal[0] * lift
    ty = far[1] + textNormal[1] * lift
    prims.push({ k: 'text', x: tx, y: ty, text, size, anchor: Math.cos(th) * uAB[0] + Math.sin(th) * uAB[1] >= 0 ? 'start' : 'end', rot: rot === 0 ? undefined : rot, owner })
  }
  return { prims, value, drag }
}
