import { beforeAll, describe, expect, it } from 'vitest'
import { makeCylinder } from 'replicad'
import { box, initOcc, type Shape } from './occ'
import { bodyFromShape, getOp, helpers } from './store'
import './drawing-ops'
import type { HlrResult } from './drawing-ops'

beforeAll(async () => { await initOcc() })

/** 40 x 30 x 10 block with an 8 mm hole through its thickness (along Z), centred on the block */
function blockWithHole() {
  const blk = box([40, 30, 10], [0, 0, 0])
  const hole = (makeCylinder(4, 12, [0, 0, -1], [0, 0, 1]) as unknown) as Shape
  return bodyFromShape('b', 'Block', blk.cut(hole) as Shape)
}
const hlr = async (key: string, eye: number[], right: number[], section?: unknown) =>
  (await getOp('drawingHlr')!({ items: [{ key }], eye, right, section } as never, helpers)) as HlrResult

describe('hidden line removal', () => {
  it('top view of a block with a hole: outline and the hole rim are visible, nothing is hidden', async () => {
    const r = await hlr(blockWithHole().key, [0, 0, 1], [1, 0, 0])
    expect(r.hidden.length).toBe(0)
    // 4 outline edges + the hole rim (a full circle is one or two arcs, depending on the seam)
    expect(r.visible.length).toBeGreaterThanOrEqual(5)
    expect(r.visible.length).toBeLessThanOrEqual(6)
    expect(r.bounds).toEqual([expect.closeTo(-20, 5), expect.closeTo(-15, 5), expect.closeTo(20, 5), expect.closeTo(15, 5)])
  })
  it('front view: the hole shows as dashed (hidden) lines', async () => {
    const r = await hlr(blockWithHole().key, [0, -1, 0], [1, 0, 0])
    // outline: 4 edges (the top/bottom faces are edge-on, so the 4 box edges seen from the front)
    expect(r.visible.length).toBeGreaterThanOrEqual(4)
    // hole silhouette lines at x = -4 and x = 4 (and the seam), z from 0 to 10
    const verticals = r.hidden.filter((p) => Math.abs(p[0] - p[p.length - 2]) < 1e-6 && Math.abs(Math.abs(p[1] - p[p.length - 1]) - 10) < 1e-6)
    const xs = verticals.map((p) => Math.round(p[0] * 100) / 100).sort((a, b) => a - b)
    expect(xs).toContain(-4)
    expect(xs).toContain(4)
    expect(r.hidden.length).toBe(2)
    expect(r.visible.length).toBe(4)
  })
  it('view axes: x is to the right and y is up', async () => {
    const b = bodyFromShape('c', 'C', box([40, 30, 10], [0, 0, 0]))
    const front = await hlr(b.key, [0, -1, 0], [1, 0, 0])
    expect(front.bounds).toEqual([expect.closeTo(-20, 5), expect.closeTo(0, 5), expect.closeTo(20, 5), expect.closeTo(10, 5)])
    const right = await hlr(b.key, [1, 0, 0], [0, 1, 0])
    expect(right.bounds).toEqual([expect.closeTo(-15, 5), expect.closeTo(0, 5), expect.closeTo(15, 5), expect.closeTo(10, 5)])
  })
  it('section: a cut through the hole makes a hatched face and keeps the hole visible', async () => {
    const r = await hlr(blockWithHole().key, [0, -1, 0], [1, 0, 0], { origin: [0, 0, 0], normal: [0, -1, 0] })
    // two section faces (left and right of the hole), each one loop
    expect(r.cut.length).toBe(2)
    expect(r.cut.every((f) => f.length === 1)).toBe(true)
    expect(r.visible.length).toBeGreaterThan(4)
  })
})
