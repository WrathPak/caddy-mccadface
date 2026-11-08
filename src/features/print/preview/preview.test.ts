import { describe, expect, it } from 'vitest'
import type { ToolpathExtras, Toolpaths } from '@muon3d/slicer-engine-protocol'
import { bedOriginFromBounds, bedToWorld, layerOfSegment, planChunks, segmentRange } from './data'

/** A square loop per layer, `perLayer` segments each, two roles alternating by layer. */
function fake(layers: number, perLayer: number): { tp: Toolpaths; extras: ToolpathExtras } {
  const n = layers * perLayer
  const positions = new Float32Array(n * 6)
  const layerStart = new Uint32Array(layers + 1)
  const roleIndex = new Uint8Array(n)
  const width = new Uint8Array(n).fill(45)
  const height = new Uint8Array(n).fill(20)
  const time = new Float32Array(n)
  const feed = new Float32Array(n)
  for (let l = 0; l < layers; l++) {
    layerStart[l] = l * perLayer
    for (let i = 0; i < perLayer; i++) {
      const s = l * perLayer + i
      positions.set([i, 0, 0.2 * (l + 1), i + 1, 0, 0.2 * (l + 1)], s * 6)
      roleIndex[s] = (l + i) % 2
      time[s] = s + 1
      feed[s] = 50 + (s % 7)
    }
  }
  layerStart[layers] = n
  const tp: Toolpaths = {
    format: 1, layerCount: layers, layerZ: Float32Array.from({ length: layers }, (_, l) => 0.2 * (l + 1)),
    extrusions: { positions, layerStart, count: n, roleIndex, width, height },
    travels: { positions: new Float32Array(0), layerStart: new Uint32Array(layers + 1), count: 0 },
    roles: [{ name: 'Outer wall', lengthMm: n / 2 }, { name: 'Inner wall', lengthMm: n / 2 }],
    lineWidth: 0.45, bounds: null,
  }
  const extras: ToolpathExtras = { feedrate: feed, fanSpeed: new Uint8Array(n).fill(100), temperature: new Uint16Array(n).fill(220), time, height: new Float32Array(n).fill(0.2) }
  return { tp, extras }
}

describe('chunk plan', () => {
  it('covers every segment once, cutting at layer starts', () => {
    const { tp } = fake(100, 1000)
    const plan = planChunks(tp.extrusions.layerStart, 12_000)
    expect(plan[0].start).toBe(0)
    expect(plan.at(-1)!.end).toBe(100_000)
    plan.forEach((c, i) => {
      if (i) expect(c.start).toBe(plan[i - 1].end)
      expect(c.end - c.start).toBeLessThanOrEqual(12_000)
      expect(c.start % 1000).toBe(0)
      expect(c.layerLo).toBe(c.start / 1000)
      expect(c.layerHi).toBe(c.end / 1000 - 1)
    })
    expect(plan.length).toBe(9)
  })
  it('cuts a layer that is bigger than the target', () => {
    const ls = Uint32Array.from([0, 50, 130, 140])
    const plan = planChunks(ls, 40)
    expect(plan.map((c) => [c.start, c.end])).toEqual([[0, 40], [40, 50], [50, 90], [90, 130], [130, 140]])
    expect(plan[0].layerLo).toBe(0)
    expect(plan[2].layerLo).toBe(1)
    expect(plan[4].layerHi).toBe(2)
  })
  it('is empty without layers', () => {
    expect(planChunks(new Uint32Array([0]))).toEqual([])
  })
})

describe('layer ranges', () => {
  const { tp } = fake(10, 100)
  const ls = tp.extrusions.layerStart
  it('maps layers to segments', () => {
    expect(segmentRange(ls, { lo: 2, hi: 4, scrub: 1 })).toEqual([200, 500])
    expect(segmentRange(ls, { lo: 0, hi: 9, scrub: 1 })).toEqual([0, 1000])
  })
  it('clamps and keeps lo below hi', () => {
    expect(segmentRange(ls, { lo: -3, hi: 99, scrub: 1 })).toEqual([0, 1000])
    expect(segmentRange(ls, { lo: 7, hi: 3, scrub: 1 })).toEqual([700, 800])
  })
  it('scrub cuts the top layer only', () => {
    expect(segmentRange(ls, { lo: 0, hi: 4, scrub: 0.5 })).toEqual([0, 450])
    expect(segmentRange(ls, { lo: 4, hi: 4, scrub: 0 })).toEqual([400, 400])
  })
  it('finds the layer of a segment', () => {
    expect(layerOfSegment(ls, 0)).toBe(0)
    expect(layerOfSegment(ls, 99)).toBe(0)
    expect(layerOfSegment(ls, 100)).toBe(1)
    expect(layerOfSegment(ls, 999)).toBe(9)
  })
})

describe('coordinates', () => {
  it('moves bed points to the world by the bed origin', () => {
    expect(bedToWorld([10, 20, 5], [-118, -118, 0.5])).toEqual([-108, -98, 5.5])
  })
  it('centers the bed under the bodies and rests it on the lowest point', () => {
    // a 20 mm cube from (-10,-10,0) to (10,10,20) on a 256 bed: the toolpaths (centered at 128, 128) land back on the cube
    const o = bedOriginFromBounds([-10, -10, 0], [10, 10, 20], [256, 256])
    expect(o).toEqual([-128, -128, 0])
    expect(bedToWorld([128, 128, 20], o)).toEqual([0, 0, 20])
    expect(bedToWorld([118, 118, 0.2], o)[0]).toBeCloseTo(-10)
  })
  it('follows a body that sits off the origin and above the ground', () => {
    const o = bedOriginFromBounds([50, 20, 3], [70, 40, 13], [180, 180])
    expect(bedToWorld([90, 90, 0], o)).toEqual([60, 30, 3])
  })
})

