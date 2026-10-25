/** Everything on a sheet as one list of primitives (the screen, SVG, DXF and PDF all draw from it). */
import { annotationPrims } from './annotations'
import { centerMarks } from './model3d'
import { arrowPrim, dimPrims } from './dims'
import { listComponents, type Component } from './components'
import { scaleText } from './sheets'
import { borderPrims, titleBlockPrims } from './titleblock'
import type { DrawingDoc, DrawingView, LineStyle, Prim, Sheet, ViewItem } from './types'
import { sightInPlane, toSheet, viewAxes, type ViewGeom } from './views'
import { hatchLines, nearestOnPolys, sectionPlane, viewBasis, type V2 } from '@/kernel/drawing-geom'
import type { Body } from '@/kernel/types'

export interface SheetInput {
  doc: DrawingDoc
  sheet: Sheet
  bodies: Body[]
  geoms: Record<string, ViewGeom>
  parts?: Component[]
}

export interface SheetOutput {
  prims: Prim[]
  /** dimensions that lost their model points, by id */
  broken: Record<string, string>
  /** measured values of the dimensions, by id */
  values: Record<string, number>
  /** how to drag each dimension to change its offset */
  drags: Record<string, V2>
}

const path = (pts: number[], style: LineStyle, owner: string, extra: Partial<Extract<Prim, { k: 'path' }>> = {}): Prim => ({ k: 'path', pts, style, owner, ...extra })

function mapPoly(v: DrawingView, p: number[]): number[] {
  const out = new Array<number>(p.length)
  for (let i = 0; i < p.length; i += 2) {
    const q = toSheet(v, [p[i], p[i + 1]])
    out[i] = q[0]
    out[i + 1] = q[1]
  }
  return out
}

/** Hatch lines of a section view in sheet coordinates. */
export function hatchPrims(v: DrawingView, g: ViewGeom, spacing: number, owner: string): Prim[] {
  const out: Prim[] = []
  const step = spacing / v.scale
  g.cut.forEach((loops, i) => {
    const angle = (g.cutBody[i] ?? 0) % 2 === 0 ? 45 : 135
    let lines = hatchLines(loops, step, angle)
    if (v.kind === 'detail' && v.detail) {
      const { c, r } = v.detail
      lines = lines.flatMap((l) => clipSeg(l, c, r))
    }
    for (const l of lines) out.push(path(mapPoly(v, l), 'hatch', owner))
  })
  return out
}

function clipSeg(l: number[], c: V2, r: number): number[][] {
  const dx = l[2] - l[0], dy = l[3] - l[1]
  const fx = l[0] - c[0], fy = l[1] - c[1]
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r
  const disc = B * B - 4 * A * C
  if (A < 1e-18 || disc <= 0) return []
  const s = Math.sqrt(disc)
  const t0 = Math.max(0, (-B - s) / (2 * A)), t1 = Math.min(1, (-B + s) / (2 * A))
  if (t0 >= t1) return []
  return [[l[0] + dx * t0, l[1] + dy * t0, l[0] + dx * t1, l[1] + dy * t1]]
}

function circleSheet(v: DrawingView, c: V2, r: number): number[] {
  const pts: number[] = []
  const n = 72
  for (let i = 0; i < n; i++) pts.push(c[0] + r * Math.cos((i / n) * 2 * Math.PI), c[1] + r * Math.sin((i / n) * 2 * Math.PI))
  return mapPoly(v, pts)
}

export function viewPrims(v: DrawingView, sheet: Sheet, g: ViewGeom | undefined, bodies: Body[], doc: DrawingDoc): Prim[] {
  const owner = 'view:' + v.id
  const out: Prim[] = []
  if (!g) return out
  for (const p of g.visible) out.push(path(mapPoly(v, p), 'visible', owner))
  if (v.showHidden) for (const p of g.hidden) out.push(path(mapPoly(v, p), 'hidden', owner))
  if (v.showTangent) for (const p of g.tangent) out.push(path(mapPoly(v, p), 'tangent', owner))
  out.push(...hatchPrims(v, g, doc.settings.hatchSpacing, owner))
  if (v.kind === 'detail' && v.detail) out.push(path(circleSheet(v, v.detail.c, v.detail.r), 'thin', owner, { closed: true }))

  if (v.showCenter && v.kind !== 'detail') {
    const ax = viewAxes(v, sheet)
    const basis = viewBasis(ax.eye, ax.right)
    const items: { body: Body; item: ViewItem }[] = []
    for (const it of v.items) {
      const b = bodies.find((x) => x.id === it.bodyId)
      if (b && b.kind === 'brep') items.push({ body: b, item: it })
    }
    const { lines, marks } = centerMarks(items, basis)
    const o = 3 / v.scale
    const drawn = [...g.visible, ...g.hidden]
    const onOutline = (x: number, y: number, r: number) => Math.abs(nearestOnPolys(x, y, drawn) - r) < 0.03 * r + 0.02
    for (const [cx, cy, r] of marks) {
      if (!onOutline(cx, cy, r)) continue
      out.push(path(mapPoly(v, [cx - r - o, cy, cx + r + o, cy]), 'center', owner), path(mapPoly(v, [cx, cy - r - o, cx, cy + r + o]), 'center', owner))
    }
    for (const [x0, y0, x1, y1, r] of lines) {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
      if (!onOutline(mx, my, r)) continue
      const len = Math.hypot(x1 - x0, y1 - y0) || 1
      const ux = (x1 - x0) / len, uy = (y1 - y0) / len
      out.push(path(mapPoly(v, [x0 - ux * o, y0 - uy * o, x1 + ux * o, y1 + uy * o]), 'center', owner))
    }
  }
  return out
}

/** Cut lines of the section views that were made from `parent`, drawn on it with their arrows and letters. */
function cutLinePrims(parent: DrawingView, sheet: Sheet, arrow: number): Prim[] {
  const out: Prim[] = []
  const pax = viewAxes(parent, sheet)
  for (const s of sheet.views) {
    if (s.kind !== 'section' || s.parentId !== parent.id || !s.cut) continue
    const owner = 'view:' + s.id
    const A = toSheet(parent, s.cut.a), B = toSheet(parent, s.cut.b)
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1
    const u: V2 = [(B[0] - A[0]) / len, (B[1] - A[1]) / len]
    const end = Math.min(8, len / 4)
    // thick ends, thin chain in the middle
    out.push(path([A[0], A[1], A[0] + u[0] * end, A[1] + u[1] * end], 'cut', owner))
    out.push(path([B[0] - u[0] * end, B[1] - u[1] * end, B[0], B[1]], 'cut', owner))
    out.push(path([A[0] + u[0] * (end + 2), A[1] + u[1] * (end + 2), B[0] - u[0] * (end + 2), B[1] - u[1] * (end + 2)], 'phantom', owner))
    // arrows at both ends point the way the section looks
    const pl = sectionPlane(pax.eye, pax.right, s.cut.a, s.cut.b, s.cut.flip)
    const sight = sightInPlane(pax, pl.normal)
    const sl = Math.hypot(sight[0], sight[1]) || 1
    const d: V2 = [sight[0] / sl, sight[1] / sl]
    for (const P of [A, B]) {
      const tail: V2 = [P[0] + d[0] * arrow * 2.2, P[1] + d[1] * arrow * 2.2]
      out.push(path([P[0], P[1], tail[0], tail[1]], 'dim', owner))
      out.push(arrowPrim(tail, [-d[0], -d[1]], arrow, owner))
      out.push({ k: 'text', x: tail[0] + d[0] * 3.5, y: tail[1] + d[1] * 3.5 - 2, text: s.cut.letter, size: 5, anchor: 'middle', bold: true, owner })
    }
  }
  return out
}

export function buildSheet(inp: SheetInput): SheetOutput {
  const { doc, sheet, bodies, geoms } = inp
  const parts = inp.parts ?? listComponents()
  const idx = doc.sheets.findIndex((s) => s.id === sheet.id)
  const prims: Prim[] = []
  const broken: Record<string, string> = {}
  const values: Record<string, number> = {}
  const drags: Record<string, V2> = {}
  prims.push(...borderPrims(sheet), ...titleBlockPrims(sheet, doc.template, idx < 0 ? 0 : idx, doc.sheets.length))
  for (const v of sheet.views) {
    const g = geoms[sheet.id + '/' + v.id]
    prims.push(...viewPrims(v, sheet, g, bodies, doc))
    prims.push(...cutLinePrims(v, sheet, doc.settings.arrowSize))
  }
  for (const v of sheet.views) {
    const g = geoms[sheet.id + '/' + v.id]
    if (!g?.bounds || !v.showLabel) continue
    const a = toSheet(v, [g.bounds[0], g.bounds[1]]), b = toSheet(v, [g.bounds[2], g.bounds[3]])
    const cx = (a[0] + b[0]) / 2, y = Math.min(a[1], b[1]) - 5.5
    const owner = 'view:' + v.id
    prims.push({ k: 'text', x: cx, y, text: v.label, size: 4.2, anchor: 'middle', bold: true, owner })
    prims.push({ k: 'text', x: cx, y: y - 3.6, text: 'SCALE ' + scaleText(v.scale), size: 2.8, anchor: 'middle', owner })
  }
  for (const d of sheet.dims) {
    const v = sheet.views.find((x) => x.id === d.viewId)
    if (!v) continue
    const r = dimPrims(d, v, sheet, bodies, doc.settings)
    if (r.broken) broken[d.id] = r.broken
    if (r.value !== null) values[d.id] = r.value
    if (r.drag) drags[d.id] = r.drag
    prims.push(...r.prims)
  }
  for (const n of sheet.notes) prims.push(...annotationPrims(n, doc.settings, parts))
  return { prims, broken, values, drags }
}
