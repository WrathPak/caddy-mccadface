/**
 * Associative Project: edges / faces / bodies of B-rep bodies projected onto the sketch plane as fixed reference geometry.
 * Each Project pick is stored as a `Projection` (a GeoRef + the entities it produced). Whenever the sketch regenerates the
 * refs are re-resolved against the current bodies and re-projected, so the geometry follows its source. A ref that no longer
 * resolves marks its curves `broken` (drawn red, the feature gets a warning); the last known geometry stays in place.
 */
import { decodeRef, resolveEdge, resolveFace, type RefReport } from '@/doc/refs'
import type { Body } from '@/kernel/types'
import type { ProjectedCurve } from '@/kernel/sketch-ops'
import { dist } from './geom'
import { addArc, addCircle, addLine, addPoint, entityById, pos, removeIds } from './model'
import type { Entity, PlaneDef, Projection, SketchModel, Vec2 } from './types'

/** worker op call, e.g. `getKernel().call` */
export type KernelCall = (name: string, args: unknown) => Promise<unknown>

const same = (a: Vec2, b: Vec2, tol = 1e-5) => dist(a, b) <= tol

/** Existing entity that already is this curve (either direction for lines), if any. */
function existing(m: SketchModel, c: ProjectedCurve): Entity | undefined {
  return m.entities.find((e: Entity) => {
    if (c.k === 'l' && e.type === 'line') {
      const a = pos(m, e.p1), b = pos(m, e.p2)
      return (same(a, c.a) && same(b, c.b)) || (same(a, c.b) && same(b, c.a))
    }
    if (c.k === 'c' && e.type === 'circle') return same(pos(m, e.c), c.c) && Math.abs(e.r - c.r) < 1e-5
    if (c.k === 'a' && e.type === 'arc') return same(pos(m, e.c), c.c) && same(pos(m, e.s), c.s) && same(pos(m, e.e), c.e)
    return false
  })
}

const kindOf = (e: Entity) => (e.type === 'line' ? 'l' : e.type === 'circle' ? 'c' : e.type === 'arc' ? 'a' : '')

function movePoint(m: SketchModel, id: string, p: Vec2) {
  const e = entityById(m, id)
  if (e && e.type === 'point') { e.x = p[0]; e.y = p[1] }
}

/** Rewrite an entity in place so it matches the curve (same kind). */
function writeCurve(m: SketchModel, e: Entity, c: ProjectedCurve) {
  if (e.type === 'line' && c.k === 'l') { movePoint(m, e.p1, c.a); movePoint(m, e.p2, c.b) }
  else if (e.type === 'circle' && c.k === 'c') { movePoint(m, e.c, c.c); e.r = c.r }
  else if (e.type === 'arc' && c.k === 'a') { movePoint(m, e.c, c.c); movePoint(m, e.s, c.s); movePoint(m, e.e, c.e) }
}

function addCurve(m: SketchModel, c: ProjectedCurve): string {
  const pt = (p: Vec2) => {
    const id = addPoint(m, p[0], p[1])
    ;(entityById(m, id) as { ref?: boolean }).ref = true
    return id
  }
  const e = c.k === 'l' ? addLine(m, pt(c.a), pt(c.b)) : c.k === 'c' ? addCircle(m, pt(c.c), c.r) : addArc(m, pt(c.c), pt(c.s), pt(c.e))
  e.ref = true
  return e.id
}

/** Entity ids an entity is made of (itself and its points). */
function partsOf(e: Entity): string[] {
  return e.type === 'point' ? [e.id] : e.type === 'line' ? [e.id, e.p1, e.p2] : e.type === 'circle' ? [e.id, e.c] : [e.id, e.c, e.s, e.e]
}

function setBroken(m: SketchModel, p: Projection, broken: boolean) {
  if (!!p.broken === broken) return
  p.broken = broken || undefined
  for (const id of p.ents) {
    const e = id ? entityById(m, id) : undefined
    if (!e) continue
    for (const part of partsOf(e)) {
      const x = entityById(m, part)
      if (x) x.broken = broken || undefined
    }
  }
}

/**
 * Bring a projection's entities in line with freshly projected curves. When the curve list has the same shape (count and
 * kinds) the entities are updated in place, so ids, constraints that reference them and anything built on them survive.
 * Otherwise the projection's own entities are replaced.
 */
function applyCurves(m: SketchModel, p: Projection, curves: ProjectedCurve[]) {
  // entities the user deleted (or trimmed away) are forgotten
  p.ents = p.ents.map((id) => (id && entityById(m, id) ? id : null))
  const fits = curves.length === p.ents.length && p.ents.every((id, i) => id === null || kindOf(entityById(m, id)!) === curves[i].k)
  if (fits) {
    p.ents.forEach((id, i) => { if (id) writeCurve(m, entityById(m, id)!, curves[i]) })
    return
  }
  const others = new Set((m.projections ?? []).filter((q) => q !== p).flatMap((q) => q.ents))
  const drop = p.ents.filter((id): id is string => !!id && !others.has(id))
  if (drop.length) removeIds(m, drop)
  p.ents = curves.map((c) => {
    const dup = existing(m, c)
    if (dup) return dup.ref ? dup.id : null // already there as ordinary geometry: leave it alone
    return addCurve(m, c)
  })
}

/** Add (or refresh) the projection of `ref`. Returns how many new curves were added. */
export function addProjected(m: SketchModel, curves: ProjectedCurve[], ref: string): number {
  const list = (m.projections ??= [])
  let p = list.find((q) => q.ref === ref)
  if (!p) { p = { id: 'j' + m.next++, ref, ents: [] }; list.push(p) }
  const count = () => m.entities.filter((e) => e.type !== 'point').length
  const before = count()
  applyCurves(m, p, curves)
  setBroken(m, p, false)
  return Math.max(0, count() - before)
}

interface Target { body: Body; faces: number[]; edges: number[]; all: boolean }

function resolveTarget(refStr: string, bodies: Body[], report?: RefReport): Target | null {
  const ref = decodeRef(refStr)
  if (!ref) return null
  if (ref.kind === 'body') {
    const body = bodies.find((b) => b.id === ref.bodyId)
    return body ? { body, faces: [], edges: [], all: true } : null
  }
  if (ref.kind === 'vertex') return null // projecting a lone point is not supported yet
  const r = ref.kind === 'face' ? resolveFace(ref, bodies, report) : resolveEdge(ref, bodies, report)
  if (!r) return null
  return ref.kind === 'face' ? { body: r.body, faces: [r.index], edges: [], all: false } : { body: r.body, faces: [], edges: [r.index], all: false }
}

/**
 * Re-resolve and re-project every projection of the model (mutates it; the caller owns the model). Refs that cannot be
 * resolved, or whose body is not a B-rep, are marked broken but never throw. Returns the number of broken projections.
 */
export async function reprojectModel(m: SketchModel, plane: PlaneDef, bodies: Body[], call: KernelCall, report?: RefReport): Promise<{ total: number; broken: number }> {
  let broken = 0
  const list = m.projections ?? []
  for (const p of list) {
    const t = resolveTarget(p.ref, bodies, report)
    if (!t || t.body.kind !== 'brep') { setBroken(m, p, true); broken++; continue }
    try {
      const curves = (await call('projectEdges', { key: t.body.key, plane, faces: t.faces, edges: t.edges, all: t.all })) as ProjectedCurve[]
      applyCurves(m, p, curves)
      setBroken(m, p, false)
    } catch {
      setBroken(m, p, true)
      broken++
    }
  }
  return { total: list.length, broken }
}

export const brokenCount = (m: SketchModel) => (m.projections ?? []).filter((p) => p.broken).length
