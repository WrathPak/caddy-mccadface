import { describe, expect, it } from 'vitest'
import { RefReport } from '@/doc/refs'
import type { Body } from '@/kernel/types'
import type { Inputs } from '../modeling'
import type { RefEnv } from '../modeling-tools/geo'
import { isPlainExtent, resolveSpan, type ExtentP } from './extent'

/** A box body spanning z 0..10 (x 0..60, y 0..40): only its corners matter to the extents. */
const plate = (): Body => {
  const p: number[] = []
  for (const x of [0, 60]) for (const y of [0, 40]) for (const z of [0, 10]) p.push(x, y, z)
  return { id: 'b1', key: 'k1', name: 'b1', kind: 'brep', mesh: { positions: new Float32Array(p), indices: new Uint32Array([0, 1, 2]), faceIds: new Uint32Array([0]), normals: new Float32Array(0), edges: new Float32Array(0) } } as unknown as Body
}
const env: RefEnv = { bodies: [plate()], dataOf: () => undefined, kernel: { call: async () => null } }
/** A profile on the top face of the plate (z = 10), looking up. */
const onTop = (): Inputs => ({
  groups: [{ plane: { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] }, profiles: [{ outer: [{ k: 'l', a: [10, 10], b: [30, 10] }, { k: 'l', a: [30, 10], b: [30, 30] }, { k: 'l', a: [30, 30], b: [10, 30] }, { k: 'l', a: [10, 30], b: [10, 10] }], holes: [] }] }],
  faces: [], anchor: [20, 20, 10], normal: [0, 0, 1], sketch: null, missing: 0, report: new RefReport(),
})
const base: ExtentP = { direction: 'one', distance: 5, distance2: 3, extent: 'dist', toObject: [], toOffset: 0, extent2: 'dist', toObject2: [], toOffset2: 0, start: 'profile', startOffset: 0, startObject: [], flip: false, operation: 'join', targets: [] }
const span = (p: Partial<ExtentP>) => resolveSpan({ ...base, ...p }, onTop(), env, new RefReport())

describe('extrude extents', () => {
  it('a plain distance from the profile plane is left to the worker', async () => {
    expect(isPlainExtent(base)).toBe(true)
    expect(await span({})).toBeNull()
  })

  it('Start offset and From Object move the whole extent', async () => {
    expect(await span({ start: 'offset', startOffset: -2 })).toMatchObject({ from: -2, to: 3 })
    expect(await span({ start: 'offset', startOffset: 4, direction: 'sym', distance: 6 })).toMatchObject({ from: 1, to: 7 })
    expect(await span({ start: 'offset', startOffset: 1, direction: 'two' })).toMatchObject({ from: -2, to: 6 })
    // the XY plane (z = 0) is 10 below the top face
    expect(await span({ start: 'object', startObject: ['planeXY'], distance: 4 })).toMatchObject({ from: -10, to: -6 })
    // a plane that is not parallel to the profile cannot be a start
    await expect(span({ start: 'object', startObject: ['planeXZ'] })).rejects.toThrow(/parallel/)
  })

  it('All reaches the far side of the bodies, one way (flip) or both ways', async () => {
    expect(await span({ extent: 'all', flip: true, operation: 'join' })).toMatchObject({ from: -10, to: 0, dir: -1 })
    expect(await span({ extent: 'all', flip: true, operation: 'cut' })).toMatchObject({ from: -11, to: 0 }) // a cut goes 1 mm past
    await expect(span({ extent: 'all', flip: false, operation: 'join' })).rejects.toThrow(/nothing to go through/i)
    await expect(span({ extent: 'all', flip: false, operation: 'cut' })).rejects.toThrow(/nothing to go through/i) // a cut's margin is not material
    expect(await span({ extent: 'all', direction: 'sym', operation: 'cut' })).toMatchObject({ from: -11, to: 1 })
    expect(await span({ extent: 'all', extent2: 'all', direction: 'two', operation: 'cut' })).toMatchObject({ from: -11, to: 0 }) // nothing above the face: that side stays put
    expect(await span({ extent: 'all', direction: 'two', distance2: 3, operation: 'cut' })).toMatchObject({ from: -11, to: 3 })
    await expect(resolveSpan({ ...base, extent: 'all' }, onTop(), { ...env, bodies: [] }, new RefReport())).rejects.toThrow(/needs a body/)
  })

  it('To Object ends at the object, moved by the offset, and refuses an object behind or square on', async () => {
    expect(await span({ extent: 'object', toObject: ['planeXY'] })).toMatchObject({ from: -10, to: 0, dir: -1 })
    // positive offset: past the object, negative: short of it
    expect(await span({ extent: 'object', toObject: ['planeXY'], toOffset: 3 })).toMatchObject({ from: -13, to: 0 })
    expect(await span({ extent: 'object', toObject: ['planeXY'], toOffset: -4 })).toMatchObject({ from: -6, to: 0 })
    expect(await span({ extent: 'object', toObject: ['planeXY'], direction: 'sym' })).toMatchObject({ from: -10, to: 10 })
    expect(await span({ extent: 'object', toObject: ['planeXY'], direction: 'two', distance2: 3 })).toMatchObject({ from: -10, to: 3 })
    await expect(span({ extent: 'object', toObject: ['planeXY'], toOffset: -10 })).rejects.toThrow(/behind|start/)
    await expect(span({ extent: 'object', toObject: [] })).rejects.toThrow(/Pick/)
  })

  it('To Object on a plane that is not parallel runs to the furthest point and trims at the plane', async () => {
    // the XZ plane is square to the profile plane: the extrude never reaches it
    await expect(span({ extent: 'object', toObject: ['planeXZ'] })).rejects.toThrow(/parallel to the extrude direction/)
  })

  it('Two sides: each side has its own extent, the second going against the first', async () => {
    // first side a distance up, second side down to the XY plane (10 below)
    expect(await span({ direction: 'two', distance: 5, extent2: 'object', toObject2: ['planeXY'] })).toMatchObject({ from: -10, to: 5, dir: 1 })
    // second side stops 4 short of its object
    expect(await span({ direction: 'two', distance: 5, extent2: 'object', toObject2: ['planeXY'], toOffset2: -4 })).toMatchObject({ from: -6, to: 5 })
    // first side down to the plane, second side up by a distance
    expect(await span({ direction: 'two', extent: 'object', toObject: ['planeXY'], distance2: 2 })).toMatchObject({ from: -10, to: 2, dir: -1 })
    // both sides to the same plane: the second would have to go the way the plane is not
    await expect(span({ direction: 'two', extent: 'object', toObject: ['planeXY'], extent2: 'object', toObject2: ['planeXY'] })).rejects.toThrow(/behind/)
    await expect(span({ direction: 'two', extent2: 'object', toObject2: [] })).rejects.toThrow(/Pick/)
  })
})
