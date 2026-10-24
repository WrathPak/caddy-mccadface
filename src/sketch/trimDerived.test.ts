/** Trim on splines, ellipses and text outlines, and trimming lines against them. */
import { beforeAll, describe, expect, it } from 'vitest'
import { derivedPolys } from './curves'
import { loadFont } from './font'
import { addConstraint, addEllipse, addLine, addPoint, addSpline, entityById, pos } from './model'
import { applyTrim, trimAt, trimSpan } from './trim'
import { emptyModel, type SketchModel, type SplineE } from './types'

beforeAll(async () => { await loadFont('Inter') })

const ends = (m: SketchModel, s: SplineE) => [pos(m, s.pts[0]), pos(m, s.pts[s.pts.length - 1])]
const splines = (m: SketchModel) => m.entities.filter((e): e is SplineE => e.type === 'spline')

function arch(): { m: SketchModel; s: SplineE } {
  const m = emptyModel()
  const s = addSpline(m, [addPoint(m, 0, 0), addPoint(m, 10, 10), addPoint(m, 20, 10), addPoint(m, 30, 0)], 'fit')
  return { m, s }
}

describe('trim a spline', () => {
  it('shortens it at the first cut, keeping the exact curve and binding the new end to the cutter', () => {
    const { m, s } = arch()
    const cutter = addLine(m, addPoint(m, 20, -5), addPoint(m, 20, 20))
    const before = derivedPolys(m, s)[0]
    expect(trimAt(m, s.id, [26, 3])).toBeNull() // click on the right of the vertical line
    const [t] = splines(m)
    expect(splines(m).length).toBe(1)
    expect(t.mode).toBe('bez')
    expect(ends(m, t)[0]).toEqual([0, 0])
    expect(ends(m, t)[1][0]).toBeCloseTo(20, 6)
    expect(m.constraints.some((c) => c.type === 'pointOnLine' && c.refs[1] === cutter.id)).toBe(true)
    // the part that stays is the same curve as before, not a re-fit
    const after = derivedPolys(m, t)[0]
    for (const q of after.filter((_, i) => i % 7 === 0)) {
      expect(Math.min(...before.map((p) => Math.hypot(p[0] - q[0], p[1] - q[1])))).toBeLessThan(0.3)
    }
  })

  it('cut on both sides: two splines remain, the middle goes', () => {
    const { m, s } = arch()
    addLine(m, addPoint(m, 8, -5), addPoint(m, 8, 20))
    addLine(m, addPoint(m, 22, -5), addPoint(m, 22, 20))
    expect(trimAt(m, s.id, [15, 10])).toBeNull()
    const parts = splines(m)
    expect(parts.length).toBe(2)
    const xs = parts.flatMap((p) => ends(m, p).map((e) => e[0])).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0, 6)
    expect(xs[1]).toBeCloseTo(8, 5)
    expect(xs[2]).toBeCloseTo(22, 5)
    expect(xs[3]).toBeCloseTo(30, 6)
  })

  it('no cutter: the whole spline goes; a spline can cut another spline', () => {
    const { m, s } = arch()
    expect(trimSpan(m, s.id, [10, 8])!.whole).toBe(true)
    const other = addSpline(m, [addPoint(m, 15, -5), addPoint(m, 14, 5), addPoint(m, 16, 15)], 'fit')
    const span = trimSpan(m, s.id, [5, 6])!
    expect(span.whole).toBe(false)
    expect(span.poly.length).toBeGreaterThan(3)
    void other
  })

  it('a straight line is trimmed where a spline crosses it', () => {
    const { m } = arch()
    const l = addLine(m, addPoint(m, -5, 5), addPoint(m, 40, 5))
    const span = trimSpan(m, l.id, [-2, 5])!
    expect(span.c1).not.toBeNull()
    expect(applyTrim(m, span)).toBeNull()
    const line = entityById(m, l.id) as { p1: string; p2: string }
    const a = pos(m, line.p1), b = pos(m, line.p2)
    expect(Math.min(a[0], b[0])).toBeGreaterThan(0)
    expect(m.constraints.some((c) => c.type === 'pointOnCurve')).toBe(false) // the spline is not a circle: a spline cutter is on a curve of its own kind
  })
})

describe('trim an ellipse', () => {
  it('between two cuts leaves an open exact spline', () => {
    const m = emptyModel()
    const e = addEllipse(m, addPoint(m, 0, 0), addPoint(m, 20, 0), 10)
    addLine(m, addPoint(m, -30, 5), addPoint(m, 30, 5))
    addLine(m, addPoint(m, -30, -5), addPoint(m, 30, -5))
    expect(trimAt(m, e.id, [20, 0])).toBeNull() // the right hand cap between the two lines
    expect(m.entities.some((x) => x.type === 'ellipse')).toBe(false)
    const [s] = splines(m)
    const poly = derivedPolys(m, s)[0]
    // what is left never goes between y = -5 and 5 on the right
    expect(poly.every((p) => Math.abs(p[1]) >= 4.99 || p[0] < 0)).toBe(true)
    for (const p of poly) expect(Math.abs((p[0] / 20) ** 2 + (p[1] / 10) ** 2 - 1)).toBeLessThan(2e-4)
  })

  it('an ellipse nothing crosses is removed whole', () => {
    const m = emptyModel()
    const e = addEllipse(m, addPoint(m, 0, 0), addPoint(m, 20, 0), 10)
    expect(trimAt(m, e.id, [20, 0])).toBeNull()
    expect(m.entities.some((x) => x.type === 'ellipse' || x.type === 'spline')).toBe(false)
  })
})

describe('trim text outlines', () => {
  it('the text is taken apart into its outlines and the piece under the click is cut at the line', async () => {
    const m = emptyModel()
    const { addText } = await import('./model')
    addText(m, addPoint(m, 0, 0), 'I', 10, 0)
    addConstraint(m, { type: 'fix', refs: ['p1'] })
    addLine(m, addPoint(m, -5, 5), addPoint(m, 15, 5))
    const before = m.entities.filter((e) => e.type === 'line').length
    // find the left edge of the I and click on it above the cutting line
    const poly = derivedPolys(m, m.entities.find((e) => e.type === 'text') as never).flat()
    const minX = Math.min(...poly.map((p) => p[0]))
    expect(trimAt(m, m.entities.find((e) => e.type === 'text')!.id, [minX, 8])).toBeNull()
    expect(m.entities.some((e) => e.type === 'text')).toBe(false)
    expect(m.entities.filter((e) => e.type === 'line').length).toBeGreaterThan(before)
  })
})
