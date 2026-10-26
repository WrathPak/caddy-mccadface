/**
 * Curve inputs of the surface tools: stored refs -> what the kernel ops take. A ref is one of
 *   `crv:<sketch>:<key>@<id>`  one chain (open or closed run of connected curves) of a finished sketch
 *   `prof:<sketch>:...`        the outline (and holes) of a closed region of a sketch
 *   a sketch id                every chain of that sketch
 *   a JSON edge ref            an edge of a body (a surface body's open edge, a solid's edge)
 */
import { RefReport, decodeRef, edgeSigs, resolveEdge } from '@/doc/refs'
import type { CurveIn } from '@/kernel/surface-ops'
import type { Vec3 } from '@/kernel/types'
import { detectChains, loopChain, pathSegs, type Chain } from '@/sketch/chains'
import { toWorld } from '@/sketch/plane'
import type { PlaneDef, SketchData } from '@/sketch/types'
import type { Env } from '../modeling'

/** `crv:<sketch>:<chain key>@<chain id>` */
export const curveRef = (featureId: string, c: Chain) => `crv:${featureId}:${c.key}${c.id ? '@' + c.id : ''}`

/** The chains of a sketch (older data has none stored: they are found again from the entities). */
export function chainsOf(data: SketchData): Chain[] {
  return data.chains ?? detectChains({ entities: data.entities, constraints: data.constraints, next: 0 })
}

export interface CurveInputs {
  curves: CurveIn[]
  /** where the first sketch curve is, and the normal of its plane: for the drag arrow and the default direction */
  anchor: Vec3 | null
  plane: PlaneDef | null
  sketch: { id: string; data: SketchData } | null
  /** number of refs that no longer resolve */
  missing: number
  report: RefReport
}

function nearestChain(data: SketchData, key: string, id?: string): { chain: Chain; byId: boolean } | null {
  const all = chainsOf(data)
  const byId = id ? all.filter((c) => c.id === id) : []
  if (byId.length === 1) return { chain: byId[0], byId: true }
  const [cx, cy, len] = key.split(',').map(Number)
  let best: Chain | null = null, bs = Infinity
  const pool = byId.length ? byId : all
  for (const c of pool) {
    const [kx, ky, kl] = c.key.split(',').map(Number)
    const scale = Math.max(1, Math.abs(len))
    const score = Math.hypot(kx - cx, ky - cy) / scale + Math.abs(kl - len) / scale
    if (score < bs) { bs = score; best = c }
  }
  return best && bs < 1 ? { chain: best, byId: false } : null
}

/** Resolve curve refs against the environment. Refs that no longer resolve are counted in `missing` and reported. */
export function resolveCurves(refs: string[], env: Env): CurveInputs {
  const curves: CurveIn[] = []
  const report = new RefReport()
  let anchor: Vec3 | null = null, plane: PlaneDef | null = null, sketch: CurveInputs['sketch'] = null, missing = 0
  // the edges of one body go into one input, placed where its first edge was picked (the order of sections matters to a loft)
  const edges = new Map<string, Extract<CurveIn, { kind: 'edges' }>>()
  const note = (fid: string, data: SketchData, c: Chain) => {
    if (!anchor) { const s = pathSegs(data.plane, c.segs)[0]; anchor = s.k === 'l' ? [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, (s.a[2] + s.b[2]) / 2] : s.a }
    plane ??= data.plane
    sketch ??= { id: fid, data }
  }
  const addChain = (fid: string, data: SketchData, c: Chain) => {
    curves.push({ kind: 'chain', segs: pathSegs(data.plane, c.segs), closed: c.closed, id: c.id || fid })
    note(fid, data, c)
  }
  for (const r of refs) {
    if (r.startsWith('crv:')) {
      const [, fid, ...rest] = r.split(':')
      const data = env.dataOf(fid) as SketchData | undefined
      const [key, cid] = rest.join(':').split('@')
      const hit = data && nearestChain(data, key, cid)
      if (!data || !hit) { missing++; report.lost.set(r, 'The curve no longer exists'); continue }
      if (cid && !hit.byId) report.rebound.set(r, 'A curve reference was re-bound by position, check it')
      addChain(fid, data, hit.chain)
      continue
    }
    if (r.startsWith('prof:')) {
      const [, fid, ...rest] = r.split(':')
      const data = env.dataOf(fid) as SketchData | undefined
      const [key, pid] = rest.join(':').split('@')
      const prof = (pid ? data?.profiles.find((p) => p.id === pid) : undefined) ?? data?.profiles.find((p) => p.key === key)
      if (!data || !prof) { missing++; report.lost.set(r, 'The profile no longer exists'); continue }
      for (const loop of [prof.outer, ...prof.holes]) addChain(fid, data, loopChain(loop))
      continue
    }
    const ref = decodeRef(r)
    if (ref?.kind === 'edge') {
      const hit = resolveEdge(ref, env.bodies, report)
      if (!hit) { missing++; continue }
      let group = edges.get(hit.body.key)
      if (!group) { group = { kind: 'edges', key: hit.body.key, edges: [] }; edges.set(hit.body.key, group); curves.push(group) }
      if (!group.edges.includes(hit.index)) group.edges.push(hit.index)
      if (!anchor) anchor = edgeSigs(hit.body)[hit.index].midpoint
      continue
    }
    if (ref?.kind === 'body') {
      // a whole sketch: all of its curves
      const data = env.dataOf(ref.bodyId) as SketchData | undefined
      if (data?.plane) { for (const c of chainsOf(data)) addChain(ref.bodyId, data, c); continue }
    }
    missing++
    report.lost.set(r, 'A curve you picked no longer exists')
  }
  return { curves, anchor, plane, sketch, missing, report }
}

export const worldPoint = (plane: PlaneDef, p: [number, number]) => toWorld(plane, p)
