/** Applying geometric constraints to a model from a set of picked entity ids. */
import { ORIGIN, type Constraint, type SketchModel } from './types'
import { addCoincident, addConstraint, deps, entityById, lineEnds, pos, sharedEnd, tangentValue } from './model'
import { tangentSpline } from './shapes'

export type CKind = 'hv' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'equal' | 'coincident' | 'midpoint' | 'fix'

export const CKIND_LABEL: Record<CKind, string> = {
  hv: 'Horizontal / Vertical', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
  tangent: 'Tangent', equal: 'Equal', coincident: 'Coincident', midpoint: 'Midpoint', fix: 'Fix',
}

const kindOf = (m: SketchModel, id: string) => (id === ORIGIN ? 'point' : entityById(m, id)?.type)
const isCurve = (t?: string) => t === 'circle' || t === 'arc'
/** things with a direction: lines, and ellipses by their major axis */
const isLineLike = (t?: string) => t === 'line' || t === 'ellipse'

/** True when `ids` is a complete input for `kind`. */
export function ready(m: SketchModel, kind: CKind, ids: string[]): boolean {
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
    case 'midpoint': return ids.length === 2 && t[0] === 'point' && t[1] === 'line'
    case 'fix': return ids.length >= 1 && t.every((x) => x !== undefined)
  }
}

const has = (m: SketchModel, type: Constraint['type'], refs: string[]) =>
  m.constraints.some((c) => c.type === type && c.refs.length === refs.length && refs.every((r) => c.refs.includes(r)))

/** Mutates `m`. Returns an error message, or null when applied. */
export function applyConstraint(m: SketchModel, kind: CKind, idsIn: string[]): string | null {
  let ids = idsIn
  if (!ready(m, kind, ids)) {
    // allow either order for point/curve pairs
    const rev = [...ids].reverse()
    if (ids.length === 2 && ready(m, kind, rev)) ids = rev
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
