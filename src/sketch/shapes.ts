/**
 * Model builders for the newer sketch tools: spline, ellipse, slots, polygons, corner fillet / chamfer, mirror, patterns and
 * text. Each mutates a model the caller owns (clone first, as `commit` does) and keeps the new geometry constrained so that
 * editing the first dimension or point updates the rest.
 */
import { evalNumber } from '@/doc/params'
import { add, cross, dist, mul, norm, perp, polar, sub, TAU } from './geom'
import { splineBeziers } from './curves'
import { defaultOff } from './dims'
import {
  addArc, addCircle, addConstraint, addEllipse, addLine, addPoint, addSpline, addText, deps, entityById, lineEnds, newId, pos, removeIds, tangentOf, tangentValue,
} from './model'
import { ORIGIN, type ArcE, type Entity, type LineE, type SketchModel, type SplineE, type Vec2 } from './types'

const DIM_K = 6 // dimension offset scale: a few mm

// ------------------------------------------------------------------------------------------------ spline

/** A spline through (fit) or controlled by (control) the given points. */
export function drawSpline(m: SketchModel, pts: Vec2[], mode: 'fit' | 'ctrl', closed = false, construction = false): SplineE {
  return addSpline(m, pts.map((p) => addPoint(m, p[0], p[1])), mode, closed, construction)
}

/** Give a fit spline its two end tangent handles (at the control points the curve currently uses), so they can be dragged and constrained. */
export function addHandles(m: SketchModel, id: string): string | void {
  const s = entityById(m, id)
  if (!s || s.type !== 'spline') return 'Select a spline'
  if (s.mode !== 'fit') return 'Tangent handles belong to fit point splines (control point splines are shaped by their points)'
  if (s.closed) return 'A closed spline has no ends to put handles on'
  if (s.t0 && s.t1) return
  const bz = splineBeziers(m, s)
  if (!bz.length) return 'The spline is too short'
  if (!s.t0) s.t0 = addPoint(m, bz[0][1][0], bz[0][1][1])
  if (!s.t1) s.t1 = addPoint(m, bz[bz.length - 1][2][0], bz[bz.length - 1][2][1])
}

/** The free end of a spline closest to p, or null. */
export function splineEnds(s: SplineE): [string, string] { return [s.pts[0], s.pts[s.pts.length - 1]] }

/** Make a spline end tangent to a line, arc, circle or another spline that meets it at `at`. */
export function tangentSpline(m: SketchModel, spline: SplineE, other: Entity, at: string): string | void {
  if (spline.mode !== 'fit') return 'Tangency needs a fit point spline'
  const err = addHandles(m, spline.id)
  if (err) return err
  if (!splineEnds(spline).includes(at)) return 'Tangency applies at an end of the spline'
  addConstraint(m, { type: 'splineTangent', refs: [spline.id, other.id, at], value: 0 })
}

// ------------------------------------------------------------------------------------------------ ellipse

export interface EllipseIds { c: string; major: string; ellipse: string }

/** Ellipse from its centre, the end of its major semi-axis and its minor semi-axis length. */
export function drawEllipse(m: SketchModel, c: Vec2, major: Vec2, minor: number, construction = false): EllipseIds {
  const cp = addPoint(m, c[0], c[1]), mp = addPoint(m, major[0], major[1])
  const e = addEllipse(m, cp, mp, Math.max(minor, 1e-3), construction)
  return { c: cp, major: mp, ellipse: e.id }
}

// ------------------------------------------------------------------------------------------------ slots

export interface SlotIds { c1: string; c2: string; arcs: string[]; lines: string[] }

/** Centre-to-centre slot: two end arcs of radius width / 2 joined by two tangent lines, with a construction centre line. */
export function drawSlotCC(m: SketchModel, c1: Vec2, c2: Vec2, width: number, construction = false): SlotIds {
  const r = width / 2
  const u = norm(sub(c2, c1)), n = perp(u)
  const C1 = addPoint(m, c1[0], c1[1]), C2 = addPoint(m, c2[0], c2[1])
  const at = (c: Vec2, s: number): Vec2 => [c[0] + n[0] * r * s, c[1] + n[1] * r * s]
  const T1 = addPoint(m, ...at(c1, 1)), B1 = addPoint(m, ...at(c1, -1)), T2 = addPoint(m, ...at(c2, 1)), B2 = addPoint(m, ...at(c2, -1))
  // counter-clockwise: the left cap runs from the top (+n) round the back to the bottom, the right cap from the bottom round the front to the top
  const a1 = addArc(m, C1, T1, B1, construction), a2 = addArc(m, C2, B2, T2, construction)
  const top = addLine(m, T1, T2, construction), bottom = addLine(m, B1, B2, construction)
  const centre = addLine(m, C1, C2, true)
  void centre
  for (const [a, l, p] of [[a1, top, T1], [a1, bottom, B1], [a2, bottom, B2], [a2, top, T2]] as [ArcE, LineE, string][]) {
    addConstraint(m, { type: 'tangentAt', refs: [a.id, l.id, p], value: tangentValue(m, a.id, l.id, p) })
  }
  addConstraint(m, { type: 'equal', refs: [a1.id, a2.id] })
  return { c1: C1, c2: C2, arcs: [a1.id, a2.id], lines: [top.id, bottom.id] }
}

/** Overall slot: the two clicks are the extreme ends of the slot, so the end arcs sit one radius inside them. */
export function drawSlotOverall(m: SketchModel, e1: Vec2, e2: Vec2, width: number, construction = false): SlotIds | string {
  const d = dist(e1, e2)
  if (d <= width + 1e-9) return 'The slot is shorter than it is wide: make it longer or narrower'
  const u = norm(sub(e2, e1)), r = width / 2
  return drawSlotCC(m, add(e1, mul(u, r)), sub(e2, mul(u, r)), width, construction)
}

/** Slot along an arc: `s` and `e` lie on the centre arc round `centre` and the slot runs counter-clockwise from s to e. */
export function drawSlotArc(m: SketchModel, centre: Vec2, s: Vec2, e: Vec2, width: number, construction = false): { centre: string; arcs: string[] } | string {
  const R = dist(centre, s), r = width / 2
  if (R <= r + 1e-9) return 'The slot is wider than the arc it follows: use a smaller width or a bigger radius'
  const a0 = Math.atan2(s[1] - centre[1], s[0] - centre[0])
  let a1 = Math.atan2(e[1] - centre[1], e[0] - centre[0])
  while (a1 <= a0 + 1e-9) a1 += TAU
  if (a1 - a0 > TAU - 1e-6) return 'The slot would close on itself'
  const O = addPoint(m, centre[0], centre[1])
  const P = (rad: number, a: number) => polar(centre, rad, a)
  const S = addPoint(m, ...P(R, a0)), E = addPoint(m, ...P(R, a1))
  const So = addPoint(m, ...P(R + r, a0)), Eo = addPoint(m, ...P(R + r, a1)), Si = addPoint(m, ...P(R - r, a0)), Ei = addPoint(m, ...P(R - r, a1))
  const mid = addArc(m, O, S, E, true)
  const outer = addArc(m, O, So, Eo, construction), inner = addArc(m, O, Si, Ei, construction)
  const capE = addArc(m, E, Eo, Ei, construction), capS = addArc(m, S, Si, So, construction)
  for (const [a, b, p] of [[outer, capE, Eo], [inner, capE, Ei], [outer, capS, So], [inner, capS, Si]] as [ArcE, ArcE, string][]) {
    addConstraint(m, { type: 'tangentAt', refs: [a.id, b.id, p], value: tangentValue(m, a.id, b.id, p) })
  }
  return { centre: O, arcs: [mid.id, outer.id, inner.id, capE.id, capS.id] }
}

// ------------------------------------------------------------------------------------------------ tangent arc

/** The curve (line or arc) that ends at `at`, with the direction it would carry on in beyond that end. */
export function curveEndingAt(m: SketchModel, at: Vec2): { curve: LineE | ArcE; dir: Vec2 } | null {
  for (const e of m.entities) {
    if (e.type === 'line') {
      const a = pos(m, e.p1), b = pos(m, e.p2)
      if (dist(a, at) < 1e-6) return { curve: e, dir: norm(sub(a, b)) }
      if (dist(b, at) < 1e-6) return { curve: e, dir: norm(sub(b, a)) }
    } else if (e.type === 'arc') {
      const s = pos(m, e.s), t = pos(m, e.e)
      if (dist(t, at) < 1e-6) return { curve: e, dir: norm(tangentOf(m, e.id, t)) }
      if (dist(s, at) < 1e-6) { const d = norm(tangentOf(m, e.id, s)); return { curve: e, dir: [-d[0], -d[1]] } }
    }
  }
  return null
}

/** Arc that leaves the end of a line or arc tangentially and finishes at `end`; it is bound to that curve by a tangent constraint. */
export function drawTangentArc(m: SketchModel, start: Vec2, end: Vec2): string | { arc: string } {
  const c = curveEndingAt(m, start)
  if (!c) return 'Start the tangent arc at the end of a line or an arc'
  const n = perp(c.dir)
  const h = (end[0] - start[0]) * n[0] + (end[1] - start[1]) * n[1]
  if (Math.abs(h) < 1e-6 * Math.max(1, dist(start, end))) return 'The end point is on the line of the tangent: pick a point to one side'
  const r = ((end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2) / (2 * h)
  const centre: Vec2 = [start[0] + n[0] * r, start[1] + n[1] * r]
  const S = addPoint(m, start[0], start[1]), E = addPoint(m, end[0], end[1]), C = addPoint(m, centre[0], centre[1])
  const arc = h > 0 ? addArc(m, C, S, E) : addArc(m, C, E, S)
  addConstraint(m, { type: 'tangentAt', refs: [c.curve.id, arc.id, S], value: tangentValue(m, c.curve.id, arc.id, S) })
  return { arc: arc.id }
}

// ------------------------------------------------------------------------------------------------ polygon

export type PolygonKind = 'inscribed' | 'circumscribed' | 'edge'

/**
 * Regular polygon. Inscribed: the vertices lie on a construction circle (`pt` is the first vertex). Circumscribed: the sides
 * touch a construction circle (`pt` is the middle of the first side). Edge: `pt` and `center` are the two ends of the first side
 * (the construction circle through the vertices is made for you).
 */
export function drawPolygon(m: SketchModel, center: Vec2, pt: Vec2, sides: number, kind: PolygonKind): { lines: string[]; circle: string; centre: string } | string {
  const n = Math.round(sides)
  if (n < 3 || n > 64) return 'A polygon needs between 3 and 64 sides'
  let cen = center, R: number, a0: number
  if (kind === 'edge') {
    // `center` and `pt` are the ends of one side; the polygon grows to the left of that side
    const e = dist(center, pt)
    if (e < 1e-9) return 'The first side has no length'
    R = e / (2 * Math.sin(Math.PI / n))
    const mid: Vec2 = [(center[0] + pt[0]) / 2, (center[1] + pt[1]) / 2]
    const nrm = perp(norm(sub(pt, center)))
    const apothem = R * Math.cos(Math.PI / n)
    cen = add(mid, mul(nrm, apothem))
    a0 = Math.atan2(center[1] - cen[1], center[0] - cen[0])
    // vertices run counter-clockwise from `center`
    if (cross(sub(center, cen), sub(pt, cen)) < 0) a0 = Math.atan2(pt[1] - cen[1], pt[0] - cen[0])
  } else {
    const d = dist(center, pt)
    if (d < 1e-9) return 'Drag out from the centre to set the size'
    const base = Math.atan2(pt[1] - center[1], pt[0] - center[0])
    if (kind === 'inscribed') { R = d; a0 = base } else { R = d / Math.cos(Math.PI / n); a0 = base - Math.PI / n }
  }
  const cp = addPoint(m, cen[0], cen[1])
  const circle = addCircle(m, cp, R, true)
  const verts = Array.from({ length: n }, (_, i) => addPoint(m, ...polar(cen, R, a0 + (TAU * i) / n)))
  const lines = verts.map((v, i) => addLine(m, v, verts[(i + 1) % n]))
  for (const v of verts) addConstraint(m, { type: 'pointOnCurve', refs: [v, circle.id] })
  for (let i = 1; i < n; i++) addConstraint(m, { type: 'equal', refs: [lines[0].id, lines[i].id] })
  if (kind === 'circumscribed') {
    // a second construction circle touching the sides: its radius is the distance across the flats
    const inner = addCircle(m, cp, R * Math.cos(Math.PI / n), true)
    addConstraint(m, { type: 'tangent', refs: [lines[0].id, inner.id] })
  }
  return { lines: lines.map((l) => l.id), circle: circle.id, centre: cp }
}

// ------------------------------------------------------------------------------------------------ corner fillet / chamfer

interface Corner { a: LineE; b: LineE; pa: string; pb: string; far: [string, string]; at: Vec2 }

/** The corner where two lines meet (same point, a coincident constraint, or the same place). */
export function cornerOf(m: SketchModel, a: LineE, b: LineE): Corner | null {
  let best: Corner | null = null, bd = Infinity
  for (const pa of [a.p1, a.p2]) {
    for (const pb of [b.p1, b.p2]) {
      const d = dist(pos(m, pa), pos(m, pb))
      if (d < bd) { bd = d; best = { a, b, pa, pb, far: [pa === a.p1 ? a.p2 : a.p1, pb === b.p1 ? b.p2 : b.p1], at: pos(m, pa) } }
    }
  }
  return best && bd < 1e-5 ? best : null
}

/**
 * Take the two lines off the corner: their ends move to `replacement`, and a point K stays at the sharp corner (on both lines,
 * so it is wherever they cross) to keep every dimension and constraint that referred to the corner meaningful.
 */
function releaseCorner(m: SketchModel, c: Corner, replacement: [string, string]): string {
  const K = addPoint(m, c.at[0], c.at[1])
  if (c.a.p1 === c.pa) c.a.p1 = replacement[0]; else c.a.p2 = replacement[0]
  if (c.b.p1 === c.pb) c.b.p1 = replacement[1]; else c.b.p2 = replacement[1]
  // constraints that only tied the two corner points together go away; the others now refer to the virtual corner
  m.constraints = m.constraints.filter((k) => !(k.type === 'coincident' && k.refs.every((r) => r === c.pa || r === c.pb)))
  for (const k of m.constraints) k.refs = k.refs.map((r) => (r === c.pa || r === c.pb ? K : r))
  const used = (id: string) => m.entities.some((e) => e.type !== 'point' && deps(e).includes(id))
  const gone = [c.pa, c.pb].filter((id, i, arr) => arr.indexOf(id) === i && id !== ORIGIN && !used(id))
  if (gone.length) removeIds(m, gone)
  addConstraint(m, { type: 'pointOnLine', refs: [K, c.a.id] })
  addConstraint(m, { type: 'pointOnLine', refs: [K, c.b.id] })
  return K
}

/** Round the corner of two lines with a tangent arc of radius r (a radius dimension is added). */
export function filletCorner(m: SketchModel, a: LineE, b: LineE, r: number): string | { arc: string } {
  const c = cornerOf(m, a, b)
  if (!c) return 'The two lines must meet at a corner'
  if (!(r > 0)) return 'The radius must be greater than zero'
  const d1 = norm(sub(pos(m, c.far[0]), c.at)), d2 = norm(sub(pos(m, c.far[1]), c.at))
  const cosPhi = d1[0] * d2[0] + d1[1] * d2[1]
  const phi = Math.acos(Math.max(-1, Math.min(1, cosPhi)))
  if (phi < 1e-3 || Math.abs(phi - Math.PI) < 1e-3) return 'The lines are parallel: there is no corner to round'
  const t = r / Math.tan(phi / 2)
  if (t >= dist(c.at, pos(m, c.far[0])) - 1e-9 || t >= dist(c.at, pos(m, c.far[1])) - 1e-9) return 'The radius is too big for these lines'
  const bis = norm(add(d1, d2))
  const centre = add(c.at, mul(bis, r / Math.sin(phi / 2)))
  const p1 = add(c.at, mul(d1, t)), p2 = add(c.at, mul(d2, t))
  const T1 = addPoint(m, p1[0], p1[1]), T2 = addPoint(m, p2[0], p2[1]), C = addPoint(m, centre[0], centre[1])
  releaseCorner(m, c, [T1, T2])
  const ccw = cross(sub(p1, centre), sub(p2, centre)) > 0
  const arc = ccw ? addArc(m, C, T1, T2) : addArc(m, C, T2, T1)
  addConstraint(m, { type: 'tangentAt', refs: [a.id, arc.id, T1], value: tangentValue(m, a.id, arc.id, T1) })
  addConstraint(m, { type: 'tangentAt', refs: [b.id, arc.id, T2], value: tangentValue(m, b.id, arc.id, T2) })
  addConstraint(m, { type: 'radius', refs: [arc.id], value: r, expr: String(+r.toFixed(4)), off: defaultOff(m, 'radius', [arc.id], DIM_K) })
  return { arc: arc.id }
}

/** Cut the corner of two lines with a straight chamfer `d1` along the first line and `d2` along the second. */
export function chamferCorner(m: SketchModel, a: LineE, b: LineE, d1: number, d2: number): string | { line: string } {
  const c = cornerOf(m, a, b)
  if (!c) return 'The two lines must meet at a corner'
  if (!(d1 > 0) || !(d2 > 0)) return 'The chamfer distances must be greater than zero'
  const u1 = norm(sub(pos(m, c.far[0]), c.at)), u2 = norm(sub(pos(m, c.far[1]), c.at))
  if (Math.abs(cross(u1, u2)) < 1e-3) return 'The lines are parallel: there is no corner to cut'
  if (d1 >= dist(c.at, pos(m, c.far[0])) - 1e-9 || d2 >= dist(c.at, pos(m, c.far[1])) - 1e-9) return 'The chamfer is longer than the lines'
  const p1 = add(c.at, mul(u1, d1)), p2 = add(c.at, mul(u2, d2))
  const T1 = addPoint(m, p1[0], p1[1]), T2 = addPoint(m, p2[0], p2[1])
  const K = releaseCorner(m, c, [T1, T2])
  const line = addLine(m, T1, T2)
  const group = d1 === d2 ? newId(m, 'k') : undefined
  addConstraint(m, { type: 'distance', refs: [K, T1], value: d1, expr: String(+d1.toFixed(4)), off: defaultOff(m, 'distance', [K, T1], DIM_K), ...(group ? { group } : {}) })
  addConstraint(m, { type: 'distance', refs: [K, T2], value: d2, expr: String(+d2.toFixed(4)), off: defaultOff(m, 'distance', [K, T2], DIM_K), ...(group ? { group, hidden: true } : {}) })
  return { line: line.id }
}

// ------------------------------------------------------------------------------------------------ copying entities

/** The points (ids) an entity set is made of, in a stable order. */
function pointsOf(m: SketchModel, ids: string[]): string[] {
  const out: string[] = []
  const push = (p: string) => { if (p !== ORIGIN && !out.includes(p)) out.push(p) }
  for (const id of ids) {
    const e = entityById(m, id)
    if (!e) continue
    if (e.type === 'point') push(e.id)
    else deps(e).forEach(push)
  }
  return out
}

/** Entities (not points) of a selection, skipping reference geometry. */
const curvesOf = (m: SketchModel, ids: string[]): Entity[] => ids.map((id) => entityById(m, id)).filter((e): e is Entity => !!e && e.type !== 'point' && !e.ref)

/**
 * Copy the curves in `src` using the point map `pm` (source point -> new point). Radii of circles and ellipses are tied to the
 * source with an equal constraint so that editing the original updates the copy.
 */
function copyCurves(m: SketchModel, src: Entity[], pm: Map<string, string>, flip = false): string[] {
  const out: string[] = []
  const P = (id: string) => pm.get(id) ?? id
  for (const e of src) {
    let n: Entity | null = null
    if (e.type === 'line') n = addLine(m, P(e.p1), P(e.p2), e.construction)
    else if (e.type === 'circle') { n = addCircle(m, P(e.c), e.r, e.construction); addConstraint(m, { type: 'equal', refs: [e.id, n.id] }) }
    // a reflection reverses the sense of rotation, so a mirrored arc runs from the image of its end to the image of its start
    else if (e.type === 'arc') n = flip ? addArc(m, P(e.c), P(e.e), P(e.s), e.construction) : addArc(m, P(e.c), P(e.s), P(e.e), e.construction)
    else if (e.type === 'ellipse') { n = addEllipse(m, P(e.c), P(e.m), e.r, e.construction); addConstraint(m, { type: 'equal', refs: [e.id, n.id] }) }
    else if (e.type === 'spline') {
      const s = addSpline(m, e.pts.map(P), e.mode, e.closed, e.construction)
      if (e.t0) s.t0 = P(e.t0)
      if (e.t1) s.t1 = P(e.t1)
      n = s
    } else if (e.type === 'text') n = addText(m, P(e.p), e.text, e.h, flip ? -e.a : e.a, e.font)
    if (n) out.push(n.id)
  }
  return out
}

const sameLineAs = (m: SketchModel, pid: string, line: LineE) => {
  const [a, b] = lineEnds(m, line)
  const p = pos(m, pid)
  const d = sub(b, a), l = Math.hypot(d[0], d[1]) || 1
  return Math.abs(cross(d, sub(p, a))) / l < 1e-7
}

/** Mirror the selected entities across a line; the copy stays linked to the original by symmetric point constraints. */
export function mirrorEntities(m: SketchModel, ids: string[], lineId: string): string | { ids: string[] } {
  const axis = entityById(m, lineId)
  if (!axis || axis.type !== 'line') return 'Pick a line to mirror across'
  const src = curvesOf(m, ids.filter((i) => i !== lineId))
  if (!src.length) return 'Select the curves to mirror first'
  const [la, lb] = lineEnds(m, axis)
  const dir = norm(sub(lb, la))
  const reflect = (p: Vec2): Vec2 => {
    const d = sub(p, la), t = d[0] * dir[0] + d[1] * dir[1]
    const foot = add(la, mul(dir, t))
    return [2 * foot[0] - p[0], 2 * foot[1] - p[1]]
  }
  const pm = new Map<string, string>()
  for (const pid of pointsOf(m, src.map((e) => e.id))) {
    if (sameLineAs(m, pid, axis)) { pm.set(pid, pid); continue } // on the mirror line: shared, so the outline stays closed
    const q = reflect(pos(m, pid))
    const np = addPoint(m, q[0], q[1])
    pm.set(pid, np)
    addConstraint(m, { type: 'mirror', refs: [pid, np, lineId] })
  }
  return { ids: copyCurves(m, src, pm, true) }
}

export interface RectPattern { ids: string[]; dir1: Vec2; count1: number; spacing1: number; dir2?: Vec2; count2?: number; spacing2?: number }

/** Offsetting copies: every point of the next copy sits a fixed distance along a fixed direction from the previous copy's point. */
function chain(m: SketchModel, from: Map<string, string>, dir: Vec2, spacing: number, group: [string, string]): Map<string, string> {
  const to = new Map<string, string>()
  const ang = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI
  let first = !m.constraints.some((k) => k.group === group[0])
  for (const [src0, prev] of from) {
    const p = pos(m, prev)
    const np = addPoint(m, p[0] + dir[0] * spacing, p[1] + dir[1] * spacing)
    to.set(src0, np)
    // the spacing is one dimension shared by every copy (only the first is drawn); the direction is kept but not shown
    addConstraint(m, {
      type: 'distance', refs: [prev, np], value: spacing, expr: String(+spacing.toFixed(4)), off: defaultOff(m, 'distance', [prev, np], DIM_K),
      group: group[0], ...(first ? {} : { hidden: true }),
    })
    addConstraint(m, { type: 'angle', refs: [prev, np], value: Math.abs(ang), sgn: ang < 0 ? -1 : 1, expr: String(+Math.abs(ang).toFixed(4)), group: group[1], hidden: true })
    first = false
  }
  return to
}

/** Rectangular pattern of the selected curves in one or two directions; the copies are constrained to the original. */
export function patternRect(m: SketchModel, p: RectPattern): string | { ids: string[] } {
  const src = curvesOf(m, p.ids)
  if (!src.length) return 'Select the curves to repeat first'
  const n1 = Math.round(p.count1), n2 = Math.round(p.count2 ?? 1)
  if (n1 < 1 || n2 < 1 || n1 * n2 < 2) return 'The pattern needs at least two instances'
  if (n1 * n2 > 400) return 'That is a lot of copies: use fewer'
  if (!(p.spacing1 > 0) || (n2 > 1 && !((p.spacing2 ?? p.spacing1) > 0))) return 'The spacing must be greater than zero'
  const d1 = norm(p.dir1), d2 = p.dir2 ? norm(p.dir2) : perp(d1)
  const base = new Map(pointsOf(m, src.map((e) => e.id)).map((q) => [q, q]))
  const g = (n: string) => newId(m, 'k') + n
  const group1: [string, string] = [g('d1'), g('a1')], group2: [string, string] = [g('d2'), g('a2')]
  // grid[j][i]: the point map of the copy in column i, row j
  const grid: Map<string, string>[][] = [[base]]
  const made: string[] = []
  for (let i = 1; i < n1; i++) {
    const next = chain(m, grid[0][i - 1], d1, p.spacing1, group1)
    grid[0].push(next)
    made.push(...copyCurves(m, src, next))
  }
  for (let j = 1; j < n2; j++) {
    grid.push([])
    for (let i = 0; i < n1; i++) {
      const next = chain(m, grid[j - 1][i], d2, p.spacing2 ?? p.spacing1, group2)
      grid[j].push(next)
      made.push(...copyCurves(m, src, next))
    }
  }
  return { ids: made }
}

export interface CircPattern { ids: string[]; centre: string; count: number; angle: number }

/** Circular pattern about a point: each copy is the previous one turned by the step angle (360 / count, or angle / (count - 1)). */
export function patternCirc(m: SketchModel, p: CircPattern): string | { ids: string[] } {
  const src = curvesOf(m, p.ids)
  if (!src.length) return 'Select the curves to repeat first'
  const n = Math.round(p.count)
  if (n < 2) return 'The pattern needs at least two instances'
  if (n > 400) return 'That is a lot of copies: use fewer'
  const full = Math.abs(Math.abs(p.angle) - 360) < 1e-9
  const step = full ? p.angle / n : p.angle / (n - 1)
  const c = p.centre === ORIGIN ? [0, 0] as Vec2 : pos(m, p.centre)
  const made: string[] = []
  let prev = new Map(pointsOf(m, src.map((e) => e.id)).filter((q) => q !== p.centre).map((q) => [q, q]))
  const rot = (q: Vec2, deg: number): Vec2 => {
    const a = (deg * Math.PI) / 180, d = sub(q, c)
    return [c[0] + d[0] * Math.cos(a) - d[1] * Math.sin(a), c[1] + d[0] * Math.sin(a) + d[1] * Math.cos(a)]
  }
  for (let k = 1; k < n; k++) {
    const next = new Map<string, string>()
    for (const [s0, pv] of prev) {
      const q = rot(pos(m, pv), step)
      const np = addPoint(m, q[0], q[1])
      next.set(s0, np)
      addConstraint(m, { type: 'rotated', refs: [p.centre, pv, np], value: step })
    }
    // a point at the centre stays where it is
    if (src.some((e) => deps(e).includes(p.centre))) next.set(p.centre, p.centre)
    made.push(...copyCurves(m, src, next))
    prev = next
  }
  return { ids: made }
}

// ------------------------------------------------------------------------------------------------ text

export function drawText(m: SketchModel, at: Vec2, text: string, h: number, angle = 0, font?: string): string {
  const p = addPoint(m, at[0], at[1])
  return addText(m, p, text, h, angle, font).id
}

/** Text height from a field value (mm or an expression with units). */
export const heightOf = (text: string): number | null => evalNumber(text, 'mm')
