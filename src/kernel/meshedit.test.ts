/** Mesh editing algorithms (pure, run in Node). */
import { describe, expect, it } from 'vitest'
import { weld } from './bigmesh'
import { boundaryLoops, clipTopo, eraseTris, groupTris, meanEdgeLength, reduceTopo, refineInPlane, remeshTopo, scaleTopo, sectionLoops, statsOf, translateTris } from './meshedit'
import type { TopoMesh } from './types'

type P = [number, number, number]
function boxSoup(w: number, d: number, h: number, n: number): number[] {
  const out: number[] = []
  const faces: [P, P, P][] = [
    [[0, 0, 0], [0, d, 0], [w, 0, 0]], [[0, 0, h], [w, 0, 0], [0, d, 0]], [[0, 0, 0], [w, 0, 0], [0, 0, h]],
    [[0, d, 0], [0, 0, h], [w, 0, 0]], [[0, 0, 0], [0, 0, h], [0, d, 0]], [[w, 0, 0], [0, d, 0], [0, 0, h]],
  ]
  for (const [o, u, v] of faces) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = (a: number, b: number): P => [o[0] + (u[0] * a + v[0] * b) / n, o[1] + (u[1] * a + v[1] * b) / n, o[2] + (u[2] * a + v[2] * b) / n]
    out.push(...p(i, j), ...p(i + 1, j), ...p(i + 1, j + 1), ...p(i, j), ...p(i + 1, j + 1), ...p(i, j + 1))
  }
  return out
}
const box = (n: number, w = 40, d = 30, h = 20): TopoMesh => weld(boxSoup(w, d, h, n))
function sphere(r: number, seg = 48, rings = 24): TopoMesh {
  const P = (i: number, j: number): P => {
    const th = (Math.PI * j) / rings, ph = (2 * Math.PI * (i % seg)) / seg
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)]
  }
  const s: number[] = []
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    if (j > 0) s.push(...P(i, j), ...P(i, j + 1), ...P(i + 1, j))
    if (j < rings - 1) s.push(...P(i + 1, j), ...P(i, j + 1), ...P(i + 1, j + 1))
  }
  return weld(s)
}
const near = (a: number, b: number, rel: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(b) * rel)

describe('mesh stats', () => {
  it('a closed box is manifold with one shell', () => {
    const s = statsOf(box(2))
    expect(s.manifold).toBe(true)
    expect(s.openEdges).toBe(0)
    expect(s.shells).toBe(1)
    near(s.volume, 24000, 1e-6)
    near(s.area, 2 * (1200 + 800 + 600), 1e-6)
  })
  it('counts open edges and flipped patches', () => {
    const b = box(2)
    const open = { positions: b.positions, indices: b.indices.slice(3) }
    expect(statsOf(open).openEdges).toBeGreaterThan(0)
    const idx = b.indices.slice()
    for (let t = 0; t < 6; t++) { const x = idx[t * 3 + 1]; idx[t * 3 + 1] = idx[t * 3 + 2]; idx[t * 3 + 2] = x }
    expect(statsOf({ positions: b.positions, indices: idx }).manifold).toBe(false)
  })
})

describe('reduce', () => {
  it('goes to a triangle count and stays closed', () => {
    const s = sphere(20)
    const before = s.indices.length / 3
    const r = reduceTopo(s, { mode: 'count', target: before / 2, preserveBoundaries: true, preserveSharp: false })
    const st = statsOf(r)
    expect(r.indices.length / 3).toBeLessThanOrEqual(before / 2 + 2)
    expect(r.indices.length / 3).toBeGreaterThan(before / 2 - 40)
    expect(st.openEdges).toBe(0)
    expect(st.nonManifoldEdges).toBe(0)
    near(st.volume, statsOf(s).volume, 0.03)
  })
  it('by tolerance on a sphere: under half the triangles, volume within 2 percent', () => {
    const s = sphere(20, 64, 32)
    const r = reduceTopo(s, { mode: 'tolerance', tolerance: 0.5, preserveBoundaries: true, preserveSharp: true })
    const st = statsOf(r)
    expect(r.indices.length / 3).toBeLessThan((s.indices.length / 3) * 0.5)
    near(st.volume, statsOf(s).volume, 0.02)
    expect(st.openEdges).toBe(0)
  })
  it('keeps the corners and edges of a box when sharp edges are preserved', () => {
    const b = box(6)
    const r = reduceTopo(b, { mode: 'tolerance', tolerance: 0.05, preserveBoundaries: true, preserveSharp: true })
    const st = statsOf(r)
    expect(r.indices.length / 3).toBeLessThan(b.indices.length / 3)
    near(st.volume, 24000, 1e-4)
    expect(st.bounds.max).toEqual([40, 30, 20])
  })
  it('leaves an open boundary alone when asked', () => {
    const b = box(4)
    const open = { positions: b.positions, indices: b.indices.slice(0, b.indices.length - 6) }
    const key = (t: TopoMesh, v: number) => [...t.positions.subarray(v * 3, v * 3 + 3)].join()
    const before = new Set(boundaryLoops(open).flat().map((v) => key(open, v)))
    const r = reduceTopo(open, { mode: 'count', target: 30, preserveBoundaries: true, preserveSharp: false })
    const after = new Set(boundaryLoops(r).flat().map((v) => key(r, v)))
    for (const v of before) expect(after.has(v)).toBe(true)
  })
})

describe('remesh', () => {
  it('uniform: a box keeps its size and corners', () => {
    const r = remeshTopo(box(1), { type: 'uniform', length: 5, density: 1, preserveSharp: true, preserveBoundaries: true })
    const st = statsOf(r)
    expect(st.manifold).toBe(true)
    near(st.volume, 24000, 0.003)
    expect(st.bounds.max[0]).toBeCloseTo(40, 3)
    expect(r.indices.length / 3).toBeGreaterThan(200)
    expect(meanEdgeLength(r)).toBeLessThan(8)
  })
  it('uniform: a sphere stays closed and round', () => {
    const s = sphere(20, 32, 16)
    const r = remeshTopo(s, { type: 'uniform', length: 3.5, density: 1, preserveSharp: false, preserveBoundaries: true })
    const st = statsOf(r)
    expect(st.openEdges).toBe(0)
    expect(st.manifold).toBe(true)
    near(st.volume, statsOf(s).volume, 0.04)
  })
  it('density: twice the density gives more triangles', () => {
    const s = sphere(20, 32, 16)
    const r = remeshTopo(s, { type: 'density', length: 1, density: 2, preserveSharp: false, preserveBoundaries: true })
    const n = r.indices.length / 3, n0 = s.indices.length / 3
    expect(n).toBeGreaterThan(n0 * 1.3)
    expect(n).toBeLessThan(n0 * 3.5)
    expect(statsOf(r).manifold).toBe(true)
  })
  it('adaptive stays a valid mesh', () => {
    const r = remeshTopo(box(2), { type: 'adaptive', length: 6, density: 1, preserveSharp: false, preserveBoundaries: true })
    expect(statsOf(r).manifold).toBe(true)
  })
})

describe('plane clip', () => {
  it('no cap: the cut leaves an open mesh', () => {
    const c = clipTopo(box(2), [0, 0, 1], 10, true)
    const st = statsOf(c)
    expect(st.openEdges).toBeGreaterThan(0)
    expect(st.bounds.min[2]).toBeCloseTo(10, 4)
  })
  it('refines the triangles that lie in a plane', () => {
    const b = box(1)
    const r = refineInPlane(b, [0, 0, 1], 20, 5)
    expect(r.indices.length / 3).toBeGreaterThan(b.indices.length / 3 + 20)
    expect(statsOf(r).manifold).toBe(true)
    near(statsOf(r).volume, 24000, 1e-6)
  })
})

describe('section', () => {
  it('a box gives one closed rectangle', () => {
    const l = sectionLoops(box(2), [0, 0, 1], 10)
    expect(l.length).toBe(1)
    expect(l[0].closed).toBe(true)
    expect(Math.max(...l[0].points.map((p) => p[0]))).toBeCloseTo(40, 4)
  })
  it('a plane through the vertices of the mesh still closes the outline', () => {
    const l = sectionLoops(box(4), [0, 0, 1], 10)
    expect(l.length).toBe(1)
    expect(l[0].closed).toBe(true)
  })
  it('a tilted plane works', () => {
    expect(sectionLoops(box(2), [1, 0, 1], 25).length).toBe(1)
  })
})

describe('face groups', () => {
  it('fast: a box is six groups', () => {
    expect(groupTris(box(2), 'fast', 20).count).toBe(6)
  })
  it('accurate cuts a smooth sphere into patches', () => {
    expect(groupTris(sphere(20, 48, 24), 'accurate', 15).count).toBeGreaterThan(4)
    expect(groupTris(sphere(20, 48, 24), 'fast', 20).count).toBe(1)
  })
})

describe('region edits', () => {
  const top = (b: TopoMesh) => { const t: number[] = []; for (let i = 0; i < b.indices.length / 3; i++) if ([0, 1, 2].every((k) => b.positions[b.indices[i * 3 + k] * 3 + 2] === 20)) t.push(i); return t }
  it('delete leaves a hole', () => {
    const b = box(2)
    expect(statsOf(eraseTris(b, top(b), false).mesh).openEdges).toBeGreaterThan(0)
  })
  it('erase and fill closes it again', () => {
    const b = box(2)
    const r = eraseTris(b, top(b), true)
    const st = statsOf(r.mesh)
    expect(r.holes).toBe(1)
    expect(st.openEdges).toBe(0)
    expect(st.manifold).toBe(true)
    near(st.volume, 24000, 0.02)
  })
  it('erase and fill on the cap of a sphere keeps it closed', () => {
    const s = sphere(20, 32, 16)
    const t: number[] = []
    for (let i = 0; i < s.indices.length / 3; i++) { const z = (s.positions[s.indices[i * 3] * 3 + 2] + s.positions[s.indices[i * 3 + 1] * 3 + 2] + s.positions[s.indices[i * 3 + 2] * 3 + 2]) / 3; if (z > 16) t.push(i) }
    const st = statsOf(eraseTris(s, t, true).mesh)
    expect(st.openEdges).toBe(0)
    expect(st.manifold).toBe(true)
  })
  it('translate stretches the neighbours', () => {
    const b = box(1)
    near(statsOf(translateTris(b, top(b), [0, 0, 5])).volume, 40 * 30 * 25, 1e-6)
  })
  it('non-uniform scale', () => {
    near(statsOf(scaleTopo(box(1), [0, 0, 0], [2, 1, 0.5])).volume, 24000, 1e-6)
    expect(statsOf(scaleTopo(box(1), [0, 0, 0], [-1, 1, 1])).volume).toBeGreaterThan(0)
  })
})
