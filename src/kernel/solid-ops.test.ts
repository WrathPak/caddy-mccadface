/** Cylinder, sweep, loft and shell worker ops, run directly in Node. */
import { beforeAll, describe, expect, it } from 'vitest'
import { measureVolume, type AnyShape } from 'replicad'
import { box, initOcc, topoOf } from './occ'
import { bodyFromShape, getBrep, getOp, helpers } from './store'
import { bbox, computeFaceSigs, type Body } from './types'
import './model-ops'
import './solid-ops'
import type { CylinderArgs, LoftArgs, ShellArgs, SweepArgs } from './solid-ops'
import type { Loop, PlaneDef } from '../sketch/types'

const run = async (name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as Body
const vol = (b: Body) => Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never))
const near = (a: number, b: number, rel = 1e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
const rect = (x0: number, y0: number, x1: number, y1: number): Loop => [
  { k: 'l', a: [x0, y0], b: [x1, y0] }, { k: 'l', a: [x1, y0], b: [x1, y1] }, { k: 'l', a: [x1, y1], b: [x0, y1] }, { k: 'l', a: [x0, y1], b: [x0, y0] },
]
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
const at = (z: number): PlaneDef => ({ ...XY, origin: [0, 0, z] })

beforeAll(async () => { await initOcc() })

describe('cylinder', () => {
  it('volume, extent and orientation along each axis', async () => {
    const mk = (dir: [number, number, number]) => run('cylinderTool', { id: 'c', name: 'c', radius: 5, height: 12, origin: [1, 2, 3], dir } satisfies CylinderArgs)
    const z = await mk([0, 0, 1])
    near(vol(z), Math.PI * 25 * 12, 2e-3)
    const bb = bbox(z.mesh.positions)
    expect(bb.min[2]).toBeCloseTo(3, 3)
    expect(bb.max[2]).toBeCloseTo(15, 3)
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(10, 1)
    const x = bbox((await mk([1, 0, 0])).mesh.positions)
    expect(x.max[0]).toBeCloseTo(13, 3)
    expect(x.max[2] - x.min[2]).toBeCloseTo(10, 1)
  })
  it('rejects non-positive sizes', () => {
    expect(() => getOp('cylinderTool')!({ id: 'c', name: 'c', radius: 0, height: 5, origin: [0, 0, 0], dir: [0, 0, 1] } as never, helpers)).toThrow()
  })
})

describe('sweep', () => {
  const profile = (plane: PlaneDef, outer: Loop, holes: Loop[] = []) => [{ plane, profiles: [{ outer, holes }] }]
  it('square along a straight path: area * length', async () => {
    const a: SweepArgs = { id: 's', name: 's', groups: profile(XY, rect(-2, -2, 2, 2)), path: [{ k: 'l', a: [0, 0, 0], b: [0, 0, 25] }] }
    const b = await run('sweepTool', a)
    near(vol(b), 16 * 25)
    expect(bbox(b.mesh.positions).max[2]).toBeCloseTo(25, 3)
  })
  it('hollow profile keeps its hole', async () => {
    const a: SweepArgs = { id: 's', name: 's', groups: profile(XY, rect(-3, -3, 3, 3), [rect(-1, -1, 1, 1)]), path: [{ k: 'l', a: [0, 0, 0], b: [0, 0, 10] }] }
    near(vol(await run('sweepTool', a)), (36 - 4) * 10)
  })
  it('along a quarter-circle arc: Pappus volume', async () => {
    // arc in the XZ plane centred at (10, 0, 0): from (0,0,0) up through to (10,0,10)
    const r = 10, s = Math.SQRT1_2
    const a: SweepArgs = {
      id: 's', name: 's',
      // profile in the YZ-normal plane at the path start (path starts going +Z): profile plane is XY at z = 0
      groups: profile(XY, rect(-1, -1, 1, 1)),
      path: [{ k: 'a', a: [0, 0, 0], m: [r - r * s, 0, r * s], b: [r, 0, r] }],
    }
    const b = await run('sweepTool', a)
    // centroid of the square sits on the arc, so V = area * arc length
    near(vol(b), 4 * (Math.PI / 2) * r, 5e-3)
  })
})

describe('loft', () => {
  it('square to a smaller square: frustum volume', async () => {
    const a: LoftArgs = {
      id: 'l', name: 'l', ruled: false,
      sections: [{ plane: at(0), profile: { outer: rect(-10, -10, 10, 10), holes: [] } }, { plane: at(10), profile: { outer: rect(-5, -5, 5, 5), holes: [] } }],
    }
    const b = await run('loftTool', a)
    near(vol(b), (10 / 3) * (400 + 100 + 200), 5e-3)
    const bb = bbox(b.mesh.positions)
    expect(bb.min[2]).toBeCloseTo(0, 3)
    expect(bb.max[2]).toBeCloseTo(10, 3)
  })
  it('three sections on different planes, and holes through every section', async () => {
    const sec = (z: number, h: number) => ({ plane: at(z), profile: { outer: rect(-h, -h, h, h), holes: [rect(-1, -1, 1, 1)] } })
    const b = await run('loftTool', { id: 'l', name: 'l', ruled: true, sections: [sec(0, 6), sec(10, 6), sec(20, 6)] } satisfies LoftArgs)
    near(vol(b), (144 - 4) * 20, 5e-3)
  })
  it('needs two sections', () => {
    expect(() => getOp('loftTool')!({ id: 'l', name: 'l', ruled: true, sections: [] } as never, helpers)).toThrow()
  })
})

describe('shell', () => {
  const topFace = (b: Body) => computeFaceSigs(b.mesh).findIndex((s) => s.normal[2] > 0.99)
  it('inside: removes the top face and keeps the outer size', async () => {
    const base = bodyFromShape('b', 'b', box([20, 20, 20], [0, 0, 0]))
    const out = await run('shellOp', { id: 's', name: 's', key: base.key, faces: [topFace(base)], thickness: 2, side: 'inside' } satisfies ShellArgs)
    near(vol(out), 20 * 20 * 20 - 16 * 16 * 18, 2e-3)
    const bb = bbox(out.mesh.positions)
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(20, 3)
    expect(bb.max[2]).toBeCloseTo(20, 3)
    expect(topoOf(getBrep(out.key) as unknown as AnyShape).faces.length).toBeGreaterThan(6)
  })
  it('outside: the wall grows outwards', async () => {
    const base = bodyFromShape('b', 'b', box([20, 20, 20], [0, 0, 0]))
    const out = await run('shellOp', { id: 's', name: 's', key: base.key, faces: [topFace(base)], thickness: 2, side: 'outside' } satisfies ShellArgs)
    near(vol(out), 4519.41, 1e-3) // outward offsets round the edges and corners
    const bb = bbox(out.mesh.positions)
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(24, 3)
  })
  it('rejects an unknown face and a thickness too large', () => {
    const base = bodyFromShape('b', 'b', box([20, 20, 20], [0, 0, 0]))
    expect(() => getOp('shellOp')!({ id: 's', name: 's', key: base.key, faces: [99], thickness: 2, side: 'inside' } as never, helpers)).toThrow()
    expect(() => getOp('shellOp')!({ id: 's', name: 's', key: base.key, faces: [topFace(base)], thickness: 10, side: 'inside' } as never, helpers)).toThrow()
  })
})
