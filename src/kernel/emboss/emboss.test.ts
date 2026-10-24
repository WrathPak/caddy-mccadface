import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import { initManifold } from '../mesh'
import { cube, cylinder, meshOf, split } from '../generators/testkit'
import { buildEmbossTool, type EmbossInput } from './emboss'
import { rasterArtwork } from './raster'
import { fitArtwork, type Artwork } from './shapes'
import { parseSvg, pathPolylines } from './svg'
import { loadFont, textShape } from './text'

let W: ManifoldToplevel
const owned: { delete(): void }[] = []
const own = <T extends { delete(): void }>(m: T): T => (owned.push(m), m)
beforeAll(async () => { W = await initManifold() })
afterAll(() => { for (const m of owned) m.delete() })

const fontBytes = (file: string): ArrayBuffer => {
  const b = fs.readFileSync('node_modules/@fontsource/' + file)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
const INTER = fontBytes('inter/files/inter-latin-700-normal.woff')
const SCRIPT = fontBytes('pacifico/files/pacifico-latin-400-normal.woff')

const text = (t: string, size = 6, font = INTER): Artwork => ({ parts: [textShape(font, t, { size, letterSpacing: 0, lineSpacing: 1, align: 'center' }).shape], strokes: [] })

function topOf(size: [number, number, number]) {
  const body = own(cube(W, size))
  const { region, others } = split(meshOf(body), (n) => n[2] > 0.99)
  return { body, region, others }
}

function emboss(art: Artwork, set: { region: { positions: Float32Array; indices: Uint32Array } }, over: Partial<EmbossInput> = {}) {
  return buildEmbossTool(W, {
    art, mode: 'emboss', depth: 1, sink: 0.3, pos: [30, 20, 10], rotation: 0, wrap: 'project', weight: 0, detail: 0.5,
    positions: set.region.positions, indices: set.region.indices, ...over,
  }, own)
}

/** Apply the tool to the body the way the worker op does. */
function apply(body: Manifold, t: Manifold, mode: 'emboss' | 'engrave') {
  return own(mode === 'emboss' ? body.add(t) : body.subtract(t))
}

describe('text outlines', () => {
  it('capital letters are exactly the requested height', () => {
    const { shape } = textShape(INTER, 'HEH', { size: 8, letterSpacing: 0, lineSpacing: 1, align: 'center' })
    let lo = Infinity, hi = -Infinity
    for (const l of shape.loops) for (const [, y] of l) { lo = Math.min(lo, y); hi = Math.max(hi, y) }
    expect(hi - lo).toBeCloseTo(8, 1)
  })
  it('letter spacing widens the text and a second line makes it taller', () => {
    const w = (t: string, ls = 0) => { const s = textShape(INTER, t, { size: 5, letterSpacing: ls, lineSpacing: 1, align: 'left' }).shape; let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const l of s.loops) for (const [x, y] of l) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y) } return [b - a, d - c] }
    expect(w('ABC', 0.3)[0]).toBeGreaterThan(w('ABC', 0)[0] + 1)
    expect(w('AB\nCD')[1]).toBeGreaterThan(w('AB')[1] * 1.8)
  })
  it('unknown characters are reported, not drawn', () => {
    expect(textShape(INTER, 'A☃B', { size: 5, letterSpacing: 0, lineSpacing: 1, align: 'center' }).missing).toEqual(['☃'])
  })
  it('loads the same font bytes once', () => {
    expect(loadFont(INTER)).toBe(loadFont(INTER))
  })
})

describe('emboss on a flat face', () => {
  it('raises text by the depth, one manifold piece, genus 0', () => {
    const set = topOf([60, 40, 10])
    const r = emboss(text('HELLO'), set)
    expect(r.wrapped).toBe('project')
    expect(r.offSurface).toBe(0)
    const m = apply(set.body, r.tool, 'emboss')
    expect(m.status()).toBe('NoError')
    expect(m.genus()).toBe(0)
    expect(m.decompose().length).toBe(1)
    expect(m.boundingBox().max[2]).toBeCloseTo(11, 2)
    expect(m.volume()).toBeGreaterThan(set.body.volume() + 20)
  })
  it('engraves: the top stays at the surface and the volume drops', () => {
    const set = topOf([60, 40, 10])
    const r = emboss(text('HELLO'), set, { mode: 'engrave', depth: 0.8 })
    const m = apply(set.body, r.tool, 'engrave')
    expect(m.status()).toBe('NoError')
    expect(m.boundingBox().max[2]).toBeCloseTo(10, 3)
    expect(set.body.volume() - m.volume()).toBeGreaterThan(8)
    expect(m.decompose().length).toBe(1)
  })
  it('sits where it was asked to and turns with the rotation', () => {
    const set = topOf([80, 40, 10])
    const a = emboss(text('IIII', 5), set, { pos: [20, 20, 10] }).tool.boundingBox()
    const b = emboss(text('IIII', 5), set, { pos: [60, 20, 10], rotation: 90 }).tool.boundingBox()
    expect((a.min[0] + a.max[0]) / 2).toBeCloseTo(20, 1)
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(60, 1)
    // rotated by a quarter turn the wide text becomes tall
    expect(a.max[0] - a.min[0]).toBeGreaterThan(a.max[1] - a.min[1])
    expect(b.max[1] - b.min[1]).toBeGreaterThan(b.max[0] - b.min[0])
  })
  it('weight grows the outline', () => {
    const set = topOf([60, 40, 10])
    const v = (weight: number) => emboss(text('HI'), set, { weight }).tool.volume()
    expect(v(0.3)).toBeGreaterThan(v(0) * 1.1)
    expect(v(-0.15)).toBeLessThan(v(0) * 0.95)
  })
  it('warns when the artwork runs off the selected faces', () => {
    const set = topOf([60, 40, 10])
    const r = emboss(text('HELLO WORLD', 10), set, { pos: [58, 20, 10] })
    expect(r.offSurface).toBeGreaterThan(0.05)
    expect(r.warnings.join(' ')).toMatch(/off the selected faces/)
  })
  it('works with a script font whose letters overlap', () => {
    const set = topOf([80, 40, 10])
    const r = emboss(text('Hello', 8, SCRIPT), set)
    const m = apply(set.body, r.tool, 'emboss')
    expect(m.status()).toBe('NoError')
    expect(m.decompose().length).toBe(1)
  })
})

describe('emboss on curved faces', () => {
  it('wraps around a cylinder without distortion', () => {
    const body = own(cylinder(W, 15, 40, 160))
    const { region } = split(meshOf(body), (n) => Math.abs(n[2]) < 0.2)
    const art = text('WRAP IT', 6)
    const r = emboss(art, { region }, { wrap: 'cylinder', pos: [15, 0, 20], depth: 1 })
    expect(r.wrapped).toBe('cylinder')
    const m = apply(body, r.tool, 'emboss')
    expect(m.status()).toBe('NoError')
    expect(m.decompose().length).toBe(1)
    expect(m.genus()).toBe(0)
    // the top of the letters is exactly one depth above the cylinder
    let rmax = 0
    const mesh = r.tool.getMesh()
    for (let i = 0; i < mesh.vertProperties.length; i += 3) rmax = Math.max(rmax, Math.hypot(mesh.vertProperties[i], mesh.vertProperties[i + 1]))
    expect(rmax).toBeGreaterThan(15.98)
    expect(rmax).toBeLessThan(16.02)
    // arc length is preserved: the text is as wide around the cylinder as it is flat
    const flat = emboss(art, topOf([80, 40, 10]), { pos: [40, 20, 10] }).tool.boundingBox()
    let a0 = Infinity, a1 = -Infinity
    for (let i = 0; i < mesh.vertProperties.length; i += 3) { const an = Math.atan2(mesh.vertProperties[i + 1], mesh.vertProperties[i]); a0 = Math.min(a0, an); a1 = Math.max(a1, an) }
    const angSpan = a1 - a0
    expect(Math.abs(angSpan) * 15).toBeGreaterThan((flat.max[0] - flat.min[0]) * 0.97)
    expect(Math.abs(angSpan) * 15).toBeLessThan((flat.max[0] - flat.min[0]) * 1.03)
  })
  it('engraves into a cylinder', () => {
    const body = own(cylinder(W, 15, 40, 160))
    const { region } = split(meshOf(body), (n) => Math.abs(n[2]) < 0.2)
    const r = emboss(text('CUT', 6), { region }, { wrap: 'cylinder', mode: 'engrave', depth: 0.8, pos: [15, 0, 20] })
    const m = apply(body, r.tool, 'engrave')
    expect(m.status()).toBe('NoError')
    expect(body.volume() - m.volume()).toBeGreaterThan(5)
    expect(m.boundingBox().max[0]).toBeCloseTo(15, 1)
  })
  it('wrapping a hole prints on its inner wall', () => {
    const body = own(W.Manifold.cube([50, 50, 30]).subtract(own(W.Manifold.cylinder(30, 12, 12, 120).translate(25, 25, 0))))
    const { region } = split(meshOf(body), (n, c) => Math.abs(n[2]) < 0.2 && Math.hypot(c[0] - 25, c[1] - 25) < 13)
    const r = emboss(text('IN', 5), { region }, { wrap: 'cylinder', pos: [37, 25, 15], depth: 0.8 })
    expect(r.wrapped).toBe('cylinder')
    const m = apply(body, r.tool, 'emboss')
    expect(m.status()).toBe('NoError')
    expect(m.volume()).toBeGreaterThan(body.volume())
    // the letters stand into the hole: the closest approach to the axis is one depth inside the wall
    let rmin = Infinity
    const mesh = r.tool.getMesh()
    for (let i = 0; i < mesh.vertProperties.length; i += 3) rmin = Math.min(rmin, Math.hypot(mesh.vertProperties[i] - 25, mesh.vertProperties[i + 1] - 25))
    expect(rmin).toBeGreaterThan(11.15)
    expect(rmin).toBeLessThan(11.25)
  })
  it('projects along the normal onto a sphere', () => {
    const body = own(W.Manifold.sphere(20, 128))
    const { region } = split(meshOf(body), (n, c) => c[2] > 6 && n[2] > 0.3)
    const r = emboss(text('DOME', 5), { region }, { pos: [0, 0, 20], depth: 0.8 })
    expect(r.wrapped).toBe('project')
    const m = apply(body, r.tool, 'emboss')
    expect(m.status()).toBe('NoError')
    expect(m.genus()).toBe(0)
    expect(m.boundingBox().max[2]).toBeGreaterThan(20.7)
    expect(m.boundingBox().max[2]).toBeLessThan(21)
  })
  it('falls back to projection when the faces are not a cylinder', () => {
    const set = topOf([60, 40, 10])
    const r = emboss(text('FLAT'), set, { wrap: 'cylinder' })
    expect(r.wrapped).toBe('project')
    expect(r.warnings.join(' ')).toMatch(/not a cylinder/)
  })
})

describe('svg logos', () => {
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" fill="#ffffff"/>
    <g transform="translate(10 10) scale(0.8)">
      <path fill-rule="evenodd" d="M50 0 A50 50 0 1 1 49.99 0 Z M50 20 A30 30 0 1 0 50.01 20 Z" fill="#111"/>
      <rect x="40" y="40" width="20" height="20" fill="black"/>
    </g>
  </svg>`
  it('reads shapes, honours transforms, fill rules and ignores white backgrounds', () => {
    const art = parseSvg(SVG)
    expect(art.parts.length).toBe(2)
    const sized = fitArtwork(art, 30)
    let lo = Infinity, hi = -Infinity
    for (const p of sized.parts) for (const l of p.loops) for (const [x] of l) { lo = Math.min(lo, x); hi = Math.max(hi, x) }
    expect(hi - lo).toBeCloseTo(30, 2)
  })
  it('embosses a ring with a square in the middle: two pieces', () => {
    const set = topOf([60, 60, 10])
    const r = emboss(fitArtwork(parseSvg(SVG), 30), set, { pos: [30, 30, 10] })
    // the ring has a hole (genus 1) and the square floats inside it as a second solid
    expect(r.tool.decompose().length).toBe(2)
    const m = apply(set.body, r.tool, 'emboss')
    expect(m.status()).toBe('NoError')
    expect(m.genus()).toBe(0)
    expect(m.decompose().length).toBe(1)
  })
  it('parses arcs, curves and relative commands', () => {
    const sq = pathPolylines('m10 10 h20 v20 h-20 z', 0.1)
    expect(sq).toHaveLength(1)
    expect(sq[0].closed).toBe(true)
    expect(sq[0].pts[2]).toEqual([30, 30])
    const circle = pathPolylines('M0 10 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 z', 0.05)
    const xs = circle[0].pts.map((p) => p[0]), ys = circle[0].pts.map((p) => p[1])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 1)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 1)
    const curve = pathPolylines('M0 0 C0 10 10 10 10 0', 0.01)
    expect(curve[0].pts.length).toBeGreaterThan(8)
  })
  it('turns strokes into solid lines', () => {
    const art = parseSvg('<svg viewBox="0 0 10 10"><path d="M1 5 H9" stroke="black" stroke-width="2" fill="none"/></svg>')
    expect(art.parts).toHaveLength(0)
    expect(art.strokes).toHaveLength(1)
    const set = topOf([40, 40, 10])
    const r = emboss(fitArtwork(art, 20), set, { pos: [20, 20, 10] })
    expect(r.tool.volume()).toBeGreaterThan(5)
  })
  it('rejects files that are not SVG or draw nothing', () => {
    expect(() => parseSvg('hello')).toThrow(/not an SVG/)
    expect(() => parseSvg('<svg viewBox="0 0 1 1"><rect width="1" height="1" fill="white"/></svg>')).toThrow(/No drawable/)
  })
})

describe('bitmap logos', () => {
  /** A 80 x 80 black ring (outer radius 30, inner 15) on a white background. */
  const ring = () => {
    const w = 80, h = 80
    const px = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = Math.hypot(x + 0.5 - 40, y + 0.5 - 40)
      const v = r < 30 && r > 15 ? 0 : 255
      px.set([v, v, v, 255], (y * w + x) * 4)
    }
    return { px, w, h }
  }
  it('traces the outline of a ring into two loops', () => {
    const { px, w, h } = ring()
    const art = rasterArtwork(px, w, h, { threshold: 0.5, invert: false, simplify: 0.6 })
    expect(art.parts[0].loops).toHaveLength(2)
  })
  it('embosses to the requested width and keeps the hole (genus 1 tool)', () => {
    const { px, w, h } = ring()
    const art = fitArtwork(rasterArtwork(px, w, h, { threshold: 0.5, invert: false, simplify: 0.6 }), 24)
    const set = topOf([50, 50, 10])
    const r = emboss(art, set, { pos: [25, 25, 10] })
    const bb = r.tool.boundingBox()
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(24, 0)
    expect(r.tool.genus()).toBe(1)
  })
  it('invert swaps shape and background; an empty image is an error', () => {
    const { px, w, h } = ring()
    const inv = rasterArtwork(px, w, h, { threshold: 0.5, invert: true, simplify: 0.6 })
    expect(inv.parts[0].loops.length).toBeGreaterThanOrEqual(2)
    const blank = new Uint8ClampedArray(16 * 16 * 4).fill(255)
    expect(() => rasterArtwork(blank, 16, 16, { threshold: 0.5, invert: false, simplify: 0.6 })).toThrow(/No shape/)
  })
})
