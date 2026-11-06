/**
 * Project to Surface. A sketch is flat, so a curve cannot be wrapped onto a curved face and stay a sketch curve. What this does,
 * for real: look along the sketch normal (both ways) from every point of the picked sketch curves and keep the parts that have the
 * face in line of sight, as reference curves in the sketch (the shadow of the face's footprint on those curves), and report how far
 * the face lies from the sketch plane there. Lines come out as lines, circles and arcs as arcs, a circle that is wholly over the
 * face stays a circle. Other curve kinds (splines, ellipses, text) are left out and counted.
 */
import type { Body } from '@/kernel/types'
import type { ProjectedCurve } from '@/kernel/sketch-ops'
import { circleOf, entityById, lineEnds, pos } from './model'
import { toWorld } from './plane'
import type { Entity, PlaneDef, SketchModel, Vec2, Vec3 } from './types'

/** The triangles of one face of a body, as flat [x, y, z, ...] triples per corner. */
export function faceTriangles(body: Body, face: number): Float32Array {
  const { positions: p, indices, faceIds } = body.mesh
  const out: number[] = []
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== face) continue
    for (let k = 0; k < 3; k++) { const i = indices[t * 3 + k] * 3; out.push(p[i], p[i + 1], p[i + 2]) }
  }
  return Float32Array.from(out)
}

/** Does the line through `o` along `d` (both ways) cross one of the triangles? Returns the signed distance to the nearest crossing, or null. */
export function lineHits(tris: Float32Array, o: Vec3, d: Vec3): number | null {
  let best: number | null = null
  for (let i = 0; i < tris.length; i += 9) {
    const e1x = tris[i + 3] - tris[i], e1y = tris[i + 4] - tris[i + 1], e1z = tris[i + 5] - tris[i + 2]
    const e2x = tris[i + 6] - tris[i], e2y = tris[i + 7] - tris[i + 1], e2z = tris[i + 8] - tris[i + 2]
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-12) continue
    const inv = 1 / det
    const tx = o[0] - tris[i], ty = o[1] - tris[i + 1], tz = o[2] - tris[i + 2]
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < -1e-9 || u > 1 + 1e-9) continue
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
    if (v < -1e-9 || u + v > 1 + 1e-9) continue
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (best === null || Math.abs(t) < Math.abs(best)) best = t
  }
  return best
}

const STEP = 0.4
const TAU = Math.PI * 2

export interface SurfaceResult { curves: ProjectedCurve[]; /** distance of the face from the sketch plane at the middle of the first piece kept (signed along the normal) */ height: number | null; skipped: number }

/** Parts of the sketch curves `src` that have the face in line of sight along the sketch normal. */
export function surfaceCurves(m: SketchModel, src: string[], plane: PlaneDef, body: Body, face: number): SurfaceResult {
  const tris = faceTriangles(body, face)
  const n = plane.normal
  const curves: ProjectedCurve[] = []
  let height: number | null = null
  let skipped = 0
  const probe = (p: Vec2): number | null => lineHits(tris, toWorld(plane, p), n)
  /** Ranges of t in [0, 1] where `at(t)` is over the face, refined at the ends by halving. */
  const runs = (at: (t: number) => Vec2, count: number): [number, number][] => {
    const hit = (t: number) => probe(at(t)) !== null
    const flags = Array.from({ length: count + 1 }, (_, i) => hit(i / count))
    const refine = (a: number, b: number) => { // a: no hit, b: hit (or the other way): find the edge
      const ha = hit(a)
      for (let k = 0; k < 14; k++) { const mid = (a + b) / 2; if (hit(mid) === ha) a = mid; else b = mid }
      return (a + b) / 2
    }
    const out: [number, number][] = []
    let start: number | null = flags[0] ? 0 : null
    for (let i = 1; i <= count; i++) {
      if (flags[i] && start === null) start = refine((i - 1) / count, i / count)
      else if (!flags[i] && start !== null) { out.push([start, refine((i - 1) / count, i / count)]); start = null }
    }
    if (start !== null) out.push([start, 1])
    return out.filter(([a, b]) => b - a > 1e-6)
  }
  const note = (at: (t: number) => Vec2, r: [number, number]) => {
    if (height === null) height = probe(at((r[0] + r[1]) / 2))
  }
  const ang = (c: Vec2, p: Vec2) => Math.atan2(p[1] - c[1], p[0] - c[0])
  for (const id of src) {
    const e: Entity | undefined = entityById(m, id)
    if (!e || e.type === 'point' || e.ref) continue
    if (e.type === 'line') {
      const [a, b] = lineEnds(m, e)
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const at = (t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      for (const r of runs(at, Math.max(2, Math.min(600, Math.ceil(len / STEP))))) { curves.push({ k: 'l', a: at(r[0]), b: at(r[1]) }); note(at, r) }
    } else if (e.type === 'circle' || e.type === 'arc') {
      const { c, r } = circleOf(m, e)
      let a0 = 0, sweep = TAU
      if (e.type === 'arc') { a0 = ang(c, pos(m, e.s)); sweep = ang(c, pos(m, e.e)) - a0; while (sweep <= 1e-12) sweep += TAU }
      const at = (t: number): Vec2 => [c[0] + r * Math.cos(a0 + sweep * t), c[1] + r * Math.sin(a0 + sweep * t)]
      const list = runs(at, Math.max(8, Math.min(1440, Math.ceil((r * sweep) / STEP))))
      if (e.type === 'circle' && list.length === 1 && list[0][0] === 0 && list[0][1] === 1) { curves.push({ k: 'c', c, r }); note(at, [0, 1]); continue }
      for (const q of list) { curves.push({ k: 'a', c, r, s: at(q[0]), e: at(q[1]) }); note(at, q) }
    } else {
      skipped++ // splines, ellipses and text have no copy that stays a sketch curve
    }
  }
  return { curves, height, skipped }
}

