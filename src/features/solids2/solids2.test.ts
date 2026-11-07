/** The maths behind the second wave of solid tools: revolve to a plane, hole offsets from edges, Align, Move ghosts, coil numbers, physical properties. */
import { describe, expect, it } from 'vitest'
import { applyPoint } from '@/kernel/xform'
import type { Body, Vec3 } from '@/kernel/types'
import { angleToPlane } from './advanced'
import { alignXf, eulerOf, ghostOf } from './transform'
import { coilNumbers } from './prims'
import { massOf, MATERIALS, physicalOf } from './material'

const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)
const nearV = (a: Vec3, b: Vec3, tol = 1e-6) => a.forEach((x, i) => near(x, b[i], tol))

describe('revolve to an object', () => {
  it('finds the turn that brings a point onto a plane', () => {
    // a point 10 out on X, spinning about Z, reaches the plane x = 0 after 90 degrees
    near(angleToPlane([10, 0, 0], [0, 0, 0], [0, 0, 1], [0, 0, 0], [1, 0, 0])!, 90)
    near(angleToPlane([10, 0, 0], [0, 0, 0], [0, 0, 1], [0, 0, 0], [1, 1, 0])!, 135)
    // the plane y = 5 is met at asin(5/10) = 30 degrees
    near(angleToPlane([10, 0, 0], [0, 0, 0], [0, 0, 1], [0, 5, 0], [0, 1, 0])!, 30, 1e-6)
    // tangent contact: the plane y = 10 from a point 10 out, from either side
    near(angleToPlane([10, 0, 0], [0, 0, 0], [0, 0, 1], [0, 10, 10], [0, -1, 0])!, 90, 1e-3)
    near(angleToPlane([10, 0, 0], [0, 0, 0], [0, 0, 1], [0, 10, 10], [0, 1, 0])!, 90, 1e-3)
    // a plane the point never reaches
    expect(angleToPlane([10, 0, 0], [0, 0, 0], [0, 0, 1], [0, 50, 0], [0, 1, 0])).toBeNull()
    // already on the plane y = 0: the next time round, not zero
    near(angleToPlane([10, 0, 0], [0, 0, 0], [0, 0, 1], [0, 0, 0], [0, 1, 0])!, 180)
  })
})

describe('align', () => {
  it('faces meet face to face, flipped they point the same way, and an offset leaves a gap', () => {
    const from = { kind: 'face' as const, point: [0, 0, 10] as Vec3, dir: [0, 0, 1] as Vec3 }
    const to = { kind: 'face' as const, point: [50, 20, 0] as Vec3, dir: [1, 0, 0] as Vec3 }
    const xf = alignXf(from, to, false, 0, 0)
    nearV(applyPoint(xf, from.point), to.point)
    // the From normal now points against the To normal
    const tip = applyPoint(xf, [0, 0, 11])
    nearV(tip, [49, 20, 0])
    const gap = alignXf(from, to, false, 0, 3)
    nearV(applyPoint(gap, from.point), [53, 20, 0])
    const flipped = alignXf(from, to, true, 0, 0)
    nearV(applyPoint(flipped, [0, 0, 11]), [51, 20, 0])
  })
  it('corners coincide, edges line up, and mixed kinds are refused', () => {
    nearV(applyPoint(alignXf({ kind: 'vertex', point: [1, 2, 3] }, { kind: 'vertex', point: [4, 5, 6] }, false, 0, 0), [1, 2, 3]), [4, 5, 6])
    const xf = alignXf({ kind: 'edge', point: [0, 0, 0], dir: [1, 0, 0] }, { kind: 'edge', point: [0, 10, 0], dir: [0, 1, 0] }, false, 0, 0)
    nearV(applyPoint(xf, [1, 0, 0]), [0, 11, 0])
    expect(() => alignXf({ kind: 'vertex', point: [0, 0, 0] }, { kind: 'edge', point: [0, 0, 0], dir: [1, 0, 0] }, false, 0, 0)).toThrow(/same kind/)
  })
})

describe('move ghost', () => {
  it('the ghost translate and Euler angles reproduce the rigid transform about the pivot', () => {
    const xf = { t: 'rigid' as const, R: [0, -1, 0, 1, 0, 0, 0, 0, 1], p: [10, 0, 0] as Vec3 } // 90 degrees about Z, then 10 along X
    const pivot: Vec3 = [5, 5, 5]
    const g = ghostOf(xf, pivot)
    nearV(g.rotate, [0, 0, 90], 1e-6)
    nearV(g.translate, [applyPoint(xf, pivot)[0] - 5, applyPoint(xf, pivot)[1] - 5, 0], 1e-9)
    nearV(eulerOf([1, 0, 0, 0, 1, 0, 0, 0, 1]), [0, 0, 0])
  })
})

describe('coil numbers', () => {
  it('derives the third value from the two that are set', () => {
    const c = (t: string) => coilNumbers({ coilType: t, revolutions: 4, height: 40, pitch: 8 })
    near(c('revH').pitch, 10)
    near(c('revP').height, 32)
    near(c('hP').rev, 5)
  })
})

describe('physical properties', () => {
  // a 10 x 20 x 30 box with a corner on the origin, as 12 triangles
  const P = new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 0, 0, 0, 30, 10, 0, 30, 10, 20, 30, 0, 20, 30])
  const I = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  const body = { id: 'b', name: 'b', kind: 'mesh', key: 'k', mesh: { positions: P, indices: I } } as unknown as Body
  it('volume, area and centre of gravity of a box', () => {
    const ph = physicalOf(body)
    near(ph.volume, 6000, 1e-3)
    near(ph.area, 2 * (200 + 300 + 600), 1e-3)
    nearV(ph.centroid, [5, 10, 15], 1e-3)
  })
  it('mass follows the density', () => {
    near(massOf(6000, 7.85), 47.1, 1e-9)
    expect(MATERIALS.find((m) => m.id === 'aluminium')!.density).toBeCloseTo(2.7)
    expect(new Set(MATERIALS.map((m) => m.id)).size).toBe(MATERIALS.length)
  })
})
