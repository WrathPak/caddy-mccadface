/** The newer sketch tools: what they build, and that the result stays constrained (real planegcs). */
import { beforeAll, describe, expect, it } from 'vitest'
import { dist } from './geom'
import { refreshDims } from './dims'
import {
  addCircle, addCoincident, addConstraint, addLine, addPoint, cloneModel, entityById, pos,
} from './model'
import { detectProfiles } from './profiles'
import { chamferCorner, drawEllipse, drawPolygon, drawSlotArc, drawSlotCC, drawSlotOverall, drawSpline, filletCorner, mirrorEntities, patternCirc, patternRect, addHandles, tangentSpline } from './shapes'
import { analyze, ensureSolver, solveModel, solvePruned } from './solver'
import { ORIGIN, emptyModel, type LineE, type SketchModel } from './types'

beforeAll(async () => { await ensureSolver() })

function rect(m: SketchModel, w: number, h: number) {
  const p = [addPoint(m, 0, 0), addPoint(m, w, 0), addPoint(m, w, h), addPoint(m, 0, h)]
  const l = p.map((id, i) => addLine(m, id, p[(i + 1) % 4]))
  addConstraint(m, { type: 'horizontal', refs: [l[0].id] })
  addConstraint(m, { type: 'horizontal', refs: [l[2].id] })
  addConstraint(m, { type: 'vertical', refs: [l[1].id] })
  addConstraint(m, { type: 'vertical', refs: [l[3].id] })
  addCoincident(m, p[0], ORIGIN)
  addConstraint(m, { type: 'hdist', refs: [p[0], p[1]], value: w, sgn: 1, expr: String(w), off: [0, 0] })
  addConstraint(m, { type: 'vdist', refs: [p[1], p[2]], value: h, sgn: 1, expr: String(h), off: [0, 0] })
  return { p, l }
}
/** Solve like the sketcher does after an edit: new redundant constraints are dropped. */
function settle(m: SketchModel, before: SketchModel = emptyModel()) {
  refreshDims(m)
  const r = solvePruned(m, new Set(before.constraints.map((c) => c.id)))
  expect(r.info.ok).toBe(true)
  expect(r.info.conflicts).toEqual([])
  return r
}
const near = (a: number, b: number, rel = 2e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))

describe('slots', () => {
  it('centre-to-centre slot has five degrees of freedom: two centres and the width', () => {
    const m = emptyModel()
    drawSlotCC(m, [0, 0], [30, 0], 8)
    const r = settle(m)
    expect(r.info.dof).toBe(5)
    const ps = detectProfiles(r.model)
    expect(ps.length).toBe(1)
    near(ps[0].area, 30 * 8 + Math.PI * 16)
  })

  it('stays a slot when it is dragged to another size', () => {
    const m = emptyModel()
    const ids = drawSlotCC(m, [0, 0], [30, 0], 8)
    // fix both centres and set the radius: the whole slot is then determined
    addConstraint(m, { type: 'fix', refs: [ids.c1] })
    addConstraint(m, { type: 'fix', refs: [ids.c2] })
    addConstraint(m, { type: 'radius', refs: [ids.arcs[0]], value: 6, expr: '6', off: [0, 0] })
    const r = settle(m)
    expect(r.info.dof).toBe(0)
    const ps = detectProfiles(r.model)
    near(ps[0].area, 30 * 12 + Math.PI * 36)
  })

  it('overall slot: the clicks are the extreme ends', () => {
    const m = emptyModel()
    const res = drawSlotOverall(m, [0, 0], [40, 0], 10)
    expect(typeof res).toBe('object')
    const ps = detectProfiles(settle(m).model)
    const xs = ps[0].outer.flatMap((s) => (s.k === 'c' ? [s.c[0] - s.r, s.c[0] + s.r] : s.k === 'a' ? [s.a[0], s.b[0], s.c[0] - s.r, s.c[0] + s.r] : [s.a[0], s.b[0]]))
    expect(Math.min(...xs)).toBeCloseTo(0, 5)
    expect(Math.max(...xs)).toBeCloseTo(40, 5)
    expect(typeof drawSlotOverall(emptyModel(), [0, 0], [4, 0], 10)).toBe('string')
  })

  it('arc slot follows a centre arc and has six degrees of freedom', () => {
    const m = emptyModel()
    const res = drawSlotArc(m, [0, 0], [20, 0], [0, 20], 6)
    expect(typeof res).toBe('object')
    const r = settle(m)
    expect(r.info.dof).toBe(6)
    const ps = detectProfiles(r.model)
    expect(ps.length).toBe(1)
    // a quarter of the ring between r = 17 and r = 23, plus two half discs of radius 3
    near(ps[0].area, (Math.PI / 4) * (23 * 23 - 17 * 17) + Math.PI * 9)
    expect(typeof drawSlotArc(emptyModel(), [0, 0], [2, 0], [0, 2], 6)).toBe('string')
  })
})

describe('polygons', () => {
  for (const kind of ['inscribed', 'circumscribed'] as const) {
    it(`${kind} hexagon is regular and has four degrees of freedom`, () => {
      const m = emptyModel()
      const res = drawPolygon(m, [0, 0], [10, 0], 6, kind)
      expect(typeof res).toBe('object')
      const r = settle(m)
      expect(r.info.dof).toBe(4)
      const ps = detectProfiles(r.model)
      // the regular hexagon with circumradius R has area 3 sqrt(3) / 2 R^2
      const R = kind === 'inscribed' ? 10 : 10 / Math.cos(Math.PI / 6)
      near(ps.find((p) => p.holes.length === 0 && p.area > 100)!.area, ((3 * Math.sqrt(3)) / 2) * R * R)
    })
  }

  it('edge polygon: the clicked side is a side of the polygon', () => {
    const m = emptyModel()
    drawPolygon(m, [0, 0], [10, 0], 5, 'edge')
    const r = settle(m)
    expect(r.info.dof).toBe(4)
    const lines = r.model.entities.filter((e): e is LineE => e.type === 'line')
    expect(lines.length).toBe(5)
    for (const l of lines) near(dist(pos(r.model, l.p1), pos(r.model, l.p2)), 10)
  })

  it('refuses silly side counts', () => {
    expect(typeof drawPolygon(emptyModel(), [0, 0], [5, 0], 2, 'inscribed')).toBe('string')
  })
})

describe('spline and ellipse tools', () => {
  it('fit spline gets tangent handles and can be made tangent to a line', () => {
    const m = emptyModel()
    const a = addPoint(m, 0, 0), b = addPoint(m, 10, 0)
    const line = addLine(m, a, b)
    addConstraint(m, { type: 'fix', refs: [a] })
    addConstraint(m, { type: 'fix', refs: [b] })
    const s = drawSpline(m, [[10, 0], [20, 8], [30, 0]], 'fit')
    addCoincident(m, s.pts[0], b)
    expect(addHandles(m, s.id)).toBeUndefined()
    expect(s.t0 && s.t1).toBeTruthy()
    expect(tangentSpline(m, s, line, s.pts[0])).toBeUndefined()
    const r = settle(m)
    expect(Math.abs(pos(r.model, s.t0!)[1])).toBeLessThan(1e-6)
    expect(addHandles(m, 'nope')).toBe('Select a spline')
  })

  it('ellipse tool builds the centre, the major axis point and the minor radius', () => {
    const m = emptyModel()
    const e = drawEllipse(m, [2, 3], [12, 3], 4)
    const ps = detectProfiles(settle(m).model)
    near(ps[0].area, Math.PI * 10 * 4)
    expect(entityById(m, e.ellipse)?.type).toBe('ellipse')
  })
})

describe('fillet and chamfer at a corner', () => {
  it('round a corner of a fully constrained rectangle: still fully constrained, tangent, with a radius dimension', () => {
    const m = emptyModel()
    const { l } = rect(m, 40, 20)
    const before = cloneModel(m)
    const res = filletCorner(m, entityById(m, l[1].id) as LineE, entityById(m, l[2].id) as LineE, 5)
    expect(typeof res).toBe('object')
    const r = settle(m, before)
    expect(r.info.dof).toBe(0)
    const ps = detectProfiles(r.model)
    expect(ps.length).toBe(1)
    near(ps[0].area, 40 * 20 - (25 - (Math.PI * 25) / 4))
    expect(r.model.constraints.some((c) => c.type === 'radius')).toBe(true)
    // changing the radius moves the tangent points
    const dim = r.model.constraints.find((c) => c.type === 'radius')!
    dim.expr = '8'
    const r2 = settle(r.model, r.model)
    near(detectProfiles(r2.model)[0].area, 40 * 20 - (64 - (Math.PI * 64) / 4))
  })

  it('refuses a radius that does not fit', () => {
    const m = emptyModel()
    const { l } = rect(m, 40, 20)
    expect(filletCorner(m, entityById(m, l[1].id) as LineE, entityById(m, l[2].id) as LineE, 30)).toBe('The radius is too big for these lines')
  })

  it('chamfer cuts the corner with editable distances', () => {
    const m = emptyModel()
    const { l } = rect(m, 40, 20)
    const before = cloneModel(m)
    const res = chamferCorner(m, entityById(m, l[1].id) as LineE, entityById(m, l[2].id) as LineE, 6, 6)
    expect(typeof res).toBe('object')
    const r = settle(m, before)
    expect(r.info.dof).toBe(0)
    near(detectProfiles(r.model)[0].area, 800 - 18)
    const dims = r.model.constraints.filter((c) => c.type === 'distance')
    expect(dims.length).toBe(2)
    expect(dims[0].group).toBeTruthy()
    expect(dims[0].group).toBe(dims[1].group)
  })

  it('unequal chamfer distances', () => {
    const m = emptyModel()
    const { l } = rect(m, 40, 20)
    const before = cloneModel(m)
    chamferCorner(m, entityById(m, l[0].id) as LineE, entityById(m, l[1].id) as LineE, 10, 4)
    const r = settle(m, before)
    near(detectProfiles(r.model)[0].area, 800 - 20)
  })
})

describe('mirror and patterns keep their constraints', () => {
  it('mirrored copies follow the original', () => {
    const m = emptyModel()
    const axA = addPoint(m, 0, -10), axB = addPoint(m, 0, 10)
    const axis = addLine(m, axA, axB, true)
    addConstraint(m, { type: 'fix', refs: [axA] })
    addConstraint(m, { type: 'fix', refs: [axB] })
    const p = [addPoint(m, 5, 0), addPoint(m, 15, 0), addPoint(m, 10, 8)]
    const ls = p.map((id, i) => addLine(m, id, p[(i + 1) % 3]))
    for (const id of p) addConstraint(m, { type: 'fix', refs: [id] })
    const res = mirrorEntities(m, ls.map((l) => l.id), axis.id)
    expect(typeof res).toBe('object')
    const r = settle(m)
    expect(r.info.dof).toBe(0)
    expect(detectProfiles(r.model).length).toBe(2)
    // move the original apex: the mirror image follows
    const mp = r.model.constraints.find((c) => c.type === 'mirror' && c.refs[0] === p[2])!
    entityOf(r.model, p[2]).y = 12
    const r2 = solveModel(r.model)
    expect(r2.info.ok).toBe(true)
    near(pos(r2.model, mp.refs[1])[1], 12)
    near(pos(r2.model, mp.refs[1])[0], -10)
  })

  it('a circle crossing the mirror line is not duplicated into a gap', () => {
    const m = emptyModel()
    const axA = addPoint(m, 0, -10), axB = addPoint(m, 0, 10)
    const axis = addLine(m, axA, axB, true)
    const c = addCircle(m, addPoint(m, 6, 0), 3)
    const res = mirrorEntities(m, [c.id], axis.id)
    expect(typeof res).toBe('object')
    const r = settle(m)
    const circles = r.model.entities.filter((e) => e.type === 'circle')
    expect(circles.length).toBe(2)
    expect(pos(r.model, (circles[1] as { c: string }).c)[0]).toBeCloseTo(-6, 6)
  })

  it('mirror needs a line and something to mirror', () => {
    const m = emptyModel()
    const c = addCircle(m, addPoint(m, 6, 0), 3)
    expect(mirrorEntities(m, [c.id], c.id)).toBe('Pick a line to mirror across')
    const axis = addLine(m, addPoint(m, 0, 0), addPoint(m, 0, 5))
    expect(mirrorEntities(m, [], axis.id)).toBe('Select the curves to mirror first')
  })

  it('rectangular pattern: copies at a fixed spacing that one dimension edits', () => {
    const m = emptyModel()
    const { l } = rect(m, 10, 10)
    const before = cloneModel(m)
    const res = patternRect(m, { ids: l.map((x) => x.id), dir1: [1, 0], count1: 3, spacing1: 20 })
    expect(typeof res).toBe('object')
    const r = settle(m, before)
    expect(r.info.dof).toBe(0)
    expect(detectProfiles(r.model).length).toBe(3)
    const spacing = r.model.constraints.filter((c) => c.type === 'distance' && !c.hidden)
    expect(spacing.length).toBe(1)
    for (const k of r.model.constraints) if (k.group === spacing[0].group) k.expr = '30' // editing a dimension edits its whole group
    const r2 = settle(r.model, r.model)
    const xs = detectProfiles(r2.model).map((p) => p.centroid[0]).sort((a, b) => a - b)
    near(xs[1] - xs[0], 30)
    near(xs[2] - xs[1], 30)
  })

  it('rectangular pattern in two directions makes a grid', () => {
    const m = emptyModel()
    const c = addCircle(m, addPoint(m, 5, 5), 2)
    const before = cloneModel(m)
    const res = patternRect(m, { ids: [c.id], dir1: [1, 0], count1: 3, spacing1: 10, count2: 2, spacing2: 15 })
    expect(typeof res).toBe('object')
    const r = settle(m, before)
    expect(detectProfiles(r.model).length).toBe(6)
    const ys = new Set(detectProfiles(r.model).map((p) => Math.round(p.centroid[1])))
    expect([...ys].sort((a, b) => a - b)).toEqual([5, 20])
    // the radius of the original drives every copy
    expect(r.model.constraints.filter((c) => c.type === 'equal').length).toBe(5)
  })

  it('circular pattern about the origin', () => {
    const m = emptyModel()
    const c = addCircle(m, addPoint(m, 10, 0), 2)
    addConstraint(m, { type: 'fix', refs: [(c as { c: string }).c] })
    addConstraint(m, { type: 'radius', refs: [c.id], value: 2, expr: '2', off: [0, 0] })
    const before = cloneModel(m)
    const res = patternCirc(m, { ids: [c.id], centre: ORIGIN, count: 6, angle: 360 })
    expect(typeof res).toBe('object')
    const r = settle(m, before)
    expect(r.info.dof).toBe(0)
    const cs = r.model.entities.filter((e) => e.type === 'circle') as { c: string }[]
    expect(cs.length).toBe(6)
    const angles = cs.map((e) => (Math.atan2(pos(r.model, e.c)[1], pos(r.model, e.c)[0]) * 180) / Math.PI).map((a) => (a + 360) % 360).sort((a, b) => a - b)
    angles.forEach((a, i) => near(a + 1e-9, i * 60 + 1e-9, 1e-6))
    for (const e of cs) near(dist(pos(r.model, e.c), [0, 0]), 10)
    expect(analyze(r.model, r.info).size).toBeGreaterThan(6)
  })

  it('circular pattern over part of a circle spaces the copies from first to last', () => {
    const m = emptyModel()
    const c = addCircle(m, addPoint(m, 10, 0), 1)
    const res = patternCirc(m, { ids: [c.id], centre: ORIGIN, count: 4, angle: 90 })
    expect(typeof res).toBe('object')
    const r = settle(m)
    const cs = r.model.entities.filter((e) => e.type === 'circle') as { c: string }[]
    const last = cs.map((e) => pos(r.model, e.c)).sort((a, b) => b[1] - a[1])[0]
    near(last[1], 10, 1e-6)
    near(last[0] + 1e-9, 1e-9, 1e-6)
  })
})

function entityOf(m: SketchModel, id: string) {
  return entityById(m, id) as { x: number; y: number }
}
