import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Manifold } from 'manifold-3d'
import { buildSolids, wallSolid, generateHair, type HairInput } from '../../kernel/hair-core'
import { initManifold } from '../../kernel/mesh'
import type { Body } from '../../kernel/types'
import { faceSigs } from '../../doc/refs'
import { resolveRegionSet } from './region'
import { prepSurface } from './sampling'
import { hairSchema, type HairParams } from './schema'
import { followResult, makeCaster, selfIntersects } from './wall'

type Mesh = { positions: Float32Array; indices: Uint32Array }

function defaults(over: Partial<HairParams> = {}): HairParams {
  const d: Record<string, unknown> = {}
  const walk = (ps: typeof hairSchema.params) => {
    for (const p of ps) {
      if (p.type === 'group') walk(p.children)
      else d[p.key] = p.default
    }
  }
  walk(hairSchema.params)
  return { ...(d as unknown as HairParams), ...over }
}

/** Cylinder about z (radius r, z in [0,h]); `side` = lateral surface only, `solid` = capped closed solid. All normals outward. */
function cylinder(r: number, h: number, segs: number, rings: number, arc = 2 * Math.PI) {
  const full = arc >= 2 * Math.PI - 1e-9
  const cols = full ? segs : segs + 1
  const pos: number[] = []
  for (let j = 0; j <= rings; j++) for (let i = 0; i < cols; i++) {
    const a = (arc * i) / segs
    pos.push(r * Math.cos(a), r * Math.sin(a), (h * j) / rings)
  }
  const idx: number[] = []
  for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
    const i2 = full ? (i + 1) % segs : i + 1
    const a = j * cols + i, b = j * cols + i2, c = (j + 1) * cols + i2, d = (j + 1) * cols + i
    idx.push(a, b, c, a, c, d)
  }
  const side: Mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
  let solid: Mesh = side
  if (full) {
    const p = [...pos]
    const bc = p.length / 3; p.push(0, 0, 0)
    const tc = p.length / 3; p.push(0, 0, h)
    const ix = [...idx]
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % segs
      ix.push(bc, i2, i) // bottom faces -z
      ix.push(tc, rings * cols + i, rings * cols + i2) // top faces +z
    }
    solid = { positions: Float32Array.from(p), indices: Uint32Array.from(ix) }
  }
  return { side, solid }
}

/** Lower hemisphere bowl with normals pointing INTO the sphere (concave as seen from the surface normal side). */
function bowl(R: number, n = 24): Mesh {
  const pos: number[] = [], idx: number[] = []
  const rings = n / 2
  for (let j = 0; j <= rings; j++) {
    const th = Math.PI / 2 + (Math.PI / 2) * (j / rings) // 90..180 deg from +z: lower hemisphere
    for (let i = 0; i < n; i++) {
      const ph = (2 * Math.PI * i) / n
      pos.push(R * Math.sin(th) * Math.cos(ph), R * Math.sin(th) * Math.sin(ph), R * Math.cos(th))
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n
    const a = j * n + i, b = j * n + i2, c = (j + 1) * n + i2, d = (j + 1) * n + i
    idx.push(a, b, c, a, c, d) // wound so normals face the centre
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

const AXIS = { o: [0, 0, 0] as [number, number, number], d: [0, 0, 1] as [number, number, number] }
const input = (m: Mesh, p: HairParams, sides = 6): HairInput => ({ p, axis: AXIS, positions: m.positions, indices: m.indices, sides })

let W: Awaited<ReturnType<typeof initManifold>>
const owned: Manifold[] = []
const own = (m: Manifold) => (owned.push(m), m)
beforeAll(async () => { W = await initManifold() })
afterAll(() => { for (const m of owned) m.delete() })

const cyl = cylinder(10, 30, 96, 30)
const AREA_CM2 = (2 * Math.PI * 10 * 30) / 100

describe('sampling and direction', () => {
  it('places roughly density x area strands for every distribution (and in print-aware mode)', () => {
    const dens = 4
    for (const distribution of ['poisson', 'grid', 'rows'] as const) {
      for (const printAware of [false, true]) {
        const g = generateHair(input(cyl.side, defaults({ distribution, printAware, density: dens, wall: false, length: 10 })))
        const expected = dens * AREA_CM2
        expect(g.tubes.strands, `${distribution}/${printAware}`).toBeGreaterThan(expected * 0.7)
        expect(g.tubes.strands, `${distribution}/${printAware}`).toBeLessThan(expected * 1.3)
      }
    }
  })

  it('print-aware: strands are horizontal and roots sit on layer multiples for every distribution; output is deterministic', () => {
    for (const distribution of ['poisson', 'grid', 'rows'] as const) {
      const p = defaults({ distribution, printAware: true, density: 6, wall: false, length: 8, jitter: 15, waveAmp: 0.5, curl: 40 })
      const g = generateHair(input(cyl.side, p))
      const half = Math.max(p.layerHeight, Math.round(p.thickness / p.layerHeight) * p.layerHeight) / 2
      for (const st of g.strands) {
        const z0 = st.pts[2]
        for (let k = 0; k < st.scale.length; k++) expect(Math.abs(st.pts[k * 3 + 2] - z0)).toBeLessThan(1e-4)
        const layers = (z0 - half) / p.layerHeight
        expect(Math.abs(layers - Math.round(layers)), distribution).toBeLessThan(1e-3)
      }
      const g2 = generateHair(input(cyl.side, p))
      expect(Array.from(g2.tubes.positions)).toEqual(Array.from(g.tubes.positions))
    }
  })

  it('rejects non-manifold input with a readable error', () => {
    const m = cyl.side
    const idx = Uint32Array.from([...m.indices, m.indices[0], m.indices[1], m.indices[2]]) // duplicated triangle
    expect(() => prepSurface(m.positions, idx)).toThrow(/non-manifold/)
  })
})

describe('wall and booleans', () => {
  it('every tube is a genus-0 manifold; the merged union is one solid larger than the base; tips are within overlap of the wall', () => {
    const p = defaults({ density: 3, length: 12, wallThickness: 2, tipOverlap: 0.6, merge: true, wallTop: 2, wallBottom: 2 })
    const g = generateHair(input(cyl.side, p, 8))
    expect(g.strands.length).toBeGreaterThan(30)
    const T = g.tubes
    for (let r = 0; r < T.strands; r++) {
      const v0 = T.ranges[r * 4], vn = T.ranges[r * 4 + 1], i0 = T.ranges[r * 4 + 2], inn = T.ranges[r * 4 + 3]
      const ix = new Uint32Array(inn)
      for (let k = 0; k < inn; k++) ix[k] = T.indices[i0 + k] - v0
      const m = own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: T.positions.slice(v0 * 3, (v0 + vn) * 3), triVerts: ix })))
      expect(m.status()).toBe('NoError')
      expect(m.genus()).toBe(0)
      expect(m.volume()).toBeGreaterThan(0)
    }
    const base = own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: cyl.solid.positions, triVerts: cyl.solid.indices })))
    const s = buildSolids(W, g, p, cyl.solid, own)
    expect(s.badTubes).toBe(0)
    expect(s.merged!.decompose().length).toBe(1)
    expect(s.merged!.volume()).toBeGreaterThan(base.volume())
    // every strand tip is buried in the wall, within the overlap distance of its surface
    const caster = makeCaster(g.wall!.mesh)
    for (const st of g.strands) expect(caster.closest(st.tip).dist).toBeLessThanOrEqual(p.tipOverlap + 1e-3)
  })

  it('applies top/bottom margins to follow walls', () => {
    const zr = (p: HairParams) => {
      const w = generateHair(input(cylinder(10, 30, 48, 15, Math.PI).side, p)).wall!.mesh.positions
      let lo = Infinity, hi = -Infinity
      for (let i = 2; i < w.length; i += 3) { lo = Math.min(lo, w[i]); hi = Math.max(hi, w[i]) }
      return [lo, hi]
    }
    const a = zr(defaults({ density: 1, length: 6, wallTop: 0, wallBottom: 0 }))
    const b = zr(defaults({ density: 1, length: 6, wallTop: 5, wallBottom: 3 }))
    expect(b[1] - a[1]).toBeGreaterThan(4.5)
    expect(a[0] - b[0]).toBeGreaterThan(2.5)
  })

  it('terminates every strand on the wall even when its straight path misses it', () => {
    // half-cylinder region, strands fixed along (1,0,1): those rooted high leave the follow wall's footprint above its top
    const half = cylinder(10, 20, 48, 10, Math.PI).side
    const p = defaults({ density: 3, length: 10, dirMode: 'fixed', fixedDir: [1, 0, 1], lengthMode: 'toWall', wallThickness: 2, tipOverlap: 0.6 })
    const g = generateHair(input(half, p))
    const live = g.strands.length + g.dropped
    expect(live).toBeGreaterThan(0)
    expect(g.redirected).toBeGreaterThan(0)
    const caster = makeCaster(g.wall!.mesh)
    for (const st of g.strands) {
      expect(st.contact).not.toBeNull()
      expect(caster.closest(st.tip).dist).toBeLessThanOrEqual(p.tipOverlap + 1e-3)
    }
  })

  it('builds a follow wall on a tight concave surface without self-intersection errors', () => {
    const p = defaults({ density: 4, length: 12, wallThickness: 2, merge: false })
    const g = generateHair(input(bowl(3, 24), p, 8)) // offset (12 mm) is 4x the bowl radius
    expect(selfIntersects(g.wall!.mesh)).toBe(false) // curvature clamp keeps the shell clean
    const s = buildSolids(W, g, p, null, own)
    expect(s.wall!.volume()).toBeGreaterThan(0)
    expect(s.hair.volume()).toBeGreaterThan(0)
  })

  /** A closed shell whose top sheet is pushed through the axis of an inward-facing cylinder (r=10): it folds through itself. */
  function foldedWall(segs: number, rings: number) {
    const p = defaults({ density: 3, length: 12, wallThickness: 2, merge: false })
    const g = generateHair(input(cylinder(10, 8, 8, 1).side, p, 8))
    const base = cylinder(10, 30, segs, rings).side
    const nv = base.positions.length / 3
    const tris = base.indices.slice()
    for (let t = 0; t < tris.length; t += 3) { const x = tris[t + 1]; tris[t + 1] = tris[t + 2]; tris[t + 2] = x }
    const pos = new Float32Array(nv * 6)
    for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) {
      const b = base.positions[v * 3 + k]
      pos[v * 3 + k] = b
      pos[(nv + v) * 3 + k] = k === 2 ? b : b * -0.4 // top: 14 inwards, i.e. 4 past the axis
    }
    return { p, g, wall: followResult(pos, tris) }
  }

  it('repairs a folded shell with a distance-field level set (manifold, one solid)', () => {
    const { p, g, wall } = foldedWall(8, 2)
    expect(selfIntersects(wall.mesh)).toBe(true)
    const s = buildSolids(W, { ...g, wall }, p, null, own)
    expect(s.wallRepaired).toBe(true)
    expect(s.wall!.status()).toBe('NoError')
    expect(s.wall!.volume()).toBeGreaterThan(0)
    expect(s.wall!.decompose().length).toBe(1)
  })

  it('repairs a dense tight-curvature fold in under 2 s', () => {
    const { wall } = foldedWall(96, 30) // 5760 triangles, shell folded through the axis
    expect(selfIntersects(wall.mesh)).toBe(true)
    const t0 = performance.now()
    const r = wallSolid(W, wall, own)
    const ms = performance.now() - t0
    console.log(`perf: wall repair ${ms.toFixed(0)} ms`)
    expect(r.repaired).toBe(true)
    expect(r.m.status()).toBe('NoError')
    expect(r.m.volume()).toBeGreaterThan(0)
    expect(r.m.decompose().length).toBe(1)
    expect(ms).toBeLessThan(2000)
  })
})

describe('inspector selection', () => {
  it('resolves face refs and whole-body ids on mesh bodies (Use sel. flow)', () => {
    const m = cylinder(5, 5, 12, 2)
    const T = m.solid.indices.length / 3
    const body = {
      id: 'b1', name: 'Mesh', kind: 'mesh', key: 'k1', featureId: 'f',
      mesh: { positions: m.solid.positions, normals: new Float32Array(m.solid.positions.length), indices: m.solid.indices, faceIds: new Uint32Array(T), edges: new Float32Array(0) },
    } as unknown as Body
    const byBody = resolveRegionSet(['b1'], [body])
    expect(byBody?.kind).toBe('mesh')
    expect(byBody?.set.size).toBe(T)
    const byFace = resolveRegionSet([JSON.stringify({ kind: 'face', bodyId: 'b1', featureId: 'f', index: 0, sig: faceSigs(body)[0] })], [body])
    expect(byFace?.set.size).toBe(T)
  })
})

describe('performance', () => {
  it('generates ~5000 strands (sampling to tubes) in reasonable time', () => {
    const big = cylinder(25, 60, 160, 60)
    const p = defaults({ density: 55, length: 15, wall: true, printAware: false })
    const t0 = performance.now()
    const g = generateHair(input(big.side, p))
    const ms = performance.now() - t0
    console.log(`perf: ${g.tubes.strands} strands, ${ms.toFixed(0)} ms (${g.redirected} redirected)`)
    expect(g.tubes.strands).toBeGreaterThan(4000)
    expect(ms).toBeLessThan(15000)
  })
})
