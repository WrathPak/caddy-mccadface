/** Hit testing and box selection against a SketchModel. */
import { arcInfo, closestOnArc, closestOnCircle, closestOnSegment, dist, sampleArc } from './geom'
import { circleOf, deps, lineEnds, pos } from './model'
import { closestOnDerived, derivedPolys, isDerived } from './curves'
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

/** Does the segment p-q touch the box? (Liang-Barsky clip) */
function segHitsBox(p: Vec2, q: Vec2, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0, t1 = 1
  const dx = q[0] - p[0], dy = q[1] - p[1]
  for (const [pp, qq] of [[-dx, p[0] - x0], [dx, x1 - p[0]], [-dy, p[1] - y0], [dy, y1 - p[1]]]) {
    if (Math.abs(pp) < 1e-12) { if (qq < 0) return false; continue }
    const r = qq / pp
    if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r } else { if (r < t0) return false; if (r < t1) t1 = r }
  }
  return true
}

/**
 * Entities the box touches (dragged right to left, "crossing"), or - dragged left to right - only those fully inside it.
 * Like Fusion 360: a window takes what it encloses, a crossing box everything it reaches.
 */
export function boxSelect(m: SketchModel, a: Vec2, b: Vec2, crossing = false): string[] {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1])
  const inside = (p: Vec2) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1
  const ids: string[] = []
  if (crossing) {
    const polyHits = (pts: Vec2[]) => pts.length === 1 ? inside(pts[0]) : pts.some((p, i) => i > 0 && segHitsBox(pts[i - 1], p, x0, y0, x1, y1))
    for (const e of m.entities) {
      let hit = false
      if (e.type === 'point') hit = inside([e.x, e.y])
      else if (e.type === 'line') { const [p, q] = lineEnds(m, e); hit = segHitsBox(p, q, x0, y0, x1, y1) }
      else if (e.type === 'circle') { const { c, r } = circleOf(m, e); hit = polyHits([...sampleArc(c, r, 0, 2 * Math.PI, Math.PI / 90)]) }
      else if (e.type === 'arc') {
        const c = pos(m, e.c), i = arcInfo(c, pos(m, e.s), pos(m, e.e))
        hit = polyHits([pos(m, e.s), ...sampleArc(c, i.r, i.a0, i.a1, Math.PI / 90)])
      } else if (isDerived(e)) hit = derivedPolys(m, e).some(polyHits)
      else hit = deps(e).some((d) => inside(pos(m, d)))
      if (hit) ids.push(e.id)
    }
    return ids
  }
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
