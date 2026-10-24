/** Spikes: cones and pyramids of varying size standing on the surface. */
import { rng, type Surf } from '../../features/hair/sampling'
import type { V3 } from '../../features/hair/schema'
import { add, cross, dot, len, lerp, mul, norm, perp, rotate, sub } from '../../features/hair/vec'
import { edgeIndex, randomRoots } from './layout'
import type { SpikeParams } from './params'
import { InstanceBuilder, type InstanceSet } from './solids'
import type { SurfaceProbe } from './surface'

export interface GenStats {
  /** instances in the result */
  count: number
  /** roots skipped (pointing down, too flat, ...) */
  dropped: number
  /** roots skipped because the footprint would overhang an edge of the selection */
  edgeRejected: number
  capped: boolean
}

const SIDES = { cone: 16, tri: 3, square: 4, hex: 6 } as const
const UP: V3 = [0, 0, 1]

/** Depth the instance root is buried: explicit, or enough to cover the roughness of the tessellation and at least 1.5 line widths. */
export const autoSink = (rootSink: number, nozzle: number) => (rootSink > 0 ? rootSink : Math.max(0.6, 1.5 * nozzle))

/** Extra depth needed because a flat footprint of radius r on a curved surface leaves its rim above the surface. */
export function sagitta(probe: SurfaceProbe, p: V3, n: V3, ex: V3, r: number): number {
  const ey = cross(n, ex)
  let worst = 0
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4
    const q = add(p, add(mul(ex, Math.cos(a) * r), mul(ey, Math.sin(a) * r)))
    const c = probe.closest(q)
    worst = Math.max(worst, -dot(sub(c.point, p), n))
  }
  return worst
}

export function buildSpikes(s: Surf, P: SpikeParams, probe: SurfaceProbe): { set: InstanceSet; stats: GenStats } {
  const { roots, capped } = randomRoots(s, { distribution: P.distribution, density: P.density, seed: P.seed, edgeMargin: P.edgeMargin })
  const reach = (P.baseWidth / 2) * (1 + P.sizeVar / 100) * 1.1 + 0.2
  const edges = edgeIndex(s, reach + P.edgeMargin + 0.5)
  const sides = SIDES[P.shape]
  const out = new InstanceBuilder()
  let dropped = 0, edgeRejected = 0
  roots.forEach((root, i) => {
    const R = rng(P.seed * 7919 + i * 104729 + 29)
    const f = Math.max(0.2, 1 + (P.sizeVar / 100) * (R() * 2 - 1))
    const h = P.height * f, r = (P.baseWidth * f) / 2
    if (edges && edges.nearest(root.p) < r * 1.05 + P.edgeMargin) { edgeRejected++; return }
    const n = root.n
    let d: V3 = P.direction === 'up' ? lerp(n, UP, 0.9) : n
    d = norm(d)
    if (P.tilt > 0) d = rotate(d, rotate(perp(d), d, R() * 2 * Math.PI), ((R() * 2 - 1) * P.tilt * Math.PI) / 180)
    if (P.printAware) {
      // the low side of the spike must not overhang more than 45 degrees from vertical
      const half = Math.atan2(r, h)
      const maxTilt = Math.max(0, Math.PI / 4 - half)
      if (dot(n, UP) < -0.2) { dropped++; return }
      const tilt = Math.acos(Math.max(-1, Math.min(1, dot(d, UP))))
      if (tilt > maxTilt) {
        const axis = cross(d, UP)
        d = len(axis) < 1e-6 ? UP : rotate(d, norm(axis), tilt - maxTilt)
      }
    }
    if (dot(d, n) < 0.2) { dropped++; return }
    const e1 = perp(n), e2 = cross(n, e1)
    const yaw = sides === 16 ? 0 : R() * Math.PI * 2
    const sink = autoSink(P.rootSink, P.nozzle) + sagitta(probe, root.p, n, e1, r)
    const ring = (rad: number, base: V3) => Array.from({ length: sides }, (_, k) => {
      const a = yaw + (k * 2 * Math.PI) / sides
      return add(base, add(mul(e1, Math.cos(a) * rad), mul(e2, Math.sin(a) * rad)))
    })
    const top = add(root.p, mul(d, h))
    const tw = (P.tipWidth * f) / 2
    const pos: V3[] = []
    const idx: number[] = []
    const r0 = ring(r, root.p), rS = ring(r, sub(root.p, mul(n, sink)))
    const i0 = pos.length; pos.push(...r0)
    const iS = pos.length; pos.push(...rS)
    const cb = pos.length; pos.push(sub(root.p, mul(n, sink)))
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides
      idx.push(i0 + k, iS + k, iS + k2, i0 + k, iS + k2, i0 + k2) // buried band
      idx.push(cb, iS + k2, iS + k) // bottom
    }
    if (tw > 1e-3) {
      const rT = ring(Math.min(tw, r * 0.9), top)
      const iT = pos.length; pos.push(...rT)
      const ct = pos.length; pos.push(top)
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides
        idx.push(i0 + k, i0 + k2, iT + k2, i0 + k, iT + k2, iT + k)
        idx.push(ct, iT + k, iT + k2)
      }
    } else {
      const ap = pos.length; pos.push(top)
      for (let k = 0; k < sides; k++) idx.push(i0 + k, i0 + (k + 1) % sides, ap)
    }
    out.add(pos.flat(), idx)
  })
  const set = out.build()
  if (!set.count) throw new Error(edgeRejected > dropped ? 'No spike fits inside the selected surface: each one would hang over an edge. Select a larger area, make the spikes narrower, or reduce the edge margin' : 'No spikes could be placed; the surface faces down (print-aware) or the density is too low')
  return { set, stats: { count: set.count, dropped, edgeRejected, capped } }
}

