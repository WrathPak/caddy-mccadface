/** One entry point for the four surface generators: build the instances, then (final) union them and fuse with the body. */
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import { prepSurface } from '../../features/hair/sampling'
import type { HairParams } from '../../features/hair/schema'
import type { Mesh3 } from '../../features/hair/wall'
import { buildSolids, type HairGen, type HairSolids } from '../hair-core'
import type { TopoMesh } from '../types'
import { generateFur } from './fur'
import { buildGrass } from './grass'
import type { FurParams, GenKind, GrassParams, ScaleParams, SpikeParams } from './params'
import { buildScales } from './scales'
import { solidOf, unionInstances, type InstanceSet } from './solids'
import { buildSpikes, type GenStats } from './spikes'
import { SurfaceProbe } from './surface'

export interface GenInput {
  kind: GenKind
  params: unknown
  /** selected region triangles */
  positions: Float32Array
  indices: Uint32Array
  /** the unselected faces of the body (instances are kept out of it) */
  obstacle?: Mesh3 | null
  /** tube sides for strand based kinds: 6 for previews, 8 for the final */
  sides?: number
}

export interface GenResult {
  kind: GenKind
  set: InstanceSet
  /** fur with a sacrificial wall */
  wall: Mesh3 | null
  /** fur keeps its hair generation so the wall and the boolean stage can be reused */
  hair?: { gen: HairGen; p: HairParams }
  stats: GenStats & { bent?: number; collided?: number; round?: number; projected?: number }
  merge: boolean
  wallSeparate: boolean
}

export function generateSurface(a: GenInput): GenResult {
  const sides = a.sides ?? 6
  if (a.kind === 'fur') {
    const P = a.params as FurParams
    const { gen, hair } = generateFur(P, { positions: a.positions, indices: a.indices, obstacle: a.obstacle ?? undefined, sides })
    const T = gen.tubes
    return {
      kind: 'fur', set: { positions: T.positions, indices: T.indices, ranges: T.ranges, count: T.strands }, wall: gen.wall?.mesh ?? null, hair: { gen, p: hair },
      stats: { count: T.strands, dropped: gen.dropped, edgeRejected: gen.edgeRejected, capped: gen.capped, bent: gen.bent, collided: gen.collided }, merge: P.merge, wallSeparate: false,
    }
  }
  const s = prepSurface(a.positions, a.indices)
  const probe = new SurfaceProbe(s)
  if (a.kind === 'spikes') {
    const P = a.params as SpikeParams
    const r = buildSpikes(s, P, probe)
    return { kind: 'spikes', set: r.set, wall: null, stats: r.stats, merge: P.merge, wallSeparate: false }
  }
  if (a.kind === 'scales') {
    const P = a.params as ScaleParams
    const r = buildScales(s, P, probe)
    return { kind: 'scales', set: r.set, wall: null, stats: r.stats, merge: P.merge, wallSeparate: false }
  }
  const P = a.params as GrassParams
  const r = buildGrass(s, P, a.obstacle ?? null, sides)
  return { kind: 'grass', set: r.set, wall: null, stats: r.stats, merge: P.merge, wallSeparate: false }
}

/** Boolean stage. Every manifold made here is registered with `own` so the caller can free them. */
export function buildGenSolids(W: ManifoldToplevel, g: GenResult, target: TopoMesh | null, own: (m: Manifold) => Manifold): HairSolids {
  if (g.hair) return buildSolids(W, g.hair.gen, g.hair.p, target, own)
  const { union, bad } = unionInstances(W, g.set, own)
  let merged: Manifold | null = null
  if (g.merge) {
    if (!target) throw new Error('Missing target body')
    merged = own(W.Manifold.union([solidOf(W, target, 'The target body', own), union]))
  }
  return { hair: union, wall: null, merged, wallRepaired: false, badTubes: bad }
}
