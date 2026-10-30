/** An L bracket drawn with the line tool the way a person does, with snapping on and loose clicks: round values, a square outline, dimensions that open their box. */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyDimEdit, beginSketch, pointerDown, pointerMove, pointerUp, setTool, setWpp, useSketch } from './store'
import { ensureSolver } from './solver'
import { pos } from './model'
import { useUi } from '@/store/ui'
import type { LineE, Vec2 } from './types'

const PLANE = { origin: [0, 0, 0] as [number, number, number], xDir: [1, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }
const MODS = { shift: false, ctrl: false }
const WPP = 0.05
const st = () => useSketch.getState()
const click = (p: Vec2) => { pointerMove(p, WPP, MODS); pointerDown(p, WPP, MODS, [0, 0]); pointerUp(p, WPP, MODS) }
const lines = () => st().model.entities.filter((e): e is LineE => e.type === 'line')
const ends = (l: LineE) => [pos(st().model, l.p1), pos(st().model, l.p2)] as const

/** (0,0) -> right -> up -> left -> up -> left -> back down to the origin, each click a few pixels off */
const L: Vec2[] = [[0.1, 0.12], [60.17, 0.2], [60.2, 10.13], [10.18, 9.9], [10.1, 40.17], [0.15, 40.2], [0.1, 0.14]]
const ROUND = (v: number) => Math.abs(v - Math.round(v)) < 1e-6

async function drawL() {
  setTool('line')
  for (const p of L) click(p)
}

beforeEach(async () => {
  await ensureSolver()
  await beginSketch({ plane: PLANE })
  setWpp(WPP)
  useUi.setState({ snap: true })
})

describe('an L drawn with loose clicks', () => {
  it('every point lands on a round value', async () => {
    await drawL()
    expect(lines()).toHaveLength(6)
    for (const l of lines()) for (const q of ends(l)) { expect(ROUND(q[0]), String(q)).toBe(true); expect(ROUND(q[1]), String(q)).toBe(true) }
  })

  it('the closing segment is constrained like the others: perpendicular to the one before it, and nothing equal by accident', async () => {
    await drawL()
    const ls = lines()
    const closing = ls[5], before = ls[4]
    const k = st().model.constraints
    expect(k.some((c) => c.type === 'perpendicular' && c.refs.includes(closing.id) && c.refs.includes(before.id))).toBe(true)
    expect(k.some((c) => c.type === 'equal')).toBe(false)
    expect(st().info.ok).toBe(true)
    expect(st().info.conflicts).toEqual([])
  })

  it('dimensions open their value box when the button comes up, and the L stays square when they are applied', async () => {
    await drawL()
    setTool('dimension')
    // the bottom edge: pick it, then click where the dimension goes
    pointerMove([30, 0], WPP, MODS); pointerDown([30, 0], WPP, MODS, [0, 0]); pointerUp([30, 0], WPP, MODS)
    expect(st().dimEdit).toBeNull()
    pointerMove([30, -6], WPP, MODS); pointerDown([30, -6], WPP, MODS, [0, 0])
    // (not yet: the browser would take the focus back from a box that opens on the press)
    expect(st().dimEdit).toBeNull()
    pointerUp([30, -6], WPP, MODS)
    const id = st().dimEdit
    expect(id).toBeTruthy()
    expect(st().dimNew).toBe(true)
    expect(applyDimEdit(id!, '70')).toBe(true)
    expect(st().dimEdit).toBeNull()
    for (const l of lines()) {
      const [a, b] = ends(l)
      expect(Math.min(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])), String([a, b])).toBeLessThan(1e-6)
    }
    // only the right-hand end moved: the left leg stays where it was drawn
    const left = lines()[5]
    expect(ends(left)[0][0]).toBeCloseTo(0, 6)
    expect(ends(left)[0][1]).toBeCloseTo(40, 6)
    expect(ends(lines()[0])[1][0]).toBeCloseTo(70, 6)
  })

  it('changing a dimension does not shuffle geometry it has nothing to do with', async () => {
    await drawL()
    const before = new Map(st().model.entities.filter((e) => e.type === 'point').map((e) => [e.id, pos(st().model, e.id)]))
    setTool('dimension')
    pointerMove([5, 40], WPP, MODS); pointerDown([5, 40], WPP, MODS, [0, 0]); pointerUp([5, 40], WPP, MODS)
    pointerMove([5, 46], WPP, MODS); pointerDown([5, 46], WPP, MODS, [0, 0]); pointerUp([5, 46], WPP, MODS)
    expect(applyDimEdit(st().dimEdit!, '12')).toBe(true)
    // the top of the left leg is 10 wide: widening it moves the points on its right, never the left edge or the base
    for (const [id, p] of before) {
      const now = pos(st().model, id)
      if (p[0] === 0) expect(now[0], id).toBeCloseTo(0, 6)
      if (p[1] === 0) expect(now[1], id).toBeCloseTo(0, 6)
    }
  })
})
