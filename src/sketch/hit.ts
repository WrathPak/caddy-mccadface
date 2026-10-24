/** Hit testing and box selection against a SketchModel. */
import { closestOnArc, closestOnCircle, closestOnSegment, dist } from './geom'
import { circleOf, deps, lineEnds, pos } from './model'
import { closestOnDerived, isDerived } from './curves'
import { ORIGIN, type Entity, type SketchModel, type Vec2 } from './types'

/** Nearest entity under `p` within `tol` (points win over curves). Returns null for none. */
export function hitTest(m: SketchModel, p: Vec2, tol: number, filter?: (e: Entity) => boolean): string | null {
  let best: { id: string; d: number } | null = null
  const consider = (id: string, d: number, bias: number) => {
    if (d <= tol && (!best || d - bias < best.d)) best = { id, d: d - bias }
  }
  if (!filter) consider(ORIGIN, dist(p, [0, 0]), tol * 0.5)
  for (const e of m.entities) {
    if (filter && !filter(e)) continue
    if (e.type === 'point') consider(e.id, dist(p, [e.x, e.y]), tol * 0.5)
  }
  if (best) return (best as { id: string }).id
  for (const e of m.entities) {
    if (filter && !filter(e)) continue
    if (e.type === 'line') {
      const [a, b] = lineEnds(m, e)
      consider(e.id, dist(p, closestOnSegment(p, a, b).pt), 0)
    } else if (e.type === 'circle') {
      const { c, r } = circleOf(m, e)
      consider(e.id, dist(p, closestOnCircle(p, c, r)), 0)
    } else if (e.type === 'arc') {
      consider(e.id, dist(p, closestOnArc(p, pos(m, e.c), pos(m, e.s), pos(m, e.e))), 0)
    } else if (isDerived(e)) {
      consider(e.id, closestOnDerived(m, e, p).d, 0)
    }
  }
  return best ? (best as { id: string }).id : null
}

/** Entities fully inside the box [min, max]. */
export function boxSelect(m: SketchModel, a: Vec2, b: Vec2): string[] {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1])
  const inside = (p: Vec2) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1
  const ids: string[] = []
  for (const e of m.entities) {
    if (e.type === 'point') { if (inside([e.x, e.y])) ids.push(e.id) }
    else if (e.type === 'line') { const [p, q] = lineEnds(m, e); if (inside(p) && inside(q)) ids.push(e.id) }
    else if (e.type === 'circle') {
      const { c, r } = circleOf(m, e)
      if (inside([c[0] - r, c[1] - r]) && inside([c[0] + r, c[1] + r])) ids.push(e.id)
    } else if (e.type === 'arc') {
      if (inside(pos(m, e.c)) && inside(pos(m, e.s)) && inside(pos(m, e.e))) ids.push(e.id)
    } else if (deps(e).every((d) => inside(pos(m, d)))) ids.push(e.id)
  }
  return ids
}
