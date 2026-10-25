import { describe, expect, it } from 'vitest'
import {
  chainPolylines, circleExtreme, clipPolyToCircle, fitCircle, hatchLines, nearestOnPolys, projectedOrientation, sectionPlane, viewBasis,
} from './drawing-geom'
import type { Vec3 } from './types'

const close = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length)
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9))
}

describe('projection', () => {
  it('standard view bases have x right and y up', () => {
    const f = viewBasis([0, -1, 0], [1, 0, 0])
    close(f.x, [1, 0, 0])
    close(f.y, [0, 0, 1])
    const t = viewBasis([0, 0, 1], [1, 0, 0])
    close(t.y, [0, 1, 0])
  })

  it('third angle puts the top view above and the right view on the right', () => {
    const f = { eye: [0, -1, 0] as Vec3, right: [1, 0, 0] as Vec3 }
    const up = projectedOrientation(f.eye, f.right, 'above', 'third')
    close(up.eye, [0, 0, 1])
    close(up.right, [1, 0, 0])
    const r = projectedOrientation(f.eye, f.right, 'right', 'third')
    close(r.eye, [1, 0, 0])
    close(r.right, [0, 1, 0])
  })

  it('first angle swaps the sides', () => {
    const f = { eye: [0, -1, 0] as Vec3, right: [1, 0, 0] as Vec3 }
    const above = projectedOrientation(f.eye, f.right, 'above', 'first')
    close(above.eye, [0, 0, -1])
    const right = projectedOrientation(f.eye, f.right, 'right', 'first')
    close(right.eye, [-1, 0, 0])
  })

  it('a section across a front view keeps it upright', () => {
    // vertical cut line in the front view: the section is a side view with Z up
    const p = sectionPlane([0, -1, 0], [1, 0, 0], [0, -5], [0, 5], false)
    expect(Math.abs(p.normal[0])).toBeCloseTo(1, 9)
    const b = viewBasis(p.secEye, p.secRight)
    expect(b.y[2]).toBeCloseTo(1, 9)
  })

  it('a section across a top view is seen sideways with Z up', () => {
    const p = sectionPlane([0, 0, 1], [1, 0, 0], [-5, 0], [5, 0], false)
    const b = viewBasis(p.secEye, p.secRight)
    expect(b.y[2]).toBeCloseTo(1, 9)
    expect(Math.abs(b.z[1])).toBeCloseTo(1, 9)
  })
})

describe('2D helpers', () => {
  it('chains the edges of a loop that come in any order and direction', () => {
    const parts = [[0, 0, 10, 0], [10, 10, 10, 0], [10, 10, 0, 10], [0, 0, 0, 10]]
    const out = chainPolylines(parts)
    expect(out.length).toBe(1)
    expect(out[0].length).toBe(10) // 4 corners + the repeated first point
    expect(out[0].slice(0, 2)).toEqual(out[0].slice(-2))
  })

  it('hatch lines fill a square at 45 degrees and skip a hole', () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10]
    const hole = [4, 4, 6, 4, 6, 6, 4, 6]
    const solid = hatchLines([outer], 1, 45)
    const holed = hatchLines([outer, hole], 1, 45)
    const len = (ls: number[][]) => ls.reduce((s, l) => s + Math.hypot(l[2] - l[0], l[3] - l[1]), 0)
    // the lines cover the area: total length ~ area / spacing
    expect(len(solid)).toBeCloseTo(100, 0)
    expect(len(holed)).toBeCloseTo(96, 0)
    // every hatch line is at 45 degrees
    for (const l of solid) expect(Math.abs(Math.abs(l[3] - l[1]) - Math.abs(l[2] - l[0]))).toBeLessThan(1e-9)
  })

  it('clips a polyline to a circle', () => {
    const out = clipPolyToCircle([-10, 0, 10, 0], [0, 0], 4)
    expect(out.length).toBe(1)
    expect(out[0][0]).toBeCloseTo(-4, 9)
    expect(out[0][2]).toBeCloseTo(4, 9)
    expect(clipPolyToCircle([-10, 9, 10, 9], [0, 0], 4)).toEqual([])
    // a polyline that leaves and comes back is two pieces
    const two = clipPolyToCircle([-3, 0, 3, 0, 3, 8, -3, 8, -3, 1], [0, 0], 4)
    expect(two.length).toBeGreaterThanOrEqual(2)
  })

  it('distance to polylines', () => {
    expect(nearestOnPolys(5, 3, [[0, 0, 10, 0]])).toBeCloseTo(3, 9)
    expect(nearestOnPolys(-4, 3, [[0, 0, 10, 0]])).toBeCloseTo(5, 9)
  })
})

describe('circle fit', () => {
  const arc = (r: number, sweep: number, n = 24): Vec3[] =>
    Array.from({ length: n + 1 }, (_, i) => [5 + r * Math.cos((sweep * i) / n), -2 + r * Math.sin((sweep * i) / n), 7] as Vec3)

  it('finds the center, radius and axis of a full circle', () => {
    const c = fitCircle(arc(4, 2 * Math.PI))!
    expect(c.center[0]).toBeCloseTo(5, 6)
    expect(c.center[1]).toBeCloseTo(-2, 6)
    expect(c.center[2]).toBeCloseTo(7, 6)
    expect(c.radius).toBeCloseTo(4, 6)
    expect(Math.abs(c.normal[2])).toBeCloseTo(1, 6)
    expect(c.sweep).toBeCloseTo(2 * Math.PI, 3)
  })

  it('finds an arc and its sweep', () => {
    const c = fitCircle(arc(3, Math.PI / 2))!
    expect(c.radius).toBeCloseTo(3, 6)
    expect(c.sweep).toBeCloseTo(Math.PI / 2, 3)
  })

  it('rejects a straight edge and a spiral', () => {
    expect(fitCircle([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]])).toBeNull()
    const spiral = Array.from({ length: 20 }, (_, i) => [Math.cos(i / 3) * (1 + i / 10), Math.sin(i / 3) * (1 + i / 10), 0] as Vec3)
    expect(fitCircle(spiral)).toBeNull()
  })

  it('finds the extreme point of a circle seen from the side', () => {
    const c = fitCircle(arc(4, 2 * Math.PI))!
    const top = viewBasis([0, 0, 1], [1, 0, 0])
    const p = circleExtreme(c, top, [1, 0])
    expect(p[0]).toBeCloseTo(9, 6)
    expect(p[1]).toBeCloseTo(-2, 6)
  })
})
