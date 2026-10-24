/** Hair pipeline core: sample -> centerlines -> wall -> attach -> sweep, then (final) manifold booleans. No worker/DOM dependencies. */
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import { bodyThickness, makeObstacles, resolveCollisions } from '../features/hair/collide'
import { prepSurface } from '../features/hair/sampling'
import type { HairParams, V3 } from '../features/hair/schema'
import { attachStrands, makeFit, planStrands, rawStrands, type Strand } from '../features/hair/strands'
import { sweepStrands, type Tubes } from '../features/hair/sweep'
import { buildWall, makeCaster, selfIntersects, wallField, type Axis, type Mesh3, type WallResult } from '../features/hair/wall'
import { instanceManifolds, solidOf } from './generators/solids'
import type { TopoMesh } from './types'

export interface HairInput {
  p: HairParams
  axis: Axis
  /** selected region triangles */
  positions: Float32Array
  indices: Uint32Array
  /** tube sides: 6 for previews, 8 for the final */
  sides?: number
  /** the rest of the body (unselected faces); when given, strands are kept out of the body and the print bed is found from it */
  obstacle?: Mesh3
}

export interface HairGen {
  strands: Strand[]
  tubes: Tubes
  wall: WallResult | null
  dropped: number
  redirected: number
  capped: boolean
  /** roots skipped because the strand footprint would overhang the edge of the selection */
  edgeRejected: number
  /** strands bent away from the body / removed because they could not be freed */
  bent: number
  collided: number
  /** height of the print bed (lowest point of body and wall): layers are counted from here */
  bedZ: number
}

const minZ = (a: ArrayLike<number>) => { let m = Infinity; for (let i = 2; i < a.length; i += 3) m = Math.min(m, a[i]); return m }
const maxZ = (a: ArrayLike<number>) => { let m = -Infinity; for (let i = 2; i < a.length; i += 3) m = Math.max(m, a[i]); return m }

export function generateHair(a: HairInput): HairGen {
  const P0: HairParams = { ...a.p, dirMode: a.p.dirMode === 'normal' ? 'blend' : a.p.dirMode }
  const s = prepSurface(a.positions, a.indices)
  const obs = a.obstacle ? makeObstacles(s, a.obstacle) : null
  const zr0 = minZ(s.pos), zr1 = maxZ(s.pos)
  const bodyMin = Math.min(zr0, a.obstacle ? minZ(a.obstacle.positions) : Infinity)
  let bedZ = Math.min(bodyMin, P0.wall ? zr0 - P0.wallBottom : Infinity)
  let P = P0, plan, raws, wall: WallResult | null = null
  // The slicer drops the model onto the bed: layers are counted from its lowest point, which can be the wall's flat bottom.
  for (let pass = 0; pass < 4; pass++) {
    P = { ...P0, bedZ }
    plan = planStrands(s, P, a.axis)
    const fit = makeFit(s, P, obs ? (p: V3, n: V3) => bodyThickness(obs, p, n) : undefined)
    raws = rawStrands(plan, P, fit)
    if (!raws.length) {
      throw new Error(plan.edgeRejected
        ? 'No strand fits inside the selected surface: each one would hang over an edge. Select a larger area, make the strands narrower, or reduce the edge margin'
        : 'No strands fit this surface with the current direction settings. Print-aware keeps strands horizontal, so it needs side faces (not faces pointing up or down): turn it off under Printing, pick side faces, or change the direction')
    }
    wall = null
    if (P.wall) {
      let hi = zr1
      for (const r of raws) for (const q of r.poly) hi = Math.max(hi, q[2])
      wall = buildWall(s, P, raws, a.axis, { lo: zr0 - P.wallBottom, hi: hi + P.wallTop })
    }
    const actual = Math.min(bodyMin, wall ? minZ(wall.mesh.positions) : Infinity)
    if (Math.abs(actual - bedZ) < 1e-4) break
    bedZ = actual
  }
  if (!plan || !raws) throw new Error('Hair could not be planned')
  let { strands, dropped, redirected } = attachStrands(raws, plan, P, wall ? makeCaster(wall.mesh) : null, P.wallThickness)
  let bent = 0, collided = 0
  if (obs) {
    const r = resolveCollisions(strands, P, obs)
    strands = r.strands; bent = r.stats.bent; collided = r.stats.removed
  }
  if (!strands.length) throw new Error(collided ? 'Every strand collided with the body; adjust the direction or length' : 'No strands could be built; adjust length, direction or wall settings')
  const tubes = sweepStrands(strands, P, a.sides ?? 6)
  return { strands, tubes, wall, dropped, redirected, capped: plan.capped, edgeRejected: plan.edgeRejected, bent, collided, bedZ }
}

export interface HairSolids {
  /** union of every tube */
  hair: Manifold
  wall: Manifold | null
  /** target + hair (+ wall) when merging */
  merged: Manifold | null
  /** wall was rebuilt from per-triangle prisms because its offset shell self-intersected */
  wallRepaired: boolean
  badTubes: number
}

/** Upper bound on SDF samples for a repair; the grid spacing grows to stay within it. */
const REPAIR_SAMPLES = 400_000

/**
 * Wall volume. Follow walls whose offset shell folds into itself are rebuilt as the level set of a signed distance field
 * (everything within half a thickness of the shell mid-surface), meshed by manifold-3d marching tetrahedra: always a
 * manifold, and the cost is bounded by REPAIR_SAMPLES BVH distance queries instead of thousands of booleans.
 */
export function wallSolid(W: ManifoldToplevel, w: WallResult, own: (m: Manifold) => Manifold): { m: Manifold; repaired: boolean } {
  if (w.follow && selfIntersects(w.mesh)) {
    const f = wallField(w.follow)
    if (!(f.half > 1e-6)) throw new Error('The sacrificial wall could not be built; the wall thickness is zero')
    const pad = f.half + 1e-3
    const lo = f.min.map((x) => x - pad) as V3, hi = f.max.map((x) => x + pad) as V3
    const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])
    // body-centred grid holds ~2 samples per edge-length cube; keep edges at most a third of the thickness where the budget allows
    const edge = Math.max(f.half * 2 / 3, Math.cbrt((2 * vol) / REPAIR_SAMPLES))
    const b = { min: lo.map((x) => x - 2 * edge) as V3, max: hi.map((x) => x + 2 * edge) as V3 }
    let m: Manifold
    try { m = own(W.Manifold.levelSet(f.sdf, b, edge)) } catch (e) {
      throw new Error('The sacrificial wall could not be repaired: ' + (e instanceof Error ? e.message : String(e)))
    }
    if (m.status() !== 'NoError' || m.isEmpty() || m.volume() <= 0) throw new Error('The sacrificial wall could not be repaired; try a smaller wall offset or a planar/cylindrical wall')
    return { m, repaired: true }
  }
  return { m: solidOf(W, w.mesh, 'The sacrificial wall', own), repaired: false }
}

/** Boolean stage. Every intermediate manifold is registered with `own` so the caller can free them. */
export function buildSolids(W: ManifoldToplevel, g: HairGen, p: HairParams, target: TopoMesh | null, own: (m: Manifold) => Manifold): HairSolids {
  const { solids: tubes, bad: badTubes } = instanceManifolds(W, { ...g.tubes, count: g.tubes.strands }, own)
  if (!tubes.length) throw new Error('Strand geometry was invalid (no strand formed a closed solid)')
  const hair = own(W.Manifold.union(tubes))
  let wall: Manifold | null = null
  let wallRepaired = false
  if (g.wall) {
    const ws = wallSolid(W, g.wall, own)
    wall = ws.m
    wallRepaired = ws.repaired
  }
  let merged: Manifold | null = null
  if (p.merge) {
    if (!target) throw new Error('Missing target body')
    const t = solidOf(W, target, 'The target body', own)
    merged = own(W.Manifold.union([t, hair, ...(wall && !p.wallSeparate ? [wall] : [])]))
  }
  return { hair, wall, merged, wallRepaired, badTubes }
}
