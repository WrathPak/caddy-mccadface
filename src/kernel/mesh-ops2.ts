/** Worker ops for the Mesh workspace, second set: reduce / remesh with types, plane cut fill types, face groups, region edits, statistics, section outlines, scaling. */
import { fromManifold, initManifold, toManifold } from './mesh'
import {
  clipTopo, compactGroups, eraseTris, groupTris, meanEdgeLength, reduceTopo, refineInPlane, remeshTopo, scaleTopo, sectionLoops, statsOf, translateTris,
  type MeshStats,
} from './meshedit'
import { getOp, getStored, registerOp } from './store'
import type { Body, TopoMesh, Vec3 } from './types'

interface Base { id: string; name: string; key: string }
const LARGE = 150_000

const crease = (key: string) => { const s = getStored(key); return s.kind === 'mesh' ? s.crease : undefined }
const keptGroups = (key: string) => { const s = getStored(key); return s.kind === 'mesh' ? s.groups : undefined }

// ---------------------------------------------------------------- reduce

export interface ReduceArgs extends Base {
  type: 'tolerance' | 'proportion' | 'count'
  tolerance: number
  /** percent of the triangles to keep */
  proportion: number
  count: number
  preserveBoundaries: boolean
  preserveSharp: boolean
}
registerOp<ReduceArgs, Body>('meshReduce2', async (a, h) => {
  let topo = h.getTopo(a.key)
  const tris = topo.indices.length / 3
  const target = a.type === 'count' ? a.count : a.type === 'proportion' ? Math.round((tris * a.proportion) / 100) : 0
  if (a.type !== 'tolerance' && !(target >= 4)) throw new Error('The target must be at least 4 triangles')
  if (a.type === 'tolerance' && !(a.tolerance > 0)) throw new Error('The tolerance must be greater than zero')
  if (tris > LARGE) {
    // millions of triangles: the fast simplifier takes the bulk off first, the quadric reducer then finishes to the target
    await initManifold()
    const man = await toManifold(topo)
    try {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < topo.positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], topo.positions[i + k]); hi[k] = Math.max(hi[k], topo.positions[i + k]) }
      const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
      const out = man.simplify(a.type === 'tolerance' ? a.tolerance : Math.max(diag * 0.0005, 1e-4))
      topo = fromManifold(out)
      out.delete()
    } finally {
      man.delete()
    }
    if (a.type === 'tolerance' || topo.indices.length / 3 <= target) return h.sendBody(h.bodyFromTopo(a.id, a.name, topo))
  }
  const r = reduceTopo(topo, a.type === 'tolerance'
    ? { mode: 'tolerance', tolerance: a.tolerance, preserveBoundaries: a.preserveBoundaries, preserveSharp: a.preserveSharp }
    : { mode: 'count', target, preserveBoundaries: a.preserveBoundaries, preserveSharp: a.preserveSharp })
  return h.sendBody(h.bodyFromTopo(a.id, a.name, r))
})

// ---------------------------------------------------------------- remesh

export interface RemeshArgs extends Base {
  type: 'uniform' | 'adaptive' | 'density'
  length: number
  density: number
  preserveSharp: boolean
  preserveBoundaries: boolean
}
registerOp<RemeshArgs, Body>('meshRemesh', (a, h) => {
  const topo = h.getTopo(a.key)
  if (topo.indices.length / 3 > 300_000) throw new Error('Remesh works on meshes up to 300 thousand triangles: Reduce the mesh first')
  const r = remeshTopo(topo, { type: a.type, length: a.length, density: a.density, preserveSharp: a.preserveSharp, preserveBoundaries: a.preserveBoundaries })
  if (r.indices.length / 3 > 2_000_000) throw new Error('That would create more than 2 million triangles; use a larger edge length')
  return h.sendBody(h.bodyFromTopo(a.id, a.name, r))
})

// ---------------------------------------------------------------- plane cut with a fill type

export interface CutArgs extends Base { normal: Vec3; offset: number; keep: 'above' | 'below' | 'both'; otherId: string; fill: 'minimal' | 'uniform' | 'none' }
/** Cut along the plane normal . p = offset. Fill: None leaves the cut open, Minimal caps it with the fewest triangles, Uniform with triangles as big as the mesh's own. */
registerOp<CutArgs, Body[]>('meshCut', async (a, h) => {
  const nl = Math.hypot(...a.normal) || 1
  const n: Vec3 = [a.normal[0] / nl, a.normal[1] / nl, a.normal[2] / nl]
  const offset = a.offset / nl
  const topo = h.getTopo(a.key)
  if (a.fill === 'none') {
    const above = a.keep !== 'below' ? clipTopo(topo, n, offset, true) : null
    const below = a.keep !== 'above' ? clipTopo(topo, n, offset, false) : null
    if (a.keep === 'both') {
      if (!above!.indices.length || !below!.indices.length) throw new Error('The plane does not cut through the body')
      return h.sendBodies([h.bodyFromTopo(a.id, a.name, above!), h.bodyFromTopo(a.otherId, a.name + ' (2)', below!)])
    }
    const kept = (above ?? below)!
    if (!kept.indices.length) throw new Error('The plane removes the whole body')
    return h.sendBodies([h.bodyFromTopo(a.id, a.name, kept)])
  }
  const op = getOp('meshPlaneCut')!
  const cut = (await op({ id: a.id, name: a.name, key: a.key, normal: n, offset, keep: a.keep, otherId: a.otherId } as never, h)) as Body[]
  if (a.fill !== 'uniform') return cut
  // Uniform: the flat cap is cut into triangles about as big as those of the cut surface
  const edge = meanEdgeLength(topo)
  const out = cut.map((b, i) => {
    const t = h.getTopo(b.key)
    const sgn = a.keep === 'both' && i === 1 ? -1 : a.keep === 'below' ? -1 : 1
    const fine = refineInPlane(t, [n[0] * sgn, n[1] * sgn, n[2] * sgn], offset * sgn, edge)
    return h.bodyFromTopo(b.id, b.name, fine)
  })
  return h.sendBodies(out)
})

// ---------------------------------------------------------------- face groups

export interface GroupArgs extends Base {
  action: 'generate' | 'combine' | 'separate'
  /** generate */
  method: 'fast' | 'accurate'
  angle: number
  /** combine: the groups to merge */
  groups: number[]
  /** separate: the triangles to cut out of their groups */
  tris: number[]
}
registerOp<GroupArgs, Body>('meshGroups', (a, h) => {
  const topo = h.getTopo(a.key)
  const cr = crease(a.key)
  let ids: Uint32Array
  if (a.action === 'generate') {
    ids = groupTris(topo, a.method, a.angle).ids
  } else if (a.action === 'combine') {
    if (a.groups.length < 2) throw new Error('Pick at least two face groups to combine')
    const cur = h.groupsOf(a.key)
    const join = new Set(a.groups)
    const to = Math.min(...a.groups)
    ids = Uint32Array.from(cur, (g) => (join.has(g) ? to : g))
  } else {
    if (!a.tris.length) throw new Error('Select the triangles to separate')
    const cur = h.groupsOf(a.key)
    let top = 0
    for (const g of cur) if (g > top) top = g
    ids = cur.slice()
    // each connected patch of the selection becomes a group of its own
    const sel = new Set(a.tris)
    const T = topo.indices.length / 3
    const nv = topo.positions.length / 3
    const byEdge = new Map<number, number[]>()
    for (const t of sel) for (let k = 0; k < 3; k++) {
      const x = topo.indices[t * 3 + k], y = topo.indices[t * 3 + ((k + 1) % 3)]
      const key = x < y ? x * nv + y : y * nv + x
      const l = byEdge.get(key); if (l) l.push(t); else byEdge.set(key, [t])
    }
    const seen = new Set<number>()
    for (const s of sel) {
      if (seen.has(s) || s >= T) continue
      const g = ++top
      const stack = [s]
      seen.add(s)
      while (stack.length) {
        const t = stack.pop()!
        ids[t] = g
        for (let k = 0; k < 3; k++) {
          const x = topo.indices[t * 3 + k], y = topo.indices[t * 3 + ((k + 1) % 3)]
          for (const o of byEdge.get(x < y ? x * nv + y : y * nv + x) ?? []) if (!seen.has(o) && sel.has(o) && cur[o] === cur[s]) { seen.add(o); stack.push(o) }
        }
      }
    }
  }
  const c = compactGroups(ids)
  return h.sendBody(h.bodyFromTopo(a.id, a.name, topo, cr, c.ids))
})

// ---------------------------------------------------------------- region edits

export interface EraseArgs extends Base { tris: number[]; fill: boolean }
registerOp<EraseArgs, Body & { holes?: number }>('meshErase', (a, h) => {
  const topo = h.getTopo(a.key)
  if (!a.tris.length) throw new Error('Select the faces to remove')
  const drop = new Set(a.tris)
  const T = topo.indices.length / 3
  if (drop.size >= T) throw new Error('That would remove the whole mesh')
  const { mesh, holes } = eraseTris(topo, a.tris, a.fill)
  // face groups stay with the triangles that are left; the patch is a group of its own
  const old = h.groupsOf(a.key)
  const keep: number[] = []
  for (let t = 0; t < T; t++) if (!drop.has(t)) keep.push(old[t])
  const total = mesh.indices.length / 3
  let top = 0
  for (const g of old) if (g > top) top = g
  const groups = new Uint32Array(total)
  for (let t = 0; t < total; t++) groups[t] = t < keep.length ? keep[t] : top + 1
  const c = compactGroups(groups)
  const body = h.bodyFromTopo(a.id, a.name, mesh, crease(a.key), c.ids)
  return h.sendBody(Object.assign(body, { holes }))
})

export interface MoveFacesArgs extends Base { tris: number[]; delta: Vec3 }
registerOp<MoveFacesArgs, Body>('meshTranslateFaces', (a, h) => {
  if (!a.tris.length) throw new Error('Select the faces to move')
  const topo = h.getTopo(a.key)
  return h.sendBody(h.bodyFromTopo(a.id, a.name, translateTris(topo, a.tris, a.delta), crease(a.key), keptGroups(a.key)))
})

export interface ScaleArgs extends Base { pivot: Vec3; factors: Vec3 }
registerOp<ScaleArgs, Body>('meshScale', (a, h) => {
  if (a.factors.some((f) => !(Math.abs(f) > 1e-9))) throw new Error('A scale factor cannot be zero')
  const topo = h.getTopo(a.key)
  const flip = a.factors[0] * a.factors[1] * a.factors[2] < 0
  return h.sendBody(h.bodyFromTopo(a.id, a.name, scaleTopo(topo, a.pivot, a.factors), crease(a.key), flip ? undefined : keptGroups(a.key)))
})

// ---------------------------------------------------------------- inspection

registerOp<{ key: string }, MeshStats>('meshStats', (a, h) => statsOf(h.getTopo(a.key) as TopoMesh))

registerOp<{ key: string; normal: Vec3; offset: number }, { points: Vec3[]; closed: boolean }[]>('meshSection', (a, h) => {
  const nl = Math.hypot(...a.normal) || 1
  return sectionLoops(h.getTopo(a.key), a.normal, a.offset * nl).filter((l) => l.points.length >= 2)
})
