/** Grass: flat blades that rise from the surface, bend and taper to a tip. Built from the hair strand sweep. */
import { makeObstacles, resolveCollisions } from '../../features/hair/collide'
import { rng, type Surf } from '../../features/hair/sampling'
import type { V3 } from '../../features/hair/schema'
import type { Strand } from '../../features/hair/strands'
import { sweepStrands } from '../../features/hair/sweep'
import type { Mesh3 } from '../../features/hair/wall'
import { add, cross, dot, len, lerp, mul, norm, perp, rotate, sub } from '../../features/hair/vec'
import { edgeIndex, hairParams, randomRoots } from './layout'
import type { GrassParams } from './params'
import type { InstanceSet } from './solids'
import { autoSink, type GenStats } from './spikes'

const UP: V3 = [0, 0, 1]
const SEGS = 10

/** Tilt of a unit vector from vertical, radians. */
const tiltOf = (d: V3) => Math.acos(Math.max(-1, Math.min(1, d[2])))

/** Rotate `d` toward +Z so it is at most `max` radians from vertical. */
function clampTilt(d: V3, max: number): V3 {
  const t = tiltOf(d)
  if (t <= max) return d
  const axis = cross(d, UP)
  return len(axis) < 1e-6 ? UP : rotate(d, norm(axis), t - max)
}

export function buildGrass(s: Surf, P: GrassParams, obstacle: Mesh3 | null, sides: number): { set: InstanceSet; stats: GenStats & { bent: number; collided: number } } {
  const { roots, capped } = randomRoots(s, { distribution: P.distribution, density: P.density, seed: P.seed, edgeMargin: P.edgeMargin })
  const HP = hairParams({ section: 'rect', width: P.baseWidth, thickness: P.thickness, nozzle: P.nozzle, layerHeight: P.layerHeight, snapThickness: false, printAware: false, taper: 0, rootFlare: 0 })
  const foot = Math.hypot(Math.max(P.baseWidth, P.nozzle * 1.4), P.thickness) / 2 + 0.05
  const edges = edgeIndex(s, foot + P.edgeMargin + 0.5)
  const sink0 = autoSink(P.rootSink, P.nozzle)
  const live = roots.map((_, i) => i)

  // clump centres: blades near one lean toward it, so they gather into bundles
  const K = Math.min(Math.round(P.clumpCount), live.length)
  const seeds: number[] = []
  const rc = rng(P.seed * 31 + 5)
  while (seeds.length < K) { const c = live[Math.floor(rc() * live.length)]; if (!seeds.includes(c)) seeds.push(c) }

  const wind = norm(P.windDir)
  const tipFrac = Math.max(0.12, Math.min(1, P.tipWidth / Math.max(P.baseWidth, 1e-6)))
  const maxLean = (P.maxLean * Math.PI) / 180
  const strands: Strand[] = []
  let dropped = 0, edgeRejected = 0
  roots.forEach((root, i) => {
    const R = rng(P.seed * 7919 + i * 104729 + 17)
    if (edges && edges.nearest(root.p) < foot + P.edgeMargin) { edgeRejected++; return }
    const n = root.n
    if (P.printAware && dot(n, UP) < -0.2) { dropped++; return }
    let d0 = P.lean > 0 ? rotate(n, rotate(perp(n), n, R() * 2 * Math.PI), (R() * P.lean * Math.PI) / 180) : n
    if (P.printAware) d0 = clampTilt(d0, maxLean)
    if (dot(d0, n) < 0.2) { dropped++; return }
    const h = P.height * Math.max(0.2, 1 + (P.heightVar / 100) * (R() * 2 - 1))
    const total = (P.bend * Math.max(0, 1 + (P.bendVar / 100) * (R() * 2 - 1)) * Math.PI) / 180
    // direction the blade bends toward, in the plane across its axis
    let across = rotate(perp(d0), d0, R() * 2 * Math.PI)
    if (P.windStrength > 0) {
      const w = sub(wind, mul(d0, dot(wind, d0)))
      if (len(w) > 1e-3) across = norm(lerp(across, norm(w), P.windStrength))
    }
    if (seeds.length) {
      let best = -1, bd = Infinity
      for (const sd of seeds) {
        const q = roots[sd].p
        const dd = (q[0] - root.p[0]) ** 2 + (q[1] - root.p[1]) ** 2 + (q[2] - root.p[2]) ** 2
        if (dd < bd) { bd = dd; best = sd }
      }
      if (best !== i) {
        const to = sub(roots[best].p, root.p)
        const t = sub(to, mul(d0, dot(to, d0)))
        if (len(t) > 1e-3) across = norm(lerp(across, norm(t), 0.8))
      }
    }
    across = norm(sub(across, mul(d0, dot(across, d0))))
    if (!across.some(Boolean)) across = perp(d0)
    const axis = norm(cross(d0, across))
    // centerline: the root crossing, then SEGS steps whose direction swings toward `across`
    const sink = sink0 / Math.max(0.3, dot(d0, n))
    const start = sub(root.p, mul(d0, sink))
    const pts: V3[] = [start, root.p]
    const sc: number[] = [1, 1]
    let tang = d0
    let p: V3 = root.p
    const step = h / SEGS
    for (let k = 1; k <= SEGS; k++) {
      const t = k / SEGS
      let dir = rotate(d0, axis, total * t ** 1.4)
      if (P.printAware) dir = clampTilt(dir, maxLean)
      p = add(p, mul(norm(add(tang, dir)), step))
      tang = dir
      pts.push(p)
      sc.push(1 - (1 - tipFrac) * t ** 0.9)
    }
    const flat = new Float32Array(pts.length * 3)
    pts.forEach((q, j) => flat.set(q, j * 3))
    strands.push({
      pts: flat, scale: Float32Array.from(sc), up: across, contact: null, tip: p, rootArc: sink, root: root.p,
      exempt: sink + 2 * foot + 0.1, patch: s.patch[root.tri],
    })
  })
  if (!strands.length) {
    throw new Error(edgeRejected > dropped ? 'No blade fits inside the selected surface: each one would hang over an edge. Select a larger area, make the blades narrower, or reduce the edge margin' : 'No blades could be placed; the surface faces down (print-aware) or the density is too low')
  }
  let kept = strands, bent = 0, collided = 0
  const obs = makeObstacles(s, obstacle)
  const r = resolveCollisions(strands, HP, obs)
  kept = r.strands; bent = r.stats.bent; collided = r.stats.removed
  if (!kept.length) throw new Error('Every blade collided with the body; lower the height or the lean, or select a different area')
  const tubes = sweepStrands(kept, HP, sides)
  const set: InstanceSet = { positions: tubes.positions, indices: tubes.indices, ranges: tubes.ranges, count: tubes.strands }
  return { set, stats: { count: tubes.strands, dropped, edgeRejected, capped, bent, collided } }
}
