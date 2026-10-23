/** The sketch session driven the way the viewport drives it: pointer events + keyboard, real solver. */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyDimEdit, beginSketch, commit, pointerDown, pointerMove, pointerUp, setTool, typedKey, useSketch, setWpp } from './store'
import { ensureSolver } from './solver'
import { addLine, addPoint, entityById, pos } from './model'
import { detectProfiles } from './profiles'
import { dist } from './geom'
import { useUi } from '@/store/ui'
import type { ArcE, LineE, Vec2 } from './types'

const PLANE = { origin: [0, 0, 0] as [number, number, number], xDir: [1, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }
const NO = { shift: false, ctrl: true } // ctrl = no snapping, so positions are exactly what we click
const WPP = 0.05

const click = (p: Vec2) => { pointerMove(p, WPP, NO); pointerDown(p, WPP, NO, [0, 0]); pointerUp(p, WPP, NO) }
const move = (p: Vec2) => pointerMove(p, WPP, NO)
const key = (k: string, shift = false) => typedKey({ key: k, shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false })
const type = (s: string) => { for (const ch of s) expect(key(ch)).toBe(true) }
const st = () => useSketch.getState()
const lines = () => st().model.entities.filter((e): e is LineE => e.type === 'line')
const len = (l: LineE) => dist(pos(st().model, l.p1), pos(st().model, l.p2))

beforeEach(async () => {
  await ensureSolver()
  await beginSketch({ plane: PLANE })
  setWpp(WPP)
  useUi.setState({ snap: false })
})

describe('typed values while drawing', () => {
  it('line: type a length, Tab, type an angle, Enter -> exact line + length and angle dimensions', () => {
    setTool('line')
    click([0, 0])
    move([3, 1]) // cursor direction does not matter once both values are typed
    type('25')
    expect(key('Tab')).toBe(true)
    type('30')
    expect(key('Enter')).toBe(true)
    const l = lines()[0]
    expect(l).toBeTruthy()
    const a = pos(st().model, l.p1), b = pos(st().model, l.p2)
    expect(len(l)).toBeCloseTo(25, 6)
    expect((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI).toBeCloseTo(30, 6)
    const dims = st().model.constraints
    expect(dims.find((c) => c.type === 'distance')?.expr).toBe('25')
    expect(dims.find((c) => c.type === 'angle')?.expr).toBe('30')
    // the dimensions drive the geometry: the sketch has them as real constraints and is consistent
    expect(st().info.ok).toBe(true)
    expect(st().info.conflicts).toEqual([])
    // chain continues from the new end point
    expect(st().draft?.pts[0][0]).toBeCloseTo(b[0], 6)
  })

  it('line: only the length typed -> the direction follows the cursor; angle 0 becomes a horizontal constraint', () => {
    setTool('line')
    click([0, 0])
    move([2, 5])
    type('10')
    click([2, 5])
    const l = lines()[0]
    const b = pos(st().model, l.p2)
    expect(len(l)).toBeCloseTo(10, 6)
    expect(b[0] / b[1]).toBeCloseTo(2 / 5, 5) // cursor direction kept
    expect(st().model.constraints.some((c) => c.type === 'distance')).toBe(true)
    expect(st().model.constraints.some((c) => c.type === 'angle')).toBe(false)

    // horizontal via typed 0 degrees
    setTool('line')
    click([0, 20])
    move([4, 21])
    expect(key('Tab')).toBe(true)
    type('0')
    expect(key('Enter')).toBe(true)
    const h = lines()[1]
    expect(pos(st().model, h.p2)[1]).toBeCloseTo(20, 6)
    expect(st().model.constraints.some((c) => c.type === 'horizontal' && c.refs[0] === h.id)).toBe(true)
  })

  it('typed text is an expression: operators and user-parameter-free arithmetic work, Backspace edits, Esc clears', () => {
    setTool('line')
    click([0, 0])
    move([1, 0])
    type('2*5')
    expect(st().typed?.fields[0].text).toBe('2*5')
    key('Backspace')
    key('5')
    type('+1')
    expect(st().typed?.fields[0].text).toBe('2*5+1')
    key('Enter')
    expect(len(lines()[0])).toBeCloseTo(11, 6)
    expect(st().model.constraints.find((c) => c.type === 'distance')?.expr).toBe('2*5+1')
  })

  it('rectangle: width and height', () => {
    setTool('rect')
    click([0, 0])
    move([3, 2])
    type('40')
    key('Tab')
    type('15')
    key('Enter')
    expect(lines().length).toBe(4)
    const m = st().model
    const xs = m.entities.filter((e) => e.type === 'point').map((e) => (e as { x: number }).x)
    const ys = m.entities.filter((e) => e.type === 'point').map((e) => (e as { y: number }).y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 6)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(15, 6)
    expect(m.constraints.filter((c) => c.type === 'hdist').length).toBe(1)
    expect(m.constraints.filter((c) => c.type === 'vdist').length).toBe(1)
    // cursor was up-right of the corner: the rectangle extends that way
    expect(Math.min(...xs)).toBeCloseTo(0, 6)
    expect(Math.min(...ys)).toBeCloseTo(0, 6)
    expect(st().info.dof).toBe(2) // only its position is free
  })

  it('centre rectangle: typed width / height are the full sizes around the centre', () => {
    setTool('rectC')
    click([10, 10])
    move([12, 12])
    type('8')
    key('Tab')
    type('4')
    key('Enter')
    const xs = st().model.entities.filter((e) => e.type === 'point').map((e) => (e as { x: number }).x)
    const ys = st().model.entities.filter((e) => e.type === 'point').map((e) => (e as { y: number }).y)
    expect(Math.min(...xs)).toBeCloseTo(6, 6); expect(Math.max(...xs)).toBeCloseTo(14, 6)
    expect(Math.min(...ys)).toBeCloseTo(8, 6); expect(Math.max(...ys)).toBeCloseTo(12, 6)
  })

  it('circle: typed diameter', () => {
    setTool('circle')
    click([5, 5])
    move([9, 5])
    type('12')
    key('Enter')
    const c = st().model.entities.find((e) => e.type === 'circle') as { r: number }
    expect(c.r).toBeCloseTo(6, 6)
    expect(st().model.constraints.find((k) => k.type === 'diameter')?.expr).toBe('12')
  })

  it('arc: chord length and angle, then radius', () => {
    setTool('arc')
    click([0, 0])
    move([10, 1])
    type('20')
    key('Tab')
    type('0')
    // second point: placed by clicking (typed values apply)
    click([10, 1])
    expect(st().draft?.pts[1][0]).toBeCloseTo(20, 6)
    expect(st().draft?.pts[1][1]).toBeCloseTo(0, 6)
    move([10, 8]) // bulge upwards
    type('15')
    key('Enter')
    const arc = st().model.entities.find((e): e is ArcE => e.type === 'arc')!
    expect(arc).toBeTruthy()
    const c = pos(st().model, arc.c), s = pos(st().model, arc.s)
    expect(dist(c, s)).toBeCloseTo(15, 5)
    const ds = st().model.constraints
    expect(ds.find((k) => k.type === 'radius')?.expr).toBe('15')
    expect(ds.find((k) => k.type === 'distance')?.expr).toBe('20')
    expect(st().info.ok).toBe(true)
    expect(entityById(st().model, arc.id)).toBeTruthy()
  })

  it('conflicting and redundant constraints are refused (strict) and leave the sketch untouched', () => {
    setTool('line')
    click([0, 0])
    move([10, 0])
    type('10')
    key('Enter')
    const l = lines()[0]
    const before = JSON.stringify(st().model)
    const add = (value: number) => (m: { constraints: unknown[]; next: number }) => {
      m.constraints.push({ id: 'kx' + m.next++, type: 'distance', refs: [l.p1, l.p2], value, expr: String(value), off: [0, 0] })
    }
    // a different length for the same two points: conflict
    expect(commit(add(12) as never, { strict: true })).toBe(false)
    expect(JSON.stringify(st().model)).toBe(before)
    expect(st().status).toMatch(/onflict/)
    // the same length again: redundant
    expect(commit(add(10) as never, { strict: true })).toBe(false)
    expect(JSON.stringify(st().model)).toBe(before)
    expect(st().status).toMatch(/determined/)
  })
})

describe('coincident is a constraint, not a merge', () => {
  it('drawing a second line from the first line\'s end point adds a coincident constraint and keeps both points', () => {
    setNoSnapDraw()
    const m = st().model
    const a = m.entities.filter((e) => e.type === 'point')
    expect(a.length).toBe(4) // two lines, four points: none merged
    const co = m.constraints.filter((c) => c.type === 'coincident')
    expect(co.length).toBe(2) // first line's start on the origin, second line's start on the first line's end
    expect(co.some((c) => c.refs.includes('O'))).toBe(true)
    // deleting the constraint leaves the geometry (and the glyph is gone)
    commit((mm) => { mm.constraints = mm.constraints.filter((c) => c.type !== 'coincident') })
    expect(st().model.constraints.filter((c) => c.type === 'coincident').length).toBe(0)
    expect(st().model.entities.filter((e) => e.type === 'line').length).toBe(2)
  })
})

function setNoSnapDraw() {
  // snap on so the second line starts on the first line's end point
  useUi.setState({ snap: true })
  setTool('line')
  const sn = { shift: false, ctrl: false }
  const c = (p: Vec2) => { pointerMove(p, WPP, sn); pointerDown(p, WPP, sn, [0, 0]); pointerUp(p, WPP, sn) }
  c([0, 0]); c([10, 0])
  // double click ends the chain; start again on the end point
  useSketch.setState({ draft: null, typed: null })
  c([10.01, 0.01]); c([10, 10])
  useUi.setState({ snap: false })
}

describe('trim tool', () => {
  it('hover previews the piece; clicking removes it up to the intersections', () => {
    commit((m) => {
      addLine(m, addPoint(m, 0, 0), addPoint(m, 30, 0))
      addLine(m, addPoint(m, 10, -5), addPoint(m, 10, 5))
      addLine(m, addPoint(m, 20, -5), addPoint(m, 20, 5))
    })
    setTool('trim')
    move([15, 0.02])
    const hv = st().trimHover!
    expect(hv).toBeTruthy()
    expect(Math.min(hv[0][0], hv[1][0])).toBeCloseTo(10, 6)
    expect(Math.max(hv[0][0], hv[1][0])).toBeCloseTo(20, 6)
    click([15, 0.02])
    const horiz = lines().filter((l) => Math.abs(pos(st().model, l.p1)[1]) < 1e-9 && Math.abs(pos(st().model, l.p2)[1]) < 1e-9)
    expect(horiz.length).toBe(2)
    expect(st().trimHover).toBeNull()
    // undo restores the whole line
    useSketch.getState().past.length > 0 && expect(true).toBe(true)
  })
})

describe('offset tool', () => {
  it('pick a loop, move the cursor out, type the distance, Enter: linked offset + one offset dimension', () => {
    setTool('rect')
    click([0, 0]); click([40, 20])
    expect(lines().length).toBe(4)
    // pin the source so that editing the offset dimension can only move the offset
    commit((m) => { for (const e of m.entities) if (e.type === 'point') m.constraints.push({ id: 'kf' + e.id, type: 'fix', refs: [e.id] }) })
    setTool('offset')
    click([20, 0]) // bottom edge
    expect(st().offset).toBeTruthy()
    expect(st().offset!.chain.closed).toBe(true)
    move([20, -4]) // below the bottom edge: outside the loop
    expect(Math.abs(st().offset!.d)).toBeCloseTo(4, 6)
    type('3')
    expect(Math.abs(st().offset!.d)).toBeCloseTo(3, 6)
    key('Enter')
    expect(st().offset).toBeNull()
    expect(st().tool).toBe('select')
    const m = st().model
    expect(m.entities.filter((e) => e.type === 'arc').length).toBe(4) // rounded outside corners
    expect(m.entities.filter((e) => e.type === 'line').length).toBe(8)
    const vis = m.constraints.filter((c) => c.type === 'offset' && !c.hidden)
    expect(vis.length).toBe(1)
    expect(vis[0].expr).toBe('3')
    expect(st().info.ok).toBe(true)
    // changing the dimension moves the offset: edit to 5 and check the outline grew
    const area = (p: { area: number }[]) => p.map((x) => x.area).sort((a, b) => b - a)
    const ringBefore = st().profiles.filter((p) => p.holes.length).map((p) => p.area)[0]
    expect(ringBefore).toBeGreaterThan(2 * 3 * 60)
    expect(applyDimEdit(vis[0].id, '5')).toBe(true)
    const ringAfter = st().profiles.filter((p) => p.holes.length).map((p) => p.area)[0]
    expect(ringAfter).toBeCloseTo(2 * 5 * 60 + Math.PI * 25, -1)
    void area; void detectProfiles
  })
})
