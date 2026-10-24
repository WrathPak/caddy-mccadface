import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import { initManifold } from '../mesh'
import { cube, cylinder, meshOf, triNormal, centroid } from '../generators/testkit'
import type { TopoMesh } from '../types'
import { applyTexture, type TextureInput } from './displace'
import { PATTERNS, heightImageOf, imageHeight } from './patterns'
import { subdivideRegion } from './subdivide'

let W: ManifoldToplevel
const owned: Manifold[] = []
const own = (m: Manifold) => (owned.push(m), m)
beforeAll(async () => { W = await initManifold() })
afterAll(() => { for (const m of owned) m.delete() })

const solidOf = (m: TopoMesh) => own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: m.positions.slice(), triVerts: m.indices.slice() })))

function body(m: Manifold, pick: (n: [number, number, number], c: [number, number, number]) => boolean) {
  const t = meshOf(m)
  const region = new Uint8Array(t.indices.length / 3)
  for (let i = 0; i < region.length; i++) region[i] = pick(triNormal(t, i), centroid(t, i)) ? 1 : 0
  return { t, region }
}

const base: Omit<TextureInput, 'positions' | 'indices' | 'region'> = {
  pattern: { id: 'knurl' }, scale: 3, depth: 0.6, direction: 'out', rotation: 0, offsetU: 0, offsetV: 0, blend: 1, projection: 'triplanar', detail: 0.4, maxTris: 1_500_000,
}
const run = (b: { t: TopoMesh; region: Uint8Array }, over: Partial<TextureInput> = {}) =>
  applyTexture({ ...base, positions: b.t.positions, indices: b.t.indices, region: b.region, ...over })

const zRange = (m: TopoMesh, region?: Uint8Array) => {
  let lo = Infinity, hi = -Infinity
  for (let t = 0; t < m.indices.length / 3; t++) {
    if (region && !region[t]) continue
    for (let k = 0; k < 3; k++) { const z = m.positions[m.indices[t * 3 + k] * 3 + 2]; lo = Math.min(lo, z); hi = Math.max(hi, z) }
  }
  return [lo, hi]
}

describe('adaptive subdivision', () => {
  it('splits the region to the target edge length and keeps the mesh watertight', () => {
    const b = own(cube(W, [20, 20, 10]))
    const { t, region } = body(b, (n) => n[2] > 0.99)
    const r = subdivideRegion(t, region, 2, 1_000_000)
    const m = solidOf(r.mesh)
    expect(m.status()).toBe('NoError')
    expect(m.volume()).toBeCloseTo(b.volume(), 3)
    expect(m.genus()).toBe(0)
    // no region edge longer than the target
    const p = r.mesh.positions, ix = r.mesh.indices
    for (let k = 0; k < r.region.length; k++) {
      if (!r.region[k]) continue
      for (let e = 0; e < 3; e++) {
        const a = ix[k * 3 + e] * 3, c = ix[k * 3 + (e + 1) % 3] * 3
        expect(Math.hypot(p[a] - p[c], p[a + 1] - p[c + 1], p[a + 2] - p[c + 2])).toBeLessThanOrEqual(2 + 1e-4)
      }
    }
    // the rest of the cube is only split where the top face's new vertices touch it
    let others = 0
    for (let k = 0; k < r.region.length; k++) if (!r.region[k]) others++
    expect(others).toBeLessThan(r.mesh.indices.length / 3 / 2)
  })
  it('respects the triangle budget', () => {
    const b = own(cube(W, [50, 50, 10]))
    const { t, region } = body(b, (n) => n[2] > 0.99)
    const r = subdivideRegion(t, region, 0.1, 5000)
    expect(r.limited).toBe(true)
    expect(r.triangles).toBeLessThanOrEqual(5000)
    expect(solidOf(r.mesh).status()).toBe('NoError')
  })
})

describe('patterns', () => {
  it('every pattern tiles in both directions and uses most of the height range', () => {
    for (const p of PATTERNS) {
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i < 60; i++) {
        for (let j = 0; j < 60; j++) {
          const u = i / 60 + 0.013, v = j / 60 + 0.007
          const h = p.height(u, v)
          expect(h).toBeGreaterThanOrEqual(0)
          expect(h).toBeLessThanOrEqual(1)
          expect(p.height(u + 1, v)).toBeCloseTo(h, 5)
          expect(p.height(u, v + 1)).toBeCloseTo(h, 5)
          lo = Math.min(lo, h); hi = Math.max(hi, h)
        }
      }
      expect(hi - lo, p.id).toBeGreaterThan(0.6)
    }
  })
})

describe('texture on a flat face', () => {
  for (const p of PATTERNS) {
    it(`${p.id}: raised texture stays a manifold with the right height`, () => {
      const b = own(cube(W, [40, 40, 20]))
      const set = body(b, (n) => n[2] > 0.99)
      const r = run(set, { pattern: { id: p.id }, detail: 0.5 })
      const m = solidOf(r.mesh)
      expect(m.status()).toBe('NoError')
      expect(m.genus()).toBe(0)
      expect(m.decompose().length).toBe(1)
      const [lo, hi] = zRange(r.mesh, r.region)
      expect(lo).toBeGreaterThanOrEqual(20 - 1e-4)
      expect(hi).toBeGreaterThan(20 + 0.4)
      expect(hi).toBeLessThanOrEqual(20.6 + 1e-3)
      expect(m.volume()).toBeGreaterThan(b.volume())
    })
  }
  it('cut and both directions move the surface the other way', () => {
    const b = own(cube(W, [40, 40, 20]))
    const set = body(b, (n) => n[2] > 0.99)
    const cut = run(set, { direction: 'in' })
    expect(solidOf(cut.mesh).volume()).toBeLessThan(b.volume())
    expect(zRange(cut.mesh, cut.region)[1]).toBeLessThanOrEqual(20 + 1e-4)
    const both = run(set, { direction: 'both' })
    const [lo, hi] = zRange(both.mesh, both.region)
    expect(lo).toBeLessThan(20 - 0.1)
    expect(hi).toBeGreaterThan(20 + 0.1)
  })
  it('fades out toward the edge of the selection', () => {
    const b = own(cube(W, [40, 40, 20]))
    const set = body(b, (n) => n[2] > 0.99)
    const r = run(set, { blend: 4 })
    // vertices within the blend distance of the rim barely move
    const p = r.mesh.positions
    for (let v = 0; v < p.length / 3; v++) {
      if (Math.abs(p[v * 3 + 2] - 20) < 1e-6 && Math.abs(p[v * 3 + 2] - 20) === 0) continue
      const edge = Math.min(p[v * 3], 40 - p[v * 3], p[v * 3 + 1], 40 - p[v * 3 + 1])
      if (edge < 0.01 && p[v * 3 + 2] > 19.99) expect(p[v * 3 + 2]).toBeLessThanOrEqual(20 + 1e-4)
      if (edge < 1 && p[v * 3 + 2] > 19.99) expect(p[v * 3 + 2] - 20).toBeLessThan(0.6 * 0.2)
    }
    const flush = run(set, { blend: 0 })
    expect(zRange(flush.mesh, flush.region)[1]).toBeGreaterThan(20.4)
  })
  it('scale sets the size of the pattern and depth its height', () => {
    const b = own(cube(W, [40, 40, 20]))
    const set = body(b, (n) => n[2] > 0.99)
    const a = run(set, { scale: 2, depth: 0.3 }), c = run(set, { scale: 5, depth: 1.2 })
    expect(zRange(a.mesh, a.region)[1]).toBeLessThanOrEqual(20.3 + 1e-3)
    expect(zRange(c.mesh, c.region)[1]).toBeGreaterThan(20.8)
    // the smaller pattern needs a finer mesh
    expect(a.stats.edgeLength).toBeLessThanOrEqual(c.stats.edgeLength)
  })
  it('rotation turns the pattern', () => {
    const b = own(cube(W, [40, 40, 20]))
    const set = body(b, (n) => n[2] > 0.99)
    const a = run(set, { pattern: { id: 'wood' }, rotation: 0 }), c = run(set, { pattern: { id: 'wood' }, rotation: 90 })
    let diff = 0
    for (let i = 2; i < a.mesh.positions.length && i < c.mesh.positions.length; i += 3) diff += Math.abs(a.mesh.positions[i] - c.mesh.positions[i])
    expect(diff).toBeGreaterThan(1)
  })
  it('only the selected faces are textured', () => {
    const b = own(cube(W, [40, 40, 20]))
    const set = body(b, (n) => n[2] > 0.99)
    const r = run(set, { blend: 0 })
    const m = solidOf(r.mesh)
    const bb = m.boundingBox()
    expect(bb.min[2]).toBeCloseTo(0, 5)
    expect(bb.min[0]).toBeCloseTo(0, 5)
    expect(bb.max[0]).toBeCloseTo(40, 5)
  })
})

describe('texture on round faces', () => {
  it('wraps a whole number of tiles around a cylinder (uv projection)', () => {
    const b = own(cylinder(W, 14, 36, 120))
    const set = body(b, (n) => Math.abs(n[2]) < 0.2)
    const r = run(set, { projection: 'uv', scale: 4, depth: 0.5, detail: 0.5, blend: 1.5 })
    expect(r.stats.mapped).toBe(1)
    expect(r.stats.tilesAround).toBe(Math.round((2 * Math.PI * 14) / 4))
    const m = solidOf(r.mesh)
    expect(m.status()).toBe('NoError')
    expect(m.genus()).toBe(0)
    expect(m.decompose().length).toBe(1)
    let rmax = 0
    for (let v = 0; v < r.mesh.positions.length; v += 3) rmax = Math.max(rmax, Math.hypot(r.mesh.positions[v], r.mesh.positions[v + 1]))
    expect(rmax).toBeGreaterThan(14.4)
    expect(rmax).toBeLessThan(14.51)
  })
  it('the pattern closes at the seam of a cylinder', () => {
    const b = own(cylinder(W, 14, 36, 120))
    const set = body(b, (n) => Math.abs(n[2]) < 0.2)
    const r = run(set, { projection: 'uv', scale: 4.4, depth: 0.5, detail: 0.5, blend: 0, pattern: { id: 'carbon' } })
    // compare the radius at angles 0 and 2 pi * (1 - 1/N) +- a tile: the profile around the axis repeats every tile
    const N = r.stats.tilesAround
    const rAt = (ang: number) => {
      let best = Infinity, val = 0
      for (let v = 0; v < r.mesh.positions.length; v += 3) {
        const z = r.mesh.positions[v + 2]
        if (Math.abs(z - 18) > 0.3) continue
        const a = Math.atan2(r.mesh.positions[v + 1], r.mesh.positions[v])
        let d = Math.abs(a - ang)
        d = Math.min(d, 2 * Math.PI - d)
        if (d < best) { best = d; val = Math.hypot(r.mesh.positions[v], r.mesh.positions[v + 1]) }
      }
      return val
    }
    for (const a of [0.3, 1.1, 2.7]) expect(rAt(a)).toBeCloseTo(rAt(a + (2 * Math.PI) / N), 1)
  })
  it('triplanar projection on a sphere gives a manifold', () => {
    const b = own(W.Manifold.sphere(20, 96))
    const set = body(b, (n, c) => c[2] > 0)
    const r = run(set, { projection: 'triplanar', pattern: { id: 'leather' }, scale: 6, depth: 0.5, detail: 0.7, blend: 3 })
    const m = solidOf(r.mesh)
    expect(m.status()).toBe('NoError')
    expect(m.genus()).toBe(0)
    expect(m.volume()).toBeGreaterThan(b.volume() * 0.99)
  })
  it('uv projection falls back to triplanar on a sphere and says so', () => {
    const b = own(W.Manifold.sphere(20, 64))
    const set = body(b, (n, c) => c[2] > 5)
    const r = run(set, { projection: 'uv', pattern: { id: 'hex' }, scale: 6, depth: 0.5, detail: 1, blend: 2 })
    expect(r.stats.fellBack).toBeGreaterThan(0)
    expect(r.warnings.join(' ')).toMatch(/triplanar/)
    expect(solidOf(r.mesh).status()).toBe('NoError')
  })
})

describe('image heightmaps', () => {
  const ramp = () => {
    const w = 32, h = 32
    const px = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.round((x / (w - 1)) * 255); px.set([v, v, v, 255], (y * w + x) * 4) }
    return heightImageOf(px, w, h, false)
  }
  it('brighter pixels are higher', () => {
    const f = imageHeight(ramp(), false)
    expect(f(0.1, 0.5)).toBeLessThan(f(0.9, 0.5))
    expect(f(0.1, 0.5)).toBeLessThan(0.2)
    expect(f(0.9, 0.5)).toBeGreaterThan(0.8)
  })
  it('mirrored tiling is seamless', () => {
    const f = imageHeight(ramp(), true)
    expect(f(0.999, 0.5)).toBeCloseTo(f(1.001, 0.5), 1)
    expect(f(0.1, 0.3)).toBeCloseTo(f(1.9, 0.3), 3)
  })
  it('embosses a picture onto a face', () => {
    const b = own(cube(W, [40, 40, 20]))
    const set = body(b, (n) => n[2] > 0.99)
    const r = run(set, { pattern: { image: ramp(), mirror: false }, scale: 40, depth: 1, blend: 0, detail: 1, offsetU: -0, offsetV: 0 })
    const m = solidOf(r.mesh)
    expect(m.status()).toBe('NoError')
    // the left side stays low and the right side rises
    const zAt = (x: number) => { let best = Infinity, z = 0; for (let v = 0; v < r.mesh.positions.length; v += 3) { const d = Math.abs(r.mesh.positions[v] - x) + Math.abs(r.mesh.positions[v + 1] - 20); if (d < best && r.mesh.positions[v + 2] > 19.9) { best = d; z = r.mesh.positions[v + 2] } } return z }
    expect(zAt(36) - zAt(4)).toBeGreaterThan(0.5)
  })
  it('keeps the model inside the triangle budget', () => {
    const b = own(cube(W, [80, 80, 20]))
    const set = body(b, (n) => n[2] > 0.99)
    const r = run(set, { detail: 0.05, maxTris: 60_000 })
    expect(r.stats.limited).toBe(true)
    expect(r.stats.triangles).toBeLessThanOrEqual(60_000)
    expect(r.warnings.join(' ')).toMatch(/mesh detail was raised/)
    expect(solidOf(r.mesh).status()).toBe('NoError')
  })
})
