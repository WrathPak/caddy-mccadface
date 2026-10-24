/**
 * Inference while drawing: relations between the point being placed and the geometry around it (parallel, perpendicular,
 * extension, tangent, alignment, equal length, 15 degree steps, quadrants, intersections). The result is a `Snap` whose `rel`
 * list the tool turns into real constraints when it places the point.
 *
 * Priority: points on / of geometry > tangent > perpendicular / parallel > extension > horizontal / vertical > angle steps >
 * tracking lines > grid. Tolerances are in screen pixels, so they follow the zoom.
 */
import { closestOnSegment, cross, dist, dot, intersectCircleCircle, intersectLineCircle, intersectLineLine, norm, sub, add, mul, perp, polar } from './geom'
import { circleOf, entityById, lineEnds, pos, tangentOf } from './model'
import { snap as baseSnap, type Guide, type Snap, type SnapCtx } from './snap'
import type { SnapFlags } from './snapSettings'
import type { SketchModel, Vec2 } from './types'

export type Rel =
  | { type: 'parallel' | 'perpendicular' | 'collinear' | 'equal'; ref: string }
  /** the new line is tangent to the arc / circle `ref`, either leaving its end `at` or touching it */
  | { type: 'tangent'; ref: string; at?: string }
  /** perpendicular to a circle or arc: the line runs through its centre point `center` */
  | { type: 'radial'; ref: string; center: string }
  | { type: 'horizontal' | 'vertical' }

export interface InferCtx extends SnapCtx {
  flags: SnapFlags
  /** the point the line starts from (when it has an id, tangency to the curves that end there is offered) */
  anchorId?: string
  /** curves the cursor has hovered over: the reference geometry for relations */
  woken: Set<string>
  /** locked direction (Shift held): keep the relation found last */
  lock?: { dir: Vec2 } | null
}

const GLYPH: Record<string, string> = { parallel: '∥', perpendicular: '⊥', collinear: '/', tangent: 'T', equal: '=', horizontal: 'H', vertical: 'V', radial: '⊥' }
export const relGlyph = (r: Rel) => GLYPH[r.type]
export const RELATION_TEXT: Record<string, string> = {
  parallel: 'Parallel', perpendicular: 'Perpendicular', radial: 'Perpendicular (radial)', collinear: 'Extension', tangent: 'Tangent', equal: 'Equal length', horizontal: 'Horizontal', vertical: 'Vertical',
}

function lineRefs(m: SketchModel, ctx: InferCtx): { id: string; a: Vec2; b: Vec2 }[] {
  const out: { id: string; a: Vec2; b: Vec2 }[] = []
  const used = new Set<string>()
  const add_ = (id: string) => {
    if (used.has(id) || ctx.exclude?.has(id)) return
    const e = entityById(m, id)
    if (e?.type !== 'line') return
    used.add(id)
    const [a, b] = lineEnds(m, e)
    if (dist(a, b) > 1e-9) out.push({ id, a, b })
  }
  ctx.woken.forEach(add_)
  // lines that end at the start point are always reference geometry (continuing a polyline)
  if (ctx.anchorId) for (const e of m.entities) if (e.type === 'line' && (e.p1 === ctx.anchorId || e.p2 === ctx.anchorId)) add_(e.id)
  return out
}

/** Quadrant points of circles and arcs, and intersections of curves, near the cursor. */
function geometricPoints(m: SketchModel, raw: Vec2, tol: number, ex: Set<string>): Snap | null {
  let best: { s: Snap; d: number } | null = null
  const offer = (s: Snap) => {
    const d = dist(raw, s.pos)
    if (d < tol && (!best || d < best.d)) best = { s, d }
  }
  const curves = m.entities.filter((e) => (e.type === 'line' || e.type === 'circle' || e.type === 'arc') && !ex.has(e.id))
  for (const e of curves) {
    if (e.type !== 'circle' && e.type !== 'arc') continue
    const { c, r } = circleOf(m, e)
    ;[[1, 0], [0, 1], [-1, 0], [0, -1]].forEach(([x, y], i) => {
      const q: Vec2 = [c[0] + x * r, c[1] + y * r]
      if (e.type === 'arc') {
        const s = pos(m, e.s), t = pos(m, e.e)
        const a = Math.atan2(q[1] - c[1], q[0] - c[0]), a0 = Math.atan2(s[1] - c[1], s[0] - c[0]), a1 = Math.atan2(t[1] - c[1], t[0] - c[0])
        const rel = (v: number, o: number) => ((v - o) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
        if (rel(a, a0) > rel(a1, a0)) return
      }
      offer({ pos: q, kind: 'quad', entityId: e.id, quad: { center: e.c, axis: i % 2 === 0 ? 'h' : 'v' }, guides: [] })
    })
  }
  const segs = (id: string) => {
    const e = entityById(m, id)
    if (e?.type === 'line') return { k: 'l' as const, ab: lineEnds(m, e) }
    if (e && (e.type === 'circle' || e.type === 'arc')) return { k: 'c' as const, ...circleOf(m, e), e }
    return null
  }
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const A = segs(curves[i].id), B = segs(curves[j].id)
      if (!A || !B) continue
      let pts: Vec2[] = []
      if (A.k === 'l' && B.k === 'l') {
        const h = intersectLineLine(A.ab[0], A.ab[1], B.ab[0], B.ab[1])
        if (h && h.t >= 0 && h.t <= 1 && h.u >= 0 && h.u <= 1) pts = [h.p]
      } else if (A.k === 'l' && B.k === 'c') pts = intersectLineCircle(A.ab[0], A.ab[1], B.c, B.r).filter((h) => h.t >= 0 && h.t <= 1).map((h) => h.p)
      else if (A.k === 'c' && B.k === 'l') pts = intersectLineCircle(B.ab[0], B.ab[1], A.c, A.r).filter((h) => h.t >= 0 && h.t <= 1).map((h) => h.p)
      else if (A.k === 'c' && B.k === 'c') pts = intersectCircleCircle(A.c, A.r, B.c, B.r)
      for (const p of pts) offer({ pos: p, kind: 'int', entityId: curves[i].id, entityIds: [curves[i].id, curves[j].id], guides: [] })
    }
  }
  return best ? (best as { s: Snap }).s : null
}

interface Cand { dir: Vec2; rel: Rel; origin?: Vec2 }

/** Tangent points of the lines from `p` to a circle. */
function tangentPoints(p: Vec2, c: Vec2, r: number): Vec2[] {
  const d = dist(p, c)
  if (d <= r + 1e-9) return []
  const base = Math.atan2(p[1] - c[1], p[0] - c[0]), a = Math.acos(r / d)
  return [polar(c, r, base + a), polar(c, r, base - a)]
}

/** Snap the cursor with every inference the settings allow. */
export function inferSnap(raw: Vec2, ctx: InferCtx): Snap {
  const { model: m, wpp, flags } = ctx
  const px = (n: number) => n * wpp
  const ex = ctx.exclude ?? new Set<string>()
  // 1. points and curves: the usual snaps first (end points, centres, mid points, points on curves)
  const base = baseSnap(raw, { ...ctx, grid: false, anchor: undefined })
  const pointy = base.kind === 'point' || base.kind === 'origin' || base.kind === 'center' || base.kind === 'mid'
  if (flags.coincident) {
    if (pointy) return { ...base, guides: [] }
    const g = geometricPoints(m, raw, px(9), ex)
    if (g) return g
    if (base.kind === 'on' && (!ctx.anchor || !flags.tangent)) return { ...base, guides: [] }
  }

  const A = ctx.anchor
  if (A && dist(raw, A) > px(8)) {
    const found = relationsFrom(raw, A, ctx)
    if (found) return found
  }

  // 2. no relation: on a curve, then tracking lines and the grid, as before
  if (flags.coincident && base.kind === 'on') return { ...base, guides: [] }
  const rest = baseSnap(raw, { ...ctx, grid: flags.grid && ctx.grid, anchor: flags.horizontalVertical ? A : undefined })
  if (!flags.tracking) rest.guides = rest.guides.filter((g) => A && dist(g.from, A) < 1e-9)
  if (!flags.horizontalVertical) { rest.h = rest.v = undefined }
  return rest
}

/** Relations of a segment from `A` toward the cursor with the reference geometry. */
function relationsFrom(raw: Vec2, A: Vec2, ctx: InferCtx): Snap | null {
  const { model: m, wpp, flags } = ctx
  const tol = 8 * wpp
  const cands: Cand[] = []
  const refs = lineRefs(m, ctx)
  // tangent leaving the end of an arc / circle that the start point belongs to
  if (flags.tangent && ctx.anchorId) {
    for (const e of m.entities) {
      if ((e.type === 'arc' && (e.s === ctx.anchorId || e.e === ctx.anchorId)) || (e.type === 'circle' && false)) {
        const t = tangentOf(m, e.id, A)
        const n = norm(t)
        cands.push({ dir: n, rel: { type: 'tangent', ref: e.id, at: ctx.anchorId } })
      }
    }
  }
  if (flags.collinear) {
    for (const l of refs) {
      const d = norm(sub(l.b, l.a))
      // only when the start point is on the line (its extension)
      if (Math.abs(cross(d, sub(A, l.a))) < 1e-6) cands.push({ dir: d, rel: { type: 'collinear', ref: l.id } })
    }
  }
  // perpendicular to a circle or an arc is radial: the line runs through its centre
  if (flags.perpendicular) {
    for (const id of ctx.woken) {
      const e = entityById(m, id)
      if (!e || (e.type !== 'circle' && e.type !== 'arc') || ex(ctx, id)) continue
      const { c } = circleOf(m, e)
      if (dist(c, A) > 1e-6) cands.push({ dir: norm(sub(c, A)), rel: { type: 'radial', ref: id, center: e.c } })
    }
  }
  if (flags.perpendicular) for (const l of refs) cands.push({ dir: perp(norm(sub(l.b, l.a))), rel: { type: 'perpendicular', ref: l.id } })
  if (flags.parallel) for (const l of refs) cands.push({ dir: norm(sub(l.b, l.a)), rel: { type: 'parallel', ref: l.id } })
  if (flags.horizontalVertical) {
    cands.push({ dir: [1, 0], rel: { type: 'horizontal' } }, { dir: [0, 1], rel: { type: 'vertical' } })
  }
  if (ctx.lock) {
    const c = cands.find((k) => Math.abs(cross(k.dir, ctx.lock!.dir)) < 1e-9)
    if (c) return place(raw, A, c, ctx)
  }
  // tangent to a circle / arc the cursor is near: the end of the line is the tangent point
  if (flags.tangent) {
    for (const id of ctx.woken) {
      const e = entityById(m, id)
      if (!e || (e.type !== 'circle' && e.type !== 'arc') || ex(ctx, id)) continue
      const { c, r } = circleOf(m, e)
      for (const t of tangentPoints(A, c, r)) {
        if (e.type === 'arc' && !onArc(m, e, t)) continue
        if (dist(t, raw) < 10 * wpp) {
          return { pos: t, kind: 'infer', rel: [{ type: 'tangent', ref: id }], refs: [id], guides: [{ from: A, to: t }], hint: "Tangent" }
        }
      }
    }
  }
  for (const c of cands) {
    const off = Math.abs(cross(c.dir, sub(raw, A)))
    if (off < tol) return place(raw, A, c, ctx)
  }
  if (flags.angle15 && dist(raw, A) > 20 * wpp) {
    const a = Math.atan2(raw[1] - A[1], raw[0] - A[0])
    const step = Math.PI / 12, q = Math.round(a / step) * step
    const dir: Vec2 = [Math.cos(q), Math.sin(q)]
    if (Math.abs(cross(dir, sub(raw, A))) < tol * 1.5) {
      const s = place(raw, A, { dir, rel: { type: 'horizontal' } }, ctx)
      // angle steps are a snap only: no constraint
      return { ...s, rel: [], h: undefined, v: undefined, refs: [], hint: `${Math.round((q * 180) / Math.PI)}°` }
    }
  }
  return null
}

/** Is the point on the arc's angular range? */
function onArc(m: SketchModel, e: { c: string; s: string; e: string }, p: Vec2): boolean {
  const c = pos(m, e.c), s = pos(m, e.s), t = pos(m, e.e)
  const rel = (v: number, o: number) => ((v - o) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0])
  return rel(Math.atan2(p[1] - c[1], p[0] - c[0]), a0) <= rel(Math.atan2(t[1] - c[1], t[0] - c[0]), a0) + 1e-9
}

const ex = (ctx: InferCtx, id: string) => !!ctx.exclude?.has(id)

/** Put the point on the ray, match lengths if one is close, and describe what was inferred. */
function place(raw: Vec2, A: Vec2, c: Cand, ctx: InferCtx): Snap {
  const { model: m, wpp, flags } = ctx
  const t = dot(sub(raw, A), c.dir)
  let p = add(A, mul(c.dir, t))
  const rel: Rel[] = [c.rel]
  const refs: string[] = 'ref' in c.rel ? [c.rel.ref] : []
  // the dotted line runs a little past the point so it reads as a guide, not as the segment being drawn
  const guides: Guide[] = [{ from: A, to: add(p, mul(c.dir, (t >= 0 ? 1 : -1) * 28 * wpp)) }]
  // an extension is drawn from the end of the line it continues
  if (c.rel.type === 'collinear') {
    const e = entityById(m, c.rel.ref)
    if (e?.type === 'line') { const [a, b] = lineEnds(m, e); guides[0] = { from: dist(a, p) < dist(b, p) ? b : a, to: add(p, mul(c.dir, (t >= 0 ? 1 : -1) * 28 * wpp)) } }
  }
  if (flags.equal) {
    const len = Math.abs(t)
    for (const e of m.entities) {
      if (e.type !== 'line' || ex(ctx, e.id)) continue
      const [a, b] = lineEnds(m, e)
      const L = dist(a, b)
      if (L > 1e-9 && Math.abs(L - len) < 6 * wpp && L > 8 * wpp) {
        p = add(A, mul(c.dir, Math.sign(t || 1) * L))
        rel.push({ type: 'equal', ref: e.id })
        refs.push(e.id)
        break
      }
    }
  }
  return {
    pos: p, kind: 'infer', rel, refs, guides,
    h: c.rel.type === 'horizontal' ? true : undefined, v: c.rel.type === 'vertical' ? true : undefined,
    hint: rel.map((r) => RELATION_TEXT[r.type]).join(" + "), dir: c.dir,
  }
}

export { closestOnSegment }
