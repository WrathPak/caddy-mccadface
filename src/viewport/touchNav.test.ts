import { describe, expect, it } from 'vitest'
import { MathUtils } from 'three'
import { TWIST_DEAD, twistRoll } from './touchNav'
import { validSelectionColor } from '@/settings/settings'

describe('two-finger twist', () => {
  it('ignores a small turn so a pinch never rolls', () => {
    expect(twistRoll(0)).toBe(0)
    expect(twistRoll(TWIST_DEAD * 0.9)).toBe(0)
    expect(twistRoll(-TWIST_DEAD * 0.9)).toBe(0)
  })
  it('follows the fingers continuously once past the dead zone, either way', () => {
    expect(twistRoll(TWIST_DEAD + 0.001)).toBeCloseTo(0.001, 6)
    expect(twistRoll(MathUtils.degToRad(45))).toBeCloseTo(MathUtils.degToRad(45) - TWIST_DEAD, 6)
    expect(twistRoll(-MathUtils.degToRad(45))).toBeCloseTo(-(MathUtils.degToRad(45) - TWIST_DEAD), 6)
  })
})

describe('selection colour setting', () => {
  it('accepts #rrggbb and falls back to the default (empty) for anything else', () => {
    expect(validSelectionColor('#E0684F')).toBe('#e0684f')
    expect(validSelectionColor('red')).toBe('')
    expect(validSelectionColor('#fff')).toBe('')
    expect(validSelectionColor(undefined)).toBe('')
  })
})
