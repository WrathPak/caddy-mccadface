/** Worker ops for the Mesh workspace: plane cut, reduce, refine, smooth, repair and B-rep -> mesh conversion. */
import { fromManifold, initManifold, toManifold } from './mesh'
import { repairTopo, smoothTopo } from './meshutil'
import { registerOp } from './store'
import type { Body, Vec3 } from './types'

interface Base { id: string; name: string; key: string }

export interface PlaneCutArgs extends Base { normal: Vec3; offset: number; keep: 'above' | 'below' | 'both'; /** id of the second body when keep = 'both' */ otherId: string }
/** Cut at the plane `normal . p = offset`; 'above' keeps the side the normal points to. */
registerOp<PlaneCutArgs, Body[]>('meshPlaneCut', async (a, h) => {
  await initManifold()
  const man = await toManifold(h.getTopo(a.key))
  const out: Body[] = []
  const add = (m: ReturnType<typeof man.trimByPlane>, id: string, name: string) => {
    out.push(h.bodyFromTopo(id, name, fromManifold(m)))
    m.delete()
  }
  try {
    if (a.keep === 'both') {
      const [above, below] = man.splitByPlane(a.normal, a.offset)
      if (above.isEmpty() || below.isEmpty()) { above.delete(); below.delete(); throw new Error('The plane does not cut through the body') }
      add(above, a.id, a.name)
      add(below, a.otherId, a.name + ' (2)')
    } else {
      const kept = a.keep === 'above' ? man.trimByPlane(a.normal, a.offset) : man.trimByPlane([-a.normal[0], -a.normal[1], -a.normal[2]], -a.offset)
      if (kept.isEmpty()) { kept.delete(); throw new Error('The plane removes the whole body') }
      add(kept, a.id, a.name)
    }
    return h.sendBodies(out) as unknown as Body[]
  } finally {
    man.delete()
  }
})

registerOp<Base & { tolerance: number }, Body>('meshReduce', async (a, h) => {
  await initManifold()
  const man = await toManifold(h.getTopo(a.key))
  try {
    const out = man.simplify(a.tolerance)
    const topo = fromManifold(out)
    out.delete()
    return h.sendBody(h.bodyFromTopo(a.id, a.name, topo))
  } finally {
    man.delete()
  }
})

registerOp<Base & { length: number }, Body>('meshRefine', async (a, h) => {
  await initManifold()
  if (!(a.length > 0)) throw new Error('The target edge length must be greater than zero')
  const man = await toManifold(h.getTopo(a.key))
  try {
    const out = man.refineToLength(a.length)
    if (out.numTri() > 2_000_000) { out.delete(); throw new Error('That edge length would create more than 2 million triangles; use a larger length') }
    const topo = fromManifold(out)
    out.delete()
    return h.sendBody(h.bodyFromTopo(a.id, a.name, topo))
  } finally {
    man.delete()
  }
})

registerOp<Base & { iterations: number; strength: number }, Body>('meshSmooth', (a, h) => {
  const topo = smoothTopo(h.getTopo(a.key), Math.max(1, Math.round(a.iterations)), a.strength)
  return h.sendBody(h.bodyFromTopo(a.id, a.name, topo))
})

export interface RepairResult { body: Body; report: { welded: number; degenerate: number; duplicates: number; holesFilled: number } }
registerOp<Base & { tolerance: number }, RepairResult>('meshRepair', async (a, h) => {
  await initManifold()
  const { mesh, report } = repairTopo(h.getTopo(a.key), a.tolerance)
  // a manifold round trip rejects anything that is still not a valid closed solid
  const man = await toManifold(mesh)
  try {
    if (man.isEmpty() || man.status() !== 'NoError') throw new Error('The mesh could not be repaired automatically (non-manifold or self-intersecting geometry remains)')
    return { body: h.sendBody(h.bodyFromTopo(a.id, a.name, fromManifold(man))), report }
  } finally {
    man.delete()
  }
})

registerOp<Base, Body>('meshConvert', (a, h) => h.sendBody(h.bodyFromTopo(a.id, a.name, h.getTopo(a.key))))
