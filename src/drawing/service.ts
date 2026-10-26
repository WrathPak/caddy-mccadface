/** Making views: orientation, scale and a free place on the sheet. */
import { sectionPlane, type Side, type V2 } from '@/kernel/drawing-geom'
import { itemsFor } from './components'
import { fitScale, sheetDims } from './sheets'
import { drawingActions, nextId, useDrawing } from './store'
import type { DrawingView, Sheet, ViewItem } from './types'
import {
  computeGeom, nextLetter, orientationName, orientationOf, projectedAxes, refreshGeoms, sightInPlane, toSheet, useViewGeoms, viewAxes, viewSheetSize, type ViewGeom,
} from './views'

export type Rect = [number, number, number, number]

/** The part of the sheet inside the border that views may use. */
export function drawingArea(sheet: Sheet): Rect {
  const { w, h } = sheetDims(sheet)
  const m = sheet.margin
  return [m + 5, m + 5, w - m - 5, h - m - 5]
}

export function titleBlockRect(sheet: Sheet): Rect {
  const t = useDrawing.getState().doc.template
  const { w } = sheetDims(sheet)
  return [w - sheet.margin - t.w, sheet.margin, w - sheet.margin, sheet.margin + t.h]
}

/** Sheet rectangle a view takes (including its label). */
export function viewRect(v: DrawingView, g: ViewGeom | undefined): Rect {
  if (!g?.bounds) return [v.pos[0], v.pos[1], v.pos[0], v.pos[1]]
  const a = toSheet(v, [g.bounds[0], g.bounds[1]]), b = toSheet(v, [g.bounds[2], g.bounds[3]])
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]) - (v.showLabel ? 9 : 0), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
}

const overlaps = (a: Rect, b: Rect, gap = 4) => a[0] < b[2] + gap && a[2] > b[0] - gap && a[1] < b[3] + gap && a[3] > b[1] - gap

/** A spot for a w x h box that does not touch the views, the title block or the border. Prefers the lower left. */
export function findSpot(sheet: Sheet, w: number, h: number, prefer?: V2): V2 | null {
  const area = drawingArea(sheet)
  const taken: Rect[] = sheet.views.map((v) => viewRect(v, useViewGeoms.getState().geoms[sheet.id + '/' + v.id]))
  taken.push(titleBlockRect(sheet))
  let best: V2 | null = null, bestScore = Infinity
  const step = 5
  for (let y = area[1]; y + h <= area[3]; y += step) {
    for (let x = area[0]; x + w <= area[2]; x += step) {
      const r: Rect = [x, y, x + w, y + h]
      if (taken.some((t) => overlaps(r, t))) continue
      const cx = x + w / 2, cy = y + h / 2
      const score = prefer ? Math.hypot(cx - prefer[0], cy - prefer[1]) : x * 0.6 + y
      if (score < bestScore) { bestScore = score; best = [cx, cy] }
    }
  }
  return best
}

const boundsCenter = (g: ViewGeom): V2 => (g.bounds ? [(g.bounds[0] + g.bounds[2]) / 2, (g.bounds[1] + g.bounds[3]) / 2] : [0, 0])

function blank(over: Partial<DrawingView> & Pick<DrawingView, 'kind' | 'label' | 'items' | 'eye' | 'right' | 'orientation'>): Omit<DrawingView, 'id'> {
  return { scale: 1, pos: [0, 0], anchor: [0, 0], showHidden: true, showTangent: false, showCenter: true, showLabel: true, ...over }
}

export interface BaseViewOptions {
  /** `all`, or a key from viewChoices() */
  choice: string
  orientation: string
  /** a fixed scale, or 0 to pick one that fits the sheet */
  scale: number
  showHidden: boolean
  showTangent: boolean
  showCenter: boolean
}

/** A base view (or an isometric view when the orientation is iso). Returns the new view id. */
export async function createBaseView(sheetId: string, o: BaseViewOptions): Promise<string> {
  const sheet = sheetOf(sheetId)
  const items = itemsFor(o.choice)
  if (!items.length) throw new Error('There is nothing to draw: the model has no solid bodies')
  const ax = orientationOf(o.orientation)
  const iso = o.orientation === 'iso'
  const draft = blank({ kind: iso ? 'iso' : 'base', label: iso ? 'ISOMETRIC' : (o.orientation === 'custom' ? 'VIEW' : o.orientation.toUpperCase()), items, eye: ax.eye, right: ax.right, orientation: o.orientation, showHidden: o.showHidden, showTangent: o.showTangent, showCenter: o.showCenter && !iso })
  const g = await computeGeom({ ...draft, id: 'tmp' }, { views: [] })
  if (!g?.bounds) throw new Error('The view is empty: the bodies have no edges to project')
  const area = drawingArea(sheet)
  const w = g.bounds[2] - g.bounds[0], h = g.bounds[3] - g.bounds[1]
  const first = sheet.views.length === 0
  const scale = o.scale > 0 ? o.scale : fitScale(w, h, (area[2] - area[0]) * (first ? 0.4 : 0.3), (area[3] - area[1]) * (first ? 0.42 : 0.3))
  const sw = w * scale, sh = h * scale + 9
  const spot = findSpot(sheet, sw, sh, first ? [area[0] + (area[2] - area[0]) * 0.3, area[1] + (area[3] - area[1]) * 0.32] : undefined)
    ?? [(area[0] + area[2]) / 2, (area[1] + area[3]) / 2]
  const c = boundsCenter(g)
  const id = drawingActions.addView(sheetId, { ...draft, scale, pos: [spot[0], spot[1] + (draft.showLabel ? 4.5 : 0)], anchor: c })
  await refreshGeoms(useDrawing.getState().doc.sheets)
  return id
}

const sheetOf = (id: string): Sheet => {
  const s = useDrawing.getState().doc.sheets.find((x) => x.id === id)
  if (!s) throw new Error('Sheet not found')
  return s
}

/** A view projected from `parentId`, placed on `side` of it. */
export async function createProjectedView(sheetId: string, parentId: string, side: Side): Promise<string> {
  const sheet = sheetOf(sheetId)
  const parent = sheet.views.find((v) => v.id === parentId)
  if (!parent) throw new Error('Pick the view to project from')
  const pax = viewAxes(parent, sheet)
  const ax = projectedAxes({ ...parent, ...pax }, side, sheet.projection)
  const name = orientationName(ax.eye, ax.right)
  const draft = blank({ kind: 'projected', label: name === 'custom' ? 'VIEW' : name.toUpperCase(), items: parent.items, eye: ax.eye, right: ax.right, orientation: name, parentId, showHidden: parent.showHidden, showTangent: parent.showTangent, showCenter: parent.showCenter, scale: parent.scale, align: side === 'left' || side === 'right' ? 'h' : 'v' })
  const g = await computeGeom({ ...draft, id: 'tmp' }, { views: [] })
  if (!g?.bounds) throw new Error('The projected view is empty')
  const pg = useViewGeoms.getState().geoms[sheetId + '/' + parentId]
  const pr = viewRect(parent, pg)
  const w = (g.bounds[2] - g.bounds[0]) * parent.scale, h = (g.bounds[3] - g.bounds[1]) * parent.scale
  const gap = 18
  const c = boundsCenter(g)
  // the projected view's centre sits level / plumb with the parent's centre
  let cx = parent.pos[0], cy = parent.pos[1]
  if (side === 'right') cx = pr[2] + gap + w / 2
  else if (side === 'left') cx = pr[0] - gap - w / 2
  else if (side === 'above') cy = pr[3] + gap + h / 2 + (draft.showLabel ? 9 : 0)
  else cy = pr[1] - gap - h / 2 - 9
  const id = drawingActions.addView(sheetId, { ...draft, pos: [cx, cy], anchor: c })
  await refreshGeoms(useDrawing.getState().doc.sheets)
  return id
}

/** A section view cut along the line a-b (in the parent view's plane coordinates). */
export async function createSectionView(sheetId: string, parentId: string, a: V2, b: V2, flip = false): Promise<string> {
  const sheet = sheetOf(sheetId)
  const parent = sheet.views.find((v) => v.id === parentId)
  if (!parent) throw new Error('Pick the view to cut')
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) throw new Error('The cut line has no length')
  const pax = viewAxes(parent, sheet)
  const pl = sectionPlane(pax.eye, pax.right, a, b, flip)
  const letter = nextLetter(sheet)
  const draft = blank({
    kind: 'section', label: `SECTION ${letter}-${letter}`, items: parent.items, eye: pl.secEye, right: pl.secRight, orientation: 'custom', parentId,
    showHidden: false, showTangent: false, showCenter: parent.showCenter, scale: parent.scale, cut: { a, b, letter, flip },
  })
  const g = await computeGeom({ ...draft, id: 'tmp' }, { views: [{ ...parent, ...pax }] })
  if (!g?.bounds) throw new Error('The cut line misses the model')
  const pg = useViewGeoms.getState().geoms[sheetId + '/' + parentId]
  const pr = viewRect(parent, pg)
  const w = (g.bounds[2] - g.bounds[0]) * parent.scale, h = (g.bounds[3] - g.bounds[1]) * parent.scale
  // the section is placed on the side the arrows point to (third angle); first angle puts it opposite
  const sight = sightInPlane(pax, pl.normal)
  const dir2: V2 = sheet.projection === 'third' ? sight : [-sight[0], -sight[1]]
  const horizontal = Math.abs(dir2[0]) >= Math.abs(dir2[1])
  const gap = 18
  let cx = parent.pos[0], cy = parent.pos[1]
  if (horizontal) cx = dir2[0] > 0 ? pr[2] + gap + w / 2 : pr[0] - gap - w / 2
  else cy = dir2[1] > 0 ? pr[3] + gap + h / 2 : pr[1] - gap - h / 2 - 9
  const c = boundsCenter(g)
  const id = drawingActions.addView(sheetId, { ...draft, pos: [cx, cy], anchor: c, align: horizontal ? 'h' : 'v' })
  await refreshGeoms(useDrawing.getState().doc.sheets)
  return id
}

/** A detail view: the circle (centre c, radius r in the parent's plane coordinates) shown at a larger scale. */
export async function createDetailView(sheetId: string, parentId: string, c: V2, r: number, scale: number): Promise<string> {
  const sheet = sheetOf(sheetId)
  const parent = sheet.views.find((v) => v.id === parentId)
  if (!parent) throw new Error('Pick the view to take the detail from')
  if (r <= 1e-6) throw new Error('The detail circle has no size')
  const letter = nextLetter(sheet)
  const pax = viewAxes(parent, sheet)
  const sc = scale > 0 ? scale : Math.min(parent.scale * 3, 50)
  const draft = blank({
    kind: 'detail', label: `DETAIL ${letter}`, items: parent.items, eye: pax.eye, right: pax.right, orientation: parent.orientation, parentId,
    showHidden: parent.showHidden, showTangent: parent.showTangent, showCenter: false, scale: sc, detail: { c, r, letter },
  })
  const pg = useViewGeoms.getState().geoms[sheetId + '/' + parentId]
  const g = await computeGeom({ ...draft, id: 'tmp' }, { views: [] }, pg)
  if (!g) throw new Error('The parent view has not been drawn yet')
  const w = 2 * r * sc, h = 2 * r * sc + 9
  const pr = viewRect(parent, pg)
  const spot = findSpot(sheet, w, h, [pr[2] + w, pr[3]]) ?? [(pr[2] + pr[0]) / 2, pr[3] + h]
  const id = drawingActions.addView(sheetId, { ...draft, pos: [spot[0], spot[1] + 4.5], anchor: c })
  await refreshGeoms(useDrawing.getState().doc.sheets)
  return id
}

/** Change the scale of a view (and of the views projected from it, so they stay in step). */
export function setViewScale(sheetId: string, viewId: string, scale: number) {
  useDrawing.getState().edit('View scale', (d) => {
    const s = d.sheets.find((x) => x.id === sheetId)
    const v = s?.views.find((x) => x.id === viewId)
    if (!s || !v) return
    const set = (x: DrawingView) => {
      x.scale = scale
      for (const c of s.views) if (c.parentId === x.id && c.kind !== 'detail') set(c)
    }
    set(v)
  })
}

export { nextId, viewSheetSize }
export type { ViewItem }
