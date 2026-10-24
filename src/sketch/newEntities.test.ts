/** Splines, ellipses and text in the sketcher: geometry, profile detection and the constraint solver, for real. */
import { beforeAll, describe, expect, it } from 'vitest'
import { bezAt, bezIntersect, bezLine, type Bez } from './bezier'
import { bsplineBeziers, ellipseBeziers, fitBeziers, splineBeziers } from './curves'
import { dist } from './geom'
import { loadFont } from './font'
import { addCircle, addConstraint, addCoincident, addEllipse, addLine, addPoint, addSpline, addText, entityById, pos } from './model'
import { detectProfiles } from './profiles'
import { analyze, ensureSolver, solveModel } from './solver'
import { ORIGIN, emptyModel, type SketchModel, type Vec2 } from './types'

beforeAll(async () => {
  await ensureSolver()
  await loadFont('Inter')
  await loadFont('JetBrains Mono')
})

/** Clamped uniform cubic B-spline evaluated directly with de Boor's algorithm. */
function deBoor(P: Vec2[], u: number): Vec2 {
  const n = P.length, p = Math.min(3, n - 1)
  const U = [...Array(p + 1).fill(0), ...Array.from({ length: n - p - 1 }, (_, i) => i + 1), ...Array(p + 1).fill(n - p)]
  let k = p
  while (k < n - 1 && u >= U[k + 1]) k++
  const d = P.slice(k - p, k + 1).map((q) => [...q] as Vec2)
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const a = (u - U[j + k - p]) / (U[j + 1 + k - r] - U[j + k - p])
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]]
    }
  }
  return d[p]
}

describe('spline geometry', () => {
  it('a control-point spline equals the clamped cubic B-spline it stands for', () => {
    const P: Vec2[] = [[0, 0], [10, 20], [25, 5], [40, 25], [55, -5], [70, 10]]
    const bz = bsplineBeziers(P, false)
    expect(bz.length).toBe(3)
    // piece i covers u in [i, i + 1]
    bz.forEach((b, i) => {
      for (const t of [0, 0.25, 0.5, 0.8, 1]) {
        const q = bezAt(b, t), r = deBoor(P, Math.min(i + t, 3 - 1e-12))
        expect(dist(q, r)).toBeLessThan(1e-9)
      }
    })
    expect(bz[0][0]).toEqual(P[0])
    expect(bz[2][3][0]).toBeCloseTo(P[5][0], 9)
  })

  it('two and three control points still give a curve through the end points', () => {
    expect(bsplineBeziers([[0, 0], [10, 0]], false).length).toBe(1)
    const q = bsplineBeziers([[0, 0], [5, 10], [10, 0]], false)
    expect(q.length).toBe(1)
    expect(bezAt(q[0], 0.5)[1]).toBeCloseTo(5, 9) // the quadratic's midpoint
  })

  it('a closed control-point spline is periodic and closed', () => {
    const bz = bsplineBeziers([[0, 0], [10, 0], [10, 10], [0, 10]], true)
    expect(bz.length).toBe(4)
    bz.forEach((b, i) => expect(dist(b[3], bz[(i + 1) % 4][0])).toBeLessThan(1e-12))
  })

  it('a fit spline passes through every point and is smooth at the joins', () => {
    const P: Vec2[] = [[0, 0], [10, 8], [25, 3], [30, 20], [50, 15]]
    const bz = fitBeziers(P, false)
    expect(bz.length).toBe(4)
    bz.forEach((b, i) => { expect(b[0]).toEqual(P[i]); expect(b[3]).toEqual(P[i + 1]) })
    for (let i = 0; i + 1 < bz.length; i++) {
      const a = [bz[i][3][0] - bz[i][2][0], bz[i][3][1] - bz[i][2][1]], b = [bz[i + 1][1][0] - bz[i + 1][0][0], bz[i + 1][1][1] - bz[i + 1][0][1]]
      const cross = a[0] * b[1] - a[1] * b[0]
      expect(Math.abs(cross) / (Math.hypot(...a) * Math.hypot(...b))).toBeLessThan(1e-9)
    }
  })

  it('tangent handles become the end control points', () => {
    const m = emptyModel()
    const ids = [addPoint(m, 0, 0), addPoint(m, 10, 10), addPoint(m, 20, 0)]
    const h0 = addPoint(m, 0, 8), h1 = addPoint(m, 20, 8)
    const s = addSpline(m, ids, 'fit')
    s.t0 = h0
    s.t1 = h1
    const bz = splineBeziers(m, s)
    expect(bz[0][1]).toEqual([0, 8])
    expect(bz[bz.length - 1][2]).toEqual([20, 8])
  })

  it('a closed fit spline closes on itself', () => {
    const bz = fitBeziers([[0, 0], [10, 0], [10, 10], [0, 10]], true)
    expect(bz.length).toBe(4)
    expect(bz[3][3]).toEqual([0, 0])
  })
})

describe('ellipse geometry', () => {
  it('traces the ellipse x^2/a^2 + y^2/b^2 = 1 about a rotated axis', () => {
    const c: Vec2 = [5, 3], m: Vec2 = [5 + 8 * Math.cos(0.5), 3 + 8 * Math.sin(0.5)]
    const bz = ellipseBeziers(c, m, 3)
    expect(bz.length).toBe(8)
    for (const b of bz) {
      for (const t of [0, 0.3, 0.6, 1]) {
        const p = bezAt(b, t)
        const dx = p[0] - c[0], dy = p[1] - c[1]
        const x = dx * Math.cos(0.5) + dy * Math.sin(0.5), y = -dx * Math.sin(0.5) + dy * Math.cos(0.5)
        expect(Math.abs((x / 8) ** 2 + (y / 3) ** 2 - 1)).toBeLessThan(3e-5)
      }
    }
  })
})

describe('bezier intersections', () => {
  it('finds where a line crosses a curve', () => {
    const b: Bez = [[0, 0], [10, 20], [20, 20], [30, 0]]
    const hits = bezIntersect(b, bezLine([0, 10], [30, 10]))
    expect(hits.length).toBe(2)
    for (const h of hits) expect(h.p[1]).toBeCloseTo(10, 6)
  })
})

describe('profiles with splines, ellipses and text', () => {
  it('a closed spline is a profile with its area', () => {
    const m = emptyModel()
    const ids = [addPoint(m, 0, 0), addPoint(m, 20, 0), addPoint(m, 20, 20), addPoint(m, 0, 20)]
    addSpline(m, ids, 'ctrl', true)
    const ps = detectProfiles(m)
    expect(ps.length).toBe(1)
    // a periodic cubic B-spline rounds the square off: less than the control polygon, more than half
    expect(ps[0].area).toBeGreaterThan(200)
    expect(ps[0].area).toBeLessThan(400)
  })

  it('an ellipse has the area pi a b', () => {
    const m = emptyModel()
    addEllipse(m, addPoint(m, 0, 0), addPoint(m, 12, 0), 5)
    const ps = detectProfiles(m)
    expect(ps.length).toBe(1)
    expect(Math.abs(ps[0].area - Math.PI * 12 * 5) / (Math.PI * 12 * 5)).toBeLessThan(2e-3)
  })

  it('an open spline across a circle splits it into two profiles', () => {
    const m = emptyModel()
    addCircle(m, addPoint(m, 0, 0), 10)
    addSpline(m, [addPoint(m, -15, -2), addPoint(m, 0, 4), addPoint(m, 15, -2)], 'fit')
    const ps = detectProfiles(m)
    expect(ps.length).toBe(2)
    expect(Math.abs(ps[0].area + ps[1].area - Math.PI * 100)).toBeLessThan(0.5)
  })

  it('an ellipse overlapping a rectangle makes three regions', () => {
    const m = emptyModel()
    const p = [addPoint(m, -10, -4), addPoint(m, 10, -4), addPoint(m, 10, 4), addPoint(m, -10, 4)]
    p.forEach((id, i) => addLine(m, id, p[(i + 1) % 4]))
    addEllipse(m, addPoint(m, 8, 0), addPoint(m, 14, 0), 3)
    expect(detectProfiles(m).length).toBe(3)
  })

  it('text outlines are profiles, letters with counters have holes', () => {
    const m = emptyModel()
    addText(m, addPoint(m, 0, 0), 'O', 10, 0)
    const ps = detectProfiles(m)
    expect(ps.length).toBe(1)
    expect(ps[0].holes.length).toBe(1)
    const m2 = emptyModel()
    addText(m2, addPoint(m2, 0, 0), 'AB', 10, 0)
    const p2 = detectProfiles(m2)
    expect(p2.length).toBe(2)
    expect(p2.map((p) => p.holes.length).sort()).toEqual([1, 2])
    // capital letters are 10 mm tall
    const ys = p2.flatMap((p) => p.outer.map((s) => (s.k === 'c' ? s.c[1] : s.a[1])))
    expect(Math.max(...ys)).toBeCloseTo(10, 1)
    expect(Math.min(...ys)).toBeGreaterThan(-0.5)
  })

  it('text follows its anchor and angle', () => {
    const m = emptyModel()
    addText(m, addPoint(m, 50, 20), 'I', 10, 90, 'JetBrains Mono')
    const ps = detectProfiles(m)
    expect(ps.length).toBe(1)
    const xs = ps[0].outer.map((s) => (s.k === 'c' ? s.c[0] : s.a[0]))
    expect(Math.max(...xs)).toBeLessThan(50.5)
    expect(Math.min(...xs)).toBeLessThan(41) // turned 90 degrees: it now stands to the left of the anchor
  })
})

describe('constraints on the new entities', () => {
  it('ellipse axes: horizontal major axis with major and minor radius is fully constrained', () => {
    const m = emptyModel()
    const c = addPoint(m, 1, 1), mp = addPoint(m, 7, 2)
    const e = addEllipse(m, c, mp, 2)
    addCoincident(m, c, ORIGIN)
    addConstraint(m, { type: 'horizontal', refs: [c, mp] })
    addConstraint(m, { type: 'majorRadius', refs: [e.id], value: 8, expr: '8', off: [0, 0] })
    addConstraint(m, { type: 'radius', refs: [e.id], value: 3, expr: '3', off: [0, 0] })
    const s = solveModel(m)
    expect(s.info.ok).toBe(true)
    expect(s.info.dof).toBe(0)
    expect(pos(s.model, mp)[0]).toBeCloseTo(8, 6)
    expect(pos(s.model, mp)[1]).toBeCloseTo(0, 6)
    expect((entityById(s.model, e.id) as { r: number }).r).toBeCloseTo(3, 6)
    expect(analyze(s.model, s.info).has(e.id)).toBe(true)
  })

  it('an ellipse axis can be made parallel to a line and equal radii link ellipses', () => {
    const m = emptyModel()
    const a = addPoint(m, 0, 0), b = addPoint(m, 10, 10)
    const l = addLine(m, a, b)
    addConstraint(m, { type: 'fix', refs: [a] })
    addConstraint(m, { type: 'fix', refs: [b] })
    const c = addPoint(m, 20, 0), mp = addPoint(m, 28, 3)
    const e = addEllipse(m, c, mp, 2)
    addConstraint(m, { type: 'parallel', refs: [e.id, l.id] })
    const c2 = addPoint(m, 20, 20), mp2 = addPoint(m, 26, 20)
    const e2 = addEllipse(m, c2, mp2, 4)
    addConstraint(m, { type: 'equal', refs: [e.id, e2.id] })
    const s = solveModel(m)
    expect(s.info.ok).toBe(true)
    const C = pos(s.model, c), M = pos(s.model, mp)
    expect(Math.abs((M[0] - C[0]) - (M[1] - C[1]))).toBeLessThan(1e-6)
    expect((entityById(s.model, e.id) as { r: number }).r).toBeCloseTo((entityById(s.model, e2.id) as { r: number }).r, 6)
  })

  it('spline tangency: the end handle lines up with a line', () => {
    const m = emptyModel()
    const a = addPoint(m, 0, 0), b = addPoint(m, 10, 0)
    const l = addLine(m, a, b)
    addConstraint(m, { type: 'fix', refs: [a] })
    addConstraint(m, { type: 'fix', refs: [b] })
    const p0 = addPoint(m, 10, 0), p1 = addPoint(m, 20, 6), p2 = addPoint(m, 30, 0)
    addCoincident(m, p0, b)
    const h0 = addPoint(m, 13, 3)
    const s = addSpline(m, [p0, p1, p2], 'fit')
    s.t0 = h0
    addConstraint(m, { type: 'splineTangent', refs: [s.id, l.id, p0], value: 0 })
    const r = solveModel(m)
    expect(r.info.ok).toBe(true)
    const P = pos(r.model, p0), H = pos(r.model, h0)
    expect(Math.abs(H[1] - P[1])).toBeLessThan(1e-6)
    expect(H[0]).toBeGreaterThan(P[0]) // it still leaves in the line's direction
  })

  it('spline tangency to an arc keeps the handle along the arc tangent', () => {
    const m = emptyModel()
    const c = addPoint(m, 0, 0), s0 = addPoint(m, 10, 0), e0 = addPoint(m, 0, 10)
    const arc = { id: 'l' + m.next++, type: 'arc' as const, c, s: s0, e: e0 }
    m.entities.push(arc)
    for (const id of [c, s0, e0]) addConstraint(m, { type: 'fix', refs: [id] })
    const p0 = addPoint(m, 0, 10), p1 = addPoint(m, -10, 20), p2 = addPoint(m, -20, 10)
    addCoincident(m, p0, e0)
    const h0 = addPoint(m, -3, 11)
    const sp = addSpline(m, [p0, p1, p2], 'fit')
    sp.t0 = h0
    addConstraint(m, { type: 'splineTangent', refs: [sp.id, arc.id, p0], value: 0 })
    const r = solveModel(m)
    expect(r.info.ok).toBe(true)
    // the tangent of the quarter circle at (0, 10) is horizontal
    expect(Math.abs(pos(r.model, h0)[1] - 10)).toBeLessThan(1e-6)
  })

  it('mirror and rotated constraints place a point from another', () => {
    const m = emptyModel()
    const a = addPoint(m, 0, -5), b = addPoint(m, 0, 5)
    const axis = addLine(m, a, b)
    addConstraint(m, { type: 'fix', refs: [a] })
    addConstraint(m, { type: 'fix', refs: [b] })
    const p = addPoint(m, 3, 1), q = addPoint(m, -2.5, 0.5)
    addConstraint(m, { type: 'fix', refs: [p] })
    addConstraint(m, { type: 'mirror', refs: [p, q, axis.id] })
    const o = addPoint(m, 10, 10), r0 = addPoint(m, 14, 10), r1 = addPoint(m, 10.5, 13.5)
    for (const id of [o, r0]) addConstraint(m, { type: 'fix', refs: [id] })
    addConstraint(m, { type: 'rotated', refs: [o, r0, r1], value: 90 })
    const s = solveModel(m)
    expect(s.info.ok).toBe(true)
    expect(pos(s.model, q)[0]).toBeCloseTo(-3, 6)
    expect(pos(s.model, q)[1]).toBeCloseTo(1, 6)
    expect(pos(s.model, r1)[0]).toBeCloseTo(10, 6)
    expect(pos(s.model, r1)[1]).toBeCloseTo(14, 6)
    expect(s.info.dof).toBe(0)
  })
})
