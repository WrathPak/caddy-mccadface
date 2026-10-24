/**
 * Scales: overlapping shingles laid in staggered rows along a flow direction. Each scale is a solid wedge that rises from the
 * surface to a standing free edge (nothing hangs over empty space, so it prints without supports).
 */
import { rng, type Surf } from '../../features/hair/sampling'
import type { V3 } from '../../features/hair/schema'
import { add, mul } from '../../features/hair/vec'
import { edgeIndex, latticeRoots } from './layout'
import type { ScaleParams } from './params'
import { InstanceBuilder, type InstanceSet } from './solids'
import { autoSink, sagitta, type GenStats } from './spikes'
import type { SurfaceProbe } from './surface'

const N = 30
const RINGS = 3

/** Outline of a scale in local coordinates: x along the flow in [0, L], y across in [-W/2, W/2]; star shaped about (L/2, 0). */
export function scaleOutline(shape: ScaleParams['shape'], L: number, W: number, n = N): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n
    const c = Math.cos(a), s = Math.sin(a)
    let x: number, y: number
    if (shape === 'round') { x = c; y = s }
    else if (shape === 'pointed') { x = c; y = s * (1 - 0.6 * Math.max(0, c)) }
    else if (shape === 'shield') {
      // squarish at the back, round at the free edge
      const e = c < 0 ? 4 : 2
      x = Math.sign(c) * Math.abs(c) ** (2 / e); y = Math.sign(s) * Math.abs(s) ** (2 / e)
    } else {
      // hexagon with its points along the flow
      const sector = ((a % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3)
      const r = Math.cos(Math.PI / 6) / Math.cos(sector - Math.PI / 6)
      x = r * c; y = r * s
    }
    out.push([L / 2 + (x * L) / 2, (y * W) / 2])
  }
  return out
}

/** Closed mesh of one scale in its local frame (x flow, y across, z surface normal, origin at the scale centre on the surface). */
export function scaleMesh(shape: ScaleParams['shape'], L: number, W: number, H: number, sink: number): { pos: V3[]; idx: number[] } {
  const outline = scaleOutline(shape, L, W)
  const n = outline.length
  const e = 0.5 // rim height as a fraction of the profile height
  const profile = (x: number) => H * (0.14 + 0.86 * Math.max(0, Math.min(1, x / L)) ** 1.3)
  const dome = (f: number) => e + (1 - e) * Math.max(0, 1 - f * f) ** 0.8
  const pos: V3[] = []
  const at = (x: number, y: number, z: number): V3 => [x - L / 2, y, z]
  const ctop = pos.length; pos.push(at(L / 2, 0, profile(L / 2) * dome(0)))
  const rings: number[] = []
  for (let r = 1; r <= RINGS; r++) {
    const f = r / RINGS
    rings.push(pos.length)
    for (const [ox, oy] of outline) {
      const x = L / 2 + (ox - L / 2) * f, y = oy * f
      pos.push(at(x, y, profile(x) * dome(f)))
    }
  }
  const bt = pos.length
  for (const [ox, oy] of outline) pos.push(at(ox, oy, -sink))
  const cb = pos.length; pos.push(at(L / 2, 0, -sink))
  const idx: number[] = []
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n
    idx.push(ctop, rings[0] + k, rings[0] + k2)
    for (let r = 0; r + 1 < RINGS; r++) {
      const A = rings[r] + k, B = rings[r] + k2, D = rings[r + 1] + k, C = rings[r + 1] + k2
      idx.push(A, D, C, A, C, B)
    }
    const T = rings[RINGS - 1]
    idx.push(T + k, bt + k, bt + k2, T + k, bt + k2, T + k2)
    idx.push(cb, bt + k2, bt + k)
  }
  return { pos, idx }
}

export function buildScales(s: Surf, P: ScaleParams, probe: SurfaceProbe): { set: InstanceSet; stats: GenStats & { round: number; projected: number } } {
  const flow: V3 = P.flow === 'down' ? [0, 0, -1] : P.flow === 'up' ? [0, 0, 1] : P.flowDir
  const { roots, capped, round, projected } = latticeRoots(s, {
    du: Math.max(0.2, P.width * 0.95), dv: Math.max(0.2, P.length * (1 - P.overlap / 100)),
    flow, stagger: P.stagger, jitter: P.jitter / 100, seed: P.seed,
  })
  const reach = (Math.max(P.width, P.length) / 2) * (1 + P.sizeVar / 100) + 0.3
  const edges = edgeIndex(s, reach + P.edgeMargin + 0.5)
  const out = new InstanceBuilder()
  let edgeRejected = 0
  roots.forEach((root) => {
    const R = rng(P.seed * 131 + root.cell[0] * 7919 + root.cell[1] * 104729 + 11)
    const f = Math.max(0.3, 1 + (P.sizeVar / 100) * (R() * 2 - 1))
    const L = P.length * f, W = P.width * f, H = P.height * f
    if (edges && edges.nearest(root.p) < Math.max(L, W) * 0.5 + P.edgeMargin) { edgeRejected++; return }
    const sink = autoSink(P.rootSink, P.nozzle) + sagitta(probe, root.p, root.n, root.flow, Math.max(L, W) * 0.4)
    const m = scaleMesh(P.shape, L, W, H, sink)
    const world: number[] = []
    for (const q of m.pos) {
      const w = add(root.p, add(mul(root.flow, q[0]), add(mul(root.side, q[1]), mul(root.n, q[2]))))
      world.push(w[0], w[1], w[2])
    }
    out.add(world, m.idx)
  })
  const set = out.build()
  if (!set.count) throw new Error(edgeRejected ? 'No scale fits inside the selected surface: each one would hang over an edge. Select a larger area, make the scales smaller, or reduce the edge margin' : 'No scales could be placed; check the size and the flow direction')
  return { set, stats: { count: set.count, dropped: 0, edgeRejected, capped, round, projected } }
}
