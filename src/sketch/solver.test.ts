/** planegcs-backed sketch solver, run for real in Node. */
import { beforeAll, describe, expect, it } from 'vitest'
import { analyze, ensureSolver, solveModel } from './solver'
import { freedom, maxResidual } from './dof'
import { addArc, addCircle, addCoincident, addConstraint, addLine, addPoint, entityById, pos, removeIds, tangentValue } from './model'
import { ORIGIN, emptyModel, type SketchModel } from './types'
import { dist } from './geom'

beforeAll(async () => { await ensureSolver() })

/** Axis-aligned rectangle (H/V constraints) with its lower-left corner coincident with the origin. */
function rect(m: SketchModel, w: number, h: number, x0 = 0, y0 = 0) {
  const p = [addPoint(m, x0, y0), addPoint(m, x0 + w, y0), addPoint(m, x0 + w, y0 + h), addPoint(m, x0, y0 + h)]
  const l = p.map((id, i) => addLine(m, id, p[(i + 1) % 4]).id)
  addConstraint(m, { type: 'horizontal', refs: [l[0]] })
  addConstraint(m, { type: 'horizontal', refs: [l[2]] })
  addConstraint(m, { type: 'vertical', refs: [l[1]] })
  addConstraint(m, { type: 'vertical', refs: [l[3]] })
  return { p, l }
}
const dimW = (m: SketchModel, p: string[], v: number) => addConstraint(m, { type: 'hdist', refs: [p[0], p[1]], value: v, sgn: 1, expr: String(v), off: [0, 0] })
const dimH = (m: SketchModel, p: string[], v: number) => addConstraint(m, { type: 'vdist', refs: [p[1], p[2]], value: v, sgn: 1, expr: String(v), off: [0, 0] })

describe('solver: constraints, DOF and fully-constrained detection', () => {
  it('a rectangle with width, height and a coincident corner is fully constrained', () => {
    const m = emptyModel()
    const r = rect(m, 40, 20)
    addCoincident(m, r.p[0], ORIGIN)
    dimW(m, r.p, 40)
    dimH(m, r.p, 20)
    const s = solveModel(m)
    expect(s.info.ok).toBe(true)
    expect(s.info.dof).toBe(0)
    expect(s.info.conflicts).toEqual([])
    const fixed = analyze(s.model, s.info)
    for (const e of s.model.entities) expect(fixed.has(e.id)).toBe(true)
    expect(pos(s.model, r.p[2])[0]).toBeCloseTo(40)
    expect(pos(s.model, r.p[2])[1]).toBeCloseTo(20)
  })

  it('dimensions drive the geometry: distorted rectangle snaps to its dimensions', () => {
    const m = emptyModel()
    const r = rect(m, 33, 27) // drawn at the wrong size
    addCoincident(m, r.p[0], ORIGIN)
    dimW(m, r.p, 40)
    dimH(m, r.p, 20)
    const s = solveModel(m)
    expect(s.info.dof).toBe(0)
    expect(pos(s.model, r.p[1])).toEqual([expect.closeTo(40, 6), expect.closeTo(0, 6)])
    expect(pos(s.model, r.p[3])[1]).toBeCloseTo(20, 6)
  })

  it('missing height: only the geometry that is still free is reported as under-constrained', () => {
    const m = emptyModel()
    const r = rect(m, 40, 20)
    addCoincident(m, r.p[0], ORIGIN)
    dimW(m, r.p, 40)
    const s = solveModel(m)
    expect(s.info.dof).toBe(1)
    const fixed = analyze(s.model, s.info)
    expect(fixed.has(r.p[0])).toBe(true)
    expect(fixed.has(r.p[1])).toBe(true)
    expect(fixed.has(r.p[2])).toBe(false)
    expect(fixed.has(r.p[3])).toBe(false)
    expect(fixed.has(r.l[0])).toBe(true) // bottom edge is pinned
    expect(fixed.has(r.l[2])).toBe(false) // top edge floats
  })

  it('a floating rectangle is entirely free', () => {
    const m = emptyModel()
    const r = rect(m, 10, 10, 5, 5)
    const s = solveModel(m)
    expect(s.info.dof).toBe(4)
    const fixed = analyze(s.model, s.info)
    for (const id of [...r.p, ...r.l]) expect(fixed.has(id)).toBe(false)
  })

  it('a conflicting dimension is reported and the solve fails', () => {
    const m = emptyModel()
    const r = rect(m, 40, 20)
    addCoincident(m, r.p[0], ORIGIN)
    const a = dimW(m, r.p, 40)
    const b = addConstraint(m, { type: 'distance', refs: [r.p[0], r.p[1]], value: 55, expr: '55', off: [0, 0] })
    const s = solveModel(m)
    expect(s.info.ok).toBe(false)
    expect(s.info.conflicts).toEqual(expect.arrayContaining([a.id, b.id]))
    // the input model is never modified by a failed solve
    expect(pos(m, r.p[1])[0]).toBe(40)
  })

  it('a redundant dimension solves but is reported', () => {
    const m = emptyModel()
    const r = rect(m, 40, 20)
    addCoincident(m, r.p[0], ORIGIN)
    dimW(m, r.p, 40)
    const dup = addConstraint(m, { type: 'distance', refs: [r.p[0], r.p[1]], value: 40, expr: '40', off: [0, 0] })
    const s = solveModel(m)
    expect(s.info.ok).toBe(true)
    expect(s.info.conflicts).toEqual([])
    expect(s.info.redundant.length).toBe(1)
    expect([dup.id, m.constraints.find((c) => c.type === 'hdist')!.id]).toContain(s.info.redundant[0])
  })

  it('coincident is a real constraint: deleting it frees the points again', () => {
    const m = emptyModel()
    const a = addPoint(m, 0, 0), b = addPoint(m, 10, 0), c = addPoint(m, 10.2, 0.1), d = addPoint(m, 10, 10)
    addLine(m, a, b)
    addLine(m, c, d)
    const co = addCoincident(m, b, c)!
    let s = solveModel(m)
    expect(dist(pos(s.model, b), pos(s.model, c))).toBeLessThan(1e-6)
    // drag b: c follows through the constraint
    s = solveModel(s.model, { points: { [b]: [20, 5] } })
    expect(dist(pos(s.model, b), pos(s.model, c))).toBeLessThan(1e-6)
    expect(pos(s.model, c)[0]).toBeGreaterThan(15)
    // remove the constraint: the points are independent again
    removeIds(m, [co.id])
    expect(m.constraints.length).toBe(0)
    s = solveModel(m, { points: { [b]: [20, 5] } })
    expect(pos(s.model, c)[0]).toBeCloseTo(10.2, 3)
    // deleting a line removes its end points and the coincident constraint that referenced them
    const m2 = emptyModel()
    const q = [addPoint(m2, 0, 0), addPoint(m2, 5, 0), addPoint(m2, 5, 0), addPoint(m2, 5, 5)]
    const l1 = addLine(m2, q[0], q[1]), l2 = addLine(m2, q[2], q[3])
    addCoincident(m2, q[1], q[2])
    removeIds(m2, [l1.id])
    expect(m2.entities.map((e) => e.id).sort()).toEqual([q[2], q[3], l2.id].sort())
    expect(m2.constraints.length).toBe(0)
  })

  it('angle (to the X axis, and between lines), perpendicular and offset constraints', () => {
    const m = emptyModel()
    const a = addPoint(m, 0, 0), b = addPoint(m, 10, 1)
    const l = addLine(m, a, b)
    addCoincident(m, a, ORIGIN)
    addConstraint(m, { type: 'distance', refs: [a, b], value: 10, expr: '10', off: [0, 0] })
    addConstraint(m, { type: 'angle', refs: [l.id], value: 30, sgn: 1, expr: '30', off: [0, 0] })
    let s = solveModel(m)
    expect(s.info.ok).toBe(true)
    expect(s.info.dof).toBe(0)
    expect(Math.atan2(pos(s.model, b)[1], pos(s.model, b)[0]) * 180 / Math.PI).toBeCloseTo(30, 4)

    // angle between two lines
    const m2 = emptyModel()
    const p = [addPoint(m2, 0, 0), addPoint(m2, 10, 0), addPoint(m2, 0, 0.5), addPoint(m2, 8, 6)]
    const l1 = addLine(m2, p[0], p[1]), l2 = addLine(m2, p[2], p[3])
    addCoincident(m2, p[0], ORIGIN)
    addCoincident(m2, p[2], p[0])
    addConstraint(m2, { type: 'horizontal', refs: [l1.id] })
    addConstraint(m2, { type: 'angle', refs: [l1.id, l2.id], value: 60, sgn: 1, expr: '60', off: [0, 0] })
    s = solveModel(m2)
    expect(s.info.ok).toBe(true)
    const d = pos(s.model, p[3])
    expect(Math.atan2(d[1], d[0]) * 180 / Math.PI).toBeCloseTo(60, 4)

    // offset constraint between two circles: concentric, radius differs by 4
    const m3 = emptyModel()
    const c0 = addPoint(m3, 0, 0), c1 = addPoint(m3, 0, 0)
    const k0 = addCircle(m3, c0, 10), k1 = addCircle(m3, c1, 13)
    addCoincident(m3, c0, c1)
    addConstraint(m3, { type: 'radius', refs: [k0.id], value: 10, expr: '10', off: [0, 0] })
    addConstraint(m3, { type: 'offset', refs: [k1.id, k0.id], value: 4, sgn: 1, expr: '4', off: [0, 0] })
    s = solveModel(m3)
    expect(s.info.ok).toBe(true)
    expect((entityById(s.model, k1.id) as { r: number }).r).toBeCloseTo(14, 6)
  })

  it('dragging with temporary constraints keeps real constraints and never reduces DOF', () => {
    const m = emptyModel()
    const r = rect(m, 40, 20)
    addCoincident(m, r.p[0], ORIGIN)
    dimW(m, r.p, 40)
    // pull the top-right corner far away: width is held by the dimension, the corner can only move vertically
    const s = solveModel(m, { points: { [r.p[2]]: [90, 70] } })
    expect(s.info.ok).toBe(true)
    expect(s.info.dof).toBe(1)
    expect(pos(s.model, r.p[2])[0]).toBeCloseTo(40, 4)
    expect(pos(s.model, r.p[2])[1]).toBeGreaterThan(40)
    expect(pos(s.model, r.p[3])[1]).toBeCloseTo(pos(s.model, r.p[2])[1], 4)
    // pulling a point that is fully determined does nothing
    const t = solveModel(s.model, { points: { [r.p[0]]: [5, 5] } })
    expect(pos(t.model, r.p[0])).toEqual([expect.closeTo(0, 5), expect.closeTo(0, 5)])
  })

  it('dragging a circle through a point changes its radius', () => {
    const m = emptyModel()
    const c = addPoint(m, 0, 0)
    const k = addCircle(m, c, 10)
    const s = solveModel(m, { curve: { id: k.id, to: [0, 25] } })
    expect(s.info.ok).toBe(true)
    expect((entityById(s.model, k.id) as { r: number }).r).toBeCloseTo(25, 3)
  })

  it('fully-constrained detection stays fast on a large sketch', () => {
    const m = emptyModel()
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 10; j++) {
        const r = rect(m, 8, 6, i * 12, j * 10)
        if (j % 2 === 0) { // half of them get pinned and dimensioned
          addCoincident(m, r.p[0], ORIGIN) // each pinned to the origin is impossible; use fix instead
          m.constraints.pop()
          addConstraint(m, { type: 'fix', refs: [r.p[0]] })
          dimW(m, r.p, 8)
          dimH(m, r.p, 6)
        }
      }
    }
    expect(m.entities.length).toBeGreaterThan(900)
    const t0 = performance.now()
    const s = solveModel(m)
    expect(s.info.ok).toBe(true)
    const fixed = analyze(s.model, s.info)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(8000)
    // pinned+dimensioned rectangles are fixed, the others are not
    const lines = s.model.entities.filter((e) => e.type === 'line')
    const nFixed = lines.filter((l) => fixed.has(l.id)).length
    expect(nFixed).toBe(60 * 4)
    expect(lines.length - nFixed).toBe(60 * 4)
  })
})

describe('independent Jacobian analysis agrees with planegcs', () => {
  /** solve with planegcs, then check: same DOF, every constraint satisfied by the result */
  const agree = (m: SketchModel) => {
    const s = solveModel(m)
    expect(s.info.ok).toBe(true)
    expect(maxResidual(s.model)).toBeLessThan(1e-6)
    expect(freedom(s.model).dof).toBe(s.info.dof)
    return s
  }

  it('rectangles with various dimension sets', () => {
    for (const dims of [[], ['w'], ['h'], ['w', 'h'], ['w', 'h', 'o']]) {
      const m = emptyModel()
      const r = rect(m, 40, 20, 3, 4)
      if (dims.includes('w')) dimW(m, r.p, 40)
      if (dims.includes('h')) dimH(m, r.p, 20)
      if (dims.includes('o')) addCoincident(m, r.p[0], ORIGIN)
      agree(m)
    }
  })

  it('tangent line / circle, tangent circles, point on curve, equal, midpoint, parallel, perpendicular', () => {
    const m = emptyModel()
    const c1 = addPoint(m, 0, 0), c2 = addPoint(m, 25, 0)
    const k1 = addCircle(m, c1, 10), k2 = addCircle(m, c2, 15)
    addConstraint(m, { type: 'tangent', refs: [k1.id, k2.id] })
    addCoincident(m, c1, ORIGIN)
    addConstraint(m, { type: 'radius', refs: [k1.id], value: 10, expr: '10', off: [0, 0] })
    addConstraint(m, { type: 'onAxis', refs: [c2], axis: 'x' })
    const a = addPoint(m, -20, 10), b = addPoint(m, 20, 10)
    const l = addLine(m, a, b)
    addConstraint(m, { type: 'horizontal', refs: [l.id] })
    addConstraint(m, { type: 'tangent', refs: [l.id, k1.id] })
    const p = addPoint(m, 5, 20), q = addPoint(m, 8, 30)
    const l2 = addLine(m, p, q)
    addConstraint(m, { type: 'perpendicular', refs: [l.id, l2.id] })
    const r = addPoint(m, 40, 40), t = addPoint(m, 50, 41)
    const l3 = addLine(m, r, t)
    addConstraint(m, { type: 'parallel', refs: [l3.id, l.id] })
    addConstraint(m, { type: 'equal', refs: [l3.id, l.id] })
    const mid = addPoint(m, 30, 45)
    addConstraint(m, { type: 'midpoint', refs: [mid, l3.id] })
    agree(m)
  })

  it('arc tangent to a line at their shared end (tangentAt) and radius dimension', () => {
    const m = emptyModel()
    const a = addPoint(m, 0, 0), b = addPoint(m, 20, 0)
    const l = addLine(m, a, b)
    addCoincident(m, a, ORIGIN)
    addConstraint(m, { type: 'horizontal', refs: [l.id] })
    addConstraint(m, { type: 'distance', refs: [a, b], value: 20, expr: '20', off: [0, 0] })
    const c = addPoint(m, 20, 8), s = addPoint(m, 20.2, 0.1), e = addPoint(m, 28, 8)
    const arc = addArc(m, c, s, e)
    addCoincident(m, s, b)
    addConstraint(m, { type: 'tangentAt', refs: [l.id, arc.id, b], value: tangentValue(m, l.id, arc.id, b) })
    addConstraint(m, { type: 'radius', refs: [arc.id], value: 8, expr: '8', off: [0, 0] })
    const sol = agree(m)
    // the arc starts at (20, 0), centre straight above: perpendicular to the line there
    expect(pos(sol.model, (entityById(sol.model, arc.id) as { c: string }).c)[0]).toBeCloseTo(20, 5)
    expect(pos(sol.model, (entityById(sol.model, arc.id) as { c: string }).c)[1]).toBeCloseTo(8, 5)
  })
})
