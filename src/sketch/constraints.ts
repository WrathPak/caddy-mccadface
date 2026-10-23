/** Applying geometric constraints to a model from a set of picked entity ids. */
import { ORIGIN, type Constraint, type SketchModel } from './types'
import { addConstraint, entityById, lineEnds, mergePoints, pos } from './model'

export type CKind = 'hv' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'equal' | 'coincident' | 'midpoint' | 'fix'

export const CKIND_LABEL: Record<CKind, string> = {
  hv: 'Horizontal / Vertical', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
  tangent: 'Tangent', equal: 'Equal', coincident: 'Coincident', midpoint: 'Midpoint', fix: 'Fix',
}

const kindOf = (m: SketchModel, id: string) => (id === ORIGIN ? 'point' : entityById(m, id)?.type)
const isCurve = (t?: string) => t === 'circle' || t === 'arc'

/** True when `ids` is a complete input for `kind`. */
export function ready(m: SketchModel, kind: CKind, ids: string[]): boolean {
  const t = ids.map((i) => kindOf(m, i))
  switch (kind) {
    case 'hv':
    case 'horizontal':
    case 'vertical': return (ids.length === 1 && t[0] === 'line') || (ids.length === 2 && t[0] === 'point' && t[1] === 'point')
    case 'parallel':
    case 'perpendicular': return ids.length === 2 && t[0] === 'line' && t[1] === 'line'
    case 'equal': return ids.length === 2 && ((t[0] === 'line' && t[1] === 'line') || (isCurve(t[0]) && isCurve(t[1])))
    case 'tangent': return ids.length === 2 && (t[0] === 'line' ? isCurve(t[1]) : isCurve(t[0]) && (t[1] === 'line' || isCurve(t[1])))
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
      if (ids.length === 1) {
        const l = entityById(m, ids[0])
        if (l?.type !== 'line') return 'Select a line'
        ;[a, b] = lineEnds(m, l)
      } else [a, b] = [pos(m, ids[0]), pos(m, ids[1])]
      const horiz = kind === 'hv' ? Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) : kind === 'horizontal'
      add(horiz ? 'horizontal' : 'vertical', ids)
      return null
    }
    case 'parallel': add('parallel', ids); return null
    case 'perpendicular': add('perpendicular', ids); return null
    case 'equal': add('equal', ids); return null
    case 'tangent': add('tangent', ids); return null
    case 'midpoint': add('midpoint', ids); return null
    case 'coincident': {
      const [a, b] = ids
      if (kindOf(m, b) === 'point') { mergePoints(m, a, b); return null }
      add(kindOf(m, b) === 'line' ? 'pointOnLine' : 'pointOnCurve', [a, b])
      return null
    }
    case 'fix': {
      for (const id of ids) {
        const e = entityById(m, id)
        const pts = id === ORIGIN ? [] : !e ? [] : e.type === 'point' ? [e.id] : e.type === 'line' ? [e.p1, e.p2] : e.type === 'circle' ? [e.c] : [e.c, e.s, e.e]
        for (const p of pts) if (p !== ORIGIN) add('fix', [p])
      }
      return null
    }
  }
}
