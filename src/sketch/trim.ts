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
import { bezClosest, bezFlatten, bezLine, bezSub, type Bez } from './bezier'
import { derivedSegs, isDerived, textSegs, type DerivedEntity } from './curves'
import { addArc, addConstraint, addLine, addPoint, addSpline, arcOf, circleOf, cloneModel, entityById, lineEnds, pos, removeIds } from './model'
import { intersections, maxParam, paramOn, type ClassicCurve as Curve, type Curve as AnyCurve } from './profiles'
import type { ArcE, CircleE, Constraint, Entity, LineE, SketchModel, Vec2 } from './types'

export interface Cut { t: number; p: Vec2; cutter: string }

export interface TrimSpan {
  id: string
  kind: 'line' | 'arc' | 'circle' | 'chain'
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

/** The line and cubic pieces of a derived entity as profile curves. */
function derivedCurves(m: SketchModel, e: DerivedEntity): AnyCurve[] {
  const out: AnyCurve[] = []
  for (const chain of derivedSegs(m, e)) {
    for (const s of chain) {
      if (s.k === 'l' && dist(s.a, s.b) > EPS) out.push({ k: 'l', a: s.a, b: s.b, src: e.id })
      else if (s.k === 'b') out.push({ k: 'b', p: [s.a, s.c1, s.c2, s.b], src: e.id })
    }
  }
  return out
}

/** The cubic pieces of a spline or an ellipse (one chain); closed when the curve closes on itself. */
function chainOf(m: SketchModel, e: DerivedEntity): { bz: Bez[]; closed: boolean } | null {
  if (e.type === 'text') return null
  const loops = derivedSegs(m, e)
  if (loops.length !== 1) return null
  const bz = loops[0].map((s): Bez => (s.k === 'b' ? [s.a, s.c1, s.c2, s.b] : s.k === 'l' ? bezLine(s.a, s.b) : [[0, 0], [0, 0], [0, 0], [0, 0]]))
  return { bz, closed: e.type === 'ellipse' || !!(e.type === 'spline' && e.closed) }
}

/** Cuts of a spline / ellipse by every other curve; the parameter is the piece number plus the position inside the piece. */
function cutsOfChain(m: SketchModel, e: DerivedEntity, bz: Bez[]): Cut[] {
  const cuts: Cut[] = []
  bz.forEach((b, i) => {
    const mine: AnyCurve = { k: 'b', p: b, src: e.id }
    for (const o of m.entities) {
      if (o.id === e.id || o.type === 'point') continue
      const others: AnyCurve[] = isDerived(o) ? derivedCurves(m, o) : (() => { const c = curveOf(m, o as LineE | ArcE | CircleE); return c ? [c] : [] })()
      for (const oc of others) for (const p of intersections(mine, oc)) cuts.push({ t: i + bezClosest(b, p).t, p, cutter: o.id })
    }
  })
  cuts.sort((a, b) => a.t - b.t)
  const out: Cut[] = []
  for (const c of cuts) if (!out.length || Math.abs(c.t - out[out.length - 1].t) > 1e-7) out.push(c)
  return out
}

/** Parameter of the point of the chain nearest to `click`. */
function chainClick(bz: Bez[], click: Vec2): number {
  let best = 0, bd = Infinity
  bz.forEach((b, i) => { const c = bezClosest(b, click); if (c.d < bd) { bd = c.d; best = i + c.t } })
  return best
}

/** The pieces of a chain between parameters u0 and u1 (u1 may run past the end of a closed chain). */
function chainRange(bz: Bez[], u0: number, u1: number): Bez[] {
  const n = bz.length
  const out: Bez[] = []
  for (let i = Math.floor(u0 + 1e-9); i < u1 - 1e-9; i++) {
    const a = Math.max(u0 - i, 0), b = Math.min(u1 - i, 1)
    if (b - a > 1e-9) out.push(bezSub(bz[((i % n) + n) % n], a, b))
  }
  return out
}

const chainPoly = (bz: Bez[], u0: number, u1: number): Vec2[] => {
  const pts: Vec2[] = []
  for (const b of chainRange(bz, u0, u1)) pts.push(...bezFlatten(b).slice(pts.length ? 1 : 0))
  return pts
}

/** All intersections of curve `id` with the other curves of the sketch, sorted by parameter. */
export function cutsOf(m: SketchModel, id: string): { cv: Curve; cuts: Cut[] } | null {
  const e = entityById(m, id)
  if (!e || (e.type !== 'line' && e.type !== 'arc' && e.type !== 'circle')) return null
  const cv = curveOf(m, e)
  if (!cv) return null
  const cuts: Cut[] = []
  for (const o of m.entities) {
    if (o.id === id) continue
    if (isDerived(o)) {
      // splines, ellipses and text outlines cut too: every one of their cubic pieces is a cutter
      for (const oc of derivedCurves(m, o)) for (const p of intersections(cv, oc)) cuts.push({ t: paramOn(cv, p), p, cutter: o.id })
      continue
    }
    if (o.type !== 'line' && o.type !== 'arc' && o.type !== 'circle') continue
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
  const de = entityById(m, id)
  if (de && isDerived(de)) {
    if (de.type === 'text') {
      // text is trimmed as the outlines it is made of: on a copy that is taken apart, for the preview
      const copy = cloneModel(m)
      const target = prepareTrim(copy, id, click)
      return target === id ? null : trimSpan(copy, target, click)
    }
    const ch = chainOf(m, de)
    if (!ch) return null
    const { bz, closed } = ch
    const cuts = cutsOfChain(m, de, bz)
    const n = bz.length, tc = chainClick(bz, click)
    if (closed) {
      if (cuts.length < 2) return { id, kind: 'chain', t0: null, t1: null, c0: null, c1: null, poly: chainPoly(bz, 0, n), whole: true }
      const left = [...cuts].reverse().find((c) => c.t < tc) ?? cuts[cuts.length - 1]
      const right = cuts.find((c) => c.t > tc) ?? cuts[0]
      if (left === right) return { id, kind: 'chain', t0: null, t1: null, c0: null, c1: null, poly: chainPoly(bz, 0, n), whole: true }
      const t1 = right.t > left.t ? right.t : right.t + n
      return { id, kind: 'chain', t0: left.t, t1, c0: left, c1: right, poly: chainPoly(bz, left.t, t1), whole: false }
    }
    const inner = cuts.filter((c) => c.t > EPS && c.t < n - EPS)
    const left = [...inner].reverse().find((c) => c.t < tc) ?? null
    const right = inner.find((c) => c.t > tc) ?? null
    return { id, kind: 'chain', t0: left ? left.t : null, t1: right ? right.t : null, c0: left, c1: right, poly: chainPoly(bz, left ? left.t : 0, right ? right.t : n), whole: !left && !right }
  }
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
  if (isDerived(e)) return trimChain(m, e, span)
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
  // a spline, ellipse or text outline has no point-on-curve constraint: the new end just sits on the cut
  const bind = (point: string, cutter: string) => { if (!ref && !isDerived(entityById(m, cutter)!)) addConstraint(m, curveConstraint(m, point, cutter)) }

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

/** Make a spline from the pieces `bz` (exact: Bezier mode), reusing the given end points when there are any. */
function splineFrom(m: SketchModel, bz: Bez[], ends: { start?: string; end?: string }, e: DerivedEntity): string {
  const pts: string[] = []
  const mk = (p: Vec2) => addPoint(m, p[0], p[1], e.construction)
  bz.forEach((b, i) => {
    if (i === 0) pts.push(ends.start ?? mk(b[0]))
    pts.push(mk(b[1]), mk(b[2]))
    pts.push(i === bz.length - 1 && ends.end ? ends.end : mk(b[3]))
  })
  const s = addSpline(m, pts, 'bez', false, e.construction)
  if (e.ref) s.ref = true
  return s.id
}

/** Trim a spline or an ellipse: the part that stays becomes a spline made of the exact pieces of the original. */
function trimChain(m: SketchModel, e: DerivedEntity, span: TrimSpan): string | null {
  const ch = chainOf(m, e)
  if (!ch) return 'Nothing to trim'
  const { bz, closed } = ch
  const n = bz.length
  const { c0, c1 } = span
  const ref = !!e.ref
  const bindEnd = (spline: string, which: 'first' | 'last', cutter: string) => {
    if (ref || isDerived(entityById(m, cutter)!)) return
    const s = entityById(m, spline) as { pts: string[] }
    addConstraint(m, curveConstraint(m, which === 'first' ? s.pts[0] : s.pts[s.pts.length - 1], cutter))
  }
  if (closed) {
    // from the far cut round to the near cut
    const pieces = chainRange(bz, c1!.t, c0!.t + (c0!.t < c1!.t ? n : 0))
    if (!pieces.length) return 'Nothing to trim'
    const id = splineFrom(m, pieces, {}, e)
    bindEnd(id, 'first', c1!.cutter)
    bindEnd(id, 'last', c0!.cutter)
    removeIds(m, [e.id])
    return null
  }
  const old = e as Extract<DerivedEntity, { type: 'spline' }>
  const first = old.pts[0], last = old.pts[old.pts.length - 1]
  const made: string[] = []
  if (c0) {
    const id = splineFrom(m, chainRange(bz, 0, c0.t), { start: first }, e)
    bindEnd(id, 'last', c0.cutter)
    made.push(id)
  }
  if (c1) {
    const id = splineFrom(m, chainRange(bz, c1.t, n), { end: last }, e)
    bindEnd(id, 'first', c1.cutter)
    made.push(id)
  }
  removeIds(m, [e.id])
  return made.length ? null : 'Nothing to trim'
}

/**
 * Text is trimmed as the outlines it is made of: take it apart into lines and exact splines (in place) and return the id of
 * the piece under the click. Any other curve is returned as it is.
 */
export function prepareTrim(m: SketchModel, id: string, click: Vec2): string {
  const e = entityById(m, id)
  if (e?.type !== 'text') return id
  const loops = textSegs(m, e)
  const made: string[] = []
  const add = (p: Vec2) => addPoint(m, p[0], p[1], e.construction)
  for (const raw of loops) {
    // text outlines are straight pieces and cubics
    const loop = raw.filter((x): x is Extract<typeof x, { k: 'l' | 'b' }> => x.k === 'l' || x.k === 'b')
    if (!loop.length) continue
    const first = add(loop[0].a)
    const ids: string[] = [first]
    loop.forEach((s, i) => ids.push(i === loop.length - 1 ? first : add(s.b)))
    let i = 0
    while (i < loop.length) {
      if (loop[i].k === 'l') { made.push(addLine(m, ids[i], ids[i + 1], e.construction).id); i++; continue }
      const run: string[] = [ids[i]]
      let j = i
      while (j < loop.length && loop[j].k === 'b') {
        const s = loop[j] as Extract<(typeof loop)[number], { k: 'b' }>
        run.push(add(s.c1), add(s.c2), ids[j + 1])
        j++
      }
      made.push(addSpline(m, run, 'bez', false, e.construction).id)
      i = j
    }
  }
  removeIds(m, [id])
  // the piece under the click
  let best = made[0], bd = Infinity
  for (const mid of made) {
    const ent = entityById(m, mid)
    if (!ent) continue
    const d = ent.type === 'line' ? closestOnSegment(click, pos(m, ent.p1), pos(m, ent.p2)).pt : (() => { const c = chainOf(m, ent as DerivedEntity); return c ? c.bz.map((b) => bezClosest(b, click).pt).sort((p, q) => dist(p, click) - dist(q, click))[0] : click })()
    const dd = dist(d, click)
    if (dd < bd) { bd = dd; best = mid }
  }
  return best ?? id
}

/** Convenience for tests / callers: trim the curve under `click` of a clone-able model. */
export function trimAt(m: SketchModel, id: string, click: Vec2): string | null {
  id = prepareTrim(m, id, click)
  const span = trimSpan(m, id, click)
  if (!span) return 'Nothing to trim here'
  return applyTrim(m, span)
}

export type { Entity }
