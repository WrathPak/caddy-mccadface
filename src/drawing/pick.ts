/** Finding things on the sheet under the pointer: prims (for selecting), views, and the model points a dimension can snap to. */
import { viewBasis, nearestOnPolys, type V2 } from '@/kernel/drawing-geom'
import type { Body } from '@/kernel/types'
import { textWidth } from './dims'
import { locateCircle, snapPoints, type SnapPoint } from './model3d'
import { viewRect } from './service'
import type { DrawingView, PointRef, Prim, Sheet } from './types'
import { toSheet, viewAxes, type ViewGeom } from './views'

const distSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

const inside = (pts: number[], x: number, y: number) => {
  let c = false
  const n = pts.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1], xj = pts[j * 2], yj = pts[j * 2 + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** Distance (sheet mm) from a point to a primitive. */
export function primDistance(p: Prim, x: number, y: number): number {
  if (p.k === 'text') {
    const w = textWidth(p.text, p.size), h = p.size
    // box in the text's own frame
    const th = ((p.rot ?? 0) * Math.PI) / 180
    const c = Math.cos(th), s = Math.sin(th)
    const rx = (x - p.x) * c + (y - p.y) * s, ry = -(x - p.x) * s + (y - p.y) * c
    const x0 = p.anchor === 'start' ? 0 : p.anchor === 'middle' ? -w / 2 : -w
    const dx = Math.max(x0 - rx, 0, rx - (x0 + w)), dy = Math.max(-h * 0.25 - ry, 0, ry - h * 0.9)
    return Math.hypot(dx, dy)
  }
  const q = p.pts
  if (p.pick || p.fill === 'solid') return inside(q, x, y) ? 0 : p.pick ? Infinity : minSeg(q, x, y, true)
  return minSeg(q, x, y, !!p.closed)
}
function minSeg(q: number[], x: number, y: number, closed: boolean) {
  let best = Infinity
  for (let i = 2; i < q.length; i += 2) best = Math.min(best, distSeg(x, y, q[i - 2], q[i - 1], q[i], q[i + 1]))
  if (closed && q.length >= 6) best = Math.min(best, distSeg(x, y, q[q.length - 2], q[q.length - 1], q[0], q[1]))
  return best
}

/**
 * The owner ('view:v1', 'dim:d2', 'note:n3') of the thing nearest to a point, within `tol` mm. Dimensions and notes win over
 * the view lines they sit on; the border and title block are not pickable.
 */
export function hitOwner(prims: Prim[], x: number, y: number, tol: number): string | null {
  const best = new Map<string, number>()
  for (const p of prims) {
    const o = p.owner
    if (!o || o === 'border' || o === 'titleblock') continue
    const d = primDistance(p, x, y)
    if (d <= tol && d < (best.get(o) ?? Infinity)) best.set(o, d)
  }
  let pick: string | null = null, pd = Infinity
  for (const [o, d] of best) {
    const w = o.startsWith('view:') ? d + tol * 0.75 : d // an annotation beats the view lines under it
    if (w < pd) { pd = w; pick = o }
  }
  return pick
}

/** The view whose rectangle holds a sheet point (the smallest one when they overlap). */
export function viewAt(sheet: Sheet, geoms: Record<string, ViewGeom>, x: number, y: number, margin = 2): DrawingView | null {
  let best: DrawingView | null = null, area = Infinity
  for (const v of sheet.views) {
    const r = viewRect(v, geoms[sheet.id + '/' + v.id])
    if (x >= r[0] - margin && x <= r[2] + margin && y >= r[1] - margin && y <= r[3] + margin) {
      const a = (r[2] - r[0]) * (r[3] - r[1])
      if (a < area) { area = a; best = v }
    }
  }
  return best
}

// ---------------------------------------------------------------- snapping

export interface Snap { pt: PointRef; s: V2; kind: SnapPoint['kind']; viewId: string; edge?: number }

const cache = new Map<string, Snap[]>()

/** Model points of a view that can be dimensioned: only the ones that are drawn visible (or on a hidden line the view shows). */
export function viewSnaps(v: DrawingView, sheet: Pick<Sheet, 'views'>, g: ViewGeom | undefined, bodies: Body[]): Snap[] {
  if (!g) return []
  const key = [v.id, g.key, v.pos.join(','), v.scale, v.showHidden, bodies.map((b) => b.key).join(',')].join('|')
  const hit = cache.get(key)
  if (hit) return hit
  const ax = viewAxes(v, sheet)
  const basis = viewBasis(ax.eye, ax.right)
  const items = v.items.flatMap((item) => {
    const body = bodies.find((b) => b.id === item.bodyId)
    return body && body.kind === 'brep' ? [{ body, item }] : []
  })
  const tol = 0.05 / v.scale + 1e-6
  const lines = v.showHidden ? [...g.visible, ...g.hidden] : g.visible
  const onLine = (p: V2) => nearestOnPolys(p[0], p[1], lines) <= tol
  const all = snapPoints(items, basis)
  // circle centers count when their circle is drawn: look at the quadrant points of the same edge
  const visibleEdges = new Set<string>()
  for (const s of all) if (s.kind === 'quad' && s.pt.ref.kind === 'edge' && onLine(s.p2)) visibleEdges.add(s.bodyId + ':' + s.pt.ref.index)
  const out: Snap[] = []
  for (const s of all) {
    const ok = s.kind === 'center' ? s.pt.ref.kind === 'edge' && visibleEdges.has(s.bodyId + ':' + s.pt.ref.index) : onLine(s.p2)
    if (!ok) continue
    out.push({ pt: s.pt, s: toSheet(v, s.p2), kind: s.kind, viewId: v.id, edge: s.pt.ref.kind === 'edge' ? s.pt.ref.index : undefined })
  }
  if (cache.size > 40) cache.clear()
  cache.set(key, out)
  return out
}

/** The snap nearest to a sheet point, within `tol` mm. Corners and centers win ties over edge midpoints and quadrants. */
export function nearestSnap(snaps: Snap[], x: number, y: number, tol: number): Snap | null {
  let best: Snap | null = null, bd = Infinity
  for (const s of snaps) {
    const d = Math.hypot(s.s[0] - x, s.s[1] - y) + (s.kind === 'vertex' || s.kind === 'center' ? 0 : tol * 0.25)
    if (d <= tol && d < bd) { bd = d; best = s }
  }
  return best
}

/** The circle (edge ref + sheet center and radius) whose outline is nearest to a point, within `tol` mm. */
export function nearestCircle(v: DrawingView, sheet: Pick<Sheet, 'views'>, g: ViewGeom | undefined, bodies: Body[], x: number, y: number, tol: number): { pr: PointRef; c: V2; r: number } | null {
  const ax = viewAxes(v, sheet)
  const basis = viewBasis(ax.eye, ax.right)
  let best: { pr: PointRef; c: V2; r: number } | null = null, bd = Infinity
  for (const s of viewSnaps(v, sheet, g, bodies)) {
    if (s.kind !== 'center') continue
    const info = locateCircle(s.pt, bodies, basis)
    if (!info || !info.faceOn) continue
    const c = toSheet(v, info.center), r = info.radius * v.scale
    const d = Math.abs(Math.hypot(x - c[0], y - c[1]) - r)
    if (d <= tol && d < bd) { bd = d; best = { pr: s.pt, c, r } }
  }
  return best
}
