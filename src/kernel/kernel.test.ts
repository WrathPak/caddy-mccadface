/** Runs the replicad / OpenCascade worker ops directly in Node (no Worker, no Comlink). */
import { beforeAll, describe, expect, it } from 'vitest'
import { measureArea, measureVolume, type AnyShape } from 'replicad'
import { box, initOcc, topoOf, type Shape } from './occ'
import { bodyFromShape, getBrep, getOp, helpers } from './store'
import { computeEdgeSigs, computeFaceSigs, type Body } from './types'
import './model-ops'
import type { ExtrudeArgs, EdgeModArgs, EdgeFrame } from './model-ops'
import type { ProjectedCurve } from './sketch-ops'
import './sketch-ops'
import './modeling-ops'
import type { Loop, PlaneDef } from '../sketch/types'

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
const run = async <T = Body>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T
const shapeOf = (b: Body) => getBrep(b.key) as unknown as AnyShape
const vol = (b: Body) => Math.abs(measureVolume(shapeOf(b) as never))
const rectLoop = (x0: number, y0: number, x1: number, y1: number): Loop => [
  { k: 'l', a: [x0, y0], b: [x1, y0] }, { k: 'l', a: [x1, y0], b: [x1, y1] }, { k: 'l', a: [x1, y1], b: [x0, y1] }, { k: 'l', a: [x0, y1], b: [x0, y0] },
]
const ext = (over: Partial<ExtrudeArgs> & { outer: Loop; holes?: Loop[] }): ExtrudeArgs => ({
  id: 'e', name: 'e', faces: [], mode: 'one', d1: 10, d2: 0, faceDir: 1,
  groups: [{ plane: XY, profiles: [{ outer: over.outer, holes: over.holes ?? [] }] }], ...over,
})
const near = (a: number, b: number, rel = 1e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
const frustum = (h: number, a1: number, a2: number) => (h / 3) * (a1 + a2 + Math.sqrt(a1 * a2))

beforeAll(async () => { await initOcc() })

/** distance from p to the display polyline segments tagged with edge id `id` */
function distToEdge(b: Body, id: number, p: number[]) {
  const m = b.mesh.edges
  let best = Infinity
  for (let s = 0; s < m.length / 6; s++) {
    if (b.mesh.edgeIds![s] !== id) continue
    const a = [m[s * 6], m[s * 6 + 1], m[s * 6 + 2]], c = [m[s * 6 + 3], m[s * 6 + 4], m[s * 6 + 5]]
    const ab = c.map((v, i) => v - a[i]), ap = p.map((v, i) => v - a[i])
    const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1)))
    best = Math.min(best, Math.hypot(...ab.map((v, i) => a[i] + v * t - p[i])))
  }
  return best
}

/** Asserts the mesh face / edge ids are exactly the B-rep topology indices. */
function checkMapping(body: Body) {
  const shape = shapeOf(body)
  const topo = topoOf(shape)
  const m = body.mesh
  expect(m.faceCount).toBe(topo.faces.length)
  expect(m.edgeCount).toBe(topo.edges.length)
  expect(Array.from(m.faceHashes!)).toEqual(topo.faceHashes)
  expect(Array.from(m.edgeHashes!)).toEqual(topo.edgeHashes)
  const sigs = computeFaceSigs(m)
  expect(sigs.length).toBe(topo.faces.length)
  // mesh patch `i` has the area of B-rep face `i` and its centroid lies on that face (plane faces: same normal)
  topo.faces.forEach((f, i) => {
    near(sigs[i].area, measureArea(f), 0.03)
    if (f.geomType === 'PLANE') {
      const nv = f.normalAt()
      const n = sigs[i].normal
      expect(Math.abs(nv.x * n[0] + nv.y * n[1] + nv.z * n[2])).toBeGreaterThan(0.999)
      const c = f.center
      expect(Math.hypot(c.x - sigs[i].centroid[0], c.y - sigs[i].centroid[1], c.z - sigs[i].centroid[2])).toBeLessThan(0.05)
    }
  })
  // each edge's end points and midpoint lie on the polyline tagged with its index
  topo.edges.forEach((e, i) => {
    for (const t of [0, 0.5, 1]) {
      const p = e.pointAt(t)
      expect(distToEdge(body, i, [p.x, p.y, p.z])).toBeLessThan(0.06)
    }
  })
  expect(computeEdgeSigs(m).length).toBe(topo.edges.length)
}

describe('face / edge id mapping', () => {
  it('box: 6 faces / 12 edges, mesh ids are topology indices', () => {
    const body = bodyFromShape('b', 'b', box([20, 10, 5], [0, 0, 0]))
    expect(body.mesh.faceCount).toBe(6)
    expect(body.mesh.edgeCount).toBe(12)
    expect(Math.max(...body.mesh.faceIds)).toBe(5)
    checkMapping(body)
  })

  it('filleted box (cylindrical + planar faces) keeps the id <-> topology bijection', async () => {
    const base = bodyFromShape('b', 'b', box([30, 20, 10], [0, 0, 0]))
    const topo = topoOf(shapeOf(base))
    const idx = topo.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.startPoint.z - 10) < 1e-6 && Math.abs(e.endPoint.z - 10) < 1e-6).map(({ i }) => i)
    expect(idx.length).toBe(4)
    const out = await run<Body>('edgeMod', { id: 'f', name: 'f', key: base.key, edges: idx, size: 2, mode: 'fillet' } satisfies EdgeModArgs)
    checkMapping(out)
    expect(out.mesh.faceCount).toBeGreaterThan(6)
  })

  it('picking an edge through the mesh id modifies exactly that edge', async () => {
    const base = bodyFromShape('b', 'b', box([30, 20, 10], [0, 0, 0]))
    // what the viewport does: hit the display segment near (0, -10, 10) -> its edge id (the 30 mm edge along x; box is centred in x/y)
    const m = base.mesh
    let picked = -1, bestD = Infinity
    for (let s = 0; s < m.edges.length / 6; s++) {
      const mx = (m.edges[s * 6] + m.edges[s * 6 + 3]) / 2, my = (m.edges[s * 6 + 1] + m.edges[s * 6 + 4]) / 2, mz = (m.edges[s * 6 + 2] + m.edges[s * 6 + 5]) / 2
      const d = Math.hypot(mx - 0, my + 10, mz - 10)
      if (d < bestD) { bestD = d; picked = m.edgeIds![s] }
    }
    const out = await run<Body>('edgeMod', { id: 'f', name: 'f', key: base.key, edges: [picked], size: 2, mode: 'fillet' } satisfies EdgeModArgs)
    // one fillet along the 30 mm edge: removed (1 - pi/4) r^2 L
    near(vol(out), 30 * 20 * 10 - (1 - Math.PI / 4) * 4 * 30, 4e-4)
    // the filleted edge was the one at y=-10, z=10
    const sigs = computeFaceSigs(out.mesh)
    const cyl = topoOf(shapeOf(out)).faces.findIndex((f) => (f.geomType as string) === 'CYLINDRE')
    expect(cyl).toBeGreaterThanOrEqual(0)
    expect(sigs[cyl].centroid[1]).toBeLessThan(-7.9)
    expect(sigs[cyl].centroid[2]).toBeGreaterThan(7.9)
  })
})

describe('extrude', () => {
  it('rectangle: volume = area * height; hole windings are handled', async () => {
    near(vol(await run('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 10), d1: 5 }))), 1000)
    // a hole drawn counter-clockwise like the outer loop must still subtract
    const out = await run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 10), holes: [rectLoop(5, 3, 9, 7)], d1: 5 }))
    near(vol(out), (200 - 16) * 5)
    checkMapping(out)
  })

  it('a circular hole is a real hole (the circle is wound against the outer loop)', async () => {
    const out = await run<Body>('extrudeTool', ext({ outer: rectLoop(-20, -15, 20, 15), holes: [[{ k: 'c', c: [0, 0], r: 4 }]], d1: 10 }))
    near(vol(out), (1200 - Math.PI * 16) * 10)
    checkMapping(out)
  })

  it('symmetric and two-sided spans', async () => {
    const b = await run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 10, 10), mode: 'sym', d1: 8 }))
    near(vol(b), 800)
    expect(b.mesh.positions.slice(2).filter((_, i) => i % 3 === 0).reduce((m, z) => Math.min(m, z), 9)).toBeCloseTo(-4, 4)
    near(vol(await run('extrudeTool', ext({ outer: rectLoop(0, 0, 10, 10), mode: 'two', d1: 3, d2: 2 }))), 500)
  })

  it('taper: square frustum volume matches the analytic value (positive shrinks, negative grows)', async () => {
    const t = Math.tan((10 * Math.PI) / 180)
    near(vol(await run('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 20), taper: 10 }))), frustum(10, 400, (20 - 20 * t) ** 2), 2e-3)
    near(vol(await run('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 20), taper: -10 }))), frustum(10, 400, (20 + 20 * t) ** 2), 2e-3)
  })

  it('taper with a hole: outer shrinks, hole grows', async () => {
    const t = Math.tan((10 * Math.PI) / 180)
    const out = await run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 20), holes: [rectLoop(5, 5, 15, 15)], taper: 10 }))
    const expected = frustum(10, 400, (20 - 20 * t) ** 2) - frustum(10, 100, (10 + 20 * t) ** 2)
    near(vol(out), expected, 3e-3)
    checkMapping(out)
  })

  it('tapered straight-edged profiles keep exact planar walls; circles give cones', async () => {
    const sq = await run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 20), taper: 10 }))
    expect(topoOf(shapeOf(sq)).faces.map((f) => f.geomType as string)).toEqual(Array(6).fill('PLANE'))
    const ci = await run<Body>('extrudeTool', ext({ outer: [{ k: 'c', c: [0, 0], r: 10 }], taper: 10 }))
    expect(topoOf(shapeOf(ci)).faces.filter((f) => (f.geomType as string) === 'CONE').length).toBe(2)
  })

  it('taper of a circle is a cone frustum; symmetric taper tapers both sides', async () => {
    const circle: Loop = [{ k: 'c', c: [0, 0], r: 10 }]
    const t = Math.tan((5 * Math.PI) / 180)
    const r2 = 10 - 10 * t
    near(vol(await run('extrudeTool', ext({ outer: circle, taper: 5 }))), (Math.PI * 10 * (100 + 10 * r2 + r2 * r2)) / 3, 3e-3)
    const sym = await run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 20), mode: 'sym', d1: 20, taper: 10 }))
    const t10 = Math.tan((10 * Math.PI) / 180)
    near(vol(sym), 2 * frustum(10, 400, (20 - 20 * t10) ** 2), 3e-3)
  })

  it('an impossible taper reports an error instead of producing garbage', async () => {
    await expect(run('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 20), d1: 30, taper: 45 }))).rejects.toThrow(/taper/i)
  })

  it('extrudes a body face by topology index', async () => {
    const base = bodyFromShape('b', 'b', box([20, 20, 10], [0, 0, 0]))
    const topo = topoOf(shapeOf(base))
    const top = topo.faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.z - 10) < 1e-6 && f.normalAt().z > 0.9)
    // the mesh agrees which patch is the top face
    const sig = computeFaceSigs(base.mesh)[top]
    expect(sig.normal[2]).toBeGreaterThan(0.99)
    const out = await run<Body>('extrudeTool', { id: 't', name: 't', groups: [], faces: [{ key: base.key, index: top }], mode: 'one', d1: 5, d2: 0, faceDir: 1, taper: 0 })
    near(vol(out), 20 * 20 * 5)
    const tapered = await run<Body>('extrudeTool', { id: 't', name: 't', groups: [], faces: [{ key: base.key, index: top }], mode: 'one', d1: 5, d2: 0, faceDir: 1, taper: 10 })
    near(vol(tapered), frustum(5, 400, (20 - 2 * 5 * Math.tan((10 * Math.PI) / 180)) ** 2), 3e-3)
    // the same face again (live preview, then the real compute), in every span mode: cached topology must survive
    for (const mode of ['one', 'sym', 'two']) {
      for (let i = 0; i < 2; i++) {
        const o = await run<Body>('extrudeTool', { id: 't', name: 't', groups: [], faces: [{ key: base.key, index: top }], mode, d1: 4, d2: 2, faceDir: 1, taper: 0 })
        expect(vol(o)).toBeGreaterThan(0)
      }
    }
  })

  it('face extrusion with a taper: hole in the face grows like the outline shrinks', async () => {
    const holed = await run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 20), holes: [rectLoop(5, 5, 15, 15)], d1: 2 }))
    const topo = topoOf(shapeOf(holed))
    const top = topo.faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.z - 2) < 1e-6)
    const t = Math.tan((10 * Math.PI) / 180)
    const out = await run<Body>('extrudeTool', { id: 't', name: 't', groups: [], faces: [{ key: holed.key, index: top }], mode: 'one', d1: 10, d2: 0, faceDir: 1, taper: 10 })
    near(vol(out), frustum(10, 400, (20 - 20 * t) ** 2) - frustum(10, 100, (10 + 20 * t) ** 2), 3e-3)
  })
})

describe('fillet / chamfer', () => {
  const edgesWhere = (b: Body, f: (a: number[], c: number[]) => boolean) =>
    topoOf(shapeOf(b)).edges.map((e, i) => ({ e, i })).filter(({ e }) => f([e.startPoint.x, e.startPoint.y, e.startPoint.z], [e.endPoint.x, e.endPoint.y, e.endPoint.z])).map(({ i }) => i)

  it('fillet on chosen edges removes (1 - pi/4) r^2 L per edge', async () => {
    const base = bodyFromShape('b', 'b', box([30, 20, 10], [0, 0, 0]))
    // two opposite 30 mm edges on the top face
    const idx = edgesWhere(base, (a, c) => Math.abs(a[2] - 10) < 1e-6 && Math.abs(c[2] - 10) < 1e-6 && Math.abs(a[0] - c[0]) > 29)
    expect(idx.length).toBe(2)
    const out = await run<Body>('edgeMod', { id: 'f', name: 'f', key: base.key, edges: idx, size: 3, mode: 'fillet' })
    near(vol(out), 6000 - 2 * (1 - Math.PI / 4) * 9 * 30, 2e-3)
    // inputs are never mutated, and the same body / edges can be used again and again (live preview does exactly that)
    near(vol(base), 6000)
    for (const size of [1, 2, 3, 3]) {
      const again = await run<Body>('edgeMod', { id: 'f', name: 'f', key: base.key, edges: idx, size, mode: 'fillet' })
      near(vol(again), 6000 - 2 * (1 - Math.PI / 4) * size * size * 30, 2e-3)
      await run('edgeFrames', { key: base.key, edges: idx })
      await run('projectEdges', { key: base.key, plane: XY, faces: [], edges: idx })
    }
  })

  it('chamfer removes d^2/2 * L', async () => {
    const base = bodyFromShape('b', 'b', box([30, 20, 10], [0, 0, 0]))
    const idx = edgesWhere(base, (a, c) => Math.abs(a[0] + 15) < 1e-6 && Math.abs(a[1] + 10) < 1e-6 && Math.abs(c[0] + 15) < 1e-6 && Math.abs(c[1] + 10) < 1e-6)
    expect(idx.length).toBe(1)
    const out = await run<Body>('edgeMod', { id: 'c', name: 'c', key: base.key, edges: idx, size: 2, mode: 'chamfer' })
    near(vol(out), 6000 - 2 * 10, 2e-3)
  })

  it('reports an error when the radius is impossible', async () => {
    const base = bodyFromShape('b', 'b', box([30, 20, 10], [0, 0, 0]))
    await expect(run('edgeMod', { id: 'f', name: 'f', key: base.key, edges: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], size: 15, mode: 'fillet' })).rejects.toThrow(/not possible/)
    await expect(run('edgeMod', { id: 'f', name: 'f', key: base.key, edges: [99], size: 1, mode: 'fillet' })).rejects.toThrow(/no longer exist/)
  })

  it('edgeFrames: midpoint and outward bisector of the faces meeting at the edge', async () => {
    const base = bodyFromShape('b', 'b', box([10, 10, 10], [0, 0, 0]))
    const i = edgesWhere(base, (a, c) => Math.abs(a[1] + 5) < 1e-6 && Math.abs(c[1] + 5) < 1e-6 && Math.abs(a[2] - 10) < 1e-6 && Math.abs(c[2] - 10) < 1e-6)[0]
    const [f] = await run<(EdgeFrame | null)[]>('edgeFrames', { key: base.key, edges: [i] })
    expect(f!.mid[2]).toBeCloseTo(10)
    expect(f!.dir[1]).toBeCloseTo(-Math.SQRT1_2, 4)
    expect(f!.dir[2]).toBeCloseTo(Math.SQRT1_2, 4)
  })
})

describe('project edges onto a plane', () => {
  it('box faces / cylinder edges become lines / circles in plane-local coordinates', async () => {
    const base = bodyFromShape('b', 'b', box([20, 10, 5], [0, 0, 0]))
    const top = topoOf(shapeOf(base)).faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.z - 5) < 1e-6)
    const plane: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
    const out = await run<ProjectedCurve[]>('projectEdges', { key: base.key, plane, faces: [top], edges: [] })
    expect(out.length).toBe(4)
    expect(out.every((c) => c.k === 'l')).toBe(true)
    const xs = out.flatMap((c) => (c.k === 'l' ? [c.a[0], c.b[0]] : []))
    expect(Math.min(...xs)).toBeCloseTo(-10)
    expect(Math.max(...xs)).toBeCloseTo(10)

    const cyl = await run<Body>('extrudeTool', ext({ outer: [{ k: 'c', c: [3, 4], r: 5 }], d1: 8 }))
    const all = await run<ProjectedCurve[]>('projectEdges', { key: cyl.key, plane, faces: [], edges: [], all: true })
    // the cylinder's top and bottom circles come back as arcs of the true circle (centre (3,4), r 5); the seam lines stand square
    // to the plane, so they come in as points
    // (the top and bottom circles lie on one another once flattened, so each half arc comes in once)
    expect(all.filter((c) => c.k === 'a').length).toBe(2)
    expect(all.filter((c) => c.k === 'p').length).toBe(2) // the wall is two half cylinders, so two seams
    expect(all.length).toBe(4)
    for (const c of all.filter((x) => x.k === 'a')) {
      expect(c.k).toBe('a')
      if (c.k !== 'a') continue
      expect(c.r).toBeCloseTo(5)
      expect(c.c[0]).toBeCloseTo(3)
      expect(c.c[1]).toBeCloseTo(4)
      expect(Math.hypot(c.s[0] - 3, c.s[1] - 4)).toBeCloseTo(5)
      expect(Math.hypot(c.e[0] - 3, c.e[1] - 4)).toBeCloseTo(5)
    }
    // onto a plane with a different origin / orientation (local x = world y)
    const side: PlaneDef = { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }
    const proj = await run<ProjectedCurve[]>('projectEdges', { key: base.key, plane: side, faces: [], edges: [], all: true })
    const ys = proj.flatMap((c) => (c.k === 'l' ? [c.a[0], c.b[0]] : []))
    expect(Math.max(...ys)).toBeCloseTo(5)
    void (null as unknown as Shape)
  })
})

describe('project modes, face circles and extents', () => {
  const plateWithHole = async () => run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 60, 40), holes: [[{ k: 'c', c: [20, 12], r: 5 }]], d1: 10 }))
  const topFace = (b: Body) => topoOf(shapeOf(b)).faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.z - 10) < 1e-6)
  const zRange = (b: Body) => {
    const p = b.mesh.positions
    let lo = Infinity, hi = -Infinity
    for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]) }
    return { lo, hi }
  }
  const top: PlaneDef = { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] }

  it('a face with a hole projects its hole as one circle when asked to merge', async () => {
    const b = await plateWithHole()
    const fi = topFace(b)
    const merged = await run<ProjectedCurve[]>('projectEdges', { key: b.key, plane: top, faces: [fi], edges: [], merge: true })
    expect(merged.filter((c) => c.k === 'l')).toHaveLength(4)
    const circ = merged.filter((c) => c.k === 'c')
    expect(circ).toHaveLength(1)
    if (circ[0].k === 'c') { expect(circ[0].r).toBeCloseTo(5); expect(circ[0].c[0]).toBeCloseTo(20); expect(circ[0].c[1]).toBeCloseTo(12) }
  })

  it('a side face seen edge on projects as one line, and an upright edge as a point', async () => {
    const b = bodyFromShape('b', 'b', box([60, 40, 10], [30, 20, 0]))
    const front = topoOf(shapeOf(b)).faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.y - 0) < 1e-6)
    const out = await run<ProjectedCurve[]>('projectEdges', { key: b.key, plane: top, faces: [front], edges: [], merge: true })
    expect(out.filter((c) => c.k === 'l')).toHaveLength(1)
    const upright = topoOf(shapeOf(b)).edges.findIndex((e) => Math.abs(e.startPoint.z - e.endPoint.z) > 5)
    const pt = await run<ProjectedCurve[]>('projectEdges', { key: b.key, plane: top, faces: [], edges: [upright] })
    expect(pt).toHaveLength(1)
    expect(pt[0].k).toBe('p')
  })

  it('Intersect gives the curves where the plane cuts the body', async () => {
    const b = bodyFromShape('b', 'b', box([60, 40, 10], [30, 20, 0]))
    const mid: PlaneDef = { origin: [0, 0, 4], xDir: [1, 0, 0], normal: [0, 0, 1] }
    const out = await run<ProjectedCurve[]>('projectEdges', { key: b.key, plane: mid, faces: [], edges: [], all: true, mode: 'intersect' })
    expect(out.filter((c) => c.k === 'l')).toHaveLength(4)
    const xs = out.flatMap((c) => (c.k === 'l' ? [c.a[0], c.b[0]] : []))
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(60)
    const away: PlaneDef = { origin: [0, 0, 40], xDir: [1, 0, 0], normal: [0, 0, 1] }
    expect(await run<ProjectedCurve[]>('projectEdges', { key: b.key, plane: away, faces: [], edges: [], all: true, mode: 'intersect' })).toHaveLength(0)
    const h = await plateWithHole()
    const cut = await run<ProjectedCurve[]>('projectEdges', { key: h.key, plane: mid, faces: [], edges: [], all: true, mode: 'intersect' })
    expect(cut.filter((c) => c.k === 'c')).toHaveLength(1)
    expect(cut.filter((c) => c.k === 'l')).toHaveLength(4)
  })

  it('Include 3D Geometry adds a point at every corner on top of the projected edges', async () => {
    const b = bodyFromShape('b', 'b', box([60, 40, 10], [30, 20, 0]))
    const out = await run<ProjectedCurve[]>('projectEdges', { key: b.key, plane: top, faces: [], edges: [], all: true, mode: 'include3d', merge: true })
    expect(out.filter((c) => c.k === 'l')).toHaveLength(4)
    expect(out.filter((c) => c.k === 'p')).toHaveLength(4)
  })

  it('faceCircles finds the round hole of a face as one circle', async () => {
    const b = await plateWithHole()
    const out = await run<{ c: [number, number]; r: number }[]>('faceCircles', { key: b.key, face: topFace(b), plane: top })
    expect(out).toHaveLength(1)
    expect(out[0].r).toBeCloseTo(5)
    expect(out[0].c[0]).toBeCloseTo(20)
    expect(out[0].c[1]).toBeCloseTo(12)
  })

  it('extrude span: starts a distance off the profile plane and ends where it is told', async () => {
    const b = await run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 10), span: [2, 7] }))
    near(vol(b), 200 * 5)
    expect(zRange(b).lo).toBeCloseTo(2)
    expect(zRange(b).hi).toBeCloseTo(7)
    const both = await run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 20, 10), span: [-3, 4] }))
    near(vol(both), 200 * 7)
  })

  it('extrude span on a face runs along the face normal whatever the operation', async () => {
    const b = bodyFromShape('b', 'b', box([60, 40, 10], [30, 20, 0]))
    const fi = topFace(b)
    const up = await run<Body>('extrudeTool', { id: 't', name: 't', groups: [], faces: [{ key: b.key, index: fi }], mode: 'one', d1: 0, d2: 0, faceDir: -1, taper: 0, span: [0, 4] })
    near(vol(up), 60 * 40 * 4)
    expect(zRange(up).hi).toBeCloseTo(14)
    const down = await run<Body>('extrudeTool', { id: 't', name: 't', groups: [], faces: [{ key: b.key, index: fi }], mode: 'one', d1: 0, d2: 0, faceDir: 1, taper: 0, span: [-6, 0] })
    near(vol(down), 60 * 40 * 6)
    expect(zRange(down).lo).toBeCloseTo(4)
  })

  it('a slanted end plane trims the extrude (To Object on a face that is not square to the profile)', async () => {
    const n = Math.SQRT1_2
    const b = await run<Body>('extrudeTool', ext({ outer: rectLoop(0, 0, 10, 10), span: [0, 20], trim: { origin: [0, 0, 10], normal: [n, 0, n] } }))
    near(vol(b), 500, 2e-3)
  })
})

describe('extrude to a curved face', () => {
  it('ends at a cylinder wall, with an offset, and refuses a face that is not in the way', async () => {
    const cyl = await run<Body>('extrudeTool', ext({ outer: [{ k: 'c', c: [30, 0], r: 10 }], d1: 10 }))
    const faces = topoOf(shapeOf(cyl)).faces
    const wall = faces.findIndex((f) => String(f.geomType) === 'CYLINDRE' && f.center.x < 30)
    expect(wall).toBeGreaterThanOrEqual(0)
    const P: PlaneDef = { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }
    const rect = rectLoop(-3, 0, 3, 5)
    const long = await run<Body>('extrudeTool', { id: 'l', name: 'l', faces: [], mode: 'one', d1: 0, d2: 0, faceDir: 1, groups: [{ plane: P, profiles: [{ outer: rect, holes: [] }] }], span: [0, 80] })
    const trim = (grow: number) => run<Body>('trimToFace', { id: 't', name: 't', key: long.key, face: { key: cyl.key, index: wall }, grow, keep: [[0.01, 0, 2.5]], fid: 'f' })
    const g = (y: number) => 0.5 * (y * Math.sqrt(100 - y * y) + 100 * Math.asin(y / 10))
    near(vol(await trim(0)), 5 * (180 - 2 * g(3)), 5e-3)
    // growing the surface by 2 (radius 12) makes the end reach further out, towards the profile
    near(vol(await trim(2)), 5 * (180 - 2 * (0.5 * (3 * Math.sqrt(144 - 9) + 144 * Math.asin(3 / 12)))), 8e-3)
    // a keep point that is not in the extrusion keeps nothing
    await expect(run('trimToFace', { id: 't', name: 't', key: long.key, face: { key: cyl.key, index: wall }, grow: 0, keep: [[50, 50, 50]], fid: 'f' })).rejects.toThrow(/does not reach/)
  })
})
