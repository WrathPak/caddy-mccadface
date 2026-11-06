/**
 * Does a constraint still hold at the geometry as it is? Used when an edit moves points about (Trim, Extend, Move): the constraints
 * the move did not disturb stay, the ones it broke are released. Constraints of kinds that are only meaningful as a whole (tangent at
 * an end, a fixed point ...) count as broken once a point they name has moved.
 */
import { closestOnLine, dist, sub } from './geom'
import { measureDim } from './dims'
import { circleOf, entityById, lineEnds, pos } from './model'
import { isDim, type Constraint, type SketchModel, type Vec2 } from './types'

const TOL = 1e-6

const lineOf = (m: SketchModel, id: string): [Vec2, Vec2] | null => {
  const e = entityById(m, id)
  if (e?.type === 'line') return lineEnds(m, e)
  if (e?.type === 'ellipse') return [pos(m, e.c), pos(m, e.m)]
  return null
}
const lenOf = (m: SketchModel, id: string): number | null => {
  const e = entityById(m, id)
  if (e?.type === 'line') return dist(...lineEnds(m, e))
  if (e?.type === 'circle' || e?.type === 'arc') return circleOf(m, e).r
  return null
}

export function holds(m: SketchModel, c: Constraint): boolean {
  const [a, b] = c.refs
  const scale = (v: number) => TOL * Math.max(1, Math.abs(v))
  if (isDim(c)) {
    const me = measureDim(m, c.type, c.refs, c.supp)
    if (!me || c.value === undefined) return false
    const signed = c.type === 'hdist' || c.type === 'vdist' || c.type === 'angle' || c.type === 'offset'
    return Math.abs(me.value - c.value) <= scale(c.value) && (!signed || me.sgn === (c.sgn ?? 1))
  }
  switch (c.type) {
    case 'coincident': return dist(pos(m, a), pos(m, b)) < TOL
    case 'pointOnLine': { const l = lineOf(m, b); return !!l && dist(pos(m, a), closestOnLine(pos(m, a), l[0], l[1])) < TOL }
    case 'pointOnCurve': { const e = entityById(m, b); if (e?.type !== 'circle' && e?.type !== 'arc') return false; const k = circleOf(m, e); return Math.abs(dist(pos(m, a), k.c) - k.r) < TOL }
    case 'onAxis': return Math.abs(c.axis === 'x' ? pos(m, a)[1] : pos(m, a)[0]) < TOL
    case 'midpoint': { const l = lineOf(m, b); return !!l && dist(pos(m, a), [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2]) < TOL }
    case 'horizontal': case 'vertical': {
      const [p, q] = b ? [pos(m, a), pos(m, b)] : (lineOf(m, a) ?? [[0, 0], [0, 0]])
      const d = sub(q, p)
      return Math.abs(c.type === 'horizontal' ? d[1] : d[0]) < TOL
    }
    case 'parallel': case 'perpendicular': {
      const l1 = lineOf(m, a), l2 = lineOf(m, b)
      if (!l1 || !l2) return false
      const d1 = sub(l1[1], l1[0]), d2 = sub(l2[1], l2[0])
      const n = Math.hypot(...d1) * Math.hypot(...d2) || 1
      return Math.abs(c.type === 'parallel' ? d1[0] * d2[1] - d1[1] * d2[0] : d1[0] * d2[0] + d1[1] * d2[1]) / n < TOL
    }
    case 'equal': { const x = lenOf(m, a), y = lenOf(m, b); return x !== null && y !== null && Math.abs(x - y) < scale(x) }
    default: return false
  }
}
