import { describe, expect, it } from 'vitest'
import type { Body } from '@/kernel/types'
import { autoOperation, bodySide, insideAnyBody, pointInMesh, worldDir } from './autoCut'

/** 10 x 10 x 10 box from the origin, as 12 triangles. */
const pos = Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10])
const idx = Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
const box = { id: 'b', kind: 'brep', mesh: { positions: pos, indices: idx } } as unknown as Body

describe('auto cut / join', () => {
  it('inside test', () => {
    expect(pointInMesh(pos, idx, [5, 5, 5])).toBe(true)
    expect(pointInMesh(pos, idx, [5, 5, 10.01])).toBe(false)
    expect(pointInMesh(pos, idx, [5, 5, 9.99])).toBe(true)
    expect(pointInMesh(pos, idx, [20, 5, 5])).toBe(false)
    expect(insideAnyBody([box], [5, 5, 5])).toBe(true)
  })
  it('finds the side the material is on, from a sketch on the top face', () => {
    const top: [number, number, number][] = [[5, 5, 10], [3, 3, 10]]
    expect(bodySide([box], top, [0, 0, 1])).toBe(-1)
    expect(bodySide([box], top, [0, 0, -1])).toBe(1)
    expect(bodySide([box], [[5, 5, 20]], [0, 0, 1])).toBe(0)
  })
  it('a sketch dragged into the body is a cut, and back out a join', () => {
    expect(autoOperation({ facesOnly: false, side: -1, operation: 'join', distance: -4 })).toEqual({ operation: 'cut', distance: -4 })
    expect(autoOperation({ facesOnly: false, side: -1, operation: 'cut', distance: 4 })).toEqual({ operation: 'join', distance: 4 })
    expect(autoOperation({ facesOnly: false, side: -1, operation: 'join', distance: 4 })).toBeNull()
    expect(autoOperation({ facesOnly: false, side: 0, operation: 'join', distance: -4 })).toBeNull()
    expect(autoOperation({ facesOnly: false, side: -1, operation: 'intersect', distance: -4 })).toBeNull()
  })
  it('a pushed face keeps its extrusion where it is when the operation flips (Cut measures inwards)', () => {
    const out = autoOperation({ facesOnly: true, side: -1, operation: 'join', distance: -4 })!
    expect(out).toEqual({ operation: 'cut', distance: 4 })
    expect(worldDir(true, 'join', -4)).toBe(worldDir(true, out.operation, out.distance))
    const back = autoOperation({ facesOnly: true, side: -1, operation: 'cut', distance: -3 })!
    expect(back).toEqual({ operation: 'join', distance: 3 })
    expect(worldDir(true, 'cut', -3)).toBe(worldDir(true, back.operation, back.distance))
    // positive, outward: stays a join
    expect(autoOperation({ facesOnly: true, side: -1, operation: 'join', distance: 5 })).toBeNull()
  })
})
