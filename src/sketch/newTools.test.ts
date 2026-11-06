/** The 3-point rectangle, circles, centre arc, curve corners, Extend / Break / Scale and the extra constraints, solved for real. */
import { beforeAll, describe, expect, it } from 'vitest'
import { applyConstraint } from './constraints'
import { chamferCurves, filletCurves } from './corners'
import { dist } from './geom'
import { breakCurve, extendCurve, scaleCurves } from './modify'
import { addArc, addCircle, addConstraint, addCoincident, addLine, addPoint, entityById, pos } from './model'
import { circleTouching, drawArcCentre, drawCircle2, drawCircle3, drawCircle2Tangent, drawRect3 } from './newShapes'
import { detectProfiles } from './profiles'
import { ensureSolver, solveModel } from './solver'
import { emptyModel, type ArcE, type CircleE, type LineE, type SketchModel, type Vec2 } from './types'

beforeAll(async () => { await ensureSolver() })

const solved = (m: SketchModel) => { const r = solveModel(m); expect(r.info.ok).toBe(true); expect(r.info.conflicts).toEqual([]); return r }
/** Hold points where they are, so a test can see what a constraint does to the rest. */
const pin = (m: SketchModel, ...ids: string[]) => { for (const id of ids) addConstraint(m, { type: 'fix', refs: [id] }) }
const line = (m: SketchModel, a: Vec2, b: Vec2) => addLine(m, addPoint(m, a[0], a[1]), addPoint(m, b[0], b[1]))

describe('3-point rectangle', () => {
  it('makes a closed, square-cornered rectangle of the right size, at any angle', () => {
    const m = emptyModel()
    const r = drawRect3(m, [0, 0], [30, 30], [10, 40])
    expect(typeof r).toBe('object')
    expect(detectProfiles(m)).toHaveLength(1)
    expect(detectProfiles(m)[0].area).toBeCloseTo(900, 6)
    expect(solved(m).info.dof).toBe(5) // x, y, turn, length, width
  })
  it('a level first side also gets a horizontal constraint', () => {
    const m = emptyModel()
    drawRect3(m, [0, 0], [30, 0], [5, -12])
    expect(m.constraints.some((c) => c.type === 'horizontal')).toBe(true)
    expect(detectProfiles(m)[0].area).toBeCloseTo(360, 6)
    expect(solved(m).info.dof).toBe(4) // x, y, length, width
  })
})

describe('circles', () => {
  it('2-point: the diameter runs between the points', () => {
    const m = emptyModel()
    const c = drawCircle2(m, [0, 0], [10, 0]) as CircleE
    expect(c.r).toBeCloseTo(5, 9)
    expect(pos(m, c.c)).toEqual([5, 0])
  })
  it('3-point: through all three points', () => {
    const m = emptyModel()
    const c = drawCircle3(m, [10, 0], [0, 10], [-10, 0]) as CircleE
    expect(c.r).toBeCloseTo(10, 9)
    expect(drawCircle3(emptyModel(), [0, 0], [1, 1], [2, 2])).toMatch(/line/)
  })
  it('2-tangent: touches two lines, where the cursor says', () => {
    const m = emptyModel()
    const a = line(m, [0, 0], [100, 0]), b = line(m, [0, 0], [0, 100])
    const hit = circleTouching(m, a, b, [8, 8])!
    expect(hit.c[0]).toBeCloseTo(hit.r, 4)
    expect(hit.c[1]).toBeCloseTo(hit.r, 4)
    expect(hit.r).toBeCloseTo(8, 1)
    const c = drawCircle2Tangent(m, a.id, b.id, [-12, 12]) as CircleE
    const s = solved(m)
    const k = entityById(s.model, c.id) as CircleE
    const [cx, cy] = pos(s.model, k.c)
    expect(Math.abs(cx)).toBeCloseTo(k.r, 4)
    expect(Math.abs(cy)).toBeCloseTo(k.r, 4)
    expect(cx).toBeLessThan(0)
    expect(m.constraints.filter((x) => x.type === 'tangent')).toHaveLength(2)
  })
  it('2-tangent: a line and a circle, and two circles', () => {
    const m = emptyModel()
    const l = line(m, [-50, 0], [50, 0])
    const big = addCircle(m, addPoint(m, 0, 30), 10)
    const c = drawCircle2Tangent(m, l.id, big.id, [25, 8]) as CircleE
    const s = solved(m)
    const k = entityById(s.model, c.id) as CircleE
    const kc = pos(s.model, k.c)
    expect(Math.abs(kc[1])).toBeCloseTo(k.r, 3)
    expect(dist(kc, [0, 30])).toBeCloseTo(10 + k.r, 3)
    const other = addCircle(m, addPoint(m, 60, 30), 10)
    expect(typeof drawCircle2Tangent(m, big.id, other.id, [30, 30])).toBe('object')
    solved(m)
  })
})

describe('centre point arc', () => {
  it('runs the short way from the start to the end ray, either side', () => {
    const m = emptyModel()
    const a = drawArcCentre(m, [0, 0], [10, 0], [0, 20]) as ArcE
    expect(pos(m, a.s)).toEqual([10, 0])
    expect(pos(m, a.e)[1]).toBeCloseTo(10, 9)
    const b = drawArcCentre(m, [0, 0], [10, 0], [0, -20]) as ArcE // clockwise: stored counter-clockwise from the end back to the start
    expect(pos(m, b.e)).toEqual([10, 0])
    solved(m)
  })
  it('a typed sweep can go past a half turn', () => {
    const m = emptyModel()
    const a = drawArcCentre(m, [0, 0], [10, 0], [0, 0], 270) as ArcE
    expect(pos(m, a.e)[1]).toBeCloseTo(-10, 9)
    expect(pos(m, a.e)[0]).toBeCloseTo(0, 9)
  })
})

describe('fillet and chamfer with arcs', () => {
  /** a level line ending at (30, 0) where a quarter arc about (50, 0) leaves downward: a corner opening to the lower left */
  function lineAndArc() {
    const m = emptyModel()
    const l = line(m, [0, 0], [30, 0])
    const C = addPoint(m, 50, 0), S = addPoint(m, 30, 0), E = addPoint(m, 50, -20)
    addCoincident(m, l.p2, S)
    const arc = addArc(m, C, S, E)
    return { m, l, arc }
  }
  it('rounds a line meeting an arc with a tangent arc of the radius', () => {
    const { m, l, arc } = lineAndArc()
    const r = filletCurves(m, l, arc, 4)
    expect(typeof r).toBe('object')
    const s = solved(m)
    const f = entityById(s.model, (r as { arc: string }).arc) as ArcE
    const c = pos(s.model, f.c)
    const radius = dist(c, pos(s.model, f.s))
    expect(radius).toBeCloseTo(4, 6)
    // tangent to the line (centre 4 above it) and to the big arc (centre 20 away from (30, 20) minus / plus 4)
    expect(c[1]).toBeCloseTo(-4, 6)
    expect(dist(c, [50, 0])).toBeCloseTo(24, 6)
    expect(s.model.constraints.filter((k) => k.type === 'tangentAt')).toHaveLength(2)
  })
  it('rounds the corner of two arcs', () => {
    const m = emptyModel()
    const S = addPoint(m, 0, 0), S2 = addPoint(m, 0, 0)
    const a1 = addArc(m, addPoint(m, 20, 0), S, addPoint(m, 20, -20)) // leaves the origin downward
    const a2 = addArc(m, addPoint(m, 0, -20), S2, addPoint(m, -20, -20)) // and this one leftward
    addCoincident(m, S, S2)
    const r = filletCurves(m, a1, a2, 3)
    expect(typeof r).toBe('object')
    solved(m)
  })
  it('refuses when the radius does not fit', () => {
    const { m, l, arc } = lineAndArc()
    expect(typeof filletCurves(m, l, arc, 500)).toBe('string')
  })
  it('chamfers a line and an arc with the distances from the corner', () => {
    const { m, l, arc } = lineAndArc()
    const r = chamferCurves(m, l, arc, 5, 6)
    expect(typeof r).toBe('object')
    const s = solved(m)
    const ch = entityById(s.model, (r as { line: string }).line) as LineE
    const K: Vec2 = [30, 0]
    const ends = [pos(s.model, ch.p1), pos(s.model, ch.p2)]
    expect(ends.map((p) => dist(p, K)).sort((a, b) => a - b).map((d) => +d.toFixed(4))).toEqual([5, 6])
  })
})

describe('Extend, Break and Scale', () => {
  it('Extend runs a free line end out to the first curve in its way', () => {
    const m = emptyModel()
    const l = line(m, [0, 0], [10, 0])
    const wall = line(m, [25, -10], [25, 10])
    line(m, [40, -10], [40, 10])
    expect(extendCurve(m, l.id, [9, 0])).toBeNull()
    const s = solved(m)
    expect(pos(s.model, l.p2)[0]).toBeCloseTo(25, 6)
    expect(m.constraints.some((c) => c.type === 'pointOnLine' && c.refs[1] === wall.id)).toBe(true)
  })
  it('Extend an arc end round to a line, and refuse an end that is joined', () => {
    const m = emptyModel()
    const C = addPoint(m, 0, 0), S = addPoint(m, 10, 0), E = addPoint(m, 0, 10)
    const arc = addArc(m, C, S, E)
    line(m, [-10, 5], [-10, -5]) // crosses the circle on the far left, a half turn on
    expect(extendCurve(m, arc.id, [0, 10])).toBeNull()
    const s = solved(m)
    const e = pos(s.model, (entityById(s.model, arc.id) as ArcE).e)
    expect(Math.hypot(...e)).toBeCloseTo(10, 6)
    const j = emptyModel()
    const a = line(j, [0, 0], [10, 0])
    addLine(j, a.p2, addPoint(j, 10, 10))
    expect(extendCurve(j, a.id, [10, 0])).toMatch(/joined/)
  })
  it('Break cuts a line at its crossings, keeping the pieces joined', () => {
    const m = emptyModel()
    const l = line(m, [0, 0], [30, 0])
    line(m, [10, -5], [10, 5])
    line(m, [20, -5], [20, 5])
    expect(breakCurve(m, l.id, [5, 0])).toBeNull()
    expect(m.entities.filter((e) => e.type === 'line')).toHaveLength(5) // 2 crossing lines + 3 pieces
    const s = solved(m)
    const pieces = s.model.entities.filter((e): e is LineE => e.type === 'line' && e.p1 !== undefined && Math.abs(pos(s.model, e.p1)[1]) < 1e-9 && Math.abs(pos(s.model, e.p2)[1]) < 1e-9)
    expect(pieces).toHaveLength(3)
  })
  it('Break at a click when nothing crosses, and a circle needs two points', () => {
    const m = emptyModel()
    const l = line(m, [0, 0], [30, 0])
    expect(breakCurve(m, l.id, [12, 0])).toBeNull()
    expect(m.entities.filter((e) => e.type === 'line')).toHaveLength(2)
    const c = addCircle(m, addPoint(m, 0, 50), 10)
    expect(breakCurve(m, c.id, [10, 50])).toMatch(/two points/)
    line(m, [-20, 50], [20, 50])
    expect(breakCurve(m, c.id, [10, 50])).toBeNull()
    expect(m.entities.filter((e) => e.type === 'arc')).toHaveLength(2)
    expect(m.entities.some((e) => e.id === c.id)).toBe(false)
    solved(m)
  })
  it('Break an arc at a crossing', () => {
    const m = emptyModel()
    const arc = addArc(m, addPoint(m, 0, 0), addPoint(m, 10, 0), addPoint(m, -10, 0))
    line(m, [0, -5], [0, 15])
    expect(breakCurve(m, arc.id, [7, 7])).toBeNull()
    expect(m.entities.filter((e) => e.type === 'arc')).toHaveLength(2)
    solved(m)
  })
  it('Scale grows the curves about a point and takes their dimensions with them', () => {
    const m = emptyModel()
    const a = addPoint(m, 10, 0), b = addPoint(m, 20, 0)
    const l = addLine(m, a, b)
    const k = addConstraint(m, { type: 'distance', refs: [a, b], value: 10, expr: '10', off: [15, 5] })
    const c = addCircle(m, addPoint(m, 0, 20), 5)
    const rd = addConstraint(m, { type: 'radius', refs: [c.id], value: 5, expr: '5', off: [3, 25] })
    expect(scaleCurves(m, { ids: [l.id, c.id], base: [0, 0], factor: 2 })).toBeNull()
    const s = solved(m)
    expect(pos(s.model, a)).toEqual([20, 0])
    expect(pos(s.model, b)).toEqual([40, 0])
    expect(s.model.constraints.find((x) => x.id === k.id)!.value).toBe(20)
    expect(s.model.constraints.find((x) => x.id === rd.id)!.value).toBe(10)
    expect((entityById(s.model, c.id) as CircleE).r).toBeCloseTo(10, 9)
    expect(scaleCurves(m, { ids: [l.id], base: [0, 0], factor: 0 })).toMatch(/greater/)
  })
})

describe('Concentric, Collinear, Symmetry, Smooth and Midpoint on an arc', () => {
  it('Concentric puts two circles on one centre', () => {
    const m = emptyModel()
    const a = addCircle(m, addPoint(m, 0, 0), 5), b = addCircle(m, addPoint(m, 8, 3), 9)
    expect(applyConstraint(m, 'concentric', [a.id, b.id])).toBeNull()
    const s = solved(m)
    const [ca, cb] = [pos(s.model, a.c), pos(s.model, b.c)]
    expect(dist(ca, cb)).toBeLessThan(1e-6)
    expect(applyConstraint(m, 'concentric', [a.id, b.id])).toMatch(/already/)
  })
  it('Collinear lays the second line along the first', () => {
    const m = emptyModel()
    const a = line(m, [0, 0], [20, 0]), b = line(m, [30, 4], [50, 12])
    pin(m, a.p1, a.p2)
    expect(applyConstraint(m, 'collinear', [a.id, b.id])).toBeNull()
    const s = solved(m)
    const eb = entityById(s.model, b.id) as LineE
    expect(Math.abs(pos(s.model, eb.p1)[1]) + Math.abs(pos(s.model, eb.p2)[1])).toBeLessThan(1e-5)
  })
  it('Symmetry mirrors two points, two lines and two circles about a line', () => {
    const m = emptyModel()
    const axis = line(m, [0, -50], [0, 50])
    pin(m, axis.p1, axis.p2)
    const p = addPoint(m, 10, 5), q = addPoint(m, -7, 9)
    pin(m, p)
    expect(applyConstraint(m, 'symmetric', [p, q, axis.id])).toBeNull()
    const l1 = line(m, [10, 20], [20, 30]), l2 = line(m, [-12, 22], [-22, 31])
    pin(m, l1.p1, l1.p2)
    expect(applyConstraint(m, 'symmetric', [l1.id, l2.id, axis.id])).toBeNull()
    const c1 = addCircle(m, addPoint(m, 30, -20), 4), c2 = addCircle(m, addPoint(m, -33, -22), 6)
    pin(m, c1.c)
    expect(applyConstraint(m, 'symmetric', [c1.id, c2.id, axis.id])).toBeNull()
    const s = solved(m)
    expect(pos(s.model, p)[0]).toBeCloseTo(-pos(s.model, q)[0], 5)
    expect(pos(s.model, p)[1]).toBeCloseTo(pos(s.model, q)[1], 5)
    expect((entityById(s.model, c2.id) as CircleE).r).toBeCloseTo((entityById(s.model, c1.id) as CircleE).r, 6)
    expect(applyConstraint(m, 'symmetric', [p, q])).toMatch(/Pick two/)
  })
  it('Midpoint puts a point halfway round an arc', () => {
    const m = emptyModel()
    const arc = addArc(m, addPoint(m, 0, 0), addPoint(m, 10, 0), addPoint(m, 0, 10))
    const p = addPoint(m, 8, 5)
    pin(m, arc.c, arc.s, arc.e)
    expect(applyConstraint(m, 'midpoint', [p, arc.id])).toBeNull()
    const s = solved(m)
    const [x, y] = pos(s.model, p)
    expect(x).toBeCloseTo(10 * Math.SQRT1_2, 5)
    expect(y).toBeCloseTo(10 * Math.SQRT1_2, 5)
  })
  it('Smooth needs a spline and a curve that meet end to end', () => {
    const m = emptyModel()
    const a = line(m, [0, 0], [10, 0]), b = line(m, [20, 0], [30, 0])
    expect(applyConstraint(m, 'smooth', [a.id, b.id])).toMatch(/Smooth/)
  })
})
