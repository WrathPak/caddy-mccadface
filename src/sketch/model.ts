/** Pure helpers over SketchModel. Mutating helpers expect a model the caller owns (clone first). */
import { ORIGIN, isDim, type ArcE, type CircleE, type Constraint, type EllipseE, type Entity, type LineE, type PointE, type SketchModel, type SplineE, type TextE, type Vec2 } from './types'
import { arcInfo, dist } from './geom'

export const cloneModel = (m: SketchModel): SketchModel => JSON.parse(JSON.stringify(m)) as SketchModel

export const entityById = (m: SketchModel, id: string) => m.entities.find((e) => e.id === id)
export const isPointId = (id: string) => id === ORIGIN || id[0] === 'p'

export function pos(m: SketchModel, id: string): Vec2 {
  if (id === ORIGIN) return [0, 0]
  const e = entityById(m, id)
  return e && e.type === 'point' ? [e.x, e.y] : [0, 0]
}
export const lineEnds = (m: SketchModel, l: LineE): [Vec2, Vec2] => [pos(m, l.p1), pos(m, l.p2)]
export const circleOf = (m: SketchModel, e: CircleE | ArcE): { c: Vec2; r: number } =>
  e.type === 'circle' ? { c: pos(m, e.c), r: e.r } : { c: pos(m, e.c), r: dist(pos(m, e.c), pos(m, e.s)) }
export const arcOf = (m: SketchModel, e: ArcE) => arcInfo(pos(m, e.c), pos(m, e.s), pos(m, e.e))

export function newId(m: SketchModel, prefix: 'p' | 'l' | 'c' | 'k'): string {
  return prefix + m.next++
}
export function addPoint(m: SketchModel, x: number, y: number, construction = false): string {
  const e: PointE = { id: newId(m, 'p'), type: 'point', x, y, ...(construction ? { construction } : {}) }
  m.entities.push(e)
  return e.id
}
export function addLine(m: SketchModel, p1: string, p2: string, construction = false): LineE {
  const e: LineE = { id: newId(m, 'l'), type: 'line', p1, p2, ...(construction ? { construction } : {}) }
  m.entities.push(e)
  return e
}
export function addCircle(m: SketchModel, c: string, r: number, construction = false): CircleE {
  const e: CircleE = { id: newId(m, 'l'), type: 'circle', c, r, ...(construction ? { construction } : {}) }
  m.entities.push(e)
  return e
}
export function addArc(m: SketchModel, c: string, s: string, e: string, construction = false): ArcE {
  const a: ArcE = { id: newId(m, 'l'), type: 'arc', c, s, e, ...(construction ? { construction } : {}) }
  m.entities.push(a)
  return a
}
export function addSpline(m: SketchModel, pts: string[], mode: SplineE['mode'] = 'fit', closed = false, construction = false): SplineE {
  const e: SplineE = { id: newId(m, 'l'), type: 'spline', mode, pts, ...(closed ? { closed } : {}), ...(construction ? { construction } : {}) }
  m.entities.push(e)
  return e
}
export function addEllipse(m: SketchModel, c: string, major: string, r: number, construction = false): EllipseE {
  const e: EllipseE = { id: newId(m, 'l'), type: 'ellipse', c, m: major, r, ...(construction ? { construction } : {}) }
  m.entities.push(e)
  return e
}
export function addText(m: SketchModel, p: string, text: string, h: number, a = 0, font?: string): TextE {
  const e: TextE = { id: newId(m, 'l'), type: 'text', p, text, h, a, ...(font ? { font } : {}) }
  m.entities.push(e)
  return e
}
export function addConstraint(m: SketchModel, c: Omit<Constraint, 'id'>): Constraint {
  const k: Constraint = { id: newId(m, 'k'), ...c }
  m.constraints.push(k)
  return k
}

/** Entity ids an entity depends on. */
export function deps(e: Entity): string[] {
  switch (e.type) {
    case 'point': return []
    case 'line': return [e.p1, e.p2]
    case 'circle': return [e.c]
    case 'arc': return [e.c, e.s, e.e]
    case 'spline': return [...e.pts, ...(e.t0 ? [e.t0] : []), ...(e.t1 ? [e.t1] : [])]
    case 'ellipse': return [e.c, e.m]
    case 'text': return [e.p]
  }
}

/**
 * Remove entities / constraints by id, plus everything that depended on them: curves built on removed points,
 * constraints that reference anything removed, and the other members of a removed constraint's `group`. Points left
 * without a curve (the end points of a deleted line, ...) are removed too, together with the constraints on them.
 */
export function removeIds(m: SketchModel, ids: Iterable<string>) {
  const gone = new Set(ids)
  const cascade = () => {
    let changed = true
    while (changed) {
      changed = false
      for (const e of m.entities) {
        if (!gone.has(e.id) && e.type !== 'point' && deps(e).some((d) => gone.has(d))) { gone.add(e.id); changed = true }
      }
      for (const c of m.constraints) {
        if (!gone.has(c.id) && c.refs.some((r) => gone.has(r))) { gone.add(c.id); changed = true }
      }
      const groups = new Set(m.constraints.filter((c) => gone.has(c.id) && c.group).map((c) => c.group))
      if (groups.size) for (const c of m.constraints) if (!gone.has(c.id) && c.group && groups.has(c.group)) { gone.add(c.id); changed = true }
    }
  }
  cascade()
  // points that only belonged to removed curves
  const candidates = new Set<string>()
  for (const e of m.entities) if (gone.has(e.id) && e.type !== 'point') deps(e).forEach((d) => candidates.add(d))
  const used = new Set<string>()
  for (const e of m.entities) if (!gone.has(e.id) && e.type !== 'point') deps(e).forEach((d) => used.add(d))
  for (const p of candidates) if (p !== ORIGIN && !used.has(p)) gone.add(p)
  cascade()
  m.entities = m.entities.filter((e) => !gone.has(e.id))
  m.constraints = m.constraints.filter((c) => !gone.has(c.id))
}

/** Add a coincident constraint between two points (no-op for identical points or an existing one). */
export function addCoincident(m: SketchModel, a: string, b: string): Constraint | null {
  if (a === b) return null
  const dup = m.constraints.find((c) => c.type === 'coincident' && c.refs.includes(a) && c.refs.includes(b))
  if (dup) return dup
  return addConstraint(m, { type: 'coincident', refs: [a, b] })
}

/** Points a (non-point) entity moves with, for dragging. */
export function entityPoints(m: SketchModel, id: string): string[] {
  const e = entityById(m, id)
  if (!e) return []
  return e.type === 'point' ? [e.id] : deps(e).filter((d) => d !== ORIGIN)
}

export const dimCount = (m: SketchModel) => m.constraints.filter(isDim).length

// ---- tangency at shared end points

/** End point ids of a line / arc (empty for other entities). */
export function endPointsOf(e: Entity | undefined): string[] {
  return e?.type === 'line' ? [e.p1, e.p2] : e?.type === 'arc' ? [e.s, e.e] : e?.type === 'spline' && !e.closed ? [e.pts[0], e.pts[e.pts.length - 1]] : []
}

/** Point id (taken from curve `a`) where curves `a` and `b` meet end to end, or null. */
export function sharedEnd(m: SketchModel, a: string, b: string): string | null {
  const pa = endPointsOf(entityById(m, a)), pb = endPointsOf(entityById(m, b))
  for (const x of pa) for (const y of pb) if (x === y || dist(pos(m, x), pos(m, y)) < 1e-6) return x
  return null
}

/** Direction of a curve at a point on it: lines run p1 -> p2, arcs and circles counter-clockwise. */
export function tangentOf(m: SketchModel, id: string, p: Vec2): Vec2 {
  const e = entityById(m, id)
  if (e?.type === 'line') { const [a, b] = lineEnds(m, e); return [b[0] - a[0], b[1] - a[1]] }
  const c = e && (e.type === 'circle' || e.type === 'arc') ? pos(m, e.c) : [0, 0]
  return [-(p[1] - c[1]), p[0] - c[0]]
}

/** 0 when the two curves run the same way at `point`, 180 when they run against each other (value of a tangentAt). */
export function tangentValue(m: SketchModel, a: string, b: string, point: string): 0 | 180 {
  const p = pos(m, point)
  const t1 = tangentOf(m, a, p), t2 = tangentOf(m, b, p)
  return t1[0] * t2[0] + t1[1] * t2[1] >= 0 ? 0 : 180
}
