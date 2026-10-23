/** Closed-region detection on real sketch models. */
import { describe, expect, it } from 'vitest'
import { detectProfiles } from './profiles'
import { addArc, addCircle, addLine, addPoint } from './model'
import { loopPoly, polyArea } from './geom'
import { emptyModel, type SketchModel } from './types'

const rect = (m: SketchModel, x0: number, y0: number, x1: number, y1: number, construction = false) => {
  const p = [addPoint(m, x0, y0), addPoint(m, x1, y0), addPoint(m, x1, y1), addPoint(m, x0, y1)]
  p.forEach((id, i) => addLine(m, id, p[(i + 1) % 4], construction))
}
const areas = (m: SketchModel) => detectProfiles(m).map((p) => p.area).sort((a, b) => b - a)
const near = (a: number, b: number, rel = 2e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(1e-6, Math.abs(b) * rel))

describe('profile detection', () => {
  it('nested holes: concentric outlines give ring, ring and island, each with the right holes', () => {
    const m = emptyModel()
    rect(m, 0, 0, 100, 100)
    rect(m, 20, 20, 80, 80)
    rect(m, 40, 40, 60, 60)
    const ps = [...detectProfiles(m)].sort((a, b) => b.area - a.area)
    expect(ps.length).toBe(3)
    near(ps[0].area, 100 * 100 - 60 * 60) // outer ring: its hole is the middle rectangle only
    expect(ps[0].holes.length).toBe(1)
    near(Math.abs(polyArea(loopPoly(ps[0].holes[0]))), 60 * 60)
    near(ps[1].area, 60 * 60 - 20 * 20) // middle ring
    expect(ps[1].holes.length).toBe(1)
    near(ps[2].area, 20 * 20) // island
    expect(ps[2].holes.length).toBe(0)
  })

  it('two holes in one outline', () => {
    const m = emptyModel()
    rect(m, 0, 0, 100, 50)
    addCircle(m, addPoint(m, 25, 25), 10)
    addCircle(m, addPoint(m, 75, 25), 10)
    const ps = detectProfiles(m)
    const outer = ps.find((p) => p.holes.length === 2)!
    expect(outer).toBeTruthy()
    near(outer.area, 5000 - 2 * Math.PI * 100)
    expect(ps.length).toBe(3) // outline-with-holes and the two discs
  })

  it('arcs: rounded rectangle area = w*h - (4 - pi) r^2', () => {
    const m = emptyModel()
    const w = 60, h = 30, r = 5
    // four lines and four quarter arcs, corners as separate centre points
    const P = (x: number, y: number) => addPoint(m, x, y)
    const l1 = addLine(m, P(r, 0), P(w - r, 0)), l2 = addLine(m, P(w, r), P(w, h - r)), l3 = addLine(m, P(w - r, h), P(r, h)), l4 = addLine(m, P(0, h - r), P(0, r))
    void l1; void l2; void l3; void l4
    addArc(m, P(w - r, r), P(w - r, 0), P(w, r))
    addArc(m, P(w - r, h - r), P(w, h - r), P(w - r, h))
    addArc(m, P(r, h - r), P(r, h), P(0, h - r))
    addArc(m, P(r, r), P(0, r), P(r, 0))
    const ps = detectProfiles(m)
    expect(ps.length).toBe(1)
    near(ps[0].area, w * h - (4 - Math.PI) * r * r)
    expect(ps[0].outer.length).toBe(8)
  })

  it('a semicircle closed by its diameter', () => {
    const m = emptyModel()
    const c = addPoint(m, 0, 0)
    addArc(m, c, addPoint(m, 10, 0), addPoint(m, -10, 0))
    addLine(m, addPoint(m, -10, 0), addPoint(m, 10, 0))
    const a = areas(m)
    expect(a.length).toBe(1)
    near(a[0], (Math.PI * 100) / 2)
  })

  it('overlapping circles split into a lens and two crescents', () => {
    const m = emptyModel()
    addCircle(m, addPoint(m, 0, 0), 10)
    addCircle(m, addPoint(m, 10, 0), 10)
    const a = areas(m)
    expect(a.length).toBe(3)
    const lens = 2 * 100 * Math.acos(0.5) - 0.5 * 10 * Math.sqrt(4 * 100 - 100)
    near(a[2], lens, 5e-3)
    near(a[0], Math.PI * 100 - lens, 5e-3)
  })

  it('a line through a rectangle splits it; dangling lines and construction geometry are ignored', () => {
    const m = emptyModel()
    rect(m, 0, 0, 40, 20)
    addLine(m, addPoint(m, 10, -10), addPoint(m, 10, 30)) // crosses top and bottom
    addLine(m, addPoint(m, 30, 5), addPoint(m, 35, 10)) // dangling inside
    rect(m, 100, 0, 110, 10, true) // construction square
    const a = areas(m)
    expect(a.length).toBe(2)
    near(a[0], 30 * 20)
    near(a[1], 10 * 20)
  })

  it('profile keys are stable under a rebuild', () => {
    const build = () => { const m = emptyModel(); rect(m, 0, 0, 40, 20); addCircle(m, addPoint(m, 20, 10), 4); return m }
    expect(detectProfiles(build()).map((p) => p.key)).toEqual(detectProfiles(build()).map((p) => p.key))
  })
})
