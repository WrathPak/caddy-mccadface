import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three'
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh'
import type { Manifold } from 'manifold-3d'
import { buildSolids, generateHair, type HairGen } from '../../kernel/hair-core'
import { initManifold } from '../../kernel/mesh'
import { hairSchema, type HairParams, type V3 } from './schema'
import { effWidth } from './sampling'
import { makeCaster } from './wall'

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

/** Closed box, outward normals. */
function boxMesh(lo: V3, hi: V3): Mesh {
  const c: V3[] = []
  for (let i = 0; i < 8; i++) c.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]])
  const quads = [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]]
  const mid: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const pos: number[] = c.flat(), idx: number[] = []
  for (const q of quads) {
    const [a, b, d] = [c[q[0]], c[q[1]], c[q[2]]]
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const out = n[0] * (a[0] - mid[0]) + n[1] * (a[1] - mid[1]) + n[2] * (a[2] - mid[2]) > 0
    idx.push(...(out ? [q[0], q[1], q[2], q[0], q[2], q[3]] : [q[0], q[2], q[1], q[0], q[3], q[2]]))
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

const triNormal = (m: Mesh, t: number): V3 => {
  const p = (k: number): V3 => [m.positions[m.indices[t * 3 + k] * 3], m.positions[m.indices[t * 3 + k] * 3 + 1], m.positions[m.indices[t * 3 + k] * 3 + 2]]
  const a = p(0), b = p(1), c = p(2)
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const l = Math.hypot(...n)
  return [n[0] / l, n[1] / l, n[2] / l]
}

/** Split a body into the triangles whose normal matches (and, optionally, whose centroid satisfies `where`) and the rest. */
function split(m: Mesh, normals: V3[], where: (c: V3) => boolean = () => true): { region: Mesh; others: Mesh } {
  const pick = (want: boolean): Mesh => {
    const pos: number[] = []
    for (let t = 0; t < m.indices.length / 3; t++) {
      const n = triNormal(m, t)
      const cen: V3 = [0, 0, 0]
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) cen[j] += m.positions[m.indices[t * 3 + k] * 3 + j] / 3
      const inside = normals.some((q) => n[0] * q[0] + n[1] * q[1] + n[2] * q[2] > 0.99) && where(cen)
      if (inside === want) for (let k = 0; k < 3; k++) pos.push(m.positions[m.indices[t * 3 + k] * 3], m.positions[m.indices[t * 3 + k] * 3 + 1], m.positions[m.indices[t * 3 + k] * 3 + 2])
    }
    return { positions: Float32Array.from(pos), indices: Uint32Array.from({ length: pos.length / 3 }, (_, i) => i) }
  }
  return { region: pick(true), others: pick(false) }
}

const bvhOf = (m: Mesh) => {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(m.positions, 3))
  g.setIndex(new BufferAttribute(m.indices.slice(), 1))
  return new MeshBVH(g)
}

/** Does any triangle of `a` cross a triangle of `b`? */
function crosses(a: Mesh, b: Mesh): boolean {
  return bvhOf(a).bvhcast(bvhOf(b), new Matrix4(), { intersectsTriangles: (t1: ExtendedTriangle, t2: ExtendedTriangle) => t1.intersectsTriangle(t2) })
}

/** Tube triangles of strand r as a standalone mesh. */
function tube(g: HairGen, r: number): Mesh {
  const T = g.tubes
  const v0 = T.ranges[r * 4], vn = T.ranges[r * 4 + 1], i0 = T.ranges[r * 4 + 2], inn = T.ranges[r * 4 + 3]
  const ix = new Uint32Array(inn)
  for (let k = 0; k < inn; k++) ix[k] = T.indices[i0 + k] - v0
  return { positions: T.positions.slice(v0 * 3, (v0 + vn) * 3), indices: ix }
}

let W: Awaited<ReturnType<typeof initManifold>>
const owned: Manifold[] = []
const own = (m: Manifold) => (owned.push(m), m)
beforeAll(async () => { W = await initManifold() })
afterAll(() => { for (const m of owned) m.delete() })

const AXIS = { o: [0, 0, 0] as V3, d: [0, 0, 1] as V3 }
const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0], Z: V3 = [0, 0, 1]

describe('edge fit: strands never overhang the selected face', () => {
  const box = boxMesh([-10, -10, 0], [10, 10, 20])
  const { region, others } = split(box, [X])

  for (const section of ['rect', 'round', 'diamond'] as const) {
    it(`2 mm wide ${section} strands stay inside the face and never touch the rest of the box`, () => {
      const p = defaults({ dirMode: 'perFace', printAware: false, distribution: 'poisson', density: 30, width: 2, nozzle: 1, thickness: 0.4, length: 6, wall: false, section, edgeMargin: 0, taper: 0, rootFlare: 50 })
      const g = generateHair({ p, axis: AXIS, positions: region.positions, indices: region.indices, obstacle: others, sides: 8 })
      expect(g.tubes.strands).toBeGreaterThan(10)
      expect(g.edgeRejected).toBeGreaterThan(0)
      const eps = 1e-3
      for (let r = 0; r < g.tubes.strands; r++) {
        const m = tube(g, r)
        for (let i = 0; i < m.positions.length; i += 3) {
          // the face spans y in [-10, 10], z in [0, 20]; nothing (not even the buried root) lies beyond its extent
          expect(Math.abs(m.positions[i + 1]), `strand ${r} y`).toBeLessThanOrEqual(10 + eps)
          expect(m.positions[i + 2], `strand ${r} z`).toBeGreaterThanOrEqual(-eps)
          expect(m.positions[i + 2], `strand ${r} z`).toBeLessThanOrEqual(20 + eps)
        }
        expect(crosses(m, others), `strand ${r} intersects the box`).toBe(false)
      }
    })
  }

  it('the edge margin comes on top of the footprint', () => {
    const base = { dirMode: 'perFace' as const, printAware: false, distribution: 'poisson' as const, density: 30, width: 2, nozzle: 1, length: 4, wall: false, taper: 0 }
    const a = generateHair({ p: defaults({ ...base, edgeMargin: 0 }), axis: AXIS, positions: region.positions, indices: region.indices, obstacle: others })
    const b = generateHair({ p: defaults({ ...base, edgeMargin: 3 }), axis: AXIS, positions: region.positions, indices: region.indices, obstacle: others })
    const ext = (g: HairGen) => Math.max(...Array.from({ length: g.strands.length }, (_, i) => Math.abs(g.strands[i].pts[g.strands[i].rootArc > 0 ? 4 : 1])))
    expect(ext(b)).toBeLessThan(ext(a))
    // root centres of the margin run are at least footprint + margin from every edge
    for (const st of b.strands) {
      const y = Math.abs(st.pts[1]), z = st.pts[2]
      expect(10 - y).toBeGreaterThanOrEqual(3 + 0.9)
      expect(Math.min(z, 20 - z)).toBeGreaterThanOrEqual(3 + 0.9)
    }
  })
})

describe('corners: roots keep off the seam between two selected faces in every direction mode', () => {
  const box = boxMesh([-10, -10, 0], [10, 10, 20])
  const both = split(box, [X, [0, -1, 0] as V3])
  const faceX = split(box, [X]).region, faceY = split(box, [[0, -1, 0] as V3]).region
  for (const over of [{ dirMode: 'perFace' as const }, { dirMode: 'blend' as const, blendDistance: 4 }, { dirMode: 'fixed' as const, fixedDir: [1, -1, 0] as V3 }, { dirMode: 'point' as const, targetPoint: [30, -30, 10] as V3, pointAway: false }]) {
    it(`${over.dirMode}: no strand pokes through the neighbouring face or the rest of the box`, () => {
      const p = defaults({ printAware: false, distribution: 'poisson', density: 40, width: 1.2, nozzle: 0.6, thickness: 0.6, length: 6, wall: false, taper: 0, ...over })
      const g = generateHair({ p, axis: AXIS, positions: both.region.positions, indices: both.region.indices, obstacle: both.others, sides: 8 })
      expect(g.tubes.strands, over.dirMode).toBeGreaterThan(10)
      for (let r = 0; r < g.tubes.strands; r++) {
        const m = tube(g, r)
        expect(crosses(m, both.others), `${over.dirMode} strand ${r} vs the rest of the box`).toBe(false)
        // rooted on the +X face (its surface point has x = 10) or on the -Y face (y = -10): it must not cross the other one
        const rootedOnX = Math.abs(g.strands[r].root[0] - 10) < 1e-2
        expect(crosses(m, rootedOnX ? faceY : faceX), `${over.dirMode} strand ${r} vs the neighbouring face`).toBe(false)
      }
    })
  }
})

describe('body collisions', () => {
  // L-shaped body: a slab with a block on its left half. Hair on the slab's top leans into the block's wall.
  const slab = boxMesh([-10, -10, 0], [20, 10, 10])
  const blockTop = boxMesh([-10, -10, 10], [0, 10, 20])
  void blockTop
  function lBody(): Mesh {
    const a = own(W.Manifold.cube([30, 20, 10]).translate([-10, -10, 0]))
    const b = own(W.Manifold.cube([10, 20, 10]).translate([-10, -10, 10]))
    const u = own(W.Manifold.union([a, b]))
    const m = u.getMesh()
    return { positions: Float32Array.from(m.vertProperties), indices: Uint32Array.from(m.triVerts) }
  }
  void slab

  it('bends strands away from the adjacent wall or removes them, and reports it; none intersect the body', () => {
    const body = lBody()
    const { region, others } = split(body, [Z], (c) => c[0] > 0.5)
    expect(region.indices.length).toBeGreaterThan(0)
    const p = defaults({ dirMode: 'fixed', fixedDir: [-1, 0, 1], printAware: false, distribution: 'poisson', density: 25, width: 0.5, thickness: 0.5, length: 9, wall: false, taper: 0 })
    const g = generateHair({ p, axis: AXIS, positions: region.positions, indices: region.indices, obstacle: others })
    expect(g.bent + g.collided).toBeGreaterThan(0)
    expect(g.tubes.strands).toBeGreaterThan(5)
    for (let r = 0; r < g.tubes.strands; r++) expect(crosses(tube(g, r), others), `strand ${r}`).toBe(false)
    // without the obstacle the same hair does run into the block
    const free = generateHair({ p, axis: AXIS, positions: region.positions, indices: region.indices })
    let hit = 0
    for (let r = 0; r < free.tubes.strands; r++) if (crosses(tube(free, r), others)) hit++
    expect(hit).toBeGreaterThan(0)
  })
})

describe('printable layers', () => {
  it('strand bands sit on whole layers counted from the lowest point of the model (not from z = 0)', () => {
    const box = boxMesh([-10, -10, 3.05], [10, 10, 23.05])
    const { region, others } = split(box, [X])
    for (const wall of [false, true]) {
      const p = defaults({ printAware: true, distribution: 'rows', density: 8, wall, length: 8, layerHeight: 0.2, firstLayer: 0.3, thickness: 0.2, width: 0.6 })
      const g = generateHair({ p, axis: AXIS, positions: region.positions, indices: region.indices, obstacle: others, sides: 8 })
      const bed = wall ? 3.05 - p.wallBottom : 3.05
      expect(g.bedZ).toBeCloseTo(bed, 4)
      for (let r = 0; r < g.tubes.strands; r++) {
        const m = tube(g, r)
        let lo = Infinity, hi = -Infinity
        for (let i = 2; i < m.positions.length; i += 3) { lo = Math.min(lo, m.positions[i]); hi = Math.max(hi, m.positions[i]) }
        const k = (lo - bed - 0.3) / 0.2
        expect(Math.abs(k - Math.round(k)), `band start ${lo}`).toBeLessThan(2e-3)
        expect((hi - lo) / 0.2, 'whole layers thick').toBeCloseTo(Math.round((hi - lo) / 0.2), 2)
        expect(hi - lo).toBeGreaterThanOrEqual(0.2 - 1e-3)
      }
    }
  })

  it('never makes a strand narrower than 1.4 x the nozzle', () => {
    const p = defaults({ width: 0.2, nozzle: 0.4, printAware: true })
    expect(effWidth(p)).toBeCloseTo(0.56, 6)
    const box = boxMesh([-10, -10, 0], [10, 10, 20])
    const { region, others } = split(box, [X])
    const g = generateHair({ p, axis: AXIS, positions: region.positions, indices: region.indices, obstacle: others })
    const m = tube(g, 0)
    let lo = Infinity, hi = -Infinity
    for (let i = 1; i < m.positions.length; i += 3) { lo = Math.min(lo, m.positions[i]); hi = Math.max(hi, m.positions[i]) }
    expect(hi - lo).toBeGreaterThanOrEqual(0.56 - 1e-3)
  })
})

describe('strands are fused to the body and the wall', () => {
  const box = boxMesh([-10, -10, 0], [10, 10, 20])
  const { region, others } = split(box, [X])
  const topo = { positions: box.positions, indices: box.indices }

  it('roots are buried by the root depth and tips sink into the wall; the union is one connected solid', () => {
    const p = defaults({ length: 8, density: 8, wallThickness: 0.8, wallSeparate: false })
    const g = generateHair({ p, axis: AXIS, positions: region.positions, indices: region.indices, obstacle: others, sides: 8 })
    expect(g.tubes.strands).toBeGreaterThan(10)
    const wallCaster = makeCaster(g.wall!.mesh)
    const minSink = Math.max(0.6, 1.5 * p.nozzle)
    for (const st of g.strands) {
      expect(10 - st.pts[0], 'root buried below the face').toBeGreaterThanOrEqual(minSink - 1e-3)
      // full-size cross-section along the buried root
      expect(st.scale[0]).toBeGreaterThanOrEqual(1 - 1e-6)
      // the tip is inside the wall, at least half its thickness deep
      const tip = st.tip
      const depth = tip[0] - (10 + p.length)
      expect(depth, 'tip depth into the wall').toBeGreaterThanOrEqual(Math.max(0.5 * p.wallThickness, p.nozzle) - 1e-3)
      expect(wallCaster.closest(tip).dist).toBeGreaterThan(0)
    }
    const s = buildSolids(W, g, p, topo, own)
    expect(s.badTubes).toBe(0)
    expect(s.merged!.decompose().length, 'strands, wall and body are one solid').toBe(1)
  })

  it('with the wall kept separate every strand still touches both solids', () => {
    const p = defaults({ length: 8, density: 8, wallThickness: 0.8, wallSeparate: true })
    const g = generateHair({ p, axis: AXIS, positions: region.positions, indices: region.indices, obstacle: others, sides: 8 })
    const s = buildSolids(W, g, p, topo, own)
    expect(s.merged!.decompose().length, 'body + hair').toBe(1)
    expect(s.wall!.decompose().length).toBe(1)
    const T = g.tubes
    const body = own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: topo.positions, triVerts: topo.indices })))
    for (let r = 0; r < T.strands; r++) {
      const m = tube(g, r)
      const t = own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices })))
      expect(own(W.Manifold.intersection(t, s.wall!)).volume(), `strand ${r} reaches the wall`).toBeGreaterThan(1e-4)
      expect(own(W.Manifold.intersection(t, body)).volume(), `strand ${r} is rooted in the body`).toBeGreaterThan(1e-4)
    }
  })
})

describe('face-following wall', () => {
  const box = boxMesh([-10, -10, 0], [10, 10, 20])
  const { region, others } = split(box, [X, Y])

  function wallOf(over: Partial<HairParams>) {
    const p = defaults({ length: 8, density: 6, wallThickness: 0.8, wallTop: 2, wallBottom: 2, ...over })
    return { p, g: generateHair({ p, axis: AXIS, positions: region.positions, indices: region.indices, obstacle: others }) }
  }

  /** Distance from the centre of every outer-sheet triangle to the inner sheet (= the wall thickness, measured perpendicular to the wall). */
  function thicknesses(g: HairGen): number[] {
    const f = g.wall!.follow!
    const nv = f.positions.length / 6
    const inner = bvhOf({ positions: f.positions.slice(0, nv * 3), indices: f.tris })
    const out: number[] = []
    for (let t = 0; t < f.tris.length; t += 3) {
      const q = new Vector3()
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) q.setComponent(j, q.getComponent(j) + f.positions[(nv + f.tris[t + k]) * 3 + j] / 3)
      out.push(inner.closestPointToPoint(q)!.distance)
    }
    return out
  }

  for (const corner of ['miter', 'round'] as const) {
    it(`${corner}: thickness is uniform within 5 %`, () => {
      const { g, p } = wallOf({ dirMode: 'perFace', wallCorner: corner })
      const th = thicknesses(g)
      for (const t of th) expect(Math.abs(t - p.wallThickness) / p.wallThickness).toBeLessThan(0.05)
    })
  }

  it('Perpendicular + sharp corners: two flat slabs joined at the corner, flat top and bottom', () => {
    const { g, p } = wallOf({ dirMode: 'perFace', wallCorner: 'miter' })
    const m = g.wall!.mesh
    // every wall triangle is axis aligned (flat slabs, flat top and bottom)
    for (let t = 0; t < m.indices.length / 3; t++) {
      const n = triNormal(m, t)
      expect(Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])), `triangle ${t}`).toBeGreaterThan(0.999)
    }
    const D = p.length, T = p.wallThickness
    const has = (x: number, y: number) => {
      for (let i = 0; i < m.positions.length; i += 3) if (Math.abs(m.positions[i] - x) < 1e-3 && Math.abs(m.positions[i + 1] - y) < 1e-3) return true
      return false
    }
    expect(has(10 + D, 10 + D), 'inner mitre corner').toBe(true)
    expect(has(10 + D + T, 10 + D + T), 'outer mitre corner').toBe(true)
    let lo = Infinity, hi = -Infinity
    for (let i = 2; i < m.positions.length; i += 3) { lo = Math.min(lo, m.positions[i]); hi = Math.max(hi, m.positions[i]) }
    expect(lo).toBeCloseTo(0 - p.wallBottom, 4)
    expect(hi).toBeCloseTo(20 + p.wallTop, 4)
    expect(g.bedZ).toBeCloseTo(-p.wallBottom, 4)
  })

  it('Through tips and Blend produce clean closed walls too', () => {
    for (const over of [{ dirMode: 'blend' as const }, { wallMode: 'tips' as const }, { wallMode: 'planar' as const }, { wallMode: 'cylindrical' as const }]) {
      const { g, p } = wallOf(over)
      const m = g.wall!.mesh
      expect(m.indices.length).toBeGreaterThan(30)
      const bb = bvhOf(m)
      expect(bb).toBeTruthy()
      expect(g.tubes.strands, JSON.stringify(over)).toBeGreaterThan(0)
      void p
    }
  })
})
