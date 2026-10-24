/** The inference engine: which relation wins for given geometry and cursor positions. */
import { describe, expect, it } from 'vitest'
import { inferSnap, type InferCtx } from './infer'
import { addArc, addCircle, addLine, addPoint } from './model'
import { defaultSnapFlags } from './snapSettings'
import { emptyModel, type SketchModel, type Vec2 } from './types'

const ctx = (m: SketchModel, anchor: Vec2 | undefined, woken: string[] = [], over: Partial<InferCtx> = {}): InferCtx => ({
  model: m, wpp: 0.1, grid: false, anchor, flags: { ...defaultSnapFlags, grid: false }, woken: new Set(woken), ...over,
})

describe('inference', () => {
  it('parallel to a woken line', () => {
    const m = emptyModel()
    const l = addLine(m, addPoint(m, 0, 10), addPoint(m, 20, 18)) // direction (20, 8)
    // from (0, 0) toward a point a hair off the parallel direction
    const s = inferSnap([30, 12.2], ctx(m, [0, 0], [l.id]))
    expect(s.rel?.map((r) => r.type)).toContain('parallel')
    expect(s.refs).toContain(l.id)
    expect(s.pos[1] / s.pos[0]).toBeCloseTo(0.4, 6)
    expect(s.guides.length).toBeGreaterThan(0)
  })

  it('perpendicular to a woken line', () => {
    const m = emptyModel()
    const l = addLine(m, addPoint(m, 0, 10), addPoint(m, 20, 18))
    const s = inferSnap([-4.1, 10.1], ctx(m, [0, 0], [l.id]))
    expect(s.rel?.[0]).toEqual({ type: 'perpendicular', ref: l.id })
    expect(s.pos[0] * 20 + s.pos[1] * 8).toBeCloseTo(0, 6)
  })

  it('extends a line from its end', () => {
    const m = emptyModel()
    const a = addPoint(m, 0, 0), b = addPoint(m, 10, 5)
    const l = addLine(m, a, b)
    const s = inferSnap([20.1, 10.0], ctx(m, [10, 5], [l.id], { anchorId: b }))
    expect(s.rel?.some((r) => r.type === 'collinear' && r.ref === l.id)).toBe(true)
    expect(s.pos[1]).toBeCloseTo(s.pos[0] / 2, 6)
  })

  it('horizontal and vertical lock, and sketch axes win over nothing', () => {
    const m = emptyModel()
    expect(inferSnap([10, 0.2], ctx(m, [0, 0])).rel?.[0]).toEqual({ type: 'horizontal' })
    expect(inferSnap([0.2, 10], ctx(m, [0, 0])).rel?.[0]).toEqual({ type: 'vertical' })
    expect(inferSnap([10, 5], ctx(m, [0, 0])).rel ?? []).toEqual([])
  })

  it('tangent leaving the end of an arc', () => {
    const m = emptyModel()
    const c = addPoint(m, 0, 0), s0 = addPoint(m, 10, 0), e0 = addPoint(m, 0, 10)
    const arc = addArc(m, c, s0, e0)
    // at (0, 10) the counter-clockwise tangent points along -x
    const s = inferSnap([-10, 10.1], ctx(m, [0, 10], [], { anchorId: e0 }))
    expect(s.rel?.[0]).toEqual({ type: 'tangent', ref: arc.id, at: e0 })
    expect(s.pos[1]).toBeCloseTo(10, 6)
  })

  it('tangent to a circle: the end lands on the tangent point', () => {
    const m = emptyModel()
    const c = addCircle(m, addPoint(m, 20, 0), 5)
    // from (0, 0) the tangent point of the upper tangent
    const d = 20, a = Math.acos(5 / d)
    const t: Vec2 = [20 + 5 * Math.cos(Math.PI + a), 5 * Math.sin(Math.PI + a)]
    const s = inferSnap([t[0] + 0.3, t[1] + 0.2], ctx(m, [0, 0], [c.id]))
    expect(s.rel?.[0]).toEqual({ type: 'tangent', ref: c.id })
    expect(Math.hypot(s.pos[0] - t[0], s.pos[1] - t[1])).toBeLessThan(1e-9)
  })

  it('points beat relations; quadrants and intersections are offered', () => {
    const m = emptyModel()
    const l = addLine(m, addPoint(m, 0, 10), addPoint(m, 30, 10))
    const q = inferSnap([30.2, 10.1], ctx(m, [0, 0]))
    expect(q.kind).toBe('point')
    const c = addCircle(m, addPoint(m, 50, 50), 5)
    expect(inferSnap([55.1, 49.9], ctx(m, undefined)).kind).toBe('quad')
    const l2 = addLine(m, addPoint(m, 10, 0), addPoint(m, 10, 30))
    const i = inferSnap([10.2, 10.1], ctx(m, undefined))
    expect(i.kind).toBe('int')
    expect(i.entityIds?.sort()).toEqual([l.id, l2.id].sort())
    expect(c.id).toBeTruthy()
  })

  it('equal length to another line', () => {
    const m = emptyModel()
    const l = addLine(m, addPoint(m, 0, 20), addPoint(m, 0, 27))
    void l
    const s = inferSnap([7.1, 0.2], ctx(m, [0, 0], [], { woken: new Set([l.id]) }))
    expect(s.rel?.some((r) => r.type === 'equal' && r.ref === l.id)).toBe(true)
    expect(s.pos[0]).toBeCloseTo(7, 6)
  })

  it('angle steps of 15 degrees when enabled', () => {
    const m = emptyModel()
    const flags = { ...defaultSnapFlags, grid: false, angle15: true }
    const a = Math.PI / 12
    const s = inferSnap([10 * Math.cos(a) + 0.05, 10 * Math.sin(a) - 0.05], ctx(m, [0, 0], [], { flags }))
    expect(Math.atan2(s.pos[1], s.pos[0])).toBeCloseTo(a, 6)
    expect(s.hint).toBe('15°')
    expect(s.rel).toEqual([])
  })

  it('every relation can be switched off', () => {
    const m = emptyModel()
    const l = addLine(m, addPoint(m, 0, 10), addPoint(m, 20, 18))
    const flags = { ...defaultSnapFlags, grid: false, parallel: false, horizontalVertical: false }
    const s = inferSnap([30, 12.2], ctx(m, [0, 0], [l.id], { flags }))
    expect(s.rel ?? []).toEqual([])
  })

  it('the tolerance follows the zoom: far from the ray nothing is inferred', () => {
    const m = emptyModel()
    const l = addLine(m, addPoint(m, 0, 10), addPoint(m, 20, 18))
    expect(inferSnap([30, 14], ctx(m, [0, 0], [l.id])).rel?.some((r) => r.type === 'parallel') ?? false).toBe(false)
    // zoomed far out the same offset is within a few pixels
    expect(inferSnap([30, 12.4], ctx(m, [0, 0], [l.id], { wpp: 1 })).rel?.some((r) => r.type === 'parallel')).toBe(true)
  })

  it('shift keeps the locked direction', () => {
    const m = emptyModel()
    const s = inferSnap([10, 7], ctx(m, [0, 0], [], { lock: { dir: [1, 0] } }))
    expect(s.pos[1]).toBeCloseTo(0, 9)
  })

  it('perpendicular to a circle is radial: the line aims at the centre', () => {
    const m = emptyModel()
    const centre = addPoint(m, 50, 30)
    const c = addCircle(m, centre, 10)
    // from (0, 0) the centre lies along (50, 30)
    const s = inferSnap([80, 48.6], ctx(m, [0, 0], [c.id]))
    expect(s.rel?.[0]).toEqual({ type: 'radial', ref: c.id, center: centre })
    expect(s.pos[1] / s.pos[0]).toBeCloseTo(0.6, 6)
    expect(s.hint).toContain('radial')
  })

  it('tangent points only count where the arc really is', () => {
    const m = emptyModel()
    // a quarter arc in the upper right of a circle at (50, 0): the lower tangent point from the origin is not on it
    const arc = addArc(m, addPoint(m, 50, 0), addPoint(m, 60, 0), addPoint(m, 50, 10))
    const d = 50, r = 10, a = Math.acos(r / d)
    const lower: Vec2 = [50 + r * Math.cos(Math.PI + a), r * Math.sin(Math.PI + a)]
    const s = inferSnap([lower[0] + 0.3, lower[1] - 0.2], ctx(m, [0, 0], [arc.id]))
    expect(s.rel?.some((r) => r.type === 'tangent') ?? false).toBe(false)
  })
})
