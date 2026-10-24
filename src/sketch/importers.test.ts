/** SVG and DXF import: parsed with the built-in readers, turned into sketch entities, checked through profile detection. */
import { describe, expect, it } from 'vitest'
import { boundsOfImport, insertImported, parseDxf, parseSvg } from './importers'
import { detectProfiles } from './profiles'
import { emptyModel } from './types'

const near = (a: number, b: number, rel = 2e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
const into = (imp: ReturnType<typeof parseSvg>) => { const m = emptyModel(); insertImported(m, imp); return m }

describe('SVG', () => {
  it('a mm-sized rectangle becomes a closed profile with the right area', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="30mm" viewBox="0 0 50 30"><rect x="5" y="5" width="40" height="20"/></svg>'
    const m = into(parseSvg(svg))
    const ps = detectProfiles(m)
    expect(ps.length).toBe(1)
    near(ps[0].area, 800)
  })

  it('pixels convert at 96 per inch and y points up', () => {
    const svg = '<svg width="96" height="96"><line x1="0" y1="0" x2="96" y2="96"/></svg>'
    const imp = parseSvg(svg)
    const b = boundsOfImport(imp)!
    near(b[2] - b[0], 25.4)
    expect(imp.shapes[0]).toMatchObject({ k: 'line' })
    const l = imp.shapes[0] as { a: [number, number]; b: [number, number] }
    expect(l.a[1]).toBeGreaterThan(l.b[1]) // the line's start was at the top of the page
  })

  it('circles stay circles, ellipses become curves, transforms apply', () => {
    const svg = '<svg width="100mm" height="100mm" viewBox="0 0 100 100"><g transform="translate(10 20) scale(2)"><circle cx="5" cy="5" r="5"/></g><ellipse cx="70" cy="70" rx="20" ry="10"/></svg>'
    const imp = parseSvg(svg)
    const circle = imp.shapes.find((s) => s.k === 'circle') as { r: number; c: [number, number] }
    near(circle.r, 10)
    near(circle.c[0], 20)
    near(circle.c[1], -30) // the page is flipped about the top edge, so the artwork lies below the origin
    const ps = detectProfiles(into(imp))
    expect(ps.length).toBe(2)
    near(ps.map((p) => p.area).sort((a, b) => a - b)[0], Math.PI * 100, 5e-3)
    near(ps.map((p) => p.area).sort((a, b) => a - b)[1], Math.PI * 20 * 10, 5e-3)
  })

  it('paths: lines, cubics, quadratics and arcs close into a profile', () => {
    // a rounded "D": a straight edge, and a half circle made from an arc command
    const svg = '<svg width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M 10 10 H 50 A 20 20 0 0 1 50 50 H 10 Z"/></svg>'
    const ps = detectProfiles(into(parseSvg(svg)))
    expect(ps.length).toBe(1)
    near(ps[0].area, 40 * 40 + (Math.PI * 400) / 2)
    const cubic = '<svg width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M 10 50 C 10 10, 50 10, 50 50 S 90 90, 90 50 Q 50 30 10 50 Z"/></svg>'
    const imp = parseSvg(cubic)
    expect(imp.shapes.some((s) => s.k === 'bez')).toBe(true)
    expect(detectProfiles(into(imp)).length).toBeGreaterThan(0)
  })

  it('a reflected arc keeps its sweep', () => {
    const svg = '<svg width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M 20 50 A 30 30 0 0 1 80 50"/></svg>'
    const imp = parseSvg(svg)
    const arc = imp.shapes[0] as { k: string; c: [number, number]; r: number; a0: number; a1: number }
    expect(arc.k).toBe('arc')
    near(arc.r, 30)
    // it bulges upwards on the page (sweep flag 1 goes over the top), which is +y after the flip: a half circle above y = 50
    const mid = arc.a0 + (arc.a1 - arc.a0) / 2
    expect(Math.sin(mid)).toBeGreaterThan(0.99)
  })

  it('rounded rectangles, polylines and groups', () => {
    const svg = '<svg width="100mm" height="100mm" viewBox="0 0 100 100"><g><rect x="0" y="0" width="40" height="20" rx="5"/></g><polygon points="50,0 70,0 60,20"/></svg>'
    const ps = detectProfiles(into(parseSvg(svg)))
    expect(ps.length).toBe(2)
    near(ps.map((p) => p.area).sort((a, b) => a - b)[0], 200, 5e-3)
    near(ps.map((p) => p.area).sort((a, b) => a - b)[1], 800 - (4 - Math.PI) * 25, 5e-3)
  })

  it('text and images are reported, not silently dropped', () => {
    const imp = parseSvg('<svg width="10mm" height="10mm"><text x="1" y="5">hi</text><rect width="5" height="5"/></svg>')
    expect(imp.notes.join(' ')).toMatch(/text/)
    expect(imp.shapes.length).toBe(4)
  })

  it('rejects things that are not SVG', () => {
    expect(() => parseSvg('hello')).toThrow(/not an SVG/)
  })
})

describe('DXF', () => {
  const dxf = (body: string, header = '') => `0\nSECTION\n2\nHEADER\n${header}0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${body}0\nENDSEC\n0\nEOF\n`
  const pair = (pairs: [number, string | number][]) => pairs.map(([c, v]) => `${c}\n${v}\n`).join('')

  it('lines, circles and arcs', () => {
    const body = pair([[0, 'LINE'], [10, 0], [20, 0], [11, 30], [21, 0]])
      + pair([[0, 'LINE'], [10, 30], [20, 0], [11, 30], [21, 20]])
      + pair([[0, 'LINE'], [10, 30], [20, 20], [11, 0], [21, 20]])
      + pair([[0, 'LINE'], [10, 0], [20, 20], [11, 0], [21, 0]])
      + pair([[0, 'CIRCLE'], [10, 100], [20, 100], [40, 5]])
      + pair([[0, 'ARC'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90]])
    const imp = parseDxf(dxf(body))
    expect(imp.shapes.map((s) => s.k).sort()).toEqual(['arc', 'circle', 'line', 'line', 'line', 'line'])
    const ps = detectProfiles(into(imp))
    expect(ps.some((p) => Math.abs(p.area - Math.PI * 25) < 0.5)).toBe(true)
  })

  it('polyline with bulges: a slot outline', () => {
    // two half circles (bulge 1) joined by straight sides: width 10, straight length 20
    const body = pair([[0, 'LWPOLYLINE'], [70, 1], [90, 4], [10, 0], [20, 0], [42, 0], [10, 20], [20, 0], [42, 1], [10, 20], [20, 10], [42, 0], [10, 0], [20, 10], [42, 1]])
    const ps = detectProfiles(into(parseDxf(dxf(body))))
    expect(ps.length).toBe(1)
    near(ps[0].area, 20 * 10 + (Math.PI * 25), 3e-3)
  })

  it('old style polylines, points, ellipses and splines', () => {
    const body = pair([[0, 'POLYLINE'], [70, 1]]) + pair([[0, 'VERTEX'], [10, 0], [20, 0]]) + pair([[0, 'VERTEX'], [10, 10], [20, 0]]) + pair([[0, 'VERTEX'], [10, 10], [20, 10]]) + pair([[0, 'SEQEND']])
      + pair([[0, 'POINT'], [10, 50], [20, 50]])
      + pair([[0, 'ELLIPSE'], [10, 100], [20, 0], [11, 20], [21, 0], [40, 0.5], [41, 0], [42, 6.283185307179586]])
      + pair([[0, 'SPLINE'], [70, 0], [71, 3], [74, 4], [11, 0], [21, 50], [11, 10], [21, 60], [11, 20], [21, 55], [11, 30], [21, 70]])
      + pair([[0, 'HATCH']])
    const imp = parseDxf(dxf(body))
    expect(imp.shapes.map((s) => s.k).sort()).toEqual(['ellipse', 'fit', 'line', 'line', 'line', 'point'])
    expect(imp.notes.join(' ')).toMatch(/HATCH/)
    const m = into(imp)
    expect(m.entities.some((e) => e.type === 'ellipse')).toBe(true)
    expect(m.entities.some((e) => e.type === 'spline')).toBe(true)
  })

  it('B-spline control points are sampled into a fit spline', () => {
    const body = pair([[0, 'SPLINE'], [70, 8], [71, 3], [72, 8], [73, 4]])
      + [0, 0, 0, 0, 1, 1, 1, 1].map((k) => `40\n${k}\n`).join('')
      + pair([[10, 0], [20, 0], [10, 10], [20, 20], [10, 20], [20, 20], [10, 30], [20, 0]])
    const imp = parseDxf(dxf(body))
    const s = imp.shapes[0] as { k: string; pts: [number, number][] }
    expect(s.k).toBe('fit')
    expect(s.pts[0]).toEqual([0, 0])
    near(s.pts[s.pts.length - 1][0], 30, 1e-6)
    expect(imp.notes.join(' ')).toMatch(/sampled/)
  })

  it('reads the drawing units (inches become millimetres)', () => {
    const body = pair([[0, 'LINE'], [10, 0], [20, 0], [11, 2], [21, 0]])
    const imp = parseDxf(dxf(body, pair([[9, '$INSUNITS'], [70, 1]])))
    const l = imp.shapes[0] as { b: [number, number] }
    near(l.b[0], 50.8)
  })

  it('rejects binary or empty files', () => {
    expect(() => parseDxf('AutoCAD Binary DXF')).toThrow(/ASCII/)
  })
})

describe('inserting', () => {
  it('shares the points where ends meet and honours offset and scale', () => {
    const svg = '<svg width="10mm" height="10mm" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    const m = emptyModel()
    const ids = insertImported(m, parseSvg(svg), [100, 50], 2)
    expect(ids.length).toBe(4)
    expect(m.entities.filter((e) => e.type === 'point').length).toBe(4)
    const ps = detectProfiles(m)
    near(ps[0].area, 400)
    expect(ps[0].centroid[0]).toBeCloseTo(110, 6)
  })
})
