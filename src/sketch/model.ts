/** Pure helpers over SketchModel. Mutating helpers expect a model the caller owns (clone first). */
import { ORIGIN, isDim, type ArcE, type CircleE, type Constraint, type Entity, type LineE, type PointE, type SketchModel, type Vec2 } from './types'
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
  }
}

/** Remove entities/constraints by id, plus everything that depended on them; then drop points orphaned by it. */
export function removeIds(m: SketchModel, ids: Iterable<string>) {
  const gone = new Set(ids)
  let changed = true
  while (changed) {
    changed = false
    for (const e of m.entities) {
      if (!gone.has(e.id) && e.type !== 'point' && deps(e).some((d) => gone.has(d))) { gone.add(e.id); changed = true }
    }
    for (const c of m.constraints) {
      if (!gone.has(c.id) && c.refs.some((r) => gone.has(r))) { gone.add(c.id); changed = true }
    }
  }
  const candidates = new Set<string>()
  for (const e of m.entities) if (gone.has(e.id) && e.type !== 'point') deps(e).forEach((d) => candidates.add(d))
  m.entities = m.entities.filter((e) => !gone.has(e.id))
  m.constraints = m.constraints.filter((c) => !gone.has(c.id))
  const used = new Set<string>()
  for (const e of m.entities) if (e.type !== 'point') deps(e).forEach((d) => used.add(d))
  for (const c of m.constraints) c.refs.forEach((r) => used.add(r))
  m.entities = m.entities.filter((e) => e.type !== 'point' || !candidates.has(e.id) || used.has(e.id))
}

/** Merge point b into a (coincident). Drops constraints that become degenerate. */
export function mergePoints(m: SketchModel, a: string, b: string) {
  if (a === b) return
  if (b === ORIGIN) [a, b] = [b, a]
  for (const e of m.entities) {
    if (e.type === 'line') { if (e.p1 === b) e.p1 = a; if (e.p2 === b) e.p2 = a }
    else if (e.type === 'circle') { if (e.c === b) e.c = a }
    else if (e.type === 'arc') { if (e.c === b) e.c = a; if (e.s === b) e.s = a; if (e.e === b) e.e = a }
  }
  for (const c of m.constraints) c.refs = c.refs.map((r) => (r === b ? a : r))
  m.constraints = m.constraints.filter((c) => !(c.type === 'fix' && c.refs[0] === ORIGIN))
  // degenerate: same point twice in a two-point constraint
  m.constraints = m.constraints.filter((c) => !((c.type === 'distance' || c.type === 'hdist' || c.type === 'vdist') && c.refs[0] === c.refs[1]))
  m.entities = m.entities.filter((e) => e.id !== b)
  // zero-length lines created by the merge
  const dead = m.entities.filter((e) => e.type === 'line' && e.p1 === e.p2).map((e) => e.id)
  if (dead.length) removeIds(m, dead)
}

/** Points a (non-point) entity moves with, for dragging. */
export function entityPoints(m: SketchModel, id: string): string[] {
  const e = entityById(m, id)
  if (!e) return []
  return e.type === 'point' ? [e.id] : deps(e).filter((d) => d !== ORIGIN)
}

export const dimCount = (m: SketchModel) => m.constraints.filter(isDim).length
