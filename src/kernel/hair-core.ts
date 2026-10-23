/** Hair pipeline core: sample -> centerlines -> wall -> attach -> sweep, then (final) manifold booleans. No worker/DOM dependencies. */
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import { prepSurface } from '../features/hair/sampling'
import type { HairParams, V3 } from '../features/hair/schema'
import { attachStrands, planStrands, rawStrands, type Strand } from '../features/hair/strands'
import { sweepStrands, type Tubes } from '../features/hair/sweep'
import { buildWall, makeCaster, selfIntersects, wallField, type Axis, type Mesh3, type WallResult } from '../features/hair/wall'
import type { TopoMesh } from './types'

export interface HairInput {
  p: HairParams
  axis: Axis
  /** selected region triangles */
  positions: Float32Array
  indices: Uint32Array
  /** tube sides: 6 for previews, 8 for the final */
  sides?: number
}

export interface HairGen {
  strands: Strand[]
  tubes: Tubes
  wall: WallResult | null
  dropped: number
  redirected: number
  capped: boolean
}

export function generateHair(a: HairInput): HairGen {
  const s = prepSurface(a.positions, a.indices)
  const plan = planStrands(s, a.p, a.axis)
  const raws = rawStrands(plan, a.p)
  if (!raws.length) throw new Error('No strands fit this surface with the current direction settings (print-aware needs a surface that is not facing straight up or down)')
  const wall = a.p.wall ? buildWall(s, a.p, raws, a.axis) : null
  const { strands, dropped, redirected } = attachStrands(raws, plan, a.p, wall ? makeCaster(wall.mesh) : null, a.p.wallThickness)
  if (!strands.length) throw new Error('No strands could be built; adjust length, direction or wall settings')
  const tubes = sweepStrands(strands, a.p, a.sides ?? 6)
  return { strands, tubes, wall, dropped, redirected, capped: plan.capped }
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

const friendly = (what: string, status: string) =>
  `${what} is not a valid closed solid (${status}). Repair the mesh${what.includes('target') ? ' or turn off "Merge into target body"' : ''} and try again`

function solidOf(W: ManifoldToplevel, m3: Mesh3 | TopoMesh, what: string, own: (m: Manifold) => Manifold): Manifold {
  let m: Manifold
  try {
    m = own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: m3.positions.slice(), triVerts: m3.indices.slice() })))
  } catch (e) {
    throw new Error(friendly(what, e instanceof Error ? e.message : String(e)))
  }
  if (m.status() !== 'NoError' || m.isEmpty() || m.volume() <= 0) throw new Error(friendly(what, m.status()))
  return m
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
  const T = g.tubes
  const tubes: Manifold[] = []
  let badTubes = 0
  for (let r = 0; r < T.strands; r++) {
    const v0 = T.ranges[r * 4], vn = T.ranges[r * 4 + 1], i0 = T.ranges[r * 4 + 2], inn = T.ranges[r * 4 + 3]
    const ix = new Uint32Array(inn)
    for (let k = 0; k < inn; k++) ix[k] = T.indices[i0 + k] - v0
    try {
      const m = own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: T.positions.slice(v0 * 3, (v0 + vn) * 3), triVerts: ix })))
      if (m.status() === 'NoError' && !m.isEmpty() && m.volume() > 0) tubes.push(m)
      else badTubes++
    } catch { badTubes++ }
  }
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
