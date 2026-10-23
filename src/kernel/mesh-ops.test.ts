/** Mesh workspace ops (manifold + pure helpers), run directly in Node. */
import { beforeAll, describe, expect, it } from 'vitest'
import { box, initOcc } from './occ'
import { initManifold } from './mesh'
import { bodyFromShape, bodyFromTopo, getOp, getTopo, helpers } from './store'
import { repairTopo, smoothTopo, topoVolume } from './meshutil'
import type { Body, TopoMesh } from './types'
import './mesh-ops'
import type { RepairResult } from './mesh-ops'

const run = async <T = Body>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T
const vol = (b: Body) => Math.abs(topoVolume(getTopo(b.key)))
const tris = (b: Body) => getTopo(b.key).indices.length / 3
const near = (a: number, b: number, rel = 1e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))

function cube(s = 10): TopoMesh {
  const positions = new Float32Array(24)
  for (let i = 0; i < 8; i++) positions.set([(i & 1) * s, ((i >> 1) & 1) * s, ((i >> 2) & 1) * s], i * 3)
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
  const idx: number[] = []
  for (const q of quads) idx.push(q[0], q[1], q[2], q[0], q[2], q[3])
  return { positions, indices: Uint32Array.from(idx) }
}
function sphere(r: number, rings = 14, segs = 24): TopoMesh {
  const pos: number[] = [0, 0, -r, 0, 0, r]
  for (let i = 1; i < rings; i++) {
    const phi = (Math.PI * i) / rings - Math.PI / 2
    for (let j = 0; j < segs; j++) pos.push(r * Math.cos(phi) * Math.cos((2 * Math.PI * j) / segs), r * Math.cos(phi) * Math.sin((2 * Math.PI * j) / segs), r * Math.sin(phi))
  }
  const v = (i: number, j: number) => 2 + (i - 1) * segs + (j % segs)
  const idx: number[] = []
  for (let j = 0; j < segs; j++) {
    idx.push(0, v(1, j + 1), v(1, j))
    idx.push(1, v(rings - 1, j), v(rings - 1, j + 1))
    for (let i = 1; i < rings - 1; i++) idx.push(v(i, j), v(i, j + 1), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i + 1, j))
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}
const meshBody = (t: TopoMesh, id = 'm') => bodyFromTopo(id, id, t)
const base = (b: Body) => ({ id: 'o', name: 'o', key: b.key })

beforeAll(async () => { await Promise.all([initOcc(), initManifold()]) })

describe('plane cut', () => {
  it('keeps one side or splits into two bodies', async () => {
    const b = meshBody(cube())
    const above = (await run<Body[]>('meshPlaneCut', { ...base(b), normal: [1, 0, 0], offset: 4, keep: 'above', otherId: 'o2' }))[0]
    near(vol(above), 600)
    const below = (await run<Body[]>('meshPlaneCut', { ...base(b), normal: [1, 0, 0], offset: 4, keep: 'below', otherId: 'o2' }))[0]
    near(vol(below), 400)
    const both = await run<Body[]>('meshPlaneCut', { ...base(b), normal: [0, 0, 1], offset: 5, keep: 'both', otherId: 'o2' })
    expect(both.map((x) => x.id)).toEqual(['o', 'o2'])
    near(vol(both[0]) + vol(both[1]), 1000)
    near(vol(both[0]), 500)
  })
  it('also cuts a B-rep (result is a mesh body) and rejects a plane that misses', async () => {
    const solid = bodyFromShape('s', 's', box([10, 10, 10], [0, 0, 0]))
    const out = (await run<Body[]>('meshPlaneCut', { ...base(solid), normal: [0, 1, 0], offset: 0, keep: 'above', otherId: 'o2' }))[0]
    expect(out.kind).toBe('mesh')
    near(vol(out), 500)
    await expect(run('meshPlaneCut', { ...base(meshBody(cube())), normal: [1, 0, 0], offset: 50, keep: 'both', otherId: 'o2' })).rejects.toThrow()
  })
})

describe('refine / reduce', () => {
  it('refine splits long edges; reduce merges coplanar triangles again', async () => {
    const b = meshBody(cube())
    const fine = await run('meshRefine', { ...base(b), length: 3 })
    expect(tris(fine)).toBeGreaterThan(100)
    near(vol(fine), 1000)
    const small = await run('meshReduce', { ...base(fine), tolerance: 0.001 })
    expect(tris(small)).toBeLessThan(tris(fine) / 4)
    near(vol(small), 1000, 1e-2)
  })
})

describe('smooth', () => {
  it('Taubin smoothing relaxes a rough surface without shrinking it', () => {
    const s = sphere(10)
    // roughen: push every vertex in or out
    const rough = { positions: s.positions.slice(), indices: s.indices }
    for (let i = 2; i < rough.positions.length / 3; i++) {
      const k = 1 + (i % 2 ? 0.06 : -0.06)
      for (let c = 0; c < 3; c++) rough.positions[i * 3 + c] *= k
    }
    const roughness = (t: TopoMesh) => {
      let m = 0
      for (let i = 2; i < t.positions.length / 3; i++) m = Math.max(m, Math.abs(Math.hypot(t.positions[i * 3], t.positions[i * 3 + 1], t.positions[i * 3 + 2]) - 10))
      return m
    }
    const out = smoothTopo(rough, 12, 1)
    expect(roughness(out)).toBeLessThan(roughness(rough) * 0.5)
    near(topoVolume(out), topoVolume(rough), 0.04)
  })
  it('the op returns a mesh body with the same triangle count', async () => {
    const b = meshBody(sphere(10))
    const out = await run('meshSmooth', { ...base(b), iterations: 4, strength: 0.5 })
    expect(tris(out)).toBe(tris(b))
  })
})

describe('repair', () => {
  it('welds a triangle soup, drops duplicates and closes an open hole', async () => {
    const c = cube()
    // open the top face (triangles 2 and 3 of the 6 quads) and add a duplicate triangle
    const keep = Array.from(c.indices).slice(0, 2 * 3).concat(Array.from(c.indices).slice(4 * 3))
    keep.push(keep[0], keep[1], keep[2])
    // unwelded soup with a little noise on the vertices
    const pos: number[] = []
    keep.forEach((v) => pos.push(c.positions[v * 3] + 1e-4, c.positions[v * 3 + 1], c.positions[v * 3 + 2]))
    const soup: TopoMesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(keep.map((_, i) => i)) }
    const { mesh, report } = repairTopo(soup, 1e-2)
    expect(report.holesFilled).toBe(1)
    expect(report.duplicates).toBe(1)
    expect(report.welded).toBeGreaterThan(0)
    near(Math.abs(topoVolume(mesh)), 1000, 1e-3)
    // through the op (includes the manifold validity check)
    const b = bodyFromTopo('soup', 'soup', soup)
    const r = await run<RepairResult>('meshRepair', { ...base(b), tolerance: 1e-2 })
    near(vol(r.body), 1000, 1e-3)
    expect(r.report.holesFilled).toBe(1)
  })
  it('refuses geometry that stays non-manifold', async () => {
    const t = cube()
    // a fin: one extra triangle glued to an edge makes that edge non-manifold
    const bad: TopoMesh = { positions: Float32Array.from([...t.positions, 20, 20, 20]), indices: Uint32Array.from([...t.indices, 0, 1, 8]) }
    await expect(run('meshRepair', { ...base(bodyFromTopo('bad', 'bad', bad)), tolerance: 1e-4 })).rejects.toThrow()
  })
})

describe('convert', () => {
  it('B-rep -> mesh body keeps the volume', async () => {
    const solid = bodyFromShape('s', 's', box([10, 20, 30], [0, 0, 0]))
    const m = await run('meshConvert', base(solid))
    expect(m.kind).toBe('mesh')
    near(vol(m), 6000)
  })
})
