import { beforeAll, describe, expect, it } from 'vitest'
import { box, initOcc } from '@/kernel/occ'
import { bodyFromShape } from '@/kernel/store'
import { chain, rotateZ, translation } from './matrix'
import { minClearance, type PlacedMesh } from './clearance'
import { DEG } from './matrix'

beforeAll(async () => { await initOcc() })

const cube = (id: string, matrix: number[], size = 10): PlacedMesh => {
  const b = bodyFromShape(id, id, box([size, size, size], [0, 0, 0]))
  return { positions: b.mesh.positions, indices: b.mesh.indices, matrix }
}

describe('minimum clearance', () => {
  it('measures the gap between two boxes face to face', () => {
    const r = minClearance([cube('a', translation([0, 0, 0]))], [cube('b', translation([13, 0, 0]))])!
    expect(r.distance).toBeCloseTo(3, 4)
    expect(r.pa[0]).toBeCloseTo(5, 4)
    expect(r.pb[0]).toBeCloseTo(8, 4)
  })

  it('is zero for boxes that touch or overlap', () => {
    expect(minClearance([cube('a', translation([0, 0, 0]))], [cube('b', translation([10, 0, 0]))])!.distance).toBeCloseTo(0, 6)
    expect(minClearance([cube('a', translation([0, 0, 0]))], [cube('b', translation([4, 3, 2]))])!.distance).toBe(0)
  })

  it('handles a rotated part (corner to face)', () => {
    // a cube turned 45 degrees about Z has its corner at x = 7.07 from its centre
    const turned = chain(translation([30, 0, 0]), rotateZ(45 * DEG))
    const r = minClearance([cube('a', translation([0, 0, 0]))], [cube('b', turned)])!
    expect(r.distance).toBeCloseTo(30 - 5 - 5 * Math.SQRT2, 3)
  })

  it('takes the smallest distance over several bodies of a component', () => {
    const near = cube('n', translation([0, 20, 0])), far = cube('f', translation([0, 90, 0]))
    const r = minClearance([far, near], [cube('b', translation([0, 0, 0]))])!
    expect(r.distance).toBeCloseTo(10, 4)
    expect(minClearance([], [near])).toBeNull()
  })
})
