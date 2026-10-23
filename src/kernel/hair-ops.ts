/** Worker op `hairGenerate`: sample -> centerlines -> wall -> raycast clip -> tube sweep -> (final) manifold union. */
import * as Comlink from 'comlink'
import type { Manifold, Mesh } from 'manifold-3d'
import { prepSurface } from '../features/hair/sampling'
import type { HairParams } from '../features/hair/schema'
import { buildStrands, planStrands } from '../features/hair/strands'
import { sweepStrands, type Tubes } from '../features/hair/sweep'
import { buildWall, makeCaster, type Axis, type Mesh3 } from '../features/hair/wall'
import { add, basis, mul, norm, sub } from '../features/hair/vec'
import { fromManifold, initManifold } from './mesh'
import { registerOp } from './store'

export interface HairArgs {
  mode: 'preview' | 'final'
  p: HairParams
  axis: Axis
  /** selected region triangles */
  positions: Float32Array
  indices: Uint32Array
  /** final only */
  targetKey?: string
  ids?: { target: string; targetName: string; hair: string; wall: string }
}

export interface HairPreviewResult {
  strands: Mesh3
  wall: Mesh3 | null
  stats: { strands: number; dropped: number; triangles: number; ms: number; capped: boolean }
}

function generate(a: HairArgs) {
  const t0 = performance.now()
  const s = prepSurface(a.positions, a.indices)
  const plan = planStrands(s, a.p, a.axis)
  const wall = a.p.wall ? buildWall(s, a.p, plan, a.axis) : null
  const { strands, dropped } = buildStrands(plan, a.p, wall ? makeCaster(wall) : null)
  if (!strands.length) throw new Error('No strands reached the wall; adjust length, direction or wall settings')
  const tubes = sweepStrands(strands, a.p, a.mode === 'final' ? 8 : 6)
  return { strands, tubes, wall, dropped, capped: plan.capped, t0 }
}

registerOp<HairArgs>('hairGenerate', async (a, h) => {
  const g = generate(a)
  const tris = (g.tubes.indices.length + (g.wall?.indices.length ?? 0)) / 3
  if (a.mode === 'preview') {
    const out: HairPreviewResult = {
      strands: { positions: g.tubes.positions, indices: g.tubes.indices },
      wall: g.wall,
      stats: { strands: g.tubes.strands, dropped: g.dropped, triangles: tris, ms: Math.round(performance.now() - g.t0), capped: g.capped },
    }
    const bufs = [g.tubes.positions.buffer, g.tubes.indices.buffer, g.wall?.positions.buffer, g.wall?.indices.buffer]
    return Comlink.transfer(out, bufs.filter((b): b is ArrayBuffer => !!b))
  }

  // ---- final: manifold batch union
  const W = await initManifold()
  const owned: Manifold[] = []
  const own = (m: Manifold) => (owned.push(m), m)
  const solid = (positions: Float32Array, indices: Uint32Array, what: string) => {
    let m: Manifold
    try {
      m = own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: positions, triVerts: indices }) as Mesh))
    } catch (e) {
      throw new Error(`${what} is not a valid solid (${e instanceof Error ? e.message : e})`)
    }
    if (m.status() !== 'NoError' || m.isEmpty() || m.volume() <= 0) throw new Error(`${what} is not a valid closed solid (${m.status()})`)
    return m
  }
  try {
    const ids = a.ids!
    const tubeList: Manifold[] = []
    const T: Tubes = g.tubes
    for (let r = 0; r < T.strands; r++) {
      const [v0, vn, i0, inn] = [T.ranges[r * 4], T.ranges[r * 4 + 1], T.ranges[r * 4 + 2], T.ranges[r * 4 + 3]]
      const ix = new Uint32Array(inn)
      for (let k = 0; k < inn; k++) ix[k] = T.indices[i0 + k] - v0
      try {
        const m = W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: T.positions.slice(v0 * 3, (v0 + vn) * 3), triVerts: ix }) as Mesh)
        own(m)
        if (m.status() === 'NoError' && !m.isEmpty()) tubeList.push(m)
      } catch { /* skip a degenerate strand */ }
    }
    if (!tubeList.length) throw new Error('Strand geometry was invalid')
    const hair = own(W.Manifold.union(tubeList))

    let wallM: Manifold | null = null
    if (g.wall) {
      wallM = solid(g.wall.positions, g.wall.indices, 'The sacrificial wall')
      if (a.p.breakLine === 'perforation') {
        const holes = perforations(W, g.strands, a.p, own)
        if (holes) wallM = own(wallM.subtract(holes))
      }
    }

    const out = []
    const bodyOf = (m: Manifold, id: string, name: string) => h.bodyFromTopo(id, name, fromManifold(m))
    const joinWall = !!wallM && !a.p.wallSeparate
    if (a.p.merge) {
      const key = a.targetKey
      if (!key) throw new Error('Missing target body')
      const target = solid(h.getTopo(key).positions, h.getTopo(key).indices, 'The target body')
      out.push(bodyOf(own(W.Manifold.union([target, hair, ...(joinWall ? [wallM!] : [])])), ids.target, ids.targetName))
    } else {
      out.push(bodyOf(joinWall ? own(W.Manifold.union([hair, wallM!])) : hair, ids.hair, 'Hair'))
    }
    if (wallM && a.p.wallSeparate) out.push(bodyOf(wallM, ids.wall, 'Sacrificial wall'))
    return h.sendBodies(out)
  } finally {
    for (const m of owned) m.delete()
  }
})

/** Small holes either side of every strand-wall joint (weakens the wall around each contact). */
function perforations(W: Awaited<ReturnType<typeof initManifold>>, strands: ReturnType<typeof generate>['strands'], P: HairParams, own: (m: Manifold) => Manifold): Manifold | null {
  const r = P.breakSize / 2
  const off = Math.max(P.width, P.thickness) / 2 + r + 0.25
  const depth = Math.min(P.wallThickness * 0.7, P.wallThickness - 0.4) + 0.3
  if (depth <= 0.3) return null
  const list: Manifold[] = []
  for (const st of strands) {
    if (!st.contact || list.length >= 20000) continue
    const w = norm(st.inward)
    const [e1, e2] = basis(w)
    let vz = sub([0, 0, 1], mul(w, w[2]))
    vz = Math.hypot(...vz) > 1e-3 ? norm(vz) : e1
    for (const sg of [-1, 1]) {
      const c = add(sub(st.contact, mul(w, 0.3)), mul(vz, sg * off))
      const m = [e1[0], e1[1], e1[2], 0, e2[0], e2[1], e2[2], 0, w[0], w[1], w[2], 0, c[0], c[1], c[2], 1] as Parameters<Manifold['transform']>[0]
      list.push(own(own(W.Manifold.cylinder(depth, r, r, 8, false)).transform(m)))
    }
  }
  return list.length ? own(W.Manifold.union(list)) : null
}
