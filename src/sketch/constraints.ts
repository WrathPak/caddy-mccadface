/** Applying geometric constraints to a model from a set of picked entity ids. */
import { ORIGIN, type Constraint, type Entity, type LineE, type SketchModel, type Vec2 } from './types'
import { addCoincident, addConstraint, deps, entityById, lineEnds, pos, sharedEnd, tangentValue } from './model'
import { dist, sub } from './geom'
import { tangentSpline } from './shapes'

export type CKind = 'hv' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'equal' | 'coincident' | 'midpoint' | 'fix' | 'concentric' | 'collinear' | 'symmetric' | 'smooth'

export const CKIND_LABEL: Record<CKind, string> = {
  hv: 'Horizontal / Vertical', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
  tangent: 'Tangent', equal: 'Equal', coincident: 'Coincident', midpoint: 'Midpoint', fix: 'Fix',
  concentric: 'Concentric', collinear: 'Collinear', symmetric: 'Symmetry', smooth: 'Smooth',
}

const kindOf = (m: SketchModel, id: string) => (id === ORIGIN ? 'point' : entityById(m, id)?.type)
const isCurve = (t?: string) => t === 'circle' || t === 'arc'
/** things with a direction: lines, and ellipses by their major axis */
const isLineLike = (t?: string) => t === 'line' || t === 'ellipse'
/** things with a centre point: circles, arcs, ellipses, and a point on its own */
const isCentred = (t?: string) => isCurve(t) || t === 'ellipse' || t === 'point'

/** More picks are still expected for `kind` (Symmetry takes the two things, then the line): the tool keeps the picks rather than calling them invalid. */
export function expects(m: SketchModel, kind: CKind, ids: string[]): boolean {
  if (kind !== 'symmetric' || ids.length >= 3) return false
  const t = ids.map((i) => kindOf(m, i))
  return ids.length === 1 ? ['point', 'line', 'circle', 'arc'].includes(t[0] ?? '') : t[0] === t[1] && ids[0] !== ids[1]
}

/** True when `ids` is a complete input for `kind`, picked in either order, or a whole selection of lines / curves / points to apply it to. */
export function ready(m: SketchModel, kind: CKind, ids: string[]): boolean {
  return readyIn(m, kind, ids) || (ids.length === 2 && readyIn(m, kind, [ids[1], ids[0]])) || manyKind(m, kind, ids) !== null
}

/** Three or more picked things for a constraint that pairs them: 'each' (one constraint per thing) or 'first' (every other one with the first). */
function manyKind(m: SketchModel, kind: CKind, ids: string[]): 'each' | 'first' | null {
  if (ids.length < 2) return null
  const t = ids.map((i) => kindOf(m, i))
  const all = (f: (x?: string) => boolean) => t.every(f)
  if ((kind === 'hv' || kind === 'horizontal' || kind === 'vertical') && all(isLineLike)) return 'each'
  if (ids.length < 3) return null
  if (kind === 'equal' && (all((x) => x === 'line') || all((x) => isCurve(x) || x === 'ellipse'))) return 'first'
  if (kind === 'parallel' && all(isLineLike)) return 'first'
  if (kind === 'coincident' && all((x) => x === 'point')) return 'first'
  if (kind === 'concentric' && all(isCentred)) return 'first'
  return null
}

function readyIn(m: SketchModel, kind: CKind, ids: string[]): boolean {
  const t = ids.map((i) => kindOf(m, i))
  switch (kind) {
    case 'hv':
    case 'horizontal':
    case 'vertical': return (ids.length === 1 && (t[0] === 'line' || t[0] === 'ellipse')) || (ids.length === 2 && t[0] === 'point' && t[1] === 'point')
    case 'parallel':
    case 'perpendicular': return ids.length === 2 && isLineLike(t[0]) && isLineLike(t[1])
    case 'equal': return ids.length === 2 && ((t[0] === 'line' && t[1] === 'line') || ((isCurve(t[0]) || t[0] === 'ellipse') && (isCurve(t[1]) || t[1] === 'ellipse')))
    case 'tangent':
      if (t[0] === 'spline' || t[1] === 'spline') return ids.length === 2 && (t[0] === 'spline' ? t[1] === 'line' || isCurve(t[1]) || t[1] === 'spline' : t[0] === 'line' || isCurve(t[0]))
      return ids.length === 2 && (t[0] === 'line' ? isCurve(t[1]) : isCurve(t[0]) && (t[1] === 'line' || isCurve(t[1])))
    case 'coincident': return ids.length === 2 && ((t[0] === 'point' && t[1] === 'point') || (t[0] === 'point' && (t[1] === 'line' || isCurve(t[1]))))
    case 'midpoint': return ids.length === 2 && t[0] === 'point' && (t[1] === 'line' || t[1] === 'arc')
    case 'concentric': return ids.length === 2 && isCentred(t[0]) && isCentred(t[1]) && !(t[0] === 'point' && t[1] === 'point')
    case 'collinear': return ids.length === 2 && t[0] === 'line' && t[1] === 'line'
    case 'smooth': return ids.length === 2 && (t[0] === 'spline' ? t[1] === 'line' || isCurve(t[1]) || t[1] === 'spline' : t[1] === 'spline' && (t[0] === 'line' || isCurve(t[0])))
    // two things and the line they mirror across (picked last): two points, two lines, two circles or two arcs
    case 'symmetric': return ids.length === 3 && t[2] === 'line' && t[0] === t[1] && (t[0] === 'point' || t[0] === 'line' || t[0] === 'circle' || t[0] === 'arc') && ids[0] !== ids[1] && ids[0] !== ids[2] && ids[1] !== ids[2]
    case 'fix': return ids.length >= 1 && t.every((x) => x !== undefined)
  }
}

const has = (m: SketchModel, type: Constraint['type'], refs: string[]) =>
  m.constraints.some((c) => c.type === type && c.refs.length === refs.length && refs.every((r) => c.refs.includes(r)))

/** Mutates `m`. Returns an error message, or null when applied. */
export function applyConstraint(m: SketchModel, kind: CKind, idsIn: string[]): string | null {
  let ids = idsIn
  const many = manyKind(m, kind, ids)
  if (many && !readyIn(m, kind, ids)) {
    for (const [i, id] of ids.entries()) {
      if (many === 'each') { const err = applyConstraint(m, kind, [id]); if (err) return err }
      else if (i > 0) { const err = applyConstraint(m, kind, [ids[0], id]); if (err) return err }
    }
    return null
  }
  if (!readyIn(m, kind, ids)) {
    if (kind === 'symmetric') return 'Pick two points, lines, circles or arcs, then the line they are mirrored across'
    // allow either order for point/curve pairs
    const rev = [...ids].reverse()
    if (ids.length === 2 && readyIn(m, kind, rev)) ids = rev
    else return 'Select valid entities for ' + CKIND_LABEL[kind]
  }
  const add = (type: Constraint['type'], refs: string[]) => {
    if (!has(m, type, refs)) addConstraint(m, { type, refs })
  }
  switch (kind) {
    case 'hv':
    case 'horizontal':
    case 'vertical': {
      let a: [number, number], b: [number, number]
      let refs = ids
      if (ids.length === 1) {
        const l = entityById(m, ids[0])
        if (l?.type === 'ellipse') { refs = [l.c, l.m]; a = pos(m, l.c); b = pos(m, l.m) } // the major axis
        else if (l?.type !== 'line') return 'Select a line'
        else [a, b] = lineEnds(m, l)
      } else [a, b] = [pos(m, ids[0]), pos(m, ids[1])]
      const horiz = kind === 'hv' ? Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) : kind === 'horizontal'
      add(horiz ? 'horizontal' : 'vertical', refs)
      return null
    }
    case 'parallel': add('parallel', ids); return null
    case 'perpendicular': add('perpendicular', ids); return null
    case 'equal': add('equal', ids); return null
    case 'tangent': {
      const sp = [ids[0], ids[1]].map((i) => entityById(m, i)).find((e) => e?.type === 'spline')
      if (sp?.type === 'spline') {
        const other = entityById(m, sp.id === ids[0] ? ids[1] : ids[0])!
        const at = sharedEnd(m, sp.id, other.id)
        if (!at) return 'A spline is made tangent where it meets another curve: bring their ends together first'
        return tangentSpline(m, sp, other, at) ?? null
      }
      // curves that meet end to end are made tangent AT that point (well conditioned); otherwise by distance
      const at = sharedEnd(m, ids[0], ids[1])
      const t0 = kindOf(m, ids[0]), t1 = kindOf(m, ids[1])
      if (at && (t0 === 'line' || t0 === 'arc') && (t1 === 'line' || t1 === 'arc') && !(t0 === 'line' && t1 === 'line')) {
        if (!m.constraints.some((c) => c.type === 'tangentAt' && c.refs[0] === ids[0] && c.refs[1] === ids[1]))
          addConstraint(m, { type: 'tangentAt', refs: [ids[0], ids[1], at], value: tangentValue(m, ids[0], ids[1], at) })
      } else add('tangent', ids)
      return null
    }
    case 'midpoint': add('midpoint', ids); return null
    case 'concentric': {
      const centre = (id: string) => { const e = entityById(m, id); return e && e.type !== 'point' && 'c' in e ? e.c : id }
      const [a, b] = [centre(ids[0]), centre(ids[1])]
      if (a === b || has(m, 'coincident', [a, b])) return 'Those already share a centre'
      addCoincident(m, a, b)
      return null
    }
    case 'collinear': {
      const [a, b] = ids.map((i) => entityById(m, i)) as LineE[]
      add('parallel', ids)
      add('pointOnLine', [b.p1, a.id])
      return null
    }
    case 'smooth': {
      const sp = [ids[0], ids[1]].map((i) => entityById(m, i)).find((e) => e?.type === 'spline')
      if (sp?.type !== 'spline') return 'Smooth joins a spline to a line, arc or another spline'
      const other = entityById(m, sp.id === ids[0] ? ids[1] : ids[0])!
      const at = sharedEnd(m, sp.id, other.id)
      if (!at) return 'A spline is made smooth where it meets another curve: bring their ends together first'
      return tangentSpline(m, sp, other, at) ?? null
    }
    case 'symmetric': return symmetric(m, ids)
    case 'coincident': {
      const [a, b] = ids
      if (kindOf(m, b) === 'point') { addCoincident(m, a, b); return null }
      add(kindOf(m, b) === 'line' ? 'pointOnLine' : 'pointOnCurve', [a, b])
      return null
    }
    case 'fix': {
      for (const id of ids) {
        const e = entityById(m, id)
        const pts = id === ORIGIN ? [] : !e ? [] : e.type === 'point' ? [e.id] : deps(e)
        for (const p of pts) if (p !== ORIGIN) add('fix', [p])
      }
      return null
    }
  }
}

/** Symmetry: the point pairs of two curves are mirrored across the line, matched up by which lies nearer the other's reflection. */
function symmetric(m: SketchModel, ids: string[]): string | null {
  const [a, b, axisId] = ids
  const axis = entityById(m, axisId) as LineE
  const [la, lb] = lineEnds(m, axis)
  const d = sub(lb, la), l2 = d[0] * d[0] + d[1] * d[1] || 1
  const reflect = (p: Vec2): Vec2 => {
    const t = ((p[0] - la[0]) * d[0] + (p[1] - la[1]) * d[1]) / l2
    return [2 * (la[0] + d[0] * t) - p[0], 2 * (la[1] + d[1] * t) - p[1]]
  }
  const mirror = (p: string, q: string) => {
    const done = m.constraints.some((c) => c.type === 'mirror' && c.refs[2] === axisId && ((c.refs[0] === p && c.refs[1] === q) || (c.refs[0] === q && c.refs[1] === p)))
    if (p !== q && !done) addConstraint(m, { type: 'mirror', refs: [p, q, axisId] })
  }
  const ea = entityById(m, a), eb = entityById(m, b)
  if (a === ORIGIN || ea?.type === 'point') { mirror(a, b); return null }
  if (!ea || !eb || eb.type === 'point') return 'Pick two things of the same kind'
  if (ea.type === 'circle' && eb.type === 'circle') {
    mirror(ea.c, eb.c)
    if (!has(m, 'equal', [a, b])) addConstraint(m, { type: 'equal', refs: [a, b] })
    return null
  }
  /** pair up the ends of two curves: straight or crossed, whichever puts them nearer the reflection */
  const ends = (e: Entity): string[] => (e.type === 'line' ? [e.p1, e.p2] : e.type === 'arc' ? [e.s, e.e] : [])
  const [pa, pb] = [ends(ea), ends(eb)]
  if (pa.length !== 2 || pb.length !== 2) return 'Pick two points, lines, circles or arcs'
  const straight = dist(reflect(pos(m, pa[0])), pos(m, pb[0])) + dist(reflect(pos(m, pa[1])), pos(m, pb[1]))
  const crossed = dist(reflect(pos(m, pa[0])), pos(m, pb[1])) + dist(reflect(pos(m, pa[1])), pos(m, pb[0]))
  const pairs: [string, string][] = straight <= crossed ? [[pa[0], pb[0]], [pa[1], pb[1]]] : [[pa[0], pb[1]], [pa[1], pb[0]]]
  for (const [p, q] of pairs) mirror(p, q)
  if (ea.type === 'arc' && eb.type === 'arc') mirror(ea.c, eb.c)
  return null
}
