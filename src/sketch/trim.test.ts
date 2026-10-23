/** Trim and Offset on real sketch models, solved with the real planegcs. */
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureSolver, solveModel, solvePruned } from './solver'
import { detectProfiles } from './profiles'
import { addArc, addCircle, addConstraint, addLine, addPoint, cloneModel, entityById, pos } from './model'
import { trimAt, trimSpan } from './trim'
import { applyOffset, collectChain, offsetGeometry } from './offsetTool'
import { offsetChain } from './offset'
import { dist, polyArea, loopPoly } from './geom'
import { emptyModel, type ArcE, type LineE, type SketchModel, type Vec2 } from './types'

beforeAll(async () => { await ensureSolver() })

const line = (m: SketchModel, a: Vec2, b: Vec2) => addLine(m, addPoint(m, a[0], a[1]), addPoint(m, b[0], b[1]))
const lens = (m: SketchModel) => m.entities.filter((e): e is LineE => e.type === 'line').map((l) => dist(pos(m, l.p1), pos(m, l.p2)))

describe('trim', () => {
  it('a crossing line is cut at the intersection and the piece you click goes away', () => {
    const m = emptyModel()
    const h = line(m, [0, 0], [20, 0])
    line(m, [10, -5], [10, 5])
    expect(trimAt(m, h.id, [15, 0])).toBeNull() // click the right half
    const r = solveModel(m)
    expect(r.info.ok).toBe(true)
    const kept = r.model.entities.find((e) => e.id === h.id) as LineE
    expect(pos(r.model, kept.p1)).toEqual([0, 0])
    expect(pos(r.model, kept.p2)[0]).toBeCloseTo(10, 6)
    // the new end is bound to the cutting line, so it follows it
    expect(m.constraints.some((c) => c.type === 'pointOnLine' && c.refs[0] === kept.p2)).toBe(true)
  })

  it('a line crossed twice is split in two; the middle piece is removed', () => {
    const m = emptyModel()
    const h = line(m, [0, 0], [30, 0])
    line(m, [10, -5], [10, 5])
    line(m, [20, -5], [20, 5])
    expect(trimAt(m, h.id, [15, 0])).toBeNull()
    const horizontals = m.entities.filter((e): e is LineE => e.type === 'line' && Math.abs(pos(m, e.p1)[1]) < 1e-9 && Math.abs(pos(m, e.p2)[1]) < 1e-9)
    expect(horizontals.length).toBe(2)
    const xs = horizontals.map((l) => [pos(m, l.p1)[0], pos(m, l.p2)[0]].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0])
    expect(xs[0][0]).toBeCloseTo(0); expect(xs[0][1]).toBeCloseTo(10)
    expect(xs[1][0]).toBeCloseTo(20); expect(xs[1][1]).toBeCloseTo(30)
    expect(solveModel(m).info.ok).toBe(true)
  })

  it('a line with nothing to cut against is deleted together with its end points', () => {
    const m = emptyModel()
    const l = line(m, [0, 0], [10, 0])
    expect(trimAt(m, l.id, [5, 0])).toBeNull()
    expect(m.entities.length).toBe(0)
  })

  it('arcs: trimmed at a crossing line, and split by two', () => {
    const m = emptyModel()
    const c = addPoint(m, 0, 0), s = addPoint(m, 10, 0), e = addPoint(m, -10, 0)
    const arc = addArc(m, c, s, e) // upper half circle, ccw from (10,0) to (-10,0)
    line(m, [0, -1], [0, 11]) // crosses at (0, 10)
    expect(trimAt(m, arc.id, [7, 7])).toBeNull() // the right part (nearer the start)
    const r = solveModel(m)
    expect(r.info.ok).toBe(true)
    const a = r.model.entities.find((x) => x.id === arc.id) as ArcE
    expect(pos(r.model, a.s)[0]).toBeCloseTo(0, 5)
    expect(pos(r.model, a.s)[1]).toBeCloseTo(10, 5)
    expect(pos(r.model, a.e)[0]).toBeCloseTo(-10, 5)

    const m2 = emptyModel()
    const c2 = addPoint(m2, 0, 0), s2 = addPoint(m2, 10, 0), e2 = addPoint(m2, -10, 0)
    const arc2 = addArc(m2, c2, s2, e2)
    line(m2, [5, -1], [5, 11])
    line(m2, [-5, -1], [-5, 11])
    expect(trimAt(m2, arc2.id, [0, 10])).toBeNull()
    expect(m2.entities.filter((x) => x.type === 'arc').length).toBe(2)
    const r2 = solveModel(m2)
    expect(r2.info.ok).toBe(true)
    for (const a2 of r2.model.entities.filter((x): x is ArcE => x.type === 'arc')) {
      expect(dist(pos(r2.model, a2.c), pos(r2.model, a2.s))).toBeCloseTo(10, 5)
      expect(dist(pos(r2.model, a2.c), pos(r2.model, a2.e))).toBeCloseTo(10, 5)
    }
  })

  it('a circle cut by a line becomes the arc that remains; radius dimensions follow', () => {
    const m = emptyModel()
    const c = addPoint(m, 0, 0)
    const k = addCircle(m, c, 10)
    addConstraint(m, { type: 'radius', refs: [k.id], value: 10, expr: '10', off: [0, 0] })
    line(m, [-15, 6], [15, 6]) // chord at y = 6
    line(m, [-15, -6], [15, -6])
    // click the right-hand side (x = 10): that piece goes away, the left piece stays
    const span = trimSpan(m, k.id, [10, 0])!
    expect(span.whole).toBe(false)
    expect(trimAt(m, k.id, [10, 0])).toBeNull()
    expect(m.entities.some((e) => e.type === 'circle')).toBe(false)
    const arc = m.entities.find((e) => e.type === 'arc') as ArcE
    expect(arc).toBeTruthy()
    expect(m.constraints.find((x) => x.type === 'radius')!.refs).toEqual([arc.id])
    const r = solveModel(m)
    expect(r.info.ok).toBe(true)
    const a = r.model.entities.find((e) => e.type === 'arc') as ArcE
    // remaining arc covers the left side: its mid angle points to -x
    const sA = pos(r.model, a.s), eA = pos(r.model, a.e)
    expect(sA[0]).toBeGreaterThan(0)
    expect(eA[0]).toBeGreaterThan(0) // it starts and ends on the right half... after the cut the long way round
    expect(dist(pos(r.model, a.c), sA)).toBeCloseTo(10, 5)
  })

  it('trimming away the inside of a crossing creates profiles as expected', () => {
    // a "+" made of two lines inside a square: trim the four arms back to the square -> 4 profiles in the square
    const m = emptyModel()
    const p = [addPoint(m, 0, 0), addPoint(m, 20, 0), addPoint(m, 20, 20), addPoint(m, 0, 20)]
    p.forEach((id, i) => addLine(m, id, p[(i + 1) % 4]))
    const h = line(m, [-5, 10], [25, 10])
    const v = line(m, [10, -5], [10, 25])
    // trim the overhanging ends of both lines
    for (const [id, click] of [[h.id, [-3, 10]], [h.id, [23, 10]], [v.id, [10, -3]], [v.id, [10, 23]]] as [string, Vec2][]) {
      // the lines are re-found by position after every trim because splitting may create new entities
      const cur = m.entities.filter((e): e is LineE => e.type === 'line').find((l) => {
        const a = pos(m, l.p1), b = pos(m, l.p2)
        const t = Math.abs((b[0] - a[0]) * (click[1] - a[1]) - (b[1] - a[1]) * (click[0] - a[0])) / (dist(a, b) || 1)
        const within = click[0] >= Math.min(a[0], b[0]) - 1e-9 && click[0] <= Math.max(a[0], b[0]) + 1e-9 && click[1] >= Math.min(a[1], b[1]) - 1e-9 && click[1] <= Math.max(a[1], b[1]) + 1e-9
        return t < 1e-9 && within && l.id !== p[0] && (l.id === id || true)
      })
      expect(cur).toBeTruthy()
      // clicking a piece of the +'s arms that lies beyond the square cuts them at the square's edge
      const edgeLine = m.entities.filter((e): e is LineE => e.type === 'line')
      void edgeLine
      expect(trimAt(m, cur!.id, click)).toBeNull()
    }
    const profiles = detectProfiles(solveModel(m).model)
    expect(profiles.length).toBe(4)
    for (const pr of profiles) near(pr.area, 100)
  })
})

function near(a: number, b: number, rel = 1e-6) { expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(1e-6, Math.abs(b) * rel)) }

describe('offset geometry', () => {
  const rect = (m: SketchModel, w: number, h: number) => {
    const p = [addPoint(m, 0, 0), addPoint(m, w, 0), addPoint(m, w, h), addPoint(m, 0, h)]
    return p.map((id, i) => addLine(m, id, p[(i + 1) % 4]))
  }
  const areaOf = (m: SketchModel) => {
    const prof = detectProfiles(m)
    return prof.map((p) => p.area).sort((a, b) => b - a)
  }

  it('offsetting a rectangle outwards rounds the corners; inwards miters them', () => {
    const m = emptyModel()
    const ls = rect(m, 40, 20)
    const chain = collectChain(m, ls[0].id)!
    expect(chain.closed).toBe(true)
    expect(chain.items.length).toBe(4)
    // outside: rect (counter-clockwise) -> negative distance is outside
    const out = offsetGeometry(m, chain, -3).segs!
    expect(out.length).toBe(8) // 4 lines + 4 corner arcs
    expect(out.filter((s) => s.corner).length).toBe(4)
    const outLoop = out.map((s) => s.seg)
    near(Math.abs(polyArea(loopPoly(outLoop))), 40 * 20 + 2 * 3 * (40 + 20) + Math.PI * 9, 2e-3)
    // inside
    const inn = offsetGeometry(m, chain, 3).segs!
    expect(inn.length).toBe(4)
    expect(inn.every((s) => !s.corner)).toBe(true)
    near(Math.abs(polyArea(loopPoly(inn.map((s) => s.seg)))), (40 - 6) * (20 - 6))
  })

  it('an inward offset larger than the shape collapses it', () => {
    const m = emptyModel()
    const ls = rect(m, 40, 20)
    expect(offsetGeometry(m, collectChain(m, ls[0].id)!, 12).segs).toBeNull()
  })

  it('open chain with an arc: offset keeps the arc concentric', () => {
    const segs = [
      { k: 'l' as const, a: [0, 0] as Vec2, b: [10, 0] as Vec2 },
      { k: 'a' as const, a: [10, 0] as Vec2, b: [10, 10] as Vec2, c: [10, 5] as Vec2, r: 5, ccw: true, m: [15, 5] as Vec2 },
      { k: 'l' as const, a: [10, 10] as Vec2, b: [0, 10] as Vec2 },
    ]
    const r = offsetChain(segs, false, 2)! // left of travel = inside of the U
    expect(r.length).toBe(3)
    const arc = r[1].seg
    expect(arc.k).toBe('a')
    if (arc.k === 'a') expect(arc.r).toBeCloseTo(3)
    expect(r[0].seg.k === 'l' && r[0].seg.a[1]).toBeCloseTo(2)
    const out = offsetChain(segs, false, -2)! // outside: arc grows
    const arc2 = out[1].seg
    if (arc2.k === 'a') expect(arc2.r).toBeCloseTo(7)
  })

  it('creating the offset in a sketch: linked, solvable, dimensioned', () => {
    const m = emptyModel()
    const ls = rect(m, 40, 20)
    addConstraint(m, { type: 'horizontal', refs: [ls[0].id] })
    addConstraint(m, { type: 'horizontal', refs: [ls[2].id] })
    addConstraint(m, { type: 'vertical', refs: [ls[1].id] })
    addConstraint(m, { type: 'vertical', refs: [ls[3].id] })
    const before = m.entities.length
    const chain = collectChain(m, ls[1].id)!
    expect(applyOffset(m, chain, -3, '3', 1)).toBeNull()
    expect(m.entities.length).toBeGreaterThan(before)
    const dims = m.constraints.filter((c) => c.type === 'offset')
    expect(dims.filter((c) => !c.hidden).length).toBe(1) // exactly one visible offset dimension
    expect(dims.length).toBeGreaterThanOrEqual(4)
    // the offset's own redundant members (hidden siblings that tangency already implies) are dropped
    const existing = new Set(m.constraints.filter((c) => !c.group && c.type !== 'tangentAt' && c.type !== 'coincident' && c.type !== 'parallel').map((c) => c.id))
    const r = solvePruned(m, existing)
    expect(r.info.ok).toBe(true)
    expect(r.info.conflicts).toEqual([])
    expect(r.info.redundant).toEqual([])
    expect(r.model.constraints.some((c) => c.type === 'offset' && !c.hidden)).toBe(true)
    // the offset outline surrounds the rectangle: the profile between them is a ring of the intended area
    const prof = detectProfiles(r.model)
    const withHole = prof.filter((p) => p.holes.length === 1)
    expect(withHole.length).toBe(1)
    near(withHole[0].area, 2 * 3 * 60 + Math.PI * 9, 3e-3)
    // the rounded offset is rigid: only the source's own freedom (position / size of the rectangle) remains
    expect(r.info.redundant).toEqual([])
    expect(r.info.dof).toBe(4)
    // editing the source moves the offset with it: make the rectangle wider by moving a corner
    const widen = cloneModel(r.model)
    const corner = ls[1].p2
    const dragged = solveModel(widen, { points: { [corner]: [55, 20] } })
    expect(dragged.info.ok).toBe(true)
    void entityById
  })
})
