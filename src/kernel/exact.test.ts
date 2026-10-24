/** Splines and ellipses reach the kernel as exact curves (not as polylines or approximations). */
import { beforeAll, describe, expect, it } from 'vitest'
import { measureVolume, type AnyShape } from 'replicad'
import { initOcc, topoOf } from './occ'
import { getBrep, getOp, helpers } from './store'
import type { Body } from './types'
import './model-ops'
import './solid-ops'
import type { ExtrudeArgs, RevolveArgs } from './model-ops'
import type { LoftArgs, SweepArgs } from './solid-ops'
import { derivedSegs } from '../sketch/curves'
import { addEllipse, addPoint } from '../sketch/model'
import { emptyModel, type Loop, type PlaneDef } from '../sketch/types'
import { setUserParams } from '../doc/params'

const run = async (name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as Body
const vol = (b: Body) => Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never))
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }

beforeAll(async () => { await initOcc() })

describe('exact curves', () => {
  it('an extruded ellipse has the volume of the true ellipse', async () => {
    const m = emptyModel()
    const e = addEllipse(m, addPoint(m, 0, 0), addPoint(m, 12, 5), 7)
    const outer = derivedSegs(m, e)[0] as Loop
    expect(outer.length).toBe(8)
    const a: ExtrudeArgs = { id: 'e', name: 'e', faces: [], mode: 'one', d1: 10, d2: 0, faceDir: 1, groups: [{ plane: XY, profiles: [{ outer, holes: [] }] }] }
    const rx = Math.hypot(12, 5)
    // a cubic approximation is about 5e-4 off; the true ellipse is within meshing-free precision
    expect(Math.abs(vol(await run('extrudeTool', a)) / (Math.PI * rx * 7 * 10) - 1)).toBeLessThan(1e-6)
  })

  it('a sweep along a spline follows the curve, not a polyline', async () => {
    // one cubic: the quarter circle of radius 10 (kappa approximation), in the XZ plane
    const r = 10, k = 0.5522847498 * r
    const a: SweepArgs = {
      id: 's', name: 's',
      groups: [{ plane: XY, profiles: [{ outer: [{ k: 'l', a: [-1, -1], b: [1, -1] }, { k: 'l', a: [1, -1], b: [1, 1] }, { k: 'l', a: [1, 1], b: [-1, 1] }, { k: 'l', a: [-1, 1], b: [-1, -1] }], holes: [] }] }],
      path: [{ k: 'b', a: [0, 0, 0], c1: [0, 0, k], c2: [r - k, 0, r], b: [r, 0, r] }],
    }
    const v = vol(await run('sweepTool', a))
    // area times the length of the (almost circular) path
    expect(Math.abs(v / (4 * (Math.PI / 2) * r) - 1)).toBeLessThan(5e-3)
  })
})

describe('parameters', () => {
  it('says plainly when a value refers to itself', () => {
    const s = setUserParams([{ name: 'w', expr: 'w * 3' }])
    expect(s.errors.w).toMatch(/itself.*circular/)
  })
  it('says plainly when a value uses one listed after it', () => {
    const s = setUserParams([{ name: 'a', expr: 'b + 1' }, { name: 'b', expr: '2' }])
    expect(s.errors.a).toMatch(/listed after/)
    setUserParams([])
  })
})

describe('exact curves in revolve and loft', () => {
  it('a revolved ellipse has the analytic volume (Pappus)', async () => {
    const m = emptyModel()
    const e = addEllipse(m, addPoint(m, 20, 0), addPoint(m, 25, 0), 3)
    const outer = derivedSegs(m, e)[0] as Loop
    const a: RevolveArgs = { id: 'r', name: 'r', groups: [{ plane: XY, profiles: [{ outer, holes: [] }] }], axisOrigin: [0, 0, 0], axisDir: [0, 1, 0], angle: 360 }
    const v = vol(await run('revolveTool', a))
    expect(Math.abs(v / (2 * Math.PI * 20 * Math.PI * 5 * 3) - 1)).toBeLessThan(1e-6)
  })

  it('a loft from a spline profile to a circle is a valid solid with spline faces', async () => {
    const lens: Loop = [
      { k: 'b', a: [-10, 0], c1: [-5, 8], c2: [5, 8], b: [10, 0] },
      { k: 'b', a: [10, 0], c1: [5, -8], c2: [-5, -8], b: [-10, 0] },
    ]
    const a: LoftArgs = {
      id: 'l', name: 'l', ruled: false,
      sections: [
        { plane: XY, profile: { outer: lens, holes: [] } },
        { plane: { ...XY, origin: [0, 0, 15] }, profile: { outer: [{ k: 'c', c: [0, 0], r: 6 }], holes: [] } },
      ],
    }
    const b = await run('loftTool', a)
    expect(vol(b)).toBeGreaterThan(0)
    const kinds = topoOf(getBrep(b.key) as unknown as AnyShape).faces.map((f) => String(f.geomType))
    expect(kinds.some((k) => /BSPLINE|BEZIER/i.test(k))).toBe(true)
  })
})
