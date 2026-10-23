/** Worker op `hairGenerate`: thin wrapper around hair-core (preview mesh, or final manifold union). */
import * as Comlink from 'comlink'
import type { Manifold } from 'manifold-3d'
import type { HairParams } from '../features/hair/schema'
import type { Axis, Mesh3 } from '../features/hair/wall'
import { buildSolids, generateHair } from './hair-core'
import { fromManifold, initManifold } from './mesh'
import { registerOp } from './store'

export interface HairArgs {
  mode: 'preview' | 'final'
  p: HairParams
  axis: Axis
  /** selected region triangles */
  positions: Float32Array
  indices: Uint32Array
  /** the unselected faces of the target body, so strands can be kept out of it */
  obstacle?: Mesh3
  /** final only */
  targetKey?: string
  ids?: { target: string; targetName: string; hair: string; wall: string }
}

export interface HairPreviewResult {
  strands: Mesh3
  wall: Mesh3 | null
  stats: { strands: number; dropped: number; redirected: number; edgeRejected: number; bent: number; collided: number; triangles: number; ms: number; capped: boolean }
}

registerOp<HairArgs>('hairGenerate', async (a, h) => {
  const t0 = performance.now()
  const g = generateHair({ p: a.p, axis: a.axis, positions: a.positions, indices: a.indices, obstacle: a.obstacle, sides: a.mode === 'final' ? 8 : 6 })
  if (a.mode === 'preview') {
    const wall = g.wall?.mesh ?? null
    const out: HairPreviewResult = {
      strands: { positions: g.tubes.positions, indices: g.tubes.indices },
      wall,
      stats: {
        strands: g.tubes.strands, dropped: g.dropped, redirected: g.redirected, capped: g.capped, edgeRejected: g.edgeRejected, bent: g.bent, collided: g.collided,
        triangles: (g.tubes.indices.length + (wall?.indices.length ?? 0)) / 3, ms: Math.round(performance.now() - t0),
      },
    }
    const bufs = [out.strands.positions.buffer, out.strands.indices.buffer, wall?.positions.buffer, wall?.indices.buffer]
    return Comlink.transfer(out, bufs.filter((b): b is ArrayBuffer => !!b))
  }

  const W = await initManifold()
  const owned: Manifold[] = []
  const own = (m: Manifold) => (owned.push(m), m)
  try {
    const ids = a.ids!
    const target = a.p.merge ? (a.targetKey ? h.getTopo(a.targetKey) : null) : null
    const s = buildSolids(W, g, a.p, target, own)
    const bodyOf = (m: Manifold, id: string, name: string) => h.bodyFromTopo(id, name, fromManifold(m))
    const out = []
    if (s.merged) out.push(bodyOf(s.merged, ids.target, ids.targetName))
    else out.push(bodyOf(s.wall && !a.p.wallSeparate ? own(W.Manifold.union([s.hair, s.wall])) : s.hair, ids.hair, 'Hair'))
    if (s.wall && a.p.wallSeparate) out.push(bodyOf(s.wall, ids.wall, 'Sacrificial wall'))
    return h.sendBodies(out)
  } finally {
    for (const m of owned) m.delete()
  }
})
