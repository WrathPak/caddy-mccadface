/** Sparse direction arrows for the Direction section: where strands would point, computed with the same rules as the real generation. */
import { prepSurface } from './sampling'
import type { HairParams, V3 } from './schema'
import { planStrands } from './strands'
import type { Axis } from './wall'

export interface Glyphs {
  /** x, y, z, dx, dy, dz per arrow (origin on the surface, unit direction) */
  data: Float32Array
  /** area-weighted centre of the selected surface */
  centre: V3
  /** diagonal of its bounding box */
  size: number
  /** area-weighted mean surface normal */
  normal: V3
}

export function directionGlyphs(positions: Float32Array, indices: Uint32Array, p: HairParams, axis: Axis, maxCount = 48): Glyphs {
  const s = prepSurface(positions, indices)
  const cm2 = Math.max(s.total / 100, 1e-6)
  const edge = Math.sqrt(s.total / maxCount) * 0.25
  const P: HairParams = { ...p, distribution: 'poisson', densityMode: 'density', density: maxCount / cm2, edgeMargin: edge, wall: false, bedZ: undefined, seed: 7 }
  const plan = planStrands(s, P, axis)
  const out: number[] = []
  for (let i = 0; i < plan.count; i++) {
    if (plan.drop[i]) continue
    out.push(plan.p[i * 3], plan.p[i * 3 + 1], plan.p[i * 3 + 2], plan.dir[i * 3], plan.dir[i * 3 + 1], plan.dir[i * 3 + 2])
  }
  const c: V3 = [0, 0, 0]
  const nsum: V3 = [0, 0, 0]
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t < s.idx.length / 3; t++) {
    for (let j = 0; j < 3; j++) nsum[j] += s.tn[t * 3 + j] * s.area[t]
    for (let k = 0; k < 3; k++) {
      const v = s.idx[t * 3 + k] * 3
      for (let j = 0; j < 3; j++) { c[j] += (s.pos[v + j] / 3) * s.area[t]; lo[j] = Math.min(lo[j], s.pos[v + j]); hi[j] = Math.max(hi[j], s.pos[v + j]) }
    }
  }
  const centre: V3 = [c[0] / s.total, c[1] / s.total, c[2] / s.total]
  const nl = Math.hypot(nsum[0], nsum[1], nsum[2]) || 1
  const normal: V3 = [nsum[0] / nl, nsum[1] / nl, nsum[2] / nl]
  return { data: Float32Array.from(out), centre, normal, size: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) }
}
