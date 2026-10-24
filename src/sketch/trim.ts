/**
 * Sketch Trim: click a piece of a line / arc / circle and it is removed up to the nearest intersections with the other
 * curves of the sketch (or to the curve's own end where there is no intersection on that side).
 *
 *  - nothing to cut against on either side -> the curve is deleted
 *  - one side cut                          -> the curve is shortened; its new end is bound to the cutting curve
 *  - cut on both sides                     -> the curve is split in two, the middle piece disappears
 *  - a circle is cut open into the arc that remains
 */
import { TAU, closestOnSegment, dist, polar, relAngle, sampleArc } from './geom'
import { addArc, addConstraint, addLine, addPoint, arcOf, circleOf, entityById, lineEnds, pos, removeIds } from './model'
import { intersections, maxParam, paramOn, type ClassicCurve as Curve } from './profiles'
import type { ArcE, CircleE, Constraint, Entity, LineE, SketchModel, Vec2 } from './types'

export interface Cut { t: number; p: Vec2; cutter: string }

export interface TrimSpan {
  id: string
  kind: 'line' | 'arc' | 'circle'
  /** parameter range of the removed piece (see paramOn: line t, arc angle offset from its start, circle angle) */
  t0: number | null
  t1: number | null
  c0: Cut | null
  c1: Cut | null
  /** the removed piece as a polyline, for the hover preview */
  poly: Vec2[]
  /** the whole curve goes away */
  whole: boolean
}

const EPS = 1e-7

function curveOf(m: SketchModel, e: LineE | ArcE | CircleE): Curve | null {
  if (e.type === 'line') {
    const [a, b] = lineEnds(m, e)
    return dist(a, b) > EPS ? { k: 'l', a, b } : null
  }
  if (e.type === 'circle') { const { c, r } = circleOf(m, e); return r > EPS ? { k: 'c', c, r } : null }
  const i = arcOf(m, e)
  return i.r > EPS ? { k: 'a', c: pos(m, e.c), r: i.r, a0: i.a0, span: i.span } : null
}

const pointAt = (cv: Curve, t: number): Vec2 =>
  cv.k === 'l' ? [cv.a[0] + (cv.b[0] - cv.a[0]) * t, cv.a[1] + (cv.b[1] - cv.a[1]) * t] : polar(cv.c, cv.r, (cv.k === 'a' ? cv.a0 : 0) + t)

/** Parameter of the point of the curve nearest to `click`. */
function clickParam(cv: Curve, click: Vec2): number {
  if (cv.k === 'l') return closestOnSegment(click, cv.a, cv.b).t
  const a = Math.atan2(click[1] - cv.c[1], click[0] - cv.c[0])
  if (cv.k === 'c') return relAngle(a, 0)
  const t = relAngle(a, cv.a0)
  if (t <= cv.span) return t
  // outside the arc's angular range: nearer end
  return t - cv.span < TAU - t ? cv.span : 0
}

/** All intersections of curve `id` with the other curves of the sketch, sorted by parameter. */
export function cutsOf(m: SketchModel, id: string): { cv: Curve; cuts: Cut[] } | null {
  const e = entityById(m, id)
  if (!e || (e.type !== 'line' && e.type !== 'arc' && e.type !== 'circle')) return null
  const cv = curveOf(m, e)
  if (!cv) return null
  const cuts: Cut[] = []
  for (const o of m.entities) {
    if (o.id === id || (o.type !== 'line' && o.type !== 'arc' && o.type !== 'circle')) continue
    const ov = curveOf(m, o)
    if (!ov) continue
    for (const p of intersections(cv, ov)) cuts.push({ t: paramOn(cv, p), p, cutter: o.id })
  }
  cuts.sort((a, b) => a.t - b.t)
  // merge duplicates (several curves through one point)
  const out: Cut[] = []
  for (const c of cuts) if (!out.length || Math.abs(c.t - out[out.length - 1].t) > 1e-7) out.push(c)
  return { cv, cuts: out }
}

const polyBetween = (cv: Curve, t0: number, t1: number): Vec2[] => {
  if (cv.k === 'l') return [pointAt(cv, t0), pointAt(cv, t1)]
  const a0 = (cv.k === 'a' ? cv.a0 : 0) + t0
  return [pointAt(cv, t0), ...sampleArc(cv.c, cv.r, a0, a0 + (t1 - t0), Math.PI / 48)]
}

/** What clicking at `click` on curve `id` would remove (or null when the curve cannot be trimmed). */
export function trimSpan(m: SketchModel, id: string, click: Vec2): TrimSpan | null {
  const r = cutsOf(m, id)
  if (!r) return null
  const { cv, cuts } = r
  const tc = clickParam(cv, click)
  const max = maxParam(cv)
  if (cv.k === 'c') {
    const kind = 'circle' as const
    if (cuts.length < 2) return { id, kind, t0: null, t1: null, c0: null, c1: null, poly: polyBetween(cv, 0, TAU), whole: true }
    const left = [...cuts].reverse().find((c) => c.t < tc) ?? cuts[cuts.length - 1]
    const right = cuts.find((c) => c.t > tc) ?? cuts[0]
    if (left === right) return { id, kind, t0: null, t1: null, c0: null, c1: null, poly: polyBetween(cv, 0, TAU), whole: true }
    const t1 = right.t > left.t ? right.t : right.t + TAU
    return { id, kind, t0: left.t, t1, c0: left, c1: right, poly: polyBetween(cv, left.t, t1), whole: false }
  }
  const kind = cv.k === 'l' ? ('line' as const) : ('arc' as const)
  const inner = cuts.filter((c) => c.t > EPS && c.t < max - EPS)
  const left = [...inner].reverse().find((c) => c.t < tc) ?? null
  const right = inner.find((c) => c.t > tc) ?? null
  const t0 = left ? left.t : 0, t1 = right ? right.t : max
  return { id, kind, t0: left ? left.t : null, t1: right ? right.t : null, c0: left, c1: right, poly: polyBetween(cv, t0, t1), whole: !left && !right }
}

const curveConstraint = (m: SketchModel, point: string, cutter: string): Omit<Constraint, 'id'> =>
  ({ type: entityById(m, cutter)?.type === 'line' ? 'pointOnLine' : 'pointOnCurve', refs: [point, cutter] })

function setPos(m: SketchModel, id: string, p: Vec2) {
  const e = entityById(m, id)
  if (e && e.type === 'point') { e.x = p[0]; e.y = p[1] }
}

/** Drop what pinned a point that is about to move (coincidences, dimensions, ...); constraints on the curve itself stay. */
function unpin(m: SketchModel, point: string, curve: string) {
  m.constraints = m.constraints.filter((c) => !(c.refs.includes(point) || (c.type === 'equal' && c.refs.includes(curve))))
}

/** Applies a trim computed by `trimSpan` to `m` (in place). Returns an error message or null. */
export function applyTrim(m: SketchModel, span: TrimSpan): string | null {
  const e = entityById(m, span.id)
  if (!e) return 'Nothing to trim'
  if (span.whole) { removeIds(m, [span.id]); return null }
  const info = cutsOf(m, span.id)
  if (!info) return 'Nothing to trim'
  const { c0, c1 } = span
  /** new end points of projected (reference) geometry stay fixed, so they need no constraint to hold them */
  const ref = !!e.ref
  const mk = (p: Vec2) => {
    const id = addPoint(m, p[0], p[1], e.construction)
    if (ref) (entityById(m, id) as { ref?: boolean }).ref = true
    return id
  }
  const bind = (point: string, cutter: string) => { if (!ref) addConstraint(m, curveConstraint(m, point, cutter)) }

  if (e.type === 'circle') {
    // open the circle into the arc that stays: from the far cut round to the near cut, counter-clockwise
    const s = mk(c1!.p)
    const t = mk(c0!.p)
    const arc = addArc(m, e.c, s, t, e.construction)
    if (e.ref) arc.ref = true
    for (const c of m.constraints) {
      if (!c.refs.includes(e.id)) continue
      if (['radius', 'diameter', 'equal', 'tangent'].includes(c.type)) c.refs = c.refs.map((r) => (r === e.id ? arc.id : r))
    }
    bind(s, c1!.cutter)
    bind(t, c0!.cutter)
    removeIds(m, [e.id])
    return null
  }

  if (e.type === 'line') {
    const keepFirst = c0 !== null // the piece before c0 stays
    const keepLast = c1 !== null // the piece after c1 stays
    if (keepFirst && keepLast) {
      // split in two: [p1 .. c0] stays on this line, [c1 .. p2] becomes a new line that takes over p2
      const p2 = e.p2
      const qa = mk(c0!.p)
      const qb = mk(c1!.p)
      const second = addLine(m, qb, p2, e.construction)
      if (e.ref) second.ref = true
      // constraints between the two original end points described the whole line
      m.constraints = m.constraints.filter((c) => !(c.refs.includes(e.p1) && c.refs.includes(p2)) && !(c.type === 'equal' && c.refs.includes(e.id)))
      e.p2 = qa
      for (const c of [...m.constraints]) if ((c.type === 'horizontal' || c.type === 'vertical') && c.refs.length === 1 && c.refs[0] === e.id) addConstraint(m, { type: c.type, refs: [second.id] })
      bind(qa, c0!.cutter)
      bind(qb, c1!.cutter)
      return null
    }
    // shorten
    const moving = keepFirst ? e.p2 : e.p1
    const fixed = keepFirst ? e.p1 : e.p2
    const cut = (keepFirst ? c0 : c1)!
    void fixed
    unpin(m, moving, e.id)
    setPos(m, moving, cut.p)
    bind(moving, cut.cutter)
    return null
  }

  // arc
  const a = e as ArcE
  const keepFirst = c0 !== null, keepLast = c1 !== null
  if (keepFirst && keepLast) {
    const oldEnd = a.e
    const qa = mk(c0!.p)
    const qb = mk(c1!.p)
    const second = addArc(m, a.c, qb, oldEnd, a.construction)
    if (a.ref) second.ref = true
    m.constraints = m.constraints.filter((c) => !(c.refs.includes(a.s) && c.refs.includes(oldEnd)) && !(c.type === 'equal' && c.refs.includes(a.id)))
    a.e = qa
    if (!ref) addConstraint(m, { type: 'equal', refs: [a.id, second.id] })
    bind(qa, c0!.cutter)
    bind(qb, c1!.cutter)
    return null
  }
  const moving = keepFirst ? a.e : a.s
  const fixed = keepFirst ? a.s : a.e
  const cut = (keepFirst ? c0 : c1)!
  void fixed
  unpin(m, moving, a.id)
  setPos(m, moving, cut.p)
  bind(moving, cut.cutter)
  return null
}

/** Convenience for tests / callers: trim the curve under `click` of a clone-able model. */
export function trimAt(m: SketchModel, id: string, click: Vec2): string | null {
  const span = trimSpan(m, id, click)
  if (!span) return 'Nothing to trim here'
  return applyTrim(m, span)
}

export type { Entity }
