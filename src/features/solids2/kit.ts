/** Shared plumbing for the second wave of solid tools: sketch curves as path pieces, a plain tool-body preview, small helpers. */
import { resolveParams } from '@/doc/params'
import { bodyIdsOf } from '@/doc/refs'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import type { PathSeg } from '@/kernel/solid-ops'
import type { Body, Vec3 } from '@/kernel/types'
import { derivedSegs, entityPolyline } from '@/sketch/curves'
import { dist, polar } from '@/sketch/geom'
import { arcOf, lineEnds, pos } from '@/sketch/model'
import { toWorld } from '@/sketch/plane'
import type { SketchData, Vec2 } from '@/sketch/types'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, resetManip, setPreview } from '@/viewport/preview'
import type { Env } from '../modeling'
import { createRunner } from '../previewKit'

/** Every curve of a sketch as world-space pieces (lines, arcs, cubic splines), in the order they were drawn. Construction curves and points are left out. */
export function sketchSegments(data: SketchData): PathSeg[] {
  const model = { entities: data.entities, constraints: data.constraints, next: 0 }
  const w = (p: Vec2): Vec3 => toWorld(data.plane, p)
  const out: PathSeg[] = []
  for (const e of data.entities) {
    if (e.construction || e.type === 'point') continue
    if (e.type === 'line') {
      const [a, b] = lineEnds(model, e)
      if (dist(a, b) > 1e-9) out.push({ k: 'l', a: w(a), b: w(b), id: e.id })
    } else if (e.type === 'arc') {
      const i = arcOf(model, e)
      out.push({ k: 'a', a: w(pos(model, e.s)), m: w(polar(pos(model, e.c), i.r, i.a0 + i.span / 2)), b: w(pos(model, e.e)), id: e.id })
    } else if (e.type === 'circle') {
      const c = pos(model, e.c)
      const p0: Vec2 = [c[0] + e.r, c[1]], p1: Vec2 = [c[0] - e.r, c[1]]
      out.push({ k: 'a', a: w(p0), m: w([c[0], c[1] + e.r]), b: w(p1), id: e.id }, { k: 'a', a: w(p1), m: w([c[0], c[1] - e.r]), b: w(p0), id: e.id })
    } else {
      const loops = e.type === 'text' ? [] : derivedSegs(model, e)
      if (loops.length) {
        for (const s of loops[0]) if (s.k === 'b') out.push({ k: 'b', a: w(s.a), c1: w(s.c1), c2: w(s.c2), b: w(s.b), id: e.id })
      } else {
        const pl = entityPolyline(model, e)
        for (let i = 0; i + 1 < pl.length; i++) if (dist(pl[i], pl[i + 1]) > 1e-9) out.push({ k: 'l', a: w(pl[i]), b: w(pl[i + 1]), id: e.id })
      }
    }
  }
  return out
}

/** The sketch data a sketch ref points at, or an error that says what to do. */
export function sketchDataOf(refs: string[], env: Env, what: string): SketchData {
  const id = refs[0] ? bodyIdsOf([refs[0]])[0] : undefined
  const data = id ? (env.dataOf(id) as SketchData | undefined) : undefined
  if (!data) throw new Error(refs.length ? `The ${what} sketch no longer exists` : `Select the ${what} sketch`)
  return data
}

/** Preview of a tool body made from the dialog values (translucent add / cut), rebuilt when the values change. */
export function bodyPreview(
  schema: ParamSchema,
  build: (p: ParamValues) => Promise<Body | null>,
  { values, setValues }: PreviewCtx,
  opts: { kind?: (p: ParamValues) => 'add' | 'cut'; handles?: (p: ParamValues, apply: (patch: ParamValues) => void) => void } = {},
): PreviewHandle {
  let cur = values
  const apply = (patch: ParamValues) => { cur = { ...cur, ...patch }; setValues(cur) }
  const runner = createRunner(async (stale) => {
    let p: ParamValues
    try { p = resolveParams(schema, cur) } catch { clearPreview(); resetManip(); return }
    try { opts.handles?.(p, apply) } catch { resetManip() }
    let tool: Body | null = null
    try { tool = await build(p) } catch { /* incomplete input: show nothing */ }
    if (stale()) return
    if (!tool) clearPreview()
    else setPreview([{ mesh: tool.mesh, kind: opts.kind?.(p) ?? 'add' }])
  })
  runner.schedule()
  return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clearPreview(); resetManip() } }
}

export const OP_OPTIONS = [
  { value: 'join', label: 'Join' }, { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' }, { value: 'new', label: 'New body' },
]

export const SECTION_OPTIONS = [{ value: 'circle', label: 'Circular' }, { value: 'square', label: 'Square' }, { value: 'triangle', label: 'Triangular' }]

/** Plane-local sketch curves -> one connected chain of world-space segments. */
export function sketchPath(data: SketchData): PathSeg[] {
  const model = { entities: data.entities, constraints: data.constraints, next: 0 }
  interface L { a: Vec2; b: Vec2; m?: Vec2; c?: [Vec2, Vec2]; id?: string }
  const segs: L[] = []
  for (const e of data.entities) {
    if (e.construction || e.type === 'point') continue
    if (e.type === 'line') {
      const [a, b] = lineEnds(model, e)
      if (dist(a, b) > 1e-9) segs.push({ a, b, id: e.id })
    } else if (e.type === 'arc') {
      const i = arcOf(model, e)
      segs.push({ a: pos(model, e.s), b: pos(model, e.e), m: polar(pos(model, e.c), i.r, i.a0 + i.span / 2), id: e.id })
    } else if (e.type === 'circle') {
      const c = pos(model, e.c)
      const p0: Vec2 = [c[0] + e.r, c[1]], p1: Vec2 = [c[0] - e.r, c[1]]
      segs.push({ a: p0, b: p1, m: [c[0], c[1] + e.r], id: e.id }, { a: p1, b: p0, m: [c[0], c[1] - e.r], id: e.id })
    } else {
      // splines and ellipses are followed exactly, piece by piece (cubic curves); only text falls back to straight pieces
      const loops = e.type === 'text' ? [] : derivedSegs(model, e)
      if (loops.length) {
        for (const s of loops[0]) if (s.k === 'b') segs.push({ a: s.a, b: s.b, c: [s.c1, s.c2], id: e.id })
      } else {
        const pl = entityPolyline(model, e)
        for (let i = 0; i + 1 < pl.length; i++) if (dist(pl[i], pl[i + 1]) > 1e-9) segs.push({ a: pl[i], b: pl[i + 1], id: e.id })
      }
    }
  }
  if (!segs.length) throw new Error('The path sketch has no curves')
  const same = (p: Vec2, q: Vec2) => dist(p, q) < 1e-5
  const degree = (p: Vec2) => segs.filter((s) => same(s.a, p)).length + segs.filter((s) => same(s.b, p)).length
  const startIdx = Math.max(0, segs.findIndex((s) => degree(s.a) === 1 || degree(s.b) === 1))
  const used = new Set<number>([startIdx])
  let first = segs[startIdx]
  if (degree(first.b) === 1 && degree(first.a) !== 1) first = { a: first.b, b: first.a, m: first.m, c: first.c && [first.c[1], first.c[0]], id: first.id }
  const chain: L[] = [first]
  for (let end = first.b; ;) {
    const k = segs.findIndex((s, i) => !used.has(i) && (same(s.a, end) || same(s.b, end)))
    if (k < 0) break
    used.add(k)
    const s = segs[k]
    const oriented: L = same(s.a, end) ? s : { a: s.b, b: s.a, m: s.m, c: s.c && [s.c[1], s.c[0]], id: s.id }
    chain.push(oriented)
    end = oriented.b
  }
  if (used.size !== segs.length) throw new Error('The path sketch curves must form one connected chain')
  const w = (p: Vec2): Vec3 => toWorld(data.plane, p)
  return chain.map((s): PathSeg => (s.c ? { k: 'b', a: w(s.a), c1: w(s.c[0]), c2: w(s.c[1]), b: w(s.b), id: s.id } : s.m ? { k: 'a', a: w(s.a), m: w(s.m), b: w(s.b), id: s.id } : { k: 'l', a: w(s.a), b: w(s.b), id: s.id }))
}

