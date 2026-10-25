import { describe, expect, it } from 'vitest'
import { Pool, poolSize } from './pool'
import { computeApi, importMesh } from './compute'
import { toManifold } from './mesh'
import { topoVolume } from './meshutil'
import { writeStl } from '../io/stl'
import { heightfield } from './testMesh'
import type { TopoMesh } from './types'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Pool', () => {
  it('runs at most `size` jobs at once and queues the rest', async () => {
    let spawned = 0
    const pool = new Pool<{ id: number }>({ size: 3, spawn: () => ({ client: { id: spawned++ }, terminate: () => {} }) })
    let live = 0, peak = 0
    const out = await pool.map([1, 2, 3, 4, 5, 6, 7], async (_w, n) => {
      peak = Math.max(peak, ++live)
      await tick(15)
      live--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(3)
    expect(pool.peak).toBe(3)
    expect(spawned).toBe(3)
  })

  it('creates workers lazily and reuses an idle one', async () => {
    let spawned = 0
    const pool = new Pool<number>({ size: 4, spawn: () => ({ client: spawned++, terminate: () => {} }) })
    await pool.run(async () => 1)
    await pool.run(async () => 2)
    expect(spawned).toBe(1)
  })

  it('a failing job frees its worker', async () => {
    const pool = new Pool<number>({ size: 1, spawn: () => ({ client: 0, terminate: () => {} }) })
    await expect(pool.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await pool.run(async () => 5)).toBe(5)
  })

  it('terminates its workers on dispose', async () => {
    let stopped = 0
    const pool = new Pool<number>({ size: 2, spawn: () => ({ client: 0, terminate: () => { stopped++ } }) })
    await Promise.all([pool.run(async () => tick(5)), pool.run(async () => tick(5))])
    pool.dispose()
    expect(stopped).toBe(2)
  })

  it('leaves one core for the main thread', () => {
    expect(poolSize(8)).toBe(7)
    expect(poolSize(2)).toBe(1)
    expect(poolSize(1)).toBe(1)
    expect(poolSize(64)).toBe(8)
  })
})

describe('compute api', () => {
  it('imports an STL end to end: welded topology plus display data', async () => {
    const t = heightfield(20)
    const parts = await importMesh({ source: writeStl([t]), format: 'stl', scale: 2, creaseDeg: 20 })
    expect(parts).toHaveLength(1)
    expect(parts[0].topo.positions.length / 3).toBe(21 * 21)
    expect(parts[0].topo.indices.length / 3).toBe(800)
    expect(parts[0].display.faceIds.length).toBe(parts[0].display.indices.length / 3)
    expect(parts[0].topo.positions[3]).toBeCloseTo(t.positions[3] * 2, 4)
  })

  it('decimates through the api', async () => {
    const t = heightfield(100)
    const lod = await computeApi.lod({ positions: t.positions, indices: t.indices, target: 3000 })
    expect(lod.indices.length / 3).toBeGreaterThan(1000)
    expect(lod.indices.length / 3).toBeLessThan(6000)
  })

  it('independent mesh booleans give the same answers in parallel as one after another', async () => {
    const box = (s: number, o: number): TopoMesh => {
      const positions = new Float32Array(24)
      for (let i = 0; i < 8; i++) positions.set([(i & 1) * s + o, ((i >> 1) & 1) * s + o, ((i >> 2) & 1) * s + o], i * 3)
      const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
      const idx: number[] = []
      for (const q of quads) idx.push(q[0], q[1], q[2], q[0], q[2], q[3])
      return { positions, indices: Uint32Array.from(idx) }
    }
    const jobs = [0, 1, 2, 3].map((k) => ({ op: 'subtract' as const, base: box(10, 0), tools: [box(5, 3 + k)] }))
    const pool = new Pool<typeof computeApi>({ size: 3, spawn: () => ({ client: computeApi, terminate: () => {} }) })
    const parallel = await pool.map(jobs, (w, j) => w.meshBoolean(j))
    const serial: TopoMesh[] = []
    for (const j of jobs) serial.push(await computeApi.meshBoolean(j))
    expect(parallel.map((m) => +topoVolume(m).toFixed(3))).toEqual(serial.map((m) => +topoVolume(m).toFixed(3)))
    // 10^3 minus the part of the 5^3 tool that is inside
    expect(topoVolume(parallel[0])).toBeCloseTo(1000 - 125, 3)
    expect(topoVolume(parallel[3])).toBeCloseTo(1000 - 64, 3) // the tool sticks out of the cube there
    const m = await toManifold(parallel[0])
    expect(m.isEmpty()).toBe(false)
    m.delete()
  })
})
