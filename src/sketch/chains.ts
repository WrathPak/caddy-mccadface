/**
 * Curve chains: the runs of connected sketch curves, open or closed. Closed regions are found by profiles.ts; the surface
 * tools also need the open ones (a line, an arc, a spline, a polyline), so every non-construction curve belongs to exactly
 * one chain. A chain ends where it meets nothing or where three or more curves meet (a junction splits chains).
 */
import { dist, loopPoly } from './geom'
import { arcOf, circleOf, lineEnds, pos } from './model'
import { derivedSegs, isDerived } from './curves'
import { toWorld } from './plane'
import { profileIdOf, profileKey, type Loop, type PlaneDef, type Seg, type SketchModel, type Vec2, type Vec3 } from './types'
import type { PathSeg } from '@/kernel/solid-ops'

export interface Chain {
  /** stable-ish key: centre + length (see profileKey) */
  key: string
  /** persistent id: the entity ids of the chain */
  id: string
  segs: Seg[]
  closed: boolean
}

const EPS = 1e-5
const startOf = (s: Seg): Vec2 => (s.k === 'c' ? [s.c[0] + s.r, s.c[1]] : s.a)
const endOf = (s: Seg): Vec2 => (s.k === 'c' ? [s.c[0] + s.r, s.c[1]] : s.b)
const same = (p: Vec2, q: Vec2) => dist(p, q) < EPS

/** The segment walked the other way. */
export function flipSeg(s: Seg): Seg {
  if (s.k === 'l') return { ...s, a: s.b, b: s.a }
  if (s.k === 'a') return { ...s, a: s.b, b: s.a, ccw: !s.ccw }
  if (s.k === 'b') return { ...s, a: s.b, b: s.a, c1: s.c2, c2: s.c1 }
  return s
}

interface Pre { segs: Seg[]; closed: boolean }

/** One entity as a run of segments. */
function preChains(m: SketchModel): Pre[] {
  const out: Pre[] = []
  for (const e of m.entities) {
    if (e.construction || e.type === 'point') continue
    if (e.type === 'line') {
      const [a, b] = lineEnds(m, e)
      if (dist(a, b) > EPS) out.push({ segs: [{ k: 'l', a, b, id: e.id }], closed: false })
    } else if (e.type === 'circle') {
      const { c, r } = circleOf(m, e)
      if (r > EPS) out.push({ segs: [{ k: 'c', c, r, id: e.id }], closed: true })
    } else if (e.type === 'arc') {
      const i = arcOf(m, e)
      if (i.r < EPS) continue
      const c = pos(m, e.c), a = pos(m, e.s), b = pos(m, e.e)
      const mid = i.a0 + i.span / 2
      out.push({ segs: [{ k: 'a', a, b, m: [c[0] + i.r * Math.cos(mid), c[1] + i.r * Math.sin(mid)], c, r: i.r, ccw: true, id: e.id }], closed: false })
    } else if (isDerived(e) && e.type !== 'text') {
      for (const segs of derivedSegs(m, e)) {
        if (segs.length) out.push({ segs, closed: same(startOf(segs[0]), endOf(segs[segs.length - 1])) })
      }
    }
  }
  return out
}

function describe(segs: Seg[], closed: boolean): Chain {
  const poly = loopPoly(segs)
  if (!closed) poly.push(endOf(segs[segs.length - 1]))
  let len = 0
  for (let i = 0; i + 1 < poly.length; i++) len += dist(poly[i], poly[i + 1])
  const cx = poly.reduce((t, p) => t + p[0], 0) / poly.length, cy = poly.reduce((t, p) => t + p[1], 0) / poly.length
  return { key: profileKey(cx, cy, len), id: profileIdOf(segs), segs, closed }
}

/** Every chain of the sketch: closed ones (a circle, a closed spline, a loop of lines) and open ones. */
export function detectChains(m: SketchModel): Chain[] {
  const pres = preChains(m)
  const chains: Chain[] = []
  const open: Pre[] = []
  for (const p of pres) (p.closed ? chains.push(describe(p.segs, true)) : open.push(p))

  // how many open runs end at each point
  const nodes: Vec2[] = []
  const node = (p: Vec2) => {
    let i = nodes.findIndex((q) => same(p, q))
    if (i < 0) { nodes.push(p); i = nodes.length - 1 }
    return i
  }
  const ends = open.map((p) => [node(startOf(p.segs[0])), node(endOf(p.segs[p.segs.length - 1]))] as const)
  const degree = nodes.map(() => 0)
  ends.forEach(([a, b]) => { degree[a]++; degree[b]++ })

  const used = new Set<number>()
  /** Walk on from `at` through nodes where exactly two runs meet. */
  const grow = (segs: Seg[], at: number): { segs: Seg[]; at: number } => {
    for (;;) {
      if (degree[at] !== 2) return { segs, at }
      const k = open.findIndex((_, i) => !used.has(i) && (ends[i][0] === at || ends[i][1] === at))
      if (k < 0) return { segs, at }
      used.add(k)
      const fwd = ends[k][0] === at
      const next = fwd ? open[k].segs : [...open[k].segs].reverse().map(flipSeg)
      segs = [...segs, ...next]
      at = fwd ? ends[k][1] : ends[k][0]
    }
  }
  // chains that start at a loose end or a junction
  open.forEach((p, i) => {
    if (used.has(i)) return
    const [a, b] = ends[i]
    if (degree[a] === 2 && degree[b] === 2) return // inside a cycle: handled below
    used.add(i)
    // start from the end that is not a plain two-way node, so the whole run is taken in one go
    const backwards = degree[a] === 2
    const first = backwards ? [...p.segs].reverse().map(flipSeg) : p.segs
    const g = grow(first, backwards ? a : b)
    chains.push(describe(g.segs, false))
  })
  // what is left only meets itself: loops of several curves
  open.forEach((p, i) => {
    if (used.has(i)) return
    used.add(i)
    const g = grow(p.segs, ends[i][1])
    chains.push(describe(g.segs, same(startOf(g.segs[0]), endOf(g.segs[g.segs.length - 1]))))
  })
  return chains
}

/** A chain's segments as world-space path pieces (a full circle becomes two half arcs). */
export function pathSegs(plane: PlaneDef, segs: Seg[]): PathSeg[] {
  const w = (p: Vec2): Vec3 => toWorld(plane, p)
  const out: PathSeg[] = []
  for (const s of segs) {
    if (s.k === 'l') out.push({ k: 'l', a: w(s.a), b: w(s.b), id: s.id })
    else if (s.k === 'a') out.push({ k: 'a', a: w(s.a), m: w(s.m), b: w(s.b), id: s.id })
    else if (s.k === 'b') out.push({ k: 'b', a: w(s.a), c1: w(s.c1), c2: w(s.c2), b: w(s.b), id: s.id })
    else {
      const [cx, cy] = s.c
      out.push(
        { k: 'a', a: w([cx + s.r, cy]), m: w([cx, cy + s.r]), b: w([cx - s.r, cy]), id: s.id },
        { k: 'a', a: w([cx - s.r, cy]), m: w([cx, cy - s.r]), b: w([cx + s.r, cy]), id: s.id },
      )
    }
  }
  return out
}

/** A closed loop of a profile as a chain. */
export const loopChain = (loop: Loop): Chain => describe(loop, true)
