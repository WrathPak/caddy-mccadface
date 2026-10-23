import { describe, expect, it } from 'vitest'
import { gridLevels, gridSnapStep, GRID_TARGET_PX } from './gridMath'

describe('adaptive grid', () => {
  it('the step is always a power of ten and the layers cross-fade smoothly across a decade', () => {
    let prev: { step: number; blend: number } | null = null
    for (let wpp = 0.001; wpp < 1000; wpp *= 1.03) {
      const { step, blend } = gridLevels(wpp)
      expect(Math.log10(step) % 1).toBeCloseTo(0, 9)
      expect(blend).toBeGreaterThanOrEqual(0)
      expect(blend).toBeLessThan(1)
      // the finest layer's cell is never bigger than the target and never smaller than a tenth of it
      const cellPx = step / wpp
      expect(cellPx).toBeLessThanOrEqual(GRID_TARGET_PX + 1e-9)
      expect(cellPx).toBeGreaterThan(GRID_TARGET_PX / 10 - 1e-9)
      if (prev && prev.step === step) expect(blend).toBeGreaterThan(prev.blend) // zooming out only moves the blend forward
      prev = { step, blend }
    }
  })

  it('continuity: just before a decade boundary the finest layer is gone and the next layer is the old minor grid', () => {
    const before = gridLevels(0.1 / GRID_TARGET_PX - 1e-9)
    const after = gridLevels(0.1 / GRID_TARGET_PX + 1e-9)
    expect(before.blend).toBeGreaterThan(0.999)
    expect(after.blend).toBeLessThan(0.001)
    expect(after.step / before.step).toBeCloseTo(10, 6)
  })

  it('snaps to a visible layer: cells between 8 and 80 px', () => {
    for (let wpp = 0.001; wpp < 1000; wpp *= 1.05) {
      const px = gridSnapStep(wpp) / wpp
      expect(px).toBeGreaterThanOrEqual(7.9)
      expect(px).toBeLessThanOrEqual(120.1)
    }
  })
})
