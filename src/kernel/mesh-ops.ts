/** Worker ops for the Mesh workspace: plane cut, reduce, refine, smooth, repair, reverse, delete faces, shell and B-rep conversion. */
import { fromManifold, initManifold, NotClosedError, toManifold } from './mesh'
import { segmentFaces, topoVolume } from './meshutil'
import { weld } from './bigmesh'
import { cleanTriangles, clipByPlane, deleteFaceGroups, fillHolesTopo, orientTopo, removeSmallShells, reverseTopo, shellTopo, smoothTopoKeep } from './meshfix'
import { voxelRebuild } from './meshvox'
import './mesh-brep'
import { getStored, registerOp, type OpHelpers } from './store'
import type { Body, TopoMesh, Vec3 } from './types'

interface Base { id: string; name: string; key: string }

export interface PlaneCutArgs extends Base { normal: Vec3; offset: number; keep: 'above' | 'below' | 'both'; /** id of the second body when keep = 'both' */ otherId: string }

/** A mesh that is not closed cannot go through manifold: it is trimmed triangle by triangle and the cut is left open. */
function openPlaneCut(a: PlaneCutArgs, topo: TopoMesh, h: OpHelpers): Body[] {
  const part = (side: 1 | -1) => clipByPlane(topo, a.normal, a.offset, side)
  const out: Body[] = []
  const add = (t: TopoMesh, id: string, name: string) => out.push(h.bodyFromTopo(id, name, t))
  if (a.keep === 'both') {
    const up = part(1), down = part(-1)
    if (!up.indices.length || !down.indices.length) throw new Error('The plane does not cut through the body')
    add(up, a.id, a.name)
    add(down, a.otherId, a.name + ' (2)')
  } else {
    const kept = part(a.keep === 'above' ? 1 : -1)
    if (!kept.indices.length) throw new Error('The plane removes the whole body')
    add(kept, a.id, a.name)
  }
  ;(out[0] as Body & { note?: string }).note = 'This mesh is open (it has holes or flipped triangles), so the cut was trimmed and left open instead of capped. Run Repair first if you need it closed.'
  return h.sendBodies(out) as unknown as Body[]
}

/** Cut at the plane `normal . p = offset`; 'above' keeps the side the normal points to. An open mesh is trimmed and left uncapped, like Fusion. */
registerOp<PlaneCutArgs, Body[]>('meshPlaneCut', async (a, h) => {
  await initManifold()
  let man: Awaited<ReturnType<typeof toManifold>>
  try {
    man = await toManifold(h.getTopo(a.key))
  } catch (e) {
    if (e instanceof NotClosedError) return openPlaneCut(a, h.getTopo(a.key), h)
    throw e
  }
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

export interface SmoothArgs extends Base { iterations: number; strength: number; preserveBoundary?: boolean; preserveSharp?: boolean; /** face groups to smooth (all when empty) */ faces?: number[] }
registerOp<SmoothArgs, Body>('meshSmooth', (a, h) => {
  const topo = h.getTopo(a.key)
  const st = getStored(a.key)
  const crease = st.kind === 'mesh' ? st.crease : 20
  let triMask: Uint8Array | undefined
  if (a.faces?.length) {
    const ids = segmentFaces(topo, crease).faceIds
    const want = new Set(a.faces)
    triMask = new Uint8Array(ids.length)
    for (let t = 0; t < ids.length; t++) triMask[t] = want.has(ids[t]) ? 1 : 0
  }
  const out = smoothTopoKeep(topo, Math.max(1, Math.round(a.iterations)), a.strength, { preserveBoundary: a.preserveBoundary ?? true, preserveSharp: a.preserveSharp ?? true, triMask })
  return h.sendBody(h.bodyFromTopo(a.id, a.name, out, crease))
})

export type RepairType = 'closed' | 'holes' | 'stitch' | 'remove' | 'wrap' | 'rebuild'
export interface RepairReport {
  type: RepairType
  welded: number
  degenerate: number
  duplicates: number
  holesFilled: number
  shellsRemoved: number
  facesFlipped: number
  /** wrap / rebuild: the voxel size used, mm */
  voxel?: number
}
export interface RepairResult { body: Body; report: RepairReport }
export interface RepairArgs extends Base {
  tolerance: number
  type?: RepairType
  /** Remove: shells smaller than this percent of the largest are dropped */
  minShell?: number
  /** Wrap / Rebuild: voxel size in mm (0 = automatic) and the widest gap to seal (0 = about two voxels) */
  voxel?: number
  gap?: number
}

registerOp<RepairArgs, RepairResult>('meshRepair', async (a, h) => {
  await initManifold()
  const type: RepairType = a.type ?? 'closed'
  const src = h.getTopo(a.key)
  const report: RepairReport = { type, welded: 0, degenerate: 0, duplicates: 0, holesFilled: 0, shellsRemoved: 0, facesFlipped: 0 }
  const need = async (t: TopoMesh, what: string) => {
    try { (await toManifold(t)).delete() } catch (e) { if (e instanceof NotClosedError) throw new Error(what); throw e }
  }
  let mesh: TopoMesh
  if (type === 'wrap' || type === 'rebuild') {
    const w = weld(src.positions, src.indices, Math.max(a.tolerance, 1e-9))
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < w.positions.length; i += 3) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], w.positions[i + d]); hi[d] = Math.max(hi[d], w.positions[i + d]) }
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    const res = voxelRebuild(w, { voxel: a.voxel && a.voxel > 0 ? a.voxel : size / 120, gap: a.gap ?? 0, keepCavities: type === 'rebuild' })
    if (!res.mesh.indices.length) throw new Error(`${type === 'wrap' ? 'Wrap' : 'Rebuild'} found no solid: the surface has gaps wider than the grid seals. Raise Gap to close, or use a larger voxel size`)
    mesh = res.mesh
    report.voxel = res.voxel
    await need(mesh, 'The rebuilt surface is not manifold; try a different voxel size')
  } else {
    const before = src.positions.length / 3
    const w = weld(src.positions, src.indices, Math.max(a.tolerance, 1e-9))
    report.welded = before - w.positions.length / 3
    let cur: TopoMesh = w
    const c = cleanTriangles(cur)
    cur = c.mesh
    report.degenerate = src.indices.length / 3 - w.indices.length / 3 + c.degenerate
    report.duplicates = c.duplicates
    if (type === 'remove') {
      const r = removeSmallShells(cur, a.minShell ?? 5)
      cur = r.mesh
      report.shellsRemoved = r.removed
    } else {
      const o = orientTopo(cur)
      cur = o.mesh
      report.facesFlipped = o.report.flipped
      if (type === 'closed' || type === 'holes') {
        const f = fillHolesTopo(cur)
        cur = f.mesh
        report.holesFilled = f.filled
        if (f.filled) { const o2 = orientTopo(cur); cur = o2.mesh; report.facesFlipped += o2.report.flipped }
      }
      if (type === 'closed') await need(cur, 'This mesh could not be closed by filling holes: edges shared by three or more triangles or self-intersections remain. Use Repair type Wrap or Rebuild, which build a clean closed mesh from it')
    }
    mesh = cur
  }
  if (!mesh.indices.length) throw new Error('Nothing is left of the mesh')
  return { body: h.sendBody(h.bodyFromTopo(a.id, a.name, mesh)), report }
})

registerOp<Base, Body>('meshReverse', (a, h) => h.sendBody(h.bodyFromTopo(a.id, a.name, reverseTopo(h.getTopo(a.key)))))

/** Remove face groups of a mesh (numbered like the display faces), leaving an open mesh: the shared op behind Delete on selected mesh faces. */
export interface MeshDeleteFacesArgs extends Base { faces: number[] }
registerOp<MeshDeleteFacesArgs, Body>('meshDeleteFaces', (a, h) => {
  const st = getStored(a.key)
  if (st.kind !== 'mesh') throw new Error('Delete Faces on a mesh needs a mesh body')
  if (!a.faces.length) throw new Error('Select the faces to delete')
  const r = deleteFaceGroups(st.topo, st.crease, a.faces)
  if (!r.removed) throw new Error('Those faces are no longer on the mesh')
  if (!r.mesh.indices.length) throw new Error('That would delete the whole mesh')
  return h.sendBody(h.bodyFromTopo(a.id, a.name, r.mesh, st.crease))
})

export interface MeshShellArgs extends Base { thickness: number; faces: number[]; outward: boolean }
/** Hollow a closed mesh with a true offset wall; picked faces become openings. */
registerOp<MeshShellArgs, Body>('meshShell', async (a, h) => {
  const st = getStored(a.key)
  if (st.kind !== 'mesh') throw new Error('Mesh Shell needs a mesh body')
  if (!(a.thickness > 0)) throw new Error('The wall thickness must be greater than zero')
  await initManifold()
  try { (await toManifold(st.topo)).delete() } catch (e) { if (e instanceof NotClosedError) throw new Error('A mesh must be closed to be hollowed. Run Mesh > Repair (Make Closed Mesh) on it first.'); throw e }
  const T = st.topo.indices.length / 3
  let opened: Uint8Array | null = null
  if (a.faces.length) {
    const ids = T > 400_000 ? new Uint32Array(T) : segmentFaces(st.topo, st.crease).faceIds
    const want = new Set(a.faces)
    opened = new Uint8Array(T)
    for (let t = 0; t < T; t++) opened[t] = want.has(ids[t]) ? 1 : 0
    if (opened.every((x) => x)) throw new Error('Every face is picked to be removed; leave at least one face to give the wall')
  }
  const out = shellTopo(st.topo, a.thickness, opened, a.outward, st.crease)
  try { (await toManifold(out)).delete() } catch (e) { if (e instanceof NotClosedError) throw new Error('The wall could not be built from this mesh. It is probably thicker than the narrowest part: try a smaller thickness'); throw e }
  const v = topoVolume(out), v0 = topoVolume(st.topo)
  if (!(v > 0) || (!a.outward && v >= v0)) throw new Error('The wall folds over itself at the narrowest part of the mesh: try a smaller thickness')
  return h.sendBody(h.bodyFromTopo(a.id, a.name, out))
})

registerOp<Base, Body>('meshConvert', (a, h) => h.sendBody(h.bodyFromTopo(a.id, a.name, h.getTopo(a.key))))
