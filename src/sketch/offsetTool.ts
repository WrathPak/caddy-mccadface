/**
 * Sketch Offset tool: picking a connected chain / loop of curves, previewing it at a distance and creating the
 * offset curves as linked geometry (parallel / concentric constraints, coincident joints, one offset dimension).
 */
import { cross, dist, norm, perp, sub, closestOnSegment, closestOnArc } from './geom'
import {
  addArc, addCircle, addCoincident, addConstraint, addLine, addPoint, circleOf, entityById, lineEnds, newId, pos, tangentValue,
} from './model'
import { defaultOff, measure } from './dims'
import { makeArc, offsetChain, type CornerStyle, type OffsetSeg } from './offset'
import type { ArcE, CircleE, Constraint, LineE, Seg, SketchModel, Vec2 } from './types'

type Line = Extract<Seg, { k: 'l' }>
type Arc = Extract<Seg, { k: 'a' }>

export interface ChainItem { id: string; reversed: boolean }
export interface Chain {
  items: ChainItem[]
  closed: boolean
  /** a lone circle (offset by changing its radius) */
  circle?: string
}

const TOL = 1e-4

type Ends = { a: Vec2; b: Vec2 }
function endsOf(m: SketchModel, e: LineE | ArcE): Ends {
  return e.type === 'line' ? { a: pos(m, e.p1), b: pos(m, e.p2) } : { a: pos(m, e.s), b: pos(m, e.e) }
}
const isCurve = (e: { type: string }): e is LineE | ArcE => e.type === 'line' || e.type === 'arc'

/** The chain of line / arc entities connected end to end with `start` (a lone circle is its own chain). */
export function collectChain(m: SketchModel, start: string): Chain | null {
  const first = entityById(m, start)
  if (!first) return null
  if (first.type === 'circle') return { items: [{ id: first.id, reversed: false }], closed: true, circle: first.id }
  if (!isCurve(first)) return null
  const curves = m.entities.filter((e): e is LineE | ArcE => isCurve(e) && !e.construction)
  if (!curves.some((c) => c.id === first.id)) return null
  const used = new Set([first.id])
  const items: ChainItem[] = [{ id: first.id, reversed: false }]
  const pointOf = (it: ChainItem, which: 'start' | 'end'): Vec2 => {
    const e = endsOf(m, entityById(m, it.id) as LineE | ArcE)
    return (which === 'end') !== it.reversed ? e.b : e.a
  }
  const nextAt = (p: Vec2): ChainItem | null => {
    const cands: ChainItem[] = []
    for (const c of curves) {
      if (used.has(c.id)) continue
      const e = endsOf(m, c)
      if (dist(e.a, p) < TOL) cands.push({ id: c.id, reversed: false })
      else if (dist(e.b, p) < TOL) cands.push({ id: c.id, reversed: true })
    }
    return cands.length === 1 ? cands[0] : null
  }
  let closed = false
  for (;;) {
    const last = items[items.length - 1]
    const end = pointOf(last, 'end')
    if (dist(end, pointOf(items[0], 'start')) < TOL && items.length > 1) { closed = true; break }
    const n = nextAt(end)
    if (!n) break
    used.add(n.id)
    items.push(n)
  }
  if (!closed && items.length === 1 && dist(pointOf(items[0], 'end'), pointOf(items[0], 'start')) < TOL) closed = true
  if (!closed) {
    for (;;) {
      const st = pointOf(items[0], 'start')
      const n = nextAt(st)
      if (!n) break
      // it must END at our start: flip orientation
      used.add(n.id)
      items.unshift({ id: n.id, reversed: !n.reversed })
    }
  }
  return { items, closed }
}

/** The chain as oriented segments in travel order. */
export function chainSegs(m: SketchModel, chain: Chain): (Line | Arc)[] {
  return chain.items.map((it): Line | Arc => {
    const e = entityById(m, it.id) as LineE | ArcE
    if (e.type === 'line') {
      const [a, b] = lineEnds(m, e)
      return it.reversed ? { k: 'l', a: b, b: a } : { k: 'l', a, b }
    }
    const c = pos(m, e.c), s = pos(m, e.s), t = pos(m, e.e)
    return it.reversed ? makeArc(t, s, c, false) : makeArc(s, t, c, true)
  })
}

/** The two offset segments leave / enter their joint in the same direction. */
function tangentContinuous(a: Line | Arc, b: Line | Arc): boolean {
  const end = a.b, start = b.a
  if (dist(end, start) > 1e-6) return false
  const tan = (s: Line | Arc, p: Vec2): Vec2 => {
    if (s.k === 'l') return norm(sub(s.b, s.a))
    const r = norm(sub(p, s.c))
    const t = perp(r)
    return s.ccw ? t : [-t[0], -t[1]]
  }
  const t1 = tan(a, end), t2 = tan(b, start)
  return Math.abs(cross(t1, t2)) < 1e-6 && t1[0] * t2[0] + t1[1] * t2[1] > 0
}

/** Model point at the start / end of an oriented chain item. */
function pointIdOf(m: SketchModel, it: ChainItem, which: 'start' | 'end'): string {
  const e = entityById(m, it.id) as LineE | ArcE
  const fwd = (which === 'start') !== it.reversed
  return e.type === 'line' ? (fwd ? e.p1 : e.p2) : fwd ? e.s : e.e
}

/** +1 when `p` lies to the left of the chain's travel direction (outside for a clockwise loop), -1 on the right. */
export function sideOf(m: SketchModel, chain: Chain, p: Vec2): { side: 1 | -1; distance: number } {
  if (chain.circle) {
    const { c, r } = circleOf(m, entityById(m, chain.circle) as CircleE)
    const d = dist(p, c) - r
    return { side: d >= 0 ? 1 : -1, distance: Math.abs(d) }
  }
  let best = { d: Infinity, side: 1 as 1 | -1 }
  for (const s of chainSegs(m, chain)) {
    let q: Vec2, t: Vec2
    if (s.k === 'l') {
      q = closestOnSegment(p, s.a, s.b).pt
      t = norm(sub(s.b, s.a))
    } else {
      q = s.ccw ? closestOnArc(p, s.c, s.a, s.b) : closestOnArc(p, s.c, s.b, s.a)
      const r = norm(sub(q, s.c))
      t = s.ccw ? perp(r) : [-perp(r)[0], -perp(r)[1]]
    }
    const d = dist(p, q)
    if (d < best.d) best = { d, side: cross(t, sub(p, q)) >= 0 ? 1 : -1 }
  }
  return { side: best.side, distance: best.d }
}

export interface OffsetResult {
  segs: OffsetSeg[] | null
  /** closed circle radius for lone-circle chains */
  circleR?: number
}

/** Geometry of the offset by signed distance `d` (left of travel positive; for a circle, outward positive). */
export function offsetGeometry(m: SketchModel, chain: Chain, d: number, style: CornerStyle = 'round'): OffsetResult {
  if (chain.circle) {
    const { r } = circleOf(m, entityById(m, chain.circle) as CircleE)
    return { segs: null, circleR: r + d > 1e-9 ? r + d : undefined }
  }
  return { segs: offsetChain(chainSegs(m, chain), chain.closed, d, style) }
}

/** Polyline(s) for drawing the preview. */
export function previewPolys(m: SketchModel, chain: Chain, d: number): Vec2[][] {
  const g = offsetGeometry(m, chain, d)
  if (g.circleR !== undefined) {
    const { c } = circleOf(m, entityById(m, chain.circle!) as CircleE)
    const pts: Vec2[] = []
    for (let i = 0; i <= 96; i++) pts.push([c[0] + g.circleR * Math.cos((i / 96) * Math.PI * 2), c[1] + g.circleR * Math.sin((i / 96) * Math.PI * 2)])
    return [pts]
  }
  if (!g.segs) return []
  return g.segs.map(({ seg }) => {
    if (seg.k === 'l') return [seg.a, seg.b]
    const out: Vec2[] = []
    const a0 = Math.atan2(seg.a[1] - seg.c[1], seg.a[0] - seg.c[0])
    const sw = (() => {
      let t = Math.atan2(seg.b[1] - seg.c[1], seg.b[0] - seg.c[0]) - a0
      if (seg.ccw) { while (t <= 1e-12) t += Math.PI * 2 } else { while (t >= -1e-12) t -= Math.PI * 2 }
      return t
    })()
    const n = Math.max(4, Math.ceil(Math.abs(sw) / (Math.PI / 48)))
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sw * i) / n
      out.push([seg.c[0] + seg.r * Math.cos(a), seg.c[1] + seg.r * Math.sin(a)])
    }
    return out
  })
}

/**
 * Create the offset curves in `m` (mutates). `text` is the dimension expression for the offset distance (|d|).
 * Returns an error message or null.
 */
export function applyOffset(m: SketchModel, chain: Chain, d: number, text: string, labelScale: number): string | null {
  const group = newId(m, 'k')
  const dimFor = (off: Constraint['type'], refs: string[]): Omit<Constraint, 'id'> | null => {
    const me = measure(m, off, refs)
    return me ? { type: off, refs, value: Math.abs(d), sgn: me.sgn, expr: text, group } : null
  }
  let primaryDone = false
  const addDim = (type: Constraint['type'], refs: string[]) => {
    const dim = dimFor(type, refs)
    if (!dim) return
    if (!primaryDone) {
      primaryDone = true
      addConstraint(m, { ...dim, off: defaultOff(m, type, refs, labelScale) })
    } else addConstraint(m, { ...dim, hidden: true })
  }

  if (chain.circle) {
    const src = entityById(m, chain.circle) as CircleE
    const g = offsetGeometry(m, chain, d)
    if (g.circleR === undefined) return 'The offset would make the circle vanish'
    const cp = addPoint(m, pos(m, src.c)[0], pos(m, src.c)[1])
    const k = addCircle(m, cp, g.circleR)
    addCoincident(m, cp, src.c)
    addDim('offset', [k.id, src.id])
    return null
  }

  const res = offsetChain(chainSegs(m, chain), chain.closed, d, 'round')
  if (!res || !res.length) return 'The offset would collapse the geometry'

  interface Made { id: string; first: string; last: string; item: OffsetSeg }
  const made: Made[] = []
  for (const o of res) {
    const s = o.seg
    if (s.k === 'l') {
      const pa = addPoint(m, s.a[0], s.a[1]), pb = addPoint(m, s.b[0], s.b[1])
      const l = addLine(m, pa, pb)
      made.push({ id: l.id, first: pa, last: pb, item: o })
    } else {
      const pc = addPoint(m, s.c[0], s.c[1]), pa = addPoint(m, s.a[0], s.a[1]), pb = addPoint(m, s.b[0], s.b[1])
      // arcs are stored counter-clockwise: a clockwise traversal a -> b is the ccw arc b -> a
      const arc = s.ccw ? addArc(m, pc, pa, pb) : addArc(m, pc, pb, pa)
      made.push({ id: arc.id, first: pa, last: pb, item: o })
      if (o.corner) {
        // centred on the original vertex: end of source segment `src` (in travel order)
        addCoincident(m, pc, pointIdOf(m, chain.items[o.src], 'end'))
      } else {
        const srcE = entityById(m, chain.items[o.src].id) as ArcE
        addCoincident(m, pc, srcE.c)
      }
    }
  }
  // joints: coincident end points; where the curves run smoothly into each other (round corners, tangent sources)
  // they are also tangent there, which keeps the system well conditioned and the offset smooth when the source moves
  const count = chain.closed ? made.length : made.length - 1
  for (let i = 0; i < count; i++) {
    const A = made[i], B = made[(i + 1) % made.length]
    if (A === B) continue
    addCoincident(m, A.last, B.first)
    const smooth = A.item.corner || B.item.corner || tangentContinuous(A.item.seg, B.item.seg)
    const bothLines = A.item.seg.k === 'l' && B.item.seg.k === 'l'
    if (smooth && !bothLines) addConstraint(m, { type: 'tangentAt', refs: [A.id, B.id, A.last], value: tangentValue(m, A.id, B.id, A.last) })
  }
  // links to the sources
  for (const mm of made) {
    if (mm.item.corner) continue
    const src = chain.items[mm.item.src]
    const srcE = entityById(m, src.id) as LineE | ArcE
    if (srcE.type === 'line') addConstraint(m, { type: 'parallel', refs: [mm.id, srcE.id] })
    addDim('offset', [mm.id, srcE.id])
  }
  return null
}

