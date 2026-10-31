import { gridSnapStep } from '@/viewport/gridMath'
/** Cursor snapping: points, midpoints, centers, on-curve, axis / alignment inference and the grid. */
import { ORIGIN, type SketchModel, type Vec2 } from './types'
import { closestOnArc, closestOnCircle, closestOnSegment, dist, mid } from './geom'
import { circleOf, lineEnds, pos } from './model'
import { closestOnDerived, isDerived } from './curves'

export type SnapKind = 'point' | 'origin' | 'center' | 'mid' | 'on' | 'axis' | 'grid' | 'free' | 'quad' | 'int' | 'infer'

export interface Guide { from: Vec2; to: Vec2 }
export interface Snap {
  pos: Vec2
  kind: SnapKind
  pointId?: string
  /** curve the cursor is on / the line whose midpoint it is */
  entityId?: string
  axis?: 'x' | 'y'
  /** horizontal / vertical lock relative to the tool anchor (adds an H / V constraint to a line) */
  h?: boolean
  v?: boolean
  guides: Guide[]
  /** relations inferred for the segment being drawn (see infer.ts), applied as constraints when the point is placed */
  rel?: import('./infer').Rel[]
  /** reference curves to highlight */
  refs?: string[]
  /** intersection: the two curves; quadrant: the circle's centre and whether the point is level (h) or above / below (v) it */
  entityIds?: string[]
  quad?: { center: string; axis: 'h' | 'v' }
  hint?: string
  /** unit direction of the inferred ray */
  dir?: Vec2
}

export interface SnapCtx {
  model: SketchModel
  /** local units per screen pixel */
  wpp: number
  grid: boolean
  anchor?: Vec2
  /** entity ids ignored as snap targets (things being dragged) */
  exclude?: Set<string>
}

/** Snap spacing: the visible minor / major grid layer (see viewport/gridMath), 8..80 px per cell. */
export function gridStep(wpp: number): number {
  return gridSnapStep(wpp)
}

/**
 * A value on the grid: on a line of the current step when one is within `reach` (a few pixels), else on the next finer one, so a
 * click never lands far from where the cursor was (the next segment is measured from here) yet the value is always round.
 */
export function gridValue(v: number, step: number, reach: number): number {
  const r = Math.round(v / step) * step
  if (Math.abs(r - v) <= reach) return r
  const f = step / 10
  return Math.round(v / f) * f
}

const centers = (m: SketchModel) => {
  const s = new Set<string>()
  for (const e of m.entities) if (e.type === 'circle' || e.type === 'arc') s.add(e.c)
  return s
}

export function snap(raw: Vec2, ctx: SnapCtx): Snap {
  const { model: m, wpp } = ctx
  const ex = ctx.exclude ?? new Set<string>()
  const px = (n: number) => n * wpp
  const out: Snap = { pos: raw, kind: 'free', guides: [] }

  // 1. points (incl. origin and centers)
  let best: { id: string; d: number } | null = null
  const ctr = centers(m)
  const consider = (id: string, p: Vec2) => {
    if (ex.has(id)) return
    const d = dist(raw, p)
    if (d < px(10) && (!best || d < best.d)) best = { id, d }
  }
  consider(ORIGIN, [0, 0])
  for (const e of m.entities) if (e.type === 'point') consider(e.id, [e.x, e.y])
  if (best) {
    const id = (best as { id: string }).id
    return { ...out, pos: pos(m, id), kind: id === ORIGIN ? 'origin' : ctr.has(id) ? 'center' : 'point', pointId: id }
  }

  // 2. line midpoints
  for (const e of m.entities) {
    if (e.type !== 'line' || ex.has(e.id)) continue
    const [a, b] = lineEnds(m, e)
    const c = mid(a, b)
    if (dist(raw, c) < px(9)) return { ...out, pos: c, kind: 'mid', entityId: e.id }
  }

  // 3. on a curve
  let on: { snap: Snap; d: number } | null = null
  for (const e of m.entities) {
    if (e.type === 'point' || ex.has(e.id)) continue
    let q: Vec2
    if (e.type === 'line') {
      const [a, b] = lineEnds(m, e)
      q = closestOnSegment(raw, a, b).pt
    } else if (e.type === 'circle') {
      const { c, r } = circleOf(m, e)
      q = closestOnCircle(raw, c, r)
    } else if (e.type === 'arc') {
      q = closestOnArc(raw, pos(m, e.c), pos(m, e.s), pos(m, e.e))
    } else if (isDerived(e)) {
      q = closestOnDerived(m, e, raw).pt
    } else continue
    const d = dist(raw, q)
    if (d < px(7) && (!on || d < on.d)) on = { snap: { ...out, pos: q, kind: 'on', entityId: e.id }, d }
  }
  if (on) return (on as { snap: Snap }).snap

  // 4. inference: lock to the anchor's horizontal / vertical, align with other points and the axes
  let [x, y] = raw
  let lockX = false, lockY = false
  const guides: Guide[] = []
  if (ctx.anchor) {
    if (Math.abs(y - ctx.anchor[1]) < px(6)) { y = ctx.anchor[1]; lockY = true; out.h = true; guides.push({ from: ctx.anchor, to: [x, y] }) }
    if (Math.abs(x - ctx.anchor[0]) < px(6)) { x = ctx.anchor[0]; lockX = true; out.v = true; guides.push({ from: ctx.anchor, to: [x, y] }) }
  }
  if (!lockX || !lockY) {
    const all: Vec2[] = [[0, 0], ...(m.entities.filter((e) => e.type === 'point' && !ex.has(e.id)) as { x: number; y: number }[]).map((p): Vec2 => [p.x, p.y])]
    for (const p of all) {
      if (!lockY && Math.abs(y - p[1]) < px(6)) {
        y = p[1]; lockY = true
        guides.push({ from: p, to: [x, y] })
        if (p[0] === 0 && p[1] === 0) out.axis = 'x'
      }
      if (!lockX && Math.abs(x - p[0]) < px(6)) {
        x = p[0]; lockX = true
        guides.push({ from: p, to: [x, y] })
        if (p[0] === 0 && p[1] === 0) out.axis = out.axis ? undefined : 'y'
      }
    }
  }
  // 5. grid
  if (ctx.grid) {
    const g = gridStep(wpp)
    if (!lockX) x = gridValue(x, g, px(6))
    if (!lockY) y = gridValue(y, g, px(6))
  }
  const kind: SnapKind = out.axis && lockX !== lockY ? 'axis' : lockX || lockY ? 'free' : ctx.grid ? 'grid' : 'free'
  // an axis snap pins the point to the axis only when exactly one coordinate was aligned with the origin
  if (kind !== 'axis') out.axis = undefined
  return { ...out, pos: [x, y], kind, guides }
}
