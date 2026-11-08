/** Second set of mesh workspace ops (reduce / remesh types, cut fill types, face groups, region edits, stats, section, scale), run in Node. */
import { beforeAll, describe, expect, it } from 'vitest'
import { initManifold } from './mesh'
import { weld } from './bigmesh'
import { bodyFromTopo, getOp, getStored, getTopo, helpers } from './store'
import { statsOf, type MeshStats } from './meshedit'
import type { Body, TopoMesh } from './types'
import './mesh-ops'
import './mesh-ops2'

const run = async <T = Body>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T
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
const box = (n = 4): TopoMesh => weld(boxSoup(40, 30, 20, n))
const base = (b: Body) => ({ id: 'o', name: 'o', key: b.key })
const groups = (b: Body) => new Set(Array.from(b.mesh.faceIds)).size
const near = (a: number, b: number, rel = 1e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(b) * rel)

beforeAll(async () => { await initManifold() })

describe('plane cut with a fill type', () => {
  const cut = (b: Body, fill: string, extra: object = {}) => run<Body[]>('meshCut', { ...base(b), normal: [0, 0, 1], offset: 10, keep: 'above', otherId: 'o2', fill, ...extra })
  it('minimal and uniform cap the cut, uniform with more triangles', async () => {
    const b = bodyFromTopo('m', 'm', box(4))
    const [min] = await cut(b, 'minimal')
    const [uni] = await cut(b, 'uniform')
    const sm = statsOf(getTopo(min.key)), su = statsOf(getTopo(uni.key))
    expect(sm.openEdges).toBe(0)
    expect(su.openEdges).toBe(0)
    expect(su.triangles).toBeGreaterThan(sm.triangles)
    near(su.volume, 12000)
  })
  it('none leaves it open, also with both sides kept', async () => {
    const b = bodyFromTopo('m', 'm', box(4))
    const out = await cut(b, 'none', { keep: 'both' })
    expect(out).toHaveLength(2)
    for (const o of out) expect(statsOf(getTopo(o.key)).openEdges).toBeGreaterThan(0)
  })
  it('a tilted plane splits the box into 1500 and 22500', async () => {
    const b = bodyFromTopo('m', 'm', box(4))
    const s = Math.SQRT1_2
    const out = await cut(b, 'minimal', { keep: 'both', normal: [s, 0, s], offset: 10 * s })
    const v = out.map((o) => statsOf(getTopo(o.key)).volume).sort((a, c) => a - c)
    near(v[0], 1500, 0.002)
    near(v[1], 22500, 0.002)
  })
})

describe('reduce and remesh ops', () => {
  it('reduce by proportion', async () => {
    const b = bodyFromTopo('m', 'm', box(6))
    const r = await run('meshReduce2', { ...base(b), type: 'proportion', tolerance: 0.1, proportion: 50, count: 0, preserveBoundaries: true, preserveSharp: true })
    const t = getTopo(r.key)
    expect(t.indices.length / 3).toBeLessThanOrEqual(b.mesh.indices.length / 3 / 2 + 2)
    expect(statsOf(t).manifold).toBe(true)
  })
  it('refuses a target under 4 triangles', async () => {
    const b = bodyFromTopo('m', 'm', box(2))
    await expect(run('meshReduce2', { ...base(b), type: 'count', tolerance: 0.1, proportion: 50, count: 2, preserveBoundaries: true, preserveSharp: true })).rejects.toThrow(/at least 4/)
  })
  it('remesh uniform keeps the box', async () => {
    const b = bodyFromTopo('m', 'm', box(1))
    const r = await run('meshRemesh', { ...base(b), type: 'uniform', length: 5, density: 1, preserveSharp: true, preserveBoundaries: true })
    const s = statsOf(getTopo(r.key))
    expect(s.manifold).toBe(true)
    near(s.volume, 24000, 0.005)
    expect(groups(r)).toBe(6)
  })
})

describe('face groups', () => {
  it('generate, combine and separate', async () => {
    const b = bodyFromTopo('m', 'm', box(2))
    expect(groups(b)).toBe(6)
    const ids = b.mesh.faceIds
    // combine the groups of triangles 0 and the first triangle that belongs to another group
    const other = Array.from(ids).findIndex((g) => g !== ids[0])
    const c = await run('meshGroups', { ...base(b), action: 'combine', method: 'fast', angle: 20, groups: [ids[0], ids[other]], tris: [] })
    expect(groups(c)).toBe(5)
    expect(getStored(c.key)).toMatchObject({ kind: 'mesh' })
    // separate two triangles out of a group
    const s = await run('meshGroups', { ...base(c), action: 'separate', method: 'fast', angle: 20, groups: [], tris: [0, 1] })
    expect(groups(s)).toBe(6)
    // a later op keeps the groups made by hand: moving the faces does not regroup
    const m = await run('meshTranslateFaces', { ...base(s), tris: [0, 1], delta: [0, 0, 0] })
    expect(groups(m)).toBe(6)
    const g = await run('meshGroups', { ...base(s), action: 'generate', method: 'fast', angle: 20, groups: [], tris: [] })
    expect(groups(g)).toBe(6)
  })
  it('combine wants two groups', async () => {
    const b = bodyFromTopo('m', 'm', box(2))
    await expect(run('meshGroups', { ...base(b), action: 'combine', method: 'fast', angle: 20, groups: [0], tris: [] })).rejects.toThrow(/two/)
  })
})

describe('region edits, stats, section, scale', () => {
  it('erase with and without fill', async () => {
    const b = bodyFromTopo('m', 'm', box(2))
    const top = Array.from(b.mesh.faceIds).map((g, t) => [g, t]).filter(([g]) => g === b.mesh.faceIds[Array.from(b.mesh.positions).findIndex((_, i) => i % 3 === 2 && b.mesh.positions[i] === 20) / 3 | 0]).map(([, t]) => t)
    const hole = await run<Body>('meshErase', { ...base(b), tris: top, fill: false })
    expect(statsOf(getTopo(hole.key)).openEdges).toBeGreaterThan(0)
    const filled = await run<Body & { holes?: number }>('meshErase', { ...base(b), tris: top, fill: true })
    expect(filled.holes).toBe(1)
    expect(statsOf(getTopo(filled.key)).manifold).toBe(true)
    await expect(run('meshErase', { ...base(b), tris: [], fill: true })).rejects.toThrow(/Select/)
  })
  it('stats and section', async () => {
    const b = bodyFromTopo('m', 'm', box(2))
    const s = await run<MeshStats>('meshStats', { key: b.key })
    expect(s.manifold).toBe(true)
    near(s.volume, 24000)
    const l = await run<{ points: P[]; closed: boolean }[]>('meshSection', { key: b.key, normal: [0, 0, 1], offset: 10 })
    expect(l).toHaveLength(1)
    expect(l[0].closed).toBe(true)
  })
  it('non-uniform scale and a mirror', async () => {
    const b = bodyFromTopo('m', 'm', box(2))
    const s = await run('meshScale', { ...base(b), pivot: [0, 0, 0], factors: [2, 1, 0.5] })
    near(statsOf(getTopo(s.key)).volume, 24000)
    const m = await run('meshScale', { ...base(b), pivot: [0, 0, 0], factors: [-1, 1, 1] })
    expect(statsOf(getTopo(m.key)).manifold).toBe(true)
    await expect(run('meshScale', { ...base(b), pivot: [0, 0, 0], factors: [0, 1, 1] })).rejects.toThrow(/zero/)
  })
})
