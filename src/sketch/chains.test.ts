/** Curve chains: open and closed runs of connected sketch curves. */
import { describe, expect, it } from 'vitest'
import { detectChains, pathSegs } from './chains'
import { addArc, addCircle, addLine, addPoint, addSpline } from './model'
import { originPlane } from './plane'
import { emptyModel, type SketchModel } from './types'

const poly = (m: SketchModel, pts: [number, number][], close = false) => {
  const ids = pts.map(([x, y]) => addPoint(m, x, y))
  const n = close ? ids.length : ids.length - 1
  for (let i = 0; i < n; i++) addLine(m, ids[i], ids[(i + 1) % ids.length])
  return ids
}

describe('chains', () => {
  it('an open polyline is one open chain, in walking order', () => {
    const m = emptyModel()
    poly(m, [[0, 0], [10, 0], [10, 10], [20, 10]])
    const c = detectChains(m)
    expect(c.length).toBe(1)
    expect(c[0].closed).toBe(false)
    expect(c[0].segs.length).toBe(3)
    // the segments join up end to start
    c[0].segs.forEach((s, i) => { if (i) expect(s.k === 'l' && c[0].segs[i - 1].k === 'l' && s.a).toEqual((c[0].segs[i - 1] as { b: unknown }).b) })
  })

  it('segments drawn in mixed directions are still walked end to start', () => {
    const m = emptyModel()
    const a = addPoint(m, 0, 0), b = addPoint(m, 10, 0), c = addPoint(m, 10, 10)
    addLine(m, b, a)
    addLine(m, b, c)
    const chains = detectChains(m)
    expect(chains.length).toBe(1)
    const [s0, s1] = chains[0].segs
    expect(s0.k === 'l' && s1.k === 'l' && s0.b[0] === s1.a[0] && s0.b[1] === s1.a[1]).toBe(true)
  })

  it('a closed polygon, a circle and a closed spline are closed chains', () => {
    const m = emptyModel()
    poly(m, [[0, 0], [10, 0], [10, 10], [0, 10]], true)
    addCircle(m, addPoint(m, 40, 0), 5)
    const pts = [addPoint(m, 60, 0), addPoint(m, 70, 5), addPoint(m, 65, 15), addPoint(m, 55, 10)]
    addSpline(m, pts, 'fit', true)
    const c = detectChains(m)
    expect(c.length).toBe(3)
    expect(c.every((x) => x.closed)).toBe(true)
  })

  it('a T junction splits the chains; construction curves are left out', () => {
    const m = emptyModel()
    const o = addPoint(m, 0, 0), x = addPoint(m, 10, 0), y = addPoint(m, 0, 10), nx = addPoint(m, -10, 0)
    addLine(m, o, x)
    addLine(m, o, y)
    addLine(m, o, nx)
    addLine(m, x, y, true)
    expect(detectChains(m).length).toBe(3)
  })

  it('an arc joined to a line is one chain with an arc piece', () => {
    const m = emptyModel()
    const c = addPoint(m, 0, 0), s = addPoint(m, 10, 0), e = addPoint(m, 0, 10), t = addPoint(m, 0, 30)
    addArc(m, c, s, e)
    addLine(m, e, t)
    const chains = detectChains(m)
    expect(chains.length).toBe(1)
    expect(chains[0].segs.map((g) => g.k).sort()).toEqual(['a', 'l'])
  })

  it('keys and ids are stable between runs', () => {
    const build = () => { const m = emptyModel(); poly(m, [[0, 0], [10, 0], [10, 10]]); return detectChains(m)[0] }
    expect(build().key).toBe(build().key)
    expect(build().id).toBe(build().id)
  })

  it('world path pieces: a circle becomes two half arcs on the plane', () => {
    const m = emptyModel()
    addCircle(m, addPoint(m, 0, 0), 5)
    const path = pathSegs(originPlane('XZ'), detectChains(m)[0].segs)
    expect(path.length).toBe(2)
    expect(path[0].k).toBe('a')
    // XZ plane: local y is world Z
    expect((path[0] as { m: number[] }).m[2]).toBeCloseTo(5, 9)
  })
})
