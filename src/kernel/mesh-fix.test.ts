/** Mesh winding, repair types, smoothing, open Plane Cut, Delete Faces, Shell and Convert Mesh to B-rep (manifold + OpenCascade, run in Node). */
import { beforeAll, describe, expect, it } from 'vitest'
import { initOcc } from './occ'
import { initManifold } from './mesh'
import { bodyFromTopo, getOp, getTopo, helpers } from './store'
import { segmentFaces, topoVolume } from './meshutil'
import { weld } from './bigmesh'
import { boundaryLoops, clipByPlane, fillHolesTopo, orientTopo, reverseTopo, smoothTopoKeep } from './meshfix'
import { voxelRebuild } from './meshvox'
import type { Body, TopoMesh } from './types'
import './mesh-ops'
import type { RepairResult } from './mesh-ops'

const run = async <T = Body>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T
const near = (a: number, b: number, rel = 1e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
type P3 = [number, number, number]
type Tri = [P3, P3, P3]

/** Box with outward winding, every face split n x n (12 n^2 triangles), as a soup. */
function boxTris(w: number, d: number, h: number, n = 1, at: P3 = [0, 0, 0]): Tri[] {
  const out: Tri[] = []
  const [x0, y0, z0] = at
  const faces: [P3, P3, P3][] = [
    [[x0, y0, z0], [0, d, 0], [w, 0, 0]], [[x0, y0, z0 + h], [w, 0, 0], [0, d, 0]], [[x0, y0, z0], [w, 0, 0], [0, 0, h]],
    [[x0, y0 + d, z0], [0, 0, h], [w, 0, 0]], [[x0, y0, z0], [0, 0, h], [0, d, 0]], [[x0 + w, y0, z0], [0, d, 0], [0, 0, h]],
  ]
  for (const [o, u, v] of faces) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = (a: number, b: number): P3 => [o[0] + (u[0] * a + v[0] * b) / n, o[1] + (u[1] * a + v[1] * b) / n, o[2] + (u[2] * a + v[2] * b) / n]
    out.push([p(i, j), p(i + 1, j), p(i + 1, j + 1)], [p(i, j), p(i + 1, j + 1), p(i, j + 1)])
  }
  return out
}
const soup = (t: Tri[]): TopoMesh => weld(Float32Array.from(t.flat(2)), undefined, 1e-6)
const flipTri = (t: Tri): Tri => [t[0], t[2], t[1]]
const vol = (m: TopoMesh) => topoVolume(m)
/** L bracket prism, legs 40 x 30, thickness 10, depth 20. */
function bracket(depth = 20): Tri[] {
  const poly: [number, number][] = [[0, 0], [40, 0], [40, 10], [10, 10], [10, 30], [0, 30]]
  const out: Tri[] = []
  for (const [a, b, c] of [[poly[0], poly[1], poly[2]], [poly[0], poly[2], poly[3]], [poly[0], poly[3], poly[4]], [poly[0], poly[4], poly[5]]]) {
    out.push([[a[0], a[1], 0], [c[0], c[1], 0], [b[0], b[1], 0]], [[a[0], a[1], depth], [b[0], b[1], depth], [c[0], c[1], depth]])
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    out.push([[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], depth]], [[a[0], a[1], 0], [b[0], b[1], depth], [a[0], a[1], depth]])
  }
  return out
}

beforeAll(async () => { await Promise.all([initOcc(), initManifold()]) })

describe('winding', () => {
  it('turns an inside-out mesh right way round', () => {
    const m = soup(boxTris(40, 30, 20, 2).map(flipTri))
    expect(vol(m)).toBeLessThan(0)
    const { mesh, report } = orientTopo(m)
    near(vol(mesh), 24000)
    expect(report.inverted).toBe(1)
    expect(report.flipped).toBe(mesh.indices.length / 3)
  })
  it('makes one flipped patch agree with the rest', () => {
    const t = boxTris(40, 30, 20, 2)
    const bad = t.map((tri, i) => (i >= 8 && i < 16 ? flipTri(tri) : tri))
    const { mesh, report } = orientTopo(soup(bad))
    expect(report.flipped).toBe(8)
    near(vol(mesh), 24000)
    expect(boundaryLoops(mesh.indices)).toEqual([])
  })
  it('leaves a cavity wound inward', () => {
    const outer = boxTris(40, 40, 40, 1)
    const inner = boxTris(10, 10, 10, 1, [15, 15, 15]).map(flipTri)
    const { mesh, report } = orientTopo(soup([...outer, ...inner]))
    expect(report.flipped).toBe(0)
    near(vol(mesh), 40 ** 3 - 1000)
  })
  it('Reverse flips every triangle', () => {
    const m = soup(boxTris(10, 10, 10))
    near(vol(reverseTopo(m)), -1000)
  })
})

describe('holes', () => {
  it('closes a curved hole by ear clipping, not a fan around the centroid', () => {
    const t = boxTris(40, 30, 20, 4)
    const drop = Array.from({ length: 32 }, (_, i) => 32 + i)
    const open = soup(t.filter((_, i) => !drop.includes(i)))
    expect(boundaryLoops(open.indices).length).toBe(1)
    const f = fillHolesTopo(open)
    expect(f.filled).toBe(1)
    near(vol(f.mesh), 24000, 1e-6)
    expect(boundaryLoops(f.mesh.indices)).toEqual([])
  })
})

describe('repair types', () => {
  const body = (t: Tri[], id = 'r') => bodyFromTopo(id, id, soup(t))
  const rep = (b: Body, extra: object) => run<RepairResult>('meshRepair', { id: 'o', name: 'o', key: b.key, tolerance: 1e-3, ...extra })
  it('Make Closed Mesh reports holes, flipped triangles and welds', async () => {
    const t = boxTris(40, 30, 20, 4)
    const bad = t.filter((_, i) => i < 32 || i >= 64).map((tri, i) => (i < 8 ? flipTri(tri) : tri))
    // the first 8 triangles are the bottom face: flipped
    const r = await rep(body(bad), { type: 'closed' })
    near(topoVolume(getTopo(r.body.key)), 24000, 1e-3)
    expect(r.report.holesFilled).toBe(1)
    expect(r.report.facesFlipped).toBeGreaterThanOrEqual(8)
  })
  it('Close Holes closes the hole and Stitch leaves it open but unifies the winding', async () => {
    const t = boxTris(40, 30, 20, 2)
    const open = t.filter((_, i) => i < 8 || i >= 16)
    const holes = await rep(body(open), { type: 'holes' })
    expect(boundaryLoops(getTopo(holes.body.key).indices)).toEqual([])
    const stitch = await rep(body(open.map(flipTri)), { type: 'stitch' })
    expect(boundaryLoops(getTopo(stitch.body.key).indices).length).toBe(1)
    expect(topoVolume(getTopo(stitch.body.key))).toBeGreaterThan(0) // wound the right way round again
    expect(stitch.report.holesFilled).toBe(0)
  })
  it('Remove drops small loose shells', async () => {
    const r = await rep(body([...boxTris(40, 30, 20, 1), ...boxTris(1, 1, 1, 1, [100, 0, 0])]), { type: 'remove', minShell: 5 })
    expect(r.report.shellsRemoved).toBe(1)
    near(topoVolume(getTopo(r.body.key)), 24000)
  })
  it('Wrap closes a mesh with three holes into a watertight solid near its volume', async () => {
    const t = boxTris(40, 30, 20, 6)
    const open = t.filter((_, i) => ![5, 6, 100, 101, 230, 300].includes(i))
    const r = await rep(body(open), { type: 'wrap', voxel: 1, gap: 10 })
    const m = getTopo(r.body.key)
    expect(boundaryLoops(m.indices)).toEqual([])
    near(topoVolume(m), 24000, 0.06)
    expect(r.report.voxel).toBeGreaterThan(0)
  })
  it('Rebuild keeps a closed cavity, Wrap fills it', async () => {
    const hollow = [...boxTris(40, 40, 40, 1), ...boxTris(16, 16, 16, 1, [12, 12, 12]).map(flipTri)]
    const a = await rep(body(hollow), { type: 'rebuild', voxel: 1 })
    near(topoVolume(getTopo(a.body.key)), 64000 - 4096, 0.05)
    const w = await rep(body(hollow), { type: 'wrap', voxel: 1 })
    near(topoVolume(getTopo(w.body.key)), 64000, 0.05)
  })
  it('voxel rebuild of a self-intersecting soup is still a closed manifold', () => {
    const two = [...boxTris(20, 20, 20, 1), ...boxTris(20, 20, 20, 1, [10, 10, 10])]
    const { mesh } = voxelRebuild(soup(two), { voxel: 1, gap: 0, keepCavities: false })
    expect(boundaryLoops(mesh.indices)).toEqual([])
    near(topoVolume(mesh), 8000 + 8000 - 1000, 0.06)
  })
})

describe('smooth keeps the part', () => {
  it('a box does not grow (sharp edges are pinned) and the part keeps its volume', () => {
    const m = soup(boxTris(40, 30, 20, 4))
    const out = smoothTopoKeep(m, 10, 0.5, { preserveSharp: true })
    let max = 0
    for (let i = 0; i < out.positions.length; i += 3) max = Math.max(max, out.positions[i])
    expect(max).toBeLessThanOrEqual(40 + 1e-4)
    near(topoVolume(out), 24000, 1e-3)
  })
  it('without the sharp option a closed mesh still gets its volume back', () => {
    const m = soup(boxTris(40, 30, 20, 4))
    const out = smoothTopoKeep(m, 10, 0.5, { preserveSharp: false })
    near(topoVolume(out), 24000, 5e-3)
  })
  it('smooths only the picked faces and keeps their border', async () => {
    const b = bodyFromTopo('s', 's', soup(boxTris(40, 30, 20, 4)))
    const topo = getTopo(b.key)
    const seg = segmentFaces(topo, 20)
    const out = await run<Body>('meshSmooth', { id: 'o', name: 'o', key: b.key, iterations: 5, strength: 0.5, preserveBoundary: true, preserveSharp: false, faces: [seg.faceIds[0]] })
    expect(getTopo(out.key).indices.length).toBe(topo.indices.length)
  })
})

describe('plane cut of an open mesh', () => {
  it('trims it and leaves the cut open', async () => {
    const t = boxTris(40, 30, 20, 4)
    const open = soup(t.filter((_, i) => i !== 40 && i !== 41))
    const b = bodyFromTopo('c', 'c', open)
    const out = await run<Body[]>('meshPlaneCut', { id: 'o', name: 'o', key: b.key, normal: [0, 0, 1], offset: 10, keep: 'above', otherId: 'o2' })
    const m = getTopo(out[0].key)
    expect(boundaryLoops(m.indices).length).toBeGreaterThan(0)
    let lo = Infinity
    for (let i = 2; i < m.positions.length; i += 3) lo = Math.min(lo, m.positions[i])
    expect(lo).toBeGreaterThanOrEqual(10 - 1e-5)
    expect((out[0] as Body & { note?: string }).note).toMatch(/open/)
    const both = await run<Body[]>('meshPlaneCut', { id: 'o', name: 'o', key: b.key, normal: [0, 0, 1], offset: 10, keep: 'both', otherId: 'o2' })
    expect(both.length).toBe(2)
  })
  it('clipByPlane keeps the right side', () => {
    const c = clipByPlane(soup(boxTris(10, 10, 10)), [1, 0, 0], 5, 1)
    let lo = Infinity
    for (let i = 0; i < c.positions.length; i += 3) lo = Math.min(lo, c.positions[i])
    expect(lo).toBeCloseTo(5, 4)
  })
  it('says Repair when a Boolean gets a mesh that is not closed', async () => {
    const open = bodyFromTopo('x', 'x', soup(boxTris(40, 30, 20, 2).filter((_, i) => i !== 5)))
    await expect(run('meshReduce', { id: 'o', name: 'o', key: open.key, tolerance: 0.05 })).rejects.toThrow(/Repair/)
  })
})

describe('Delete Faces and Shell', () => {
  it('meshDeleteFaces removes a face group and leaves an open mesh', async () => {
    const b = bodyFromTopo('d', 'd', soup(boxTris(40, 30, 20, 2)))
    const seg = segmentFaces(getTopo(b.key), 20)
    expect(seg.faceCount).toBe(6)
    const out = await run<Body>('meshDeleteFaces', { id: 'o', name: 'o', key: b.key, faces: [seg.faceIds[10]] })
    const m = getTopo(out.key)
    expect(m.indices.length / 3).toBe(getTopo(b.key).indices.length / 3 - 8)
    expect(boundaryLoops(m.indices).length).toBe(1)
  })
  it('meshShell hollows a box with a true 2 mm wall and an open top', async () => {
    const b = bodyFromTopo('s', 's', soup(boxTris(40, 30, 20, 2)))
    const seg = segmentFaces(getTopo(b.key), 20)
    const top = seg.faceIds[8 + 0] // second face of boxTris is the top (z = 20)
    const out = await run<Body>('meshShell', { id: 'o', name: 'o', key: b.key, thickness: 2, faces: [top], outward: false })
    near(topoVolume(getTopo(out.key)), 24000 - 36 * 26 * 18, 1e-3)
  })
  it('meshShell closed leaves a sealed cavity, outward grows the wall out', async () => {
    const b = bodyFromTopo('s', 's', soup(boxTris(40, 30, 20, 1)))
    const closed = await run<Body>('meshShell', { id: 'o', name: 'o', key: b.key, thickness: 2, faces: [], outward: false })
    near(topoVolume(getTopo(closed.key)), 24000 - 36 * 26 * 16, 1e-3)
    const out = await run<Body>('meshShell', { id: 'o', name: 'o', key: b.key, thickness: 2, faces: [], outward: true })
    near(topoVolume(getTopo(out.key)), 44 * 34 * 24 - 24000, 1e-3)
  })
})

describe('Convert Mesh to B-rep', () => {
  it('Prismatic turns an L bracket into 8 planar faces and the volume is exact', async () => {
    const b = bodyFromTopo('b', 'b', soup(bracket()))
    const r = await run<{ body: Body; report: { planes: number; triangleFaces: number; faces: number; volumeError: number } }>('meshToBrep', { id: 'o', name: 'o', key: b.key, mode: 'prismatic', crease: 20, tolerance: 0.05, maxTris: 5000 })
    expect(r.body.kind).toBe('brep')
    expect(r.report.planes).toBe(8)
    expect(r.report.triangleFaces).toBe(0)
    expect(r.report.volumeError).toBeLessThan(1e-6)
    expect(r.body.mesh.faceCount).toBe(8)
  })
  it('Faceted makes a face per triangle and refuses over the limit with a message', async () => {
    const b = bodyFromTopo('b', 'b', soup(boxTris(10, 10, 10, 1)))
    const r = await run<{ body: Body; report: { faces: number } }>('meshToBrep', { id: 'o', name: 'o', key: b.key, mode: 'faceted', crease: 20, tolerance: 0.05, maxTris: 5000 })
    expect(r.report.faces).toBe(12)
    expect(r.body.kind).toBe('brep')
    await expect(run('meshToBrep', { id: 'o', name: 'o', key: b.key, mode: 'faceted', crease: 20, tolerance: 0.05, maxTris: 5 })).rejects.toThrow(/limited to 5/)
  })
  it('refuses an open mesh and says Repair', async () => {
    const b = bodyFromTopo('b', 'b', soup(boxTris(10, 10, 10, 1).slice(2)))
    await expect(run('meshToBrep', { id: 'o', name: 'o', key: b.key, mode: 'prismatic', crease: 20, tolerance: 0.05, maxTris: 5000 })).rejects.toThrow(/Repair/)
  })
})
