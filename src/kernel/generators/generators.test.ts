import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import { GEN_SCHEMAS, FUR_PRESETS, GRASS_PRESETS, SCALE_PRESETS, SPIKE_PRESETS } from '../../features/detail/genSchema'
import { schemaDefaults, type ParamValue } from '../../ui/schema'
import { initManifold } from '../mesh'
import { buildGenSolids, generateSurface } from './generate'
import { fitPatch, uvOf } from './param'
import type { GenKind } from './params'
import { prepSurface } from '../../features/hair/sampling'
import { cube, cylinder, meshOf, split, type Soup } from './testkit'

let W: ManifoldToplevel
const owned: Manifold[] = []
const own = (m: Manifold) => (owned.push(m), m)
beforeAll(async () => { W = await initManifold() })
afterAll(() => { for (const m of owned) m.delete() })

const paramsOf = (kind: GenKind, over: Record<string, ParamValue> = {}) => ({ ...schemaDefaults(GEN_SCHEMAS[kind]), ...over })

interface Setup { body: Manifold; region: Soup; others: Soup }
function topOfCube(): Setup {
  const body = own(cube(W, [40, 40, 20]))
  const { region, others } = split(meshOf(body), (n) => n[2] > 0.99)
  return { body, region, others }
}
function sideOfCube(): Setup {
  const body = own(cube(W, [40, 40, 30]))
  const { region, others } = split(meshOf(body), (n) => n[0] > 0.99)
  return { body, region, others }
}
function sideOfCylinder(): Setup {
  const body = own(cylinder(W, 14, 36, 120))
  const { region, others } = split(meshOf(body), (n) => Math.abs(n[2]) < 0.2)
  return { body, region, others }
}

function run(kind: GenKind, set: Setup, over: Record<string, ParamValue> = {}) {
  const params = paramsOf(kind, over)
  const g = generateSurface({ kind, params, positions: set.region.positions, indices: set.region.indices, obstacle: set.others, sides: 8 })
  const s = buildGenSolids(W, g, meshOf(set.body), own)
  expect(s.merged).not.toBeNull()
  const m = s.merged!
  return { g, s, m }
}

/** The printable-manifold checks every generator result has to pass. */
function expectPrintable(m: Manifold, body: Manifold) {
  expect(m.status()).toBe('NoError')
  expect(m.isEmpty()).toBe(false)
  expect(m.volume()).toBeGreaterThan(body.volume())
  expect(m.decompose().length).toBe(1)
}

describe('spikes', () => {
  for (const pr of SPIKE_PRESETS) {
    it(`preset ${pr.id}: manifold, one piece, genus 0`, () => {
      const set = topOfCube()
      const { g, m } = run('spikes', set, pr.values)
      expect(g.set.count).toBeGreaterThan(5)
      expectPrintable(m, set.body)
      expect(m.genus()).toBe(0)
    })
  }
  it('spikes stand off the surface by the requested height', () => {
    const set = topOfCube()
    const { m } = run('spikes', set, { ...SPIKE_PRESETS[2].values, height: 8, sizeVar: 0, tilt: 0, density: 6 })
    expect(m.boundingBox().max[2]).toBeGreaterThan(20 + 7.5)
    expect(m.boundingBox().max[2]).toBeLessThan(20 + 8.01)
  })
  it('print-aware drops spikes on a face that points down and tilts side spikes up', () => {
    const body = own(cube(W, [40, 40, 20]))
    const { region, others } = split(meshOf(body), (n) => n[2] < -0.99)
    expect(() => generateSurface({ kind: 'spikes', params: paramsOf('spikes'), positions: region.positions, indices: region.indices, obstacle: others })).toThrow(/No spikes/)
    const side = sideOfCube()
    const { g } = run('spikes', side, { tilt: 0, density: 8 })
    // every spike apex sits above its base because the axis was tilted up
    const pos = g.set.positions
    let up = 0
    for (let r = 0; r < g.set.count; r++) {
      const v0 = g.set.ranges[r * 4], vn = g.set.ranges[r * 4 + 1]
      let zmax = -Infinity, zmin = Infinity
      for (let v = v0; v < v0 + vn; v++) { zmax = Math.max(zmax, pos[v * 3 + 2]); zmin = Math.min(zmin, pos[v * 3 + 2]) }
      if (zmax - zmin > 0.5) up++
    }
    expect(up).toBe(g.set.count)
  })
  it('a different seed gives a different layout, the same seed the same one', () => {
    const set = topOfCube()
    const a = run('spikes', set, { seed: 1 }).g.set.positions, b = run('spikes', set, { seed: 1 }).g.set.positions, c = run('spikes', set, { seed: 2 }).g.set.positions
    expect(Array.from(a.slice(0, 30))).toEqual(Array.from(b.slice(0, 30)))
    expect(Array.from(a.slice(0, 30))).not.toEqual(Array.from(c.slice(0, 30)))
  })
})

describe('scales', () => {
  for (const pr of SCALE_PRESETS) {
    it(`preset ${pr.id} on a cylinder: manifold, one piece`, () => {
      const set = sideOfCylinder()
      const { g, m } = run('scales', set, pr.values)
      expect(g.set.count).toBeGreaterThan(10)
      expectPrintable(m, set.body)
    })
  }
  it('rows run along the flow: down on a vertical wall stacks scales in z', () => {
    const set = sideOfCube()
    const { g, m } = run('scales', set, { jitter: 0, sizeVar: 0 })
    expectPrintable(m, set.body)
    expect(g.stats.count).toBeGreaterThan(12)
    // centres of the scales fall on rows spaced by length * (1 - overlap)
    const zs = new Set<number>()
    for (let r = 0; r < g.set.count; r++) {
      const v0 = g.set.ranges[r * 4], vn = g.set.ranges[r * 4 + 1]
      let z = 0
      for (let v = v0; v < v0 + vn; v++) z += g.set.positions[v * 3 + 2]
      zs.add(Math.round((z / vn) * 10) / 10)
    }
    expect(zs.size).toBeGreaterThanOrEqual(3)
  })
  it('a round part gets a whole number of scales around it', () => {
    const set = sideOfCylinder()
    const { g } = run('scales', set, { width: 7, jitter: 0, sizeVar: 0 })
    expect(g.stats.round).toBeGreaterThan(0)
    // all centres of the first row are at one z and evenly spread: count them
    const rows = new Map<number, number>()
    for (let r = 0; r < g.set.count; r++) {
      const v0 = g.set.ranges[r * 4], vn = g.set.ranges[r * 4 + 1]
      let z = 0
      for (let v = v0; v < v0 + vn; v++) z += g.set.positions[v * 3 + 2]
      const k = Math.round((z / vn) * 5)
      rows.set(k, (rows.get(k) ?? 0) + 1)
    }
    const counts = [...rows.values()].sort((a, b) => b - a)
    expect(counts[0]).toBeGreaterThanOrEqual(10)
  })
})

describe('grass', () => {
  for (const pr of GRASS_PRESETS) {
    it(`preset ${pr.id}: manifold, one piece`, () => {
      const set = topOfCube()
      const { g, m } = run('grass', set, pr.values)
      expect(g.set.count).toBeGreaterThan(5)
      expectPrintable(m, set.body)
    })
  }
  it('print-aware keeps every blade within the steepest lean', () => {
    const set = topOfCube()
    const { g } = run('grass', set, { bend: 110, maxLean: 40, heightVar: 0, density: 8 })
    // a blade that never leans past 40 degrees reaches sideways at most tan(40) times its height (plus its own width)
    for (let r = 0; r < g.set.count; r++) {
      const v0 = g.set.ranges[r * 4], vn = g.set.ranges[r * 4 + 1]
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (let v = v0; v < v0 + vn; v++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], g.set.positions[v * 3 + a]); hi[a] = Math.max(hi[a], g.set.positions[v * 3 + a]) }
      expect(Math.hypot(hi[0] - lo[0], hi[1] - lo[1])).toBeLessThanOrEqual((hi[2] - lo[2]) * Math.tan((40 * Math.PI) / 180) + 1.6)
      expect(hi[2] - lo[2]).toBeGreaterThan(5)
    }
  })
})

describe('fur', () => {
  it('standard fur on top: manifold and one piece', () => {
    const set = topOfCube()
    const { g, m } = run('fur', set, FUR_PRESETS[0].values)
    expect(g.set.count).toBeGreaterThan(50)
    expectPrintable(m, set.body)
  })
  it('clumped fur differs from unclumped fur', () => {
    const set = topOfCube()
    const a = run('fur', set, FUR_PRESETS[0].values).g.set.positions
    const b = run('fur', set, FUR_PRESETS[1].values).g.set.positions
    expect(a.length).not.toBe(b.length)
  })
  it('up-facing variant has no wall and every strand stands up', () => {
    const set = topOfCube()
    const { g, m } = run('fur', set, FUR_PRESETS[2].values)
    expect(g.wall).toBeNull()
    expectPrintable(m, set.body)
    // strand tops are above their roots
    let lo = Infinity
    for (let i = 2; i < g.set.positions.length; i += 3) lo = Math.min(lo, g.set.positions[i])
    expect(lo).toBeGreaterThan(20 - 2)
    expect(m.boundingBox().max[2]).toBeGreaterThan(20 + 4)
  })
  it('wall variant builds a sacrificial wall that fuses into one piece', () => {
    const set = sideOfCube()
    const { g, m } = run('fur', set, FUR_PRESETS[3].values)
    expect(g.wall).not.toBeNull()
    expectPrintable(m, set.body)
  })
})

describe('surface maps', () => {
  it('a flat patch maps to a plane aligned with the flow', () => {
    const set = sideOfCube()
    const s = prepSurface(set.region.positions, set.region.indices)
    const map = fitPatch(s, Array.from({ length: s.idx.length / 3 }, (_, i) => i), [0, 0, -1])!
    expect(map.kind).toBe('planar')
    const [, v0] = uvOf(map, [40, 10, 10]), [, v1] = uvOf(map, [40, 10, 5])
    expect(v1 - v0).toBeCloseTo(5, 3)
  })
  it('a round patch maps to a cylinder of the right radius', () => {
    const set = sideOfCylinder()
    const s = prepSurface(set.region.positions, set.region.indices)
    const map = fitPatch(s, Array.from({ length: s.idx.length / 3 }, (_, i) => i), [0, 0, -1])!
    expect(map.kind).toBe('cylinder')
    expect(map.r).toBeGreaterThan(13.9)
    expect(map.r).toBeLessThan(14.05)
    expect(Math.abs(map.a[2])).toBeGreaterThan(0.99)
  })
})
