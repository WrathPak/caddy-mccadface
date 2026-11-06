import { beforeAll, describe, expect, it } from 'vitest'
import { initOcc } from '@/kernel/occ'
import { getOp, helpers } from '@/kernel/store'
import '@/kernel/model-ops'
import type { Body } from '@/kernel/types'
import { addCircle, addLine, addPoint } from './model'
import { surfaceCurves } from './surface'
import { emptyModel, type PlaneDef } from './types'

beforeAll(async () => { await initOcc() })
const run = async <T = Body>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T

describe('Project to Surface', () => {
  it('keeps the part of a line that has a curved face in view along the sketch normal, and the height of the face', async () => {
    const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
    const cyl = await run<Body>('extrudeTool', { id: 'c', name: 'c', faces: [], mode: 'one', d1: 10, d2: 0, faceDir: 1, groups: [{ plane: XY, profiles: [{ outer: [{ k: 'c', c: [30, 0], r: 10 }], holes: [] }] }] })
    // the half of the wall that faces the sketch plane (the sketch looks along +y from y = -50)
    const { faceIds, positions, indices } = cyl.mesh
    let wall = -1
    for (let t = 0; t < faceIds.length && wall < 0; t++) {
      const i = indices[t * 3] * 3
      if (Math.abs(Math.hypot(positions[i] - 30, positions[i + 1]) - 10) < 1e-3 && positions[i + 1] < -1) wall = faceIds[t]
    }
    expect(wall).toBeGreaterThanOrEqual(0)
    const plane: PlaneDef = { origin: [0, -50, 0], xDir: [1, 0, 0], normal: [0, 1, 0] } // local y points down (-z)
    const m = emptyModel()
    const a = addPoint(m, 0, -5), b = addPoint(m, 60, -5)
    const line = addLine(m, a, b)
    const res = surfaceCurves(m, [line.id], plane, cyl, wall)
    expect(res.curves).toHaveLength(1)
    const c = res.curves[0]
    expect(c.k).toBe('l')
    if (c.k === 'l') {
      expect(Math.min(c.a[0], c.b[0])).toBeCloseTo(20, 1)
      expect(Math.max(c.a[0], c.b[0])).toBeCloseTo(40, 1)
    }
    // the face is about 40 mm in front of the plane where the line crosses its middle (x = 30, y = -10 on the wall: 40 from y = -50)
    expect(Math.abs(res.height!)).toBeCloseTo(40, 0)
    // a circle that is wholly over the face stays a circle; one that is not comes back as arcs
    const m2 = emptyModel()
    const small = addCircle(m2, addPoint(m2, 30, -5), 2)
    expect(surfaceCurves(m2, [small.id], plane, cyl, wall).curves.map((q) => q.k)).toEqual(['c'])
    const m3 = emptyModel()
    const big = addCircle(m3, addPoint(m3, 20, -5), 3)
    expect(surfaceCurves(m3, [big.id], plane, cyl, wall).curves.every((q) => q.k === 'a')).toBe(true)
  })
})
