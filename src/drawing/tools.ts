/** The interactive tools of the Drawing workspace: what each click does, what the status line says, and the live preview. */
import { create } from 'zustand'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import type { Side, V2 } from '@/kernel/drawing-geom'
import { toast } from '@/ui/Modal'
import { listComponents } from './components'
import { dimPrims } from './dims'
import { placeNote } from './forms'
import { nearestCircle, nearestSnap, viewAt, viewSnaps, type Snap } from './pick'
import { createDetailView, createProjectedView, createSectionView, viewRect } from './service'
import { fitScale } from './sheets'
import { activeSheet, drawingActions, useDrawing } from './store'
import type { Dimension, DimType, PointRef, Prim, Sheet } from './types'
import { useViewGeoms } from './views'

export type ToolId =
  | 'view.projected' | 'view.section' | 'view.detail'
  | 'dim.linear' | 'dim.aligned' | 'dim.angular' | 'dim.radius' | 'dim.diameter' | 'dim.ordinate' | 'dim.baseline'
  | 'ann.note' | 'ann.leader' | 'ann.gdt' | 'ann.datum' | 'ann.finish' | 'ann.balloon' | 'ann.partsList'

interface ToolState {
  tool: ToolId | null
  /** what to do next, shown in the status line */
  hint: string
  /** live preview drawn in the accent color */
  preview: Prim[]
  /** the snap under the pointer */
  marker: V2 | null
  /** view highlighted as the target of the tool */
  target: string | null
  /** sheet coordinates of the pointer */
  cursor: V2 | null
}

export const useTool = create<ToolState>(() => ({ tool: null, hint: '', preview: [], marker: null, target: null, cursor: null }))

interface Work {
  viewId?: string
  pts: Snap[]
  pos: V2[]
  circle?: { pr: PointRef; c: V2; r: number }
  /** baseline: the picks are finished, the next click places the dimension */
  placing?: boolean
  side?: Side
}
let work: Work = { pts: [], pos: [] }

const HINTS: Record<ToolId, string[]> = {
  'view.projected': ['Click the view to project from', 'Move to the side you want, then click'],
  'view.section': ['Click the view to cut', 'Click the start of the cut line', 'Click the end of the cut line'],
  'view.detail': ['Click the view to take the detail from', 'Click the center of the detail circle', 'Click to set the size of the circle'],
  'dim.linear': ['Click the first point', 'Click the second point', 'Move away from the part and click to place the dimension'],
  'dim.aligned': ['Click the first point', 'Click the second point', 'Move away from the part and click to place the dimension'],
  'dim.angular': ['Click the corner of the angle', 'Click a point on the first side', 'Click a point on the second side', 'Move out and click to place the dimension'],
  'dim.radius': ['Click a circle or an arc', 'Click to place the dimension'],
  'dim.diameter': ['Click a circle', 'Click to place the dimension'],
  'dim.ordinate': ['Click the origin point', 'Click the point to measure', 'Move away and click to place the dimension'],
  'dim.baseline': ['Click the base point', 'Click the first point to measure from it', 'Click more points, press Enter when done', 'Move away from the part and click to place the dimensions'],
  'ann.note': ['Click where the note goes'],
  'ann.leader': ['Click the point the leader points at', 'Click where the text goes'],
  'ann.gdt': ['Click the feature the frame points at', 'Click where the frame goes'],
  'ann.datum': ['Click the feature', 'Click where the datum symbol goes'],
  'ann.finish': ['Click the surface the symbol belongs to'],
  'ann.balloon': ['Click the part', 'Click where the balloon goes'],
  'ann.partsList': ['Click where the lower left corner of the list goes'],
}

const set = (p: Partial<ToolState>) => useTool.setState(p)

const step = () => (work.circle ? 1 : 0) + work.pts.length + work.pos.length + (work.viewId ? 1 : 0)

export function startTool(tool: ToolId) {
  useUi.getState().inspector?.onCancel()
  work = { pts: [], pos: [] }
  useDrawing.getState().select(null)
  useUi.getState().setActiveTool('drawing.' + tool)
  set({ tool, hint: HINTS[tool][0], preview: [], marker: null, target: null })
}

export function endTool() {
  work = { pts: [], pos: [] }
  if (useTool.getState().tool) useUi.getState().setActiveTool(null)
  set({ tool: null, hint: '', preview: [], marker: null, target: null })
}

const restart = (tool: ToolId) => {
  work = { pts: [], pos: [] }
  set({ hint: HINTS[tool][0], preview: [], marker: null, target: null })
}

const ctx = () => {
  const sheet = activeSheet()
  return sheet ? { sheet, bodies: useDoc.getState().geometry, geoms: useViewGeoms.getState().geoms, doc: useDrawing.getState().doc } : null
}

const sideOf = (r: [number, number, number, number], p: V2): Side => {
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2
  const dx = (p[0] - cx) / Math.max(r[2] - r[0], 1), dy = (p[1] - cy) / Math.max(r[3] - r[1], 1)
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'above' : 'below'
}

/**
 * Which way a dimension measures, from where the pointer is relative to the box of its points: above or below them
 * it measures across ('h', the dimension line is horizontal), to the left or right it measures up ('v').
 */
function sideAxis(points: V2[], cur: V2): 'h' | 'v' {
  const x0 = Math.min(...points.map((p) => p[0])), x1 = Math.max(...points.map((p) => p[0]))
  const y0 = Math.min(...points.map((p) => p[1])), y1 = Math.max(...points.map((p) => p[1]))
  const dx = Math.max(x0 - cur[0], 0, cur[0] - x1), dy = Math.max(y0 - cur[1], 0, cur[1] - y1)
  return dy >= dx ? 'h' : 'v'
}

/** The dimension as it would be if the placing click were at `cur`. */
function draftDim(tool: ToolId, sheet: Sheet, cur: V2): Dimension | null {
  const viewId = work.viewId
  if (!viewId) return null
  const base: Dimension = { id: 'draft', viewId, type: tool.slice(4) as DimType, pts: work.pts.map((p) => p.pt), axis: 'h', offset: 8, angle: 45, text: '', precision: useDrawing.getState().doc.settings.precision, tolPlus: '', tolMinus: '' }
  const P = work.pts.map((p) => p.s)
  switch (tool) {
    case 'dim.linear': {
      const [a, b] = P
      const mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const h = sideAxis(P, cur) === 'h'
      base.axis = h ? 'h' : 'v'
      const i = h ? 1 : 0
      const hi = Math.max(a[i], b[i]), lo = Math.min(a[i], b[i])
      base.offset = cur[i] >= mid[i] ? cur[i] - hi : cur[i] - lo
      return base
    }
    case 'dim.aligned': {
      const [a, b] = P
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      const n: V2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]
      base.offset = (cur[0] - a[0]) * n[0] + (cur[1] - a[1]) * n[1]
      return base
    }
    case 'dim.angular': {
      base.offset = Math.max(6, Math.hypot(cur[0] - P[0][0], cur[1] - P[0][1]))
      return base
    }
    case 'dim.ordinate': {
      const [o, p] = P
      const h = sideAxis(P, cur) === 'h'
      base.axis = h ? 'h' : 'v'
      base.offset = h ? cur[1] - o[1] : cur[0] - o[0]
      return base
    }
    case 'dim.baseline': {
      const h = sideAxis(P, cur) === 'h'
      base.axis = h ? 'h' : 'v'
      const i = h ? 1 : 0
      const hi = Math.max(...P.map((p) => p[i])), lo = Math.min(...P.map((p) => p[i]))
      const up = cur[i] >= (hi + lo) / 2
      // the first dimension line is at least a text height away from the part, the others stack beyond it
      base.offset = up ? Math.max(cur[i] - hi, 5) : Math.min(cur[i] - lo, -5)
      return base
    }
    case 'dim.radius': case 'dim.diameter': {
      const c = work.circle
      if (!c) return null
      base.pts = [c.pr]
      base.angle = (Math.atan2(cur[1] - c.c[1], cur[0] - c.c[0]) * 180) / Math.PI
      base.offset = Math.max(Math.hypot(cur[0] - c.c[0], cur[1] - c.c[1]) - c.r, 0)
      return base
    }
    default:
      return null
  }
}

const needPts: Partial<Record<ToolId, number>> = { 'dim.linear': 2, 'dim.aligned': 2, 'dim.angular': 3, 'dim.ordinate': 2 }

function previewFor(tool: ToolId, sheet: Sheet, cur: V2): Prim[] {
  const c = ctx()
  if (!c) return []
  const doc = c.doc
  const markDots = (pts: V2[]): Prim[] => pts.map((p) => ({ k: 'path', pts: [p[0] - 0.8, p[1], p[0] + 0.8, p[1], p[0], p[1] + 0.8], closed: true, style: 'dim' }))
  if (tool.startsWith('dim.')) {
    const view = sheet.views.find((v) => v.id === work.viewId)
    if (!view) return []
    const placing = tool === 'dim.radius' || tool === 'dim.diameter' ? !!work.circle : work.placing || work.pts.length >= (needPts[tool] ?? 99)
    if (placing) {
      const d = draftDim(tool, sheet, cur)
      if (d) {
        const r = dimPrims(d, view, sheet, c.bodies, doc.settings)
        return r.prims.map((p) => ({ ...p, owner: undefined }))
      }
    }
    const prims = markDots(work.pts.map((p) => p.s))
    if (work.pts.length && !placing) prims.push({ k: 'path', pts: [work.pts[work.pts.length - 1].s[0], work.pts[work.pts.length - 1].s[1], cur[0], cur[1]], style: 'dim' })
    return prims
  }
  if (tool === 'view.section' && work.pos.length) {
    const a = work.pos[0]
    return [{ k: 'path', pts: [a[0], a[1], cur[0], cur[1]], style: 'phantom' }]
  }
  if (tool === 'view.detail' && work.pos.length) {
    const ctr = work.pos[0], r = Math.hypot(cur[0] - ctr[0], cur[1] - ctr[1])
    const pts: number[] = []
    for (let i = 0; i < 64; i++) pts.push(ctr[0] + r * Math.cos((i / 64) * 2 * Math.PI), ctr[1] + r * Math.sin((i / 64) * 2 * Math.PI))
    return [{ k: 'path', pts, closed: true, style: 'phantom' }]
  }
  if ((tool === 'ann.leader' || tool === 'ann.gdt' || tool === 'ann.datum' || tool === 'ann.balloon') && work.pos.length) {
    const a = work.pos[0]
    return [{ k: 'path', pts: [a[0], a[1], cur[0], cur[1]], style: 'thin' }]
  }
  if (tool === 'view.projected' && work.viewId && work.side) {
    const v = sheet.views.find((x) => x.id === work.viewId)
    if (!v) return []
    const r = viewRect(v, c.geoms[sheet.id + '/' + v.id])
    const w = r[2] - r[0], h = r[3] - r[1]
    const gap = 18
    let x0 = r[0], y0 = r[1]
    if (work.side === 'right') x0 = r[2] + gap
    else if (work.side === 'left') x0 = r[0] - gap - w
    else if (work.side === 'above') y0 = r[3] + gap
    else y0 = r[1] - gap - h
    return [{ k: 'path', pts: [x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h], closed: true, style: 'phantom' }]
  }
  return []
}

export function toolMove(pt: V2, zoom: number) {
  const { tool } = useTool.getState()
  const c = ctx()
  set({ cursor: pt })
  if (!tool || !c) return
  const tol = 9 / zoom
  let marker: V2 | null = null
  let target: string | null = null

  if (tool.startsWith('dim.')) {
    const view = work.viewId ? c.sheet.views.find((v) => v.id === work.viewId) : viewAt(c.sheet, c.geoms, pt[0], pt[1])
    target = view?.id ?? null
    if (view) {
      const g = c.geoms[c.sheet.id + '/' + view.id]
      if (tool === 'dim.radius' || tool === 'dim.diameter') {
        if (!work.circle) {
          const circ = nearestCircle(view, c.sheet, g, c.bodies, pt[0], pt[1], tol)
          if (circ) marker = circ.c
        }
      } else if (!(work.placing || work.pts.length >= (needPts[tool] ?? 99))) {
        const s = nearestSnap(viewSnaps(view, c.sheet, g, c.bodies), pt[0], pt[1], tol)
        if (s) marker = s.s
      }
    }
  } else if (tool === 'view.projected') {
    if (!work.viewId) target = viewAt(c.sheet, c.geoms, pt[0], pt[1])?.id ?? null
    else {
      const v = c.sheet.views.find((x) => x.id === work.viewId)
      if (v) {
        work.side = sideOf(viewRect(v, c.geoms[c.sheet.id + '/' + v.id]), pt)
        target = v.id
      }
    }
  } else if (tool === 'view.section' || tool === 'view.detail') {
    target = work.viewId ?? viewAt(c.sheet, c.geoms, pt[0], pt[1])?.id ?? null
  }
  // section cut lines snap to horizontal / vertical
  let cur = pt
  if (tool === 'view.section' && work.pos.length) cur = orthoSnap(work.pos[0], pt)
  set({ marker, target, preview: previewFor(tool, c.sheet, cur) })
}

function orthoSnap(a: V2, p: V2): V2 {
  const dx = p[0] - a[0], dy = p[1] - a[1]
  const ang = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI) % 90
  if (Math.min(ang, 90 - ang) < 4) return Math.abs(dx) > Math.abs(dy) ? [p[0], a[1]] : [a[0], p[1]]
  return p
}

/** Sheet point to the view's plane coordinates (inverse of toSheet). */
const toPlane = (v: { pos: V2; anchor: V2; scale: number }, p: V2): V2 => [v.anchor[0] + (p[0] - v.pos[0]) / v.scale, v.anchor[1] + (p[1] - v.pos[1]) / v.scale]

export async function toolClick(pt: V2, zoom: number) {
  const { tool } = useTool.getState()
  const c = ctx()
  if (!tool || !c) return
  const tol = 9 / zoom
  const sheetId = c.sheet.id
  const again = () => restart(tool)
  const hint = () => set({ hint: HINTS[tool][Math.min(step(), HINTS[tool].length - 1)] })
  try {
    // ---- views
    if (tool === 'view.projected') {
      if (!work.viewId) {
        const v = viewAt(c.sheet, c.geoms, pt[0], pt[1])
        if (!v) return toast('Click on a view', 'error')
        work.viewId = v.id
        work.side = sideOf(viewRect(v, c.geoms[sheetId + '/' + v.id]), pt)
        return hint()
      }
      const side = work.side ?? 'right'
      const parent = work.viewId
      endTool()
      const id = await createProjectedView(sheetId, parent, side)
      useDrawing.getState().select({ kind: 'view', id })
      return
    }
    if (tool === 'view.section') {
      if (!work.viewId) {
        const v = viewAt(c.sheet, c.geoms, pt[0], pt[1])
        if (!v) return toast('Click on a view', 'error')
        if (v.kind === 'iso') return toast('Cut a standard view, not an isometric one', 'error')
        work.viewId = v.id
        return hint()
      }
      const parent = c.sheet.views.find((v) => v.id === work.viewId)!
      if (!work.pos.length) {
        work.pos.push(pt)
        return hint()
      }
      const end = orthoSnap(work.pos[0], pt)
      const a = toPlane(parent, work.pos[0]), b = toPlane(parent, end)
      const id0 = work.viewId
      endTool()
      const id = await createSectionView(sheetId, id0, a, b, false)
      useDrawing.getState().select({ kind: 'view', id })
      return
    }
    if (tool === 'view.detail') {
      if (!work.viewId) {
        const v = viewAt(c.sheet, c.geoms, pt[0], pt[1])
        if (!v) return toast('Click on a view', 'error')
        work.viewId = v.id
        return hint()
      }
      const parent = c.sheet.views.find((v) => v.id === work.viewId)!
      if (!work.pos.length) {
        work.pos.push(pt)
        return hint()
      }
      const r = Math.hypot(pt[0] - work.pos[0][0], pt[1] - work.pos[0][1]) / parent.scale
      if (r < 0.5 / parent.scale) return toast('Drag out the circle a little further', 'error')
      const ctr = toPlane(parent, work.pos[0])
      const id0 = work.viewId
      endTool()
      const id = await createDetailView(sheetId, id0, ctr, r, fitScale(2 * r, 2 * r, 70, 70))
      useDrawing.getState().select({ kind: 'view', id })
      return
    }

    // ---- dimensions
    if (tool.startsWith('dim.')) {
      const view = work.viewId ? c.sheet.views.find((v) => v.id === work.viewId) : viewAt(c.sheet, c.geoms, pt[0], pt[1])
      if (!view) return toast('Click on a view', 'error')
      const g = c.geoms[sheetId + '/' + view.id]
      const place = (d: Omit<Dimension, 'id'>) => {
        const id = drawingActions.addDim(sheetId, d)
        useDrawing.getState().select({ kind: 'dim', id })
        again()
      }
      if (tool === 'dim.radius' || tool === 'dim.diameter') {
        if (!work.circle) {
          const circ = nearestCircle(view, c.sheet, g, c.bodies, pt[0], pt[1], tol)
          if (!circ) return toast('Click on a circle that is drawn as a circle in this view', 'error')
          work.viewId = view.id
          work.circle = circ
          return hint()
        }
        const d = draftDim(tool, c.sheet, pt)
        if (d) place({ ...d, pts: [work.circle.pr] } as Omit<Dimension, 'id'>)
        return
      }
      const complete = work.placing || work.pts.length >= (needPts[tool] ?? 99)
      if (!complete) {
        const s = nearestSnap(viewSnaps(view, c.sheet, g, c.bodies), pt[0], pt[1], tol)
        if (!s) return
        work.viewId = view.id
        if (work.pts.some((p) => p.s[0] === s.s[0] && p.s[1] === s.s[1])) return
        work.pts.push(s)
        set({ hint: HINTS[tool][Math.min(work.pts.length, HINTS[tool].length - 1)] })
        return
      }
      const d = draftDim(tool, c.sheet, pt)
      if (d) place(d)
      return
    }

    // ---- annotations
    const pos = (): V2 => pt
    const first = work.pos[0] // the tool is reset before the annotation is made
    switch (tool) {
      case 'ann.note':
        endTool()
        return placeNote(sheetId, { kind: 'note', pos: pos(), text: 'NOTE', size: 3.5 })
      case 'ann.leader':
        if (!work.pos.length) { work.pos.push(pt); return hint() }
        endTool()
        return placeNote(sheetId, { kind: 'leader', pts: [first, pt], text: 'TEXT', size: 3.5 })
      case 'ann.gdt':
        if (!work.pos.length) { work.pos.push(pt); return hint() }
        endTool()
        return placeNote(sheetId, { kind: 'gdt', pos: pt, symbol: 'position', tol: '0.1', modifier: '', datums: [], diameter: false, tip: first })
      case 'ann.datum': {
        if (!work.pos.length) { work.pos.push(pt); return hint() }
        const used = new Set(c.sheet.notes.flatMap((n) => (n.kind === 'datum' ? [n.letter] : [])))
        const letter = 'ABCDEFGHJKLMNPRSTUVWY'.split('').find((l) => !used.has(l)) ?? 'A'
        endTool()
        return placeNote(sheetId, { kind: 'datum', pos: pt, letter, tip: first })
      }
      case 'ann.finish':
        endTool()
        return placeNote(sheetId, { kind: 'finish', pos: pos(), ra: '3.2', method: 'removal', allowance: '', lay: '' })
      case 'ann.balloon': {
        if (!work.pos.length) { work.pos.push(pt); return hint() }
        const parts = listComponents()
        if (!parts.length) { endTool(); return toast('The model has no parts to number', 'error') }
        const used = new Set(c.sheet.notes.flatMap((n) => (n.kind === 'balloon' ? [n.item] : [])))
        const next = parts.find((p) => !used.has(p.key)) ?? parts[0]
        endTool()
        return placeNote(sheetId, { kind: 'balloon', pos: pt, item: next.key, tip: first })
      }
      case 'ann.partsList':
        endTool()
        placeNote(sheetId, { kind: 'partsList', pos: pos() })
        return
    }
  } catch (e) {
    endTool()
    toast(e instanceof Error ? e.message : String(e), 'error')
  }
}

/** Enter: baseline dimensions stop collecting points and wait for the placing click. */
export function toolKey(key: string): boolean {
  const { tool } = useTool.getState()
  if (!tool) return false
  if (key === 'Escape') {
    endTool()
    return true
  }
  if (key === 'Enter' && tool === 'dim.baseline' && work.pts.length >= 2 && !work.placing) {
    work.placing = true
    set({ hint: HINTS[tool][3] })
    return true
  }
  return false
}

