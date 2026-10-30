/** Surface worker ops, run on real OpenCascade in Node. */
import { beforeAll, describe, expect, it } from 'vitest'
import { getOC, iterTopo, makeVertex, measureArea, measureDistanceBetween, measureVolume, type AnyShape } from 'replicad'
import { box, initOcc, topoOf } from './occ'
import { bodyFromShape, getBrep, getOp, helpers } from './store'
import { boxNames, openEdges } from './naming'
import { bbox, computeFaceSigs, isSolidBody, type Body } from './types'
import './model-ops'
import './solid-ops'
import './surface-ops'
import { api } from './api'
import type { CurveIn } from './surface-ops'
import type { PathSeg } from './solid-ops'

beforeAll(async () => { await initOcc() })

const run = async <T = Body>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T
const areaOf = (b: Body) => Math.abs(measureArea(getBrep(b.key) as unknown as AnyShape as never))
const volOf = (b: Body) => Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never))
const near = (a: number, b: number, rel = 2e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
const faceCount = (b: Body) => topoOf(getBrep(b.key) as unknown as AnyShape).faces.length
/** a box centred on `pos` */
const mkBox = (id: string, size: [number, number, number], pos: [number, number, number] = [0, 0, 0]): Body => {
  const b = box(size, pos)
  return helpers.sendBody(bodyFromShape(id, id, b, boxNames(b, id))) as unknown as Body
}
const line = (a: [number, number, number], b: [number, number, number], id?: string): PathSeg => ({ k: 'l', a, b, id })
const chain = (segs: PathSeg[], closed = false, id = 'c'): CurveIn => ({ kind: 'chain', segs, closed, id })
/** An open polyline: 10 along X, then 10 along Y. */
const ell = (): CurveIn => chain([line([0, 0, 0], [10, 0, 0], 'l1'), line([10, 0, 0], [10, 10, 0], 'l2')])
/** A closed square in the XY plane at height z. */
const square = (z = 0, s = 10): CurveIn => chain([line([0, 0, z], [s, 0, z], 'a'), line([s, 0, z], [s, s, z], 'b'), line([s, s, z], [0, s, z], 'c'), line([0, s, z], [0, 0, z], 'd')], true)

describe('surface body flag', () => {
  it('a solid is a solid, an extruded open curve is a surface', async () => {
    const solid = mkBox('b', [10, 10, 10])
    expect(solid.surface).toBeUndefined()
    expect(isSolidBody(solid)).toBe(true)
    const s = await run('surfaceExtrude', { id: 's', name: 's', curves: [ell()], dir: [0, 0, 1], from: 0, to: 5 })
    expect(s.surface).toBe(true)
    expect(isSolidBody(s)).toBe(false)
    expect(s.kind).toBe('brep')
  })
})

describe('solid tools and surfaces', () => {
  it('a surface handed to a solid-only op is refused with a clear message', async () => {
    const b = mkBox('b', [10, 10, 10])
    const s = await run('surfaceDeleteFace', { id: 'd', name: 'd', key: b.key, faces: faceIdx(b, (_c, n) => n[2] > 0.9) })
    const refused = /needs a solid body.*open surface/
    await expect(api.call('shellOp', { id: 'x', name: 'x', key: s.key, faces: [0], thickness: 1, side: 'inside' })).rejects.toThrow(refused)
    await expect(api.call('edgeMod', { id: 'x', name: 'x', key: s.key, edges: [0], size: 1, mode: 'fillet' })).rejects.toThrow(refused)
    await expect(api.boolean({ id: 'x', name: 'x', op: 'union', base: b.key, tools: [s.key] })).rejects.toThrow(refused)
    await expect(api.boolean({ id: 'x', name: 'x', op: 'subtract', base: s.key, tools: [b.key] })).rejects.toThrow(refused)
    // a solid goes through
    await expect(api.boolean({ id: 'x', name: 'x', op: 'union', base: b.key, tools: [mkBox('c', [4, 4, 4], [5, 0, 0]).key] })).resolves.toBeTruthy()
  })
})

describe('surface extrude', () => {
  it('open polyline: area is length times distance, two faces', async () => {
    const s = await run('surfaceExtrude', { id: 's', name: 's', curves: [ell()], dir: [0, 0, 1], from: 0, to: 5 })
    near(areaOf(s), 20 * 5)
    expect(faceCount(s)).toBe(2)
    const bb = bbox(s.mesh.positions)
    expect(bb.max[2]).toBeCloseTo(5, 3)
    expect(bb.min[2]).toBeCloseTo(0, 3)
    // named after the sketch entities it came from
    expect(s.mesh.faceNames!.map((n) => n[0]).sort()).toEqual(['s:side:l1', 's:side:l2'])
  })
  it('closed profile gives the open tube (no caps)', async () => {
    const s = await run('surfaceExtrude', { id: 's', name: 's', curves: [square()], dir: [0, 0, 1], from: 0, to: 3 })
    near(areaOf(s), 40 * 3)
    expect(faceCount(s)).toBe(4)
    expect(s.surface).toBe(true)
  })
  it('symmetric span', async () => {
    const s = await run('surfaceExtrude', { id: 's', name: 's', curves: [ell()], dir: [0, 0, 1], from: -3, to: 3 })
    const bb = bbox(s.mesh.positions)
    expect(bb.min[2]).toBeCloseTo(-3, 3)
    expect(bb.max[2]).toBeCloseTo(3, 3)
    near(areaOf(s), 20 * 6)
  })
  it('an arc and a spline piece extrude too', async () => {
    const r = 5
    const arc: PathSeg = { k: 'a', a: [r, 0, 0], m: [0, r, 0], b: [-r, 0, 0], id: 'arc' }
    const s = await run('surfaceExtrude', { id: 's', name: 's', curves: [chain([arc])], dir: [0, 0, 1], from: 0, to: 4 })
    near(areaOf(s), Math.PI * r * 4)
    const bz: PathSeg = { k: 'b', a: [0, 0, 0], c1: [3, 4, 0], c2: [7, -4, 0], b: [10, 0, 0], id: 'sp' }
    const t = await run('surfaceExtrude', { id: 't', name: 't', curves: [chain([bz])], dir: [0, 0, 1], from: 0, to: 2 })
    expect(areaOf(t)).toBeGreaterThan(20)
  })
  it('edges of a body: the top outline of a box extrudes to a tube', async () => {
    const b = mkBox('b', [10, 10, 10])
    const topo = topoOf(getBrep(b.key) as unknown as AnyShape)
    const top = topo.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.startPoint.z - 10) < 1e-6 && Math.abs(e.endPoint.z - 10) < 1e-6)
    expect(top.length).toBe(4)
    const s = await run('surfaceExtrude', { id: 's', name: 's', curves: [{ kind: 'edges', key: b.key, edges: top.map((t) => t.i) }], dir: [0, 0, 1], from: 0, to: 5 })
    near(areaOf(s), 40 * 5)
    expect(s.surface).toBe(true)
  })
  it('without a direction the plane of the curves gives it', async () => {
    const s = await run('surfaceExtrude', { id: 's', name: 's', curves: [square()], dir: null, from: 0, to: 3 })
    near(areaOf(s), 40 * 3)
    const bb = bbox(s.mesh.positions)
    expect(Math.abs(bb.max[2] - bb.min[2])).toBeCloseTo(3, 3)
    // a bent open curve has no plane
    const bent = chain([line([0, 0, 0], [10, 0, 0]), line([10, 0, 0], [10, 10, 5]), line([10, 10, 5], [0, 10, -5]), line([0, 10, -5], [0, 0, 8])])
    await expect(run('surfaceExtrude', { id: 's', name: 's', curves: [bent], dir: null, from: 0, to: 3 })).rejects.toThrow(/plane/)
  })
  it('rejects zero distance and no curves', async () => {
    await expect(run('surfaceExtrude', { id: 's', name: 's', curves: [ell()], dir: [0, 0, 1], from: 0, to: 0 })).rejects.toThrow()
    await expect(run('surfaceExtrude', { id: 's', name: 's', curves: [], dir: [0, 0, 1], from: 0, to: 1 })).rejects.toThrow()
  })
})

describe('surface revolve', () => {
  it('a line revolved a full turn is a cylinder wall', async () => {
    const c = chain([line([5, 0, 0], [5, 0, 10], 'l')])
    const s = await run('surfaceRevolve', { id: 's', name: 's', curves: [c], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
    near(areaOf(s), 2 * Math.PI * 5 * 10)
    expect(s.surface).toBe(true)
  })
  it('a curve across the axis is a message, not a bare OpenCascade exception', async () => {
    const across = chain([line([-10, 0, 0], [30, 0, 0], 'l')])
    await expect(run('surfaceRevolve', { id: 's', name: 's', curves: [across], axisOrigin: [0, 0, 0], axisDir: [0, 1, 0], angle: 360 })).rejects.toThrow(/Revolve Surface failed inside OpenCascade/)
  })
  it('a partial angle', async () => {
    const c = chain([line([5, 0, 0], [5, 0, 10], 'l')])
    const s = await run('surfaceRevolve', { id: 's', name: 's', curves: [c], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 90 })
    near(areaOf(s), (Math.PI / 2) * 5 * 10)
  })
  it('a slanted line from the axis makes a cone', async () => {
    const c = chain([line([0, 0, 0], [4, 0, 3], 'l')])
    const s = await run('surfaceRevolve', { id: 's', name: 's', curves: [c], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
    near(areaOf(s), Math.PI * 4 * 5, 5e-3)
  })
})

describe('surface sweep', () => {
  it('an open profile along a straight path: length times path', async () => {
    const prof = chain([line([-2, 0, 0], [2, 0, 0], 'p')])
    const s = await run('surfaceSweep', { id: 's', name: 's', profiles: [prof], path: [{ k: 'l', a: [0, 0, 0], b: [0, 0, 8] }] })
    near(areaOf(s), 4 * 8)
    expect(s.surface).toBe(true)
  })
  it('a closed profile along a bent path', async () => {
    const prof = chain([line([-1, -1, 0], [1, -1, 0]), line([1, -1, 0], [1, 1, 0]), line([1, 1, 0], [-1, 1, 0]), line([-1, 1, 0], [-1, -1, 0])], true)
    const path: PathSeg[] = [{ k: 'a', a: [0, 0, 0], m: [10 - 10 * Math.SQRT1_2, 0, 10 * Math.SQRT1_2], b: [10, 0, 10] }]
    const s = await run('surfaceSweep', { id: 's', name: 's', profiles: [prof], path })
    // Pappus: perimeter x centroid path length (profile centroid on the path)
    near(areaOf(s), 8 * (Math.PI / 2) * 10, 2e-2)
  })
})

describe('surface loft', () => {
  it('two open sections', async () => {
    const a = chain([line([0, 0, 0], [10, 0, 0], 'a')])
    const b = chain([line([0, 0, 6], [10, 0, 6], 'b')])
    const s = await run('surfaceLoft', { id: 's', name: 's', sections: [a, b], ruled: false })
    near(areaOf(s), 60)
    expect(s.surface).toBe(true)
  })
  it('three closed sections give a tube', async () => {
    const s = await run('surfaceLoft', { id: 's', name: 's', sections: [square(0, 10), square(5, 8), square(10, 10)], ruled: true })
    expect(s.surface).toBe(true)
    expect(areaOf(s)).toBeGreaterThan(300)
  })
  it('mixing open and closed sections is a clear error', async () => {
    await expect(run('surfaceLoft', { id: 's', name: 's', sections: [ell(), square()], ruled: false })).rejects.toThrow(/closed/)
  })
  it('one section is not enough', async () => {
    await expect(run('surfaceLoft', { id: 's', name: 's', sections: [ell()], ruled: false })).rejects.toThrow()
  })
})


// ---------------------------------------------------------------------------------------------- helpers for the modify ops

/** A flat rectangle surface in the XY plane (one face) made from a closed chain via patch. */
const flat = async (id: string, w = 10, h = 10, z = 0) =>
  run('surfacePatch', { id, name: id, boundary: [chain([line([0, 0, z], [w, 0, z], id + 'a'), line([w, 0, z], [w, h, z], id + 'b'), line([w, h, z], [0, h, z], id + 'c'), line([0, h, z], [0, 0, z], id + 'd')], true)], continuity: 'g0' })
const edgeIdx = (b: Body, pred: (s: [number, number, number], e: [number, number, number]) => boolean) =>
  topoOf(getBrep(b.key) as unknown as AnyShape).edges.map((e, i) => ({ e, i })).filter(({ e }) => pred([e.startPoint.x, e.startPoint.y, e.startPoint.z], [e.endPoint.x, e.endPoint.y, e.endPoint.z])).map((x) => x.i)
const faceIdx = (b: Body, pred: (c: [number, number, number], n: [number, number, number]) => boolean) =>
  computeFaceSigs(b.mesh).map((s, i) => ({ s, i })).filter(({ s }) => pred(s.centroid, s.normal)).map((x) => x.i)

describe('surface patch', () => {
  it('a flat boundary becomes one exact plane', async () => {
    const p = await flat('p')
    near(areaOf(p), 100)
    expect(faceCount(p)).toBe(1)
    expect(p.surface).toBe(true)
    expect(p.mesh.faceNames![0][0]).toBe('p:patch')
  })
  it('a bent boundary is filled with a smooth surface', async () => {
    // four edges of a saddle: corners at z = +-2
    const pt = (x: number, y: number, z: number): [number, number, number] => [x, y, z]
    const c = chain([line(pt(0, 0, 2), pt(10, 0, -2), 'a'), line(pt(10, 0, -2), pt(10, 10, 2), 'b'), line(pt(10, 10, 2), pt(0, 10, -2), 'c'), line(pt(0, 10, -2), pt(0, 0, 2), 'd')], true)
    const p = await run('surfacePatch', { id: 'p', name: 'p', boundary: [c], continuity: 'g0' })
    expect(areaOf(p)).toBeGreaterThan(100)
    expect(areaOf(p)).toBeLessThan(140)
    expect(p.surface).toBe(true)
  })
  it('separate curves that meet end to end make one loop', async () => {
    const a = chain([line([0, 0, 0], [10, 0, 0], 'a'), line([10, 0, 0], [10, 10, 0], 'b')], false, 'x')
    const b = chain([line([10, 10, 0], [0, 10, 0], 'c'), line([0, 10, 0], [0, 0, 0], 'd')], false, 'y')
    const p = await run('surfacePatch', { id: 'p', name: 'p', boundary: [a, b], continuity: 'g0' })
    near(areaOf(p), 100)
  })
  it('an open boundary is a clear error', async () => {
    await expect(run('surfacePatch', { id: 'p', name: 'p', boundary: [ell()], continuity: 'g0' })).rejects.toThrow(/closed loop/)
  })
  it('the open edges of a surface can be the boundary, and tangent continuity follows the neighbour', async () => {
    // a cylinder wall (open at both ends): patch its top rim with a dome-ish fill
    const circ = await run('surfaceRevolve', { id: 'w', name: 'w', curves: [chain([line([5, 0, 0], [5, 0, 10], 'l')])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
    const rim = edgeIdx(circ, (s, e) => Math.abs(s[2] - 10) < 1e-6 && Math.abs(e[2] - 10) < 1e-6)
    expect(rim.length).toBe(1)
    const g0 = await run('surfacePatch', { id: 'p0', name: 'p0', boundary: [{ kind: 'edges', key: circ.key, edges: rim }], continuity: 'g0' })
    near(areaOf(g0), Math.PI * 25, 1e-2)
    const g1 = await run('surfacePatch', { id: 'p1', name: 'p1', boundary: [{ kind: 'edges', key: circ.key, edges: rim }], continuity: 'g1' })
    // tangent to the cylinder wall at the rim means it starts out vertical: a deep cap, much more area than the flat disc
    expect(areaOf(g1)).toBeGreaterThan(Math.PI * 25)
  })
})

describe('surface offset', () => {
  it('a plane offset keeps its area and moves along the normal', async () => {
    const p = await flat('p')
    const o = await run('surfaceOffset', { id: 'o', name: 'o', sources: [{ key: p.key }], distance: 3 })
    near(areaOf(o), 100)
    const z = bbox(o.mesh.positions).min[2]
    expect(Math.abs(z)).toBeCloseTo(3, 3)
    expect(o.surface).toBe(true)
    // the opposite sign goes the other way
    const back = await run('surfaceOffset', { id: 'o', name: 'o', sources: [{ key: p.key }], distance: -3 })
    expect(bbox(back.mesh.positions).min[2]).toBeCloseTo(-z, 3)
  })
  it('a cylinder wall offset changes its radius', async () => {
    const wall = await run('surfaceRevolve', { id: 'w', name: 'w', curves: [chain([line([5, 0, 0], [5, 0, 10], 'l')])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
    const outer = await run('surfaceOffset', { id: 'o', name: 'o', sources: [{ key: wall.key }], distance: 2 })
    const inner = await run('surfaceOffset', { id: 'i', name: 'i', sources: [{ key: wall.key }], distance: -2 })
    const areas = [areaOf(outer), areaOf(inner)].sort((a, b) => a - b)
    near(areas[0], 2 * Math.PI * 3 * 10, 5e-3)
    near(areas[1], 2 * Math.PI * 7 * 10, 5e-3)
  })
  it('faces of a solid can be offset into a surface', async () => {
    const b = mkBox('b', [10, 10, 10])
    const top = faceIdx(b, (_c, n) => n[2] > 0.9)
    const o = await run('surfaceOffset', { id: 'o', name: 'o', sources: [{ key: b.key, faces: top }], distance: 4 })
    near(areaOf(o), 100)
    expect(o.surface).toBe(true)
    expect(bbox(o.mesh.positions).max[2]).toBeCloseTo(14, 3)
  })
  it('a whole solid is refused with a clear message', async () => {
    const b = mkBox('b', [10, 10, 10])
    await expect(run('surfaceOffset', { id: 'o', name: 'o', sources: [{ key: b.key }], distance: 1 })).rejects.toThrow(/faces/)
  })
})

describe('surface trim', () => {
  it('a plane keeps the front or the back half', async () => {
    const p = await flat('p', 10, 10)
    const front = await run('surfaceTrim', { id: 't', name: 't', key: p.key, tool: { kind: 'plane', origin: [4, 0, 0], normal: [1, 0, 0] }, keep: 'front' })
    near(areaOf(front), 60)
    const back = await run('surfaceTrim', { id: 't', name: 't', key: p.key, tool: { kind: 'plane', origin: [4, 0, 0], normal: [1, 0, 0] }, keep: 'back' })
    near(areaOf(back), 40)
    expect(front.surface).toBe(true)
  })
  it('a surface cuts a surface', async () => {
    const p = await flat('p', 10, 10)
    // a vertical wall across the middle (x = 5)
    const wall = await run('surfaceExtrude', { id: 'w', name: 'w', curves: [chain([line([5, -2, -5], [5, 12, -5], 'w')])], dir: [0, 0, 1], from: 0, to: 10 })
    const left = await run('surfaceTrim', { id: 't', name: 't', key: p.key, tool: { kind: 'body', key: wall.key }, keep: 'back' })
    const right = await run('surfaceTrim', { id: 't', name: 't', key: p.key, tool: { kind: 'body', key: wall.key }, keep: 'front' })
    near(areaOf(left) + areaOf(right), 100)
    expect(areaOf(left)).toBeGreaterThan(1)
    expect(areaOf(right)).toBeGreaterThan(1)
  })
  it('a solid trims by boolean: outside or inside', async () => {
    const p = await flat('p', 20, 20)
    const b = mkBox('b', [10, 10, 10], [10, 10, 0])
    const out = await run('surfaceTrim', { id: 't', name: 't', key: p.key, tool: { kind: 'body', key: b.key }, keep: 'front' })
    near(areaOf(out), 400 - 100)
    const inside = await run('surfaceTrim', { id: 't', name: 't', key: p.key, tool: { kind: 'body', key: b.key }, keep: 'back' })
    near(areaOf(inside), 100)
  })
  it('faces of a body work as the tool', async () => {
    const p = await flat('p', 10, 10)
    const b = mkBox('b', [10, 14, 10], [10, 5, 0])
    const side = faceIdx(b, (_c, n) => n[0] < -0.9)
    const r = await run('surfaceTrim', { id: 't', name: 't', key: p.key, tool: { kind: 'faces', key: b.key, faces: side }, keep: 'back' })
    near(areaOf(r), 50)
  })
  it('a tool that misses is a clear error', async () => {
    const p = await flat('p', 10, 10)
    await expect(run('surfaceTrim', { id: 't', name: 't', key: p.key, tool: { kind: 'plane', origin: [50, 0, 0], normal: [1, 0, 0] }, keep: 'back' })).rejects.toThrow(/does not cut the surface in two/)
  })
  it('a tool that stops half way across is a clear error too', async () => {
    const p = await flat('p', 10, 10)
    const wall = await run('surfaceExtrude', { id: 'w', name: 'w', curves: [chain([line([5, 2, -5], [5, 6, -5], 'w')])], dir: [0, 0, 1], from: 0, to: 10 })
    await expect(run('surfaceTrim', { id: 't', name: 't', key: p.key, tool: { kind: 'body', key: wall.key }, keep: 'back' })).rejects.toThrow(/all the way across/)
  })
  it('refuses a solid target', async () => {
    const b = mkBox('b', [10, 10, 10])
    await expect(run('surfaceTrim', { id: 't', name: 't', key: b.key, tool: { kind: 'plane', origin: [5, 0, 0], normal: [1, 0, 0] }, keep: 'back' })).rejects.toThrow(/surface/i)
  })
})

describe('surface extend', () => {
  const rimEdge = async (p: Body, pred: Parameters<typeof edgeIdx>[1]) => edgeIdx(p, pred)
  it('tangent extension of a flat edge adds distance times length', async () => {
    const p = await flat('p', 10, 10)
    const e = await rimEdge(p, (s, t) => Math.abs(s[0] - 10) < 1e-6 && Math.abs(t[0] - 10) < 1e-6)
    expect(e.length).toBe(1)
    const x = await run('surfaceExtend', { id: 'x', name: 'x', key: p.key, edges: e, distance: 4, mode: 'tangent' })
    near(areaOf(x), 140)
    expect(bbox(x.mesh.positions).max[0]).toBeCloseTo(14, 3)
  })
  it('says where the drag handle stands: the middle of the free edge, pointing away from the surface', async () => {
    const p = await flat('p', 10, 10)
    const cases: [(s: number[], t: number[]) => boolean, number[], number[]][] = [
      [(s, t) => Math.abs(s[0] - 10) < 1e-6 && Math.abs(t[0] - 10) < 1e-6, [10, 5, 0], [1, 0, 0]],
      [(s, t) => Math.abs(s[0]) < 1e-6 && Math.abs(t[0]) < 1e-6, [0, 5, 0], [-1, 0, 0]],
      [(s, t) => Math.abs(s[1]) < 1e-6 && Math.abs(t[1]) < 1e-6, [5, 0, 0], [0, -1, 0]],
      [(s, t) => Math.abs(s[1] - 10) < 1e-6 && Math.abs(t[1] - 10) < 1e-6, [5, 10, 0], [0, 1, 0]],
    ]
    for (const [pred, origin, dir] of cases) {
      const [e] = await rimEdge(p, pred as never)
      const at = await run<{ origin: number[]; dir: number[] }>('surfaceExtendDir', { key: p.key, edge: e })
      origin.forEach((v, i) => expect(at.origin[i]).toBeCloseTo(v, 6))
      dir.forEach((v, i) => expect(at.dir[i]).toBeCloseTo(v, 6))
    }
    // a cylinder wall extends straight on along its axis, away from the wall
    const wall = await run('surfaceRevolve', { id: 'w', name: 'w', curves: [chain([line([5, 0, 0], [5, 0, 10], 'l')])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
    const top = edgeIdx(wall, (s, t) => Math.abs(s[2] - 10) < 1e-6 && Math.abs(t[2] - 10) < 1e-6)
    const up = await run<{ origin: number[]; dir: number[] }>('surfaceExtendDir', { key: wall.key, edge: top[0] })
    expect(up.dir[2]).toBeCloseTo(1, 4)
    expect(up.origin[2]).toBeCloseTo(10, 6)
  })
  it('every edge of a rectangle extends outward whatever its orientation', async () => {
    const p = await flat('p', 10, 10)
    for (const pred of [
      (s: number[], t: number[]) => Math.abs(s[0]) < 1e-6 && Math.abs(t[0]) < 1e-6,
      (s: number[], t: number[]) => Math.abs(s[1]) < 1e-6 && Math.abs(t[1]) < 1e-6,
      (s: number[], t: number[]) => Math.abs(s[1] - 10) < 1e-6 && Math.abs(t[1] - 10) < 1e-6,
    ]) {
      const e = await rimEdge(p, pred as never)
      const x = await run('surfaceExtend', { id: 'x', name: 'x', key: p.key, edges: e, distance: 3, mode: 'tangent' })
      near(areaOf(x), 130)
    }
  })
  it('natural extension of a cylinder wall keeps the radius', async () => {
    const wall = await run('surfaceRevolve', { id: 'w', name: 'w', curves: [chain([line([5, 0, 0], [5, 0, 10], 'l')])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
    const top = edgeIdx(wall, (s, t) => Math.abs(s[2] - 10) < 1e-6 && Math.abs(t[2] - 10) < 1e-6)
    const x = await run('surfaceExtend', { id: 'x', name: 'x', key: wall.key, edges: top, distance: 5, mode: 'natural' })
    near(areaOf(x), 2 * Math.PI * 5 * 15, 5e-3)
    expect(bbox(x.mesh.positions).max[2]).toBeCloseTo(15, 2)
    // tangent leaves the cylinder straight along the wall too
    const y = await run('surfaceExtend', { id: 'y', name: 'y', key: wall.key, edges: top, distance: 5, mode: 'tangent' })
    near(areaOf(y), 2 * Math.PI * 5 * 15, 5e-3)
  })
  it('natural extension of a sphere cap grows over the sphere, tangent leaves it', async () => {
    // a 60 degree cap of a sphere of radius 10, revolved from an arc
    const r = 10, a = (Math.PI / 3)
    const arc: PathSeg = { k: 'a', a: [0, 0, r], m: [r * Math.sin(a / 2), 0, r * Math.cos(a / 2)], b: [r * Math.sin(a), 0, r * Math.cos(a)], id: 'arc' }
    const cap = await run('surfaceRevolve', { id: 'c', name: 'c', curves: [chain([arc])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
    const capArea = areaOf(cap)
    near(capArea, 2 * Math.PI * r * r * (1 - Math.cos(a)), 5e-3)
    const rim = edgeIdx(cap, (s, t) => Math.abs(s[2] - r * Math.cos(a)) < 1e-4 && Math.abs(t[2] - r * Math.cos(a)) < 1e-4)
    const nat = await run('surfaceExtend', { id: 'n', name: 'n', key: cap.key, edges: rim, distance: 3, mode: 'natural' })
    const tan = await run('surfaceExtend', { id: 't', name: 't', key: cap.key, edges: rim, distance: 3, mode: 'tangent' })
    // the natural band follows the sphere; the tangent band is a straight cone and sits outside the sphere
    const band = areaOf(nat) - capArea
    near(band, 2 * Math.PI * r * r * (Math.cos(a) - Math.cos(a + 3 / r)), 5e-3)
    expect(areaOf(tan)).toBeGreaterThan(capArea)
  })
  const freeOf = (b: Body) => openEdges(getBrep(b.key) as unknown as AnyShape).length
  it('two adjacent edges extended together get their corner filled', async () => {
    const p = await flat('p', 10, 10)
    // the x = 10 edge and the y = 10 edge meet at (10, 10)
    const e = edgeIdx(p, (s, t) => (Math.abs(s[0] - 10) < 1e-6 && Math.abs(t[0] - 10) < 1e-6) || (Math.abs(s[1] - 10) < 1e-6 && Math.abs(t[1] - 10) < 1e-6))
    expect(e.length).toBe(2)
    for (const mode of ['tangent', 'natural'] as const) {
      const x = await run('surfaceExtend', { id: 'x', name: 'x', key: p.key, edges: e, distance: 4, mode })
      // 100 + two 10 x 4 strips + the 4 x 4 corner square
      near(areaOf(x), 196, 1e-3)
      expect(faceCount(x)).toBe(4)
      const bb = bbox(x.mesh.positions)
      expect(bb.max[0]).toBeCloseTo(14, 3)
      expect(bb.max[1]).toBeCloseTo(14, 3)
      // one connected shell: its only open edges are the outer rim, nothing is left open at the corner
      expect(x.freeEdges).toBe(freeOf(x))
      const rim = openEdges(getBrep(x.key) as unknown as AnyShape)
      const corner = rim.filter((r) => [r.startPoint, r.endPoint].some((q) => Math.abs(q.x - 14) < 1e-6 && Math.abs(q.y - 14) < 1e-6))
      expect(corner.length).toBe(2)
      // two far edges, two corner rims, the two strip ends and the two untouched square edges
      expect(rim.length).toBe(8)
    }
  })
  it('extending every edge of a square closes all four corners', async () => {
    const p = await flat('p', 10, 10)
    const e = edgeIdx(p, () => true)
    const x = await run('surfaceExtend', { id: 'x', name: 'x', key: p.key, edges: e, distance: 2, mode: 'tangent' })
    near(areaOf(x), 14 * 14, 1e-3)
    expect(faceCount(x)).toBe(9)
    // the rim is one closed loop: four far edges and two rim edges at each corner
    expect(freeOf(x)).toBe(12)
    expect(isSolidBody(x)).toBe(false)
  })
  it('a corner on a sphere cap stays on the sphere when extended naturally', async () => {
    // a quarter-ish patch of a sphere: a lat-long window made by revolving an arc 90 degrees, with two straight meridian edges and two arcs
    const r = 10, a1 = Math.PI / 6, a2 = Math.PI / 3
    const arc: PathSeg = { k: 'a', a: [r * Math.sin(a1), 0, r * Math.cos(a1)], m: [r * Math.sin((a1 + a2) / 2), 0, r * Math.cos((a1 + a2) / 2)], b: [r * Math.sin(a2), 0, r * Math.cos(a2)], id: 'arc' }
    const win = await run('surfaceRevolve', { id: 'c', name: 'c', curves: [chain([arc])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 90 })
    const all = edgeIdx(win, () => true)
    const nat = await run('surfaceExtend', { id: 'n', name: 'n', key: win.key, edges: all, distance: 1, mode: 'natural' })
    // every vertex of the result sits on the sphere (or on the cone-free natural continuation of it)
    const m = nat.mesh.positions
    for (let i = 0; i < m.length; i += 3) expect(Math.abs(Math.hypot(m[i], m[i + 1], m[i + 2]) - r)).toBeLessThan(0.05)
    expect(faceCount(nat)).toBe(9)
    expect(freeOf(nat)).toBe(12)
  })
  it('a reflex corner is mitred: the two strips meet on one edge instead of overlapping', async () => {
    // an L: the corner at (10, 10) wraps round, so the strips of the two edges meeting there would overlap
    const pts: [number, number][] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]]
    const outline = chain(pts.map((q, i) => line([q[0], q[1], 0], [pts[(i + 1) % 6][0], pts[(i + 1) % 6][1], 0], 'l' + i)), true)
    const ell6 = await run('surfacePatch', { id: 'L', name: 'L', boundary: [outline], continuity: 'g0' })
    near(areaOf(ell6), 300)
    const e = edgeIdx(ell6, (s, t) => (Math.abs(s[1] - 10) < 1e-6 && Math.abs(t[1] - 10) < 1e-6 && s[0] > 9 && t[0] > 9) || (Math.abs(s[0] - 10) < 1e-6 && Math.abs(t[0] - 10) < 1e-6 && s[1] > 9 && t[1] > 9))
    expect(e.length).toBe(2)
    for (const mode of ['tangent', 'natural'] as const) {
      const d = 3
      const x = await run('surfaceExtend', { id: 'x', name: 'x', key: ell6.key, edges: e, distance: d, mode })
      // the union of the two strips: 10 x 3 each, minus the 3 x 3 square they share
      near(areaOf(x), 300 + 2 * 10 * d - d * d, 1e-4)
      // no overlap: the mesh area agrees with the B-rep area, and the sheet is one shell
      expect(Array.from(iterTopo((getBrep(x.key) as unknown as AnyShape).wrapped as never, 'shell')).length).toBe(1)
      expect(faceCount(x)).toBe(3)
      // free edges: four untouched outline edges, two strip ends, and the two far edges that meet at the mitre point
      expect(x.freeEdges).toBe(8)
      const rim = openEdges(getBrep(x.key) as unknown as AnyShape)
      const at = (q: { x: number; y: number }) => Math.abs(q.x - 13) < 1e-6 && Math.abs(q.y - 13) < 1e-6
      expect(rim.filter((r) => at(r.startPoint) || at(r.endPoint)).length).toBe(2)
    }
  })
  it('only open edges extend', async () => {
    const b = mkBox('b', [10, 10, 10])
    const p = await run('surfaceDeleteFace', { id: 'd', name: 'd', key: b.key, faces: faceIdx(b, (_c, n) => n[2] > 0.9) })
    const inner = edgeIdx(p, (s, t) => Math.abs(s[2]) < 1e-6 && Math.abs(t[2]) < 1e-6)
    await expect(run('surfaceExtend', { id: 'x', name: 'x', key: p.key, edges: [inner[0]], distance: 2, mode: 'tangent' })).rejects.toThrow(/open/)
  })
})

/**
 * How well a result hangs together. One shell, valid, no stray free edges (the free edges are one closed loop, every
 * vertex on it shared by exactly two of them), no vertex or edge tolerance blown up to hide a gap, and the tessellation
 * is closed everywhere except along those free edges (a gap between a strip and a corner patch would show up there).
 */
function seams(b: Body) {
  const shape = getBrep(b.key) as unknown as AnyShape
  const oc = getOC() as unknown as {
    BRepCheck_Analyzer: new (s: unknown, a: boolean, b: boolean) => { IsValid(): boolean }
    BRep_Tool: { MaxTolerance(s: unknown, t: unknown): number }
    TopAbs_ShapeEnum: { TopAbs_VERTEX: unknown; TopAbs_EDGE: unknown }
  }
  const rim = openEdges(shape)
  const q = (x: number, y: number, z: number) => `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`
  const degree = new Map<string, number>()
  for (const e of rim) for (const p of [e.startPoint, e.endPoint]) degree.set(q(p.x, p.y, p.z), (degree.get(q(p.x, p.y, p.z)) ?? 0) + 1)
  // mesh edges used by one triangle only
  const m = b.mesh
  const key = (i: number) => q(m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2])
  const used = new Map<string, [number, number, number]>()
  const bump = (i: number, j: number) => {
    const a = key(i), c = key(j)
    if (a === c) return // a collapsed edge (the tip of a triangular face) is not a gap
    const k = a < c ? a + '|' + c : c + '|' + a
    const prev = used.get(k)
    used.set(k, [(prev?.[0] ?? 0) + 1, i, j])
  }
  for (let t = 0; t < m.indices.length; t += 3) {
    const [i, j, k] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]]
    bump(i, j); bump(j, k); bump(k, i)
  }
  let strayMeshEdges = 0
  for (const [n, i, j] of used.values()) {
    if (n !== 1) continue
    const at = (v: number) => makeVertex([m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]])
    const onRim = (v: number) => rim.some((e) => measureDistanceBetween(e as never, at(v) as never) < 2e-3)
    if (!onRim(i) || !onRim(j)) strayMeshEdges++
  }
  const worstTol = Math.max(oc.BRep_Tool.MaxTolerance(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_VERTEX), oc.BRep_Tool.MaxTolerance(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE))
  return {
    shells: Array.from(iterTopo(shape.wrapped as never, 'shell')).length,
    valid: new oc.BRepCheck_Analyzer(shape.wrapped, true, false).IsValid(),
    free: rim.length,
    badVertices: Array.from(degree.values()).filter((d) => d !== 2).length,
    strayMeshEdges,
    worstTol,
  }
}
const sound = (b: Body, free: number) => {
  const s = seams(b)
  expect(s).toMatchObject({ shells: 1, valid: true, free, badVertices: 0, strayMeshEdges: 0 })
  expect(s.worstTol).toBeLessThan(1e-3)
  expect(b.freeEdges).toBe(free)
}
const spread = (b: Body, f: (x: number, y: number, z: number) => number): [number, number] => {
  const m = b.mesh.positions
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < m.length; i += 3) { const r = f(m[i], m[i + 1], m[i + 2]); lo = Math.min(lo, r); hi = Math.max(hi, r) }
  return [lo, hi]
}

describe('surface extend on curved surfaces', () => {
  const R = 5, H = 10
  /** a quarter of a cylinder wall: two arcs (z = 0, z = H) and two straight edges (x axis side, y axis side) */
  const quarterWall = () => run('surfaceRevolve', { id: 'w', name: 'w', curves: [chain([line([R, 0, 0], [R, 0, H], 'l')])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 90 })
  const topArc = (b: Body) => edgeIdx(b, (s, t) => Math.abs(s[2] - H) < 1e-6 && Math.abs(t[2] - H) < 1e-6)
  const yEdge = (b: Body) => edgeIdx(b, (s, t) => Math.abs(s[0]) < 1e-6 && Math.abs(t[0]) < 1e-6 && Math.abs(s[2] - t[2]) > 1)
  const xEdge = (b: Body) => edgeIdx(b, (s, t) => Math.abs(s[1]) < 1e-6 && Math.abs(t[1]) < 1e-6 && Math.abs(s[2] - t[2]) > 1)
  const botArc = (b: Body) => edgeIdx(b, (s, t) => Math.abs(s[2]) < 1e-6 && Math.abs(t[2]) < 1e-6)
  const axial = (x: number, y: number) => Math.hypot(x, y)

  it('a cylinder patch: the arc and the straight edge that meet at a corner, natural, stay on the cylinder with the corner closed', async () => {
    const w = await quarterWall()
    sound(w, 4)
    const d = 2
    const e = [...topArc(w), ...yEdge(w)]
    expect(e.length).toBe(2)
    const x = await run('surfaceExtend', { id: 'x', name: 'x', key: w.key, edges: e, distance: d, mode: 'natural' })
    // a cylinder unrolls flat: the patch, an arc strip, a straight strip and the d x d corner
    const th = Math.PI / 2
    near(areaOf(x), R * th * H + R * th * d + H * d + d * d, 5e-3)
    expect(faceCount(x)).toBe(4)
    // one shell, and nothing open at the corner: the free edges are the outer rim and nothing else
    sound(x, 8)
    const [lo, hi] = spread(x, axial)
    expect(lo).toBeGreaterThan(R - 0.02)
    expect(hi).toBeLessThan(R + 0.02)
    expect(bbox(x.mesh.positions).max[2]).toBeCloseTo(H + d, 2)
  })

  it('a cylinder patch, tangent: the arc strip leaves the wall along its tangent and the corner is closed', async () => {
    const w = await quarterWall()
    const e = [...topArc(w), ...yEdge(w)]
    const x = await run('surfaceExtend', { id: 'x', name: 'x', key: w.key, edges: e, distance: 2, mode: 'tangent' })
    expect(faceCount(x)).toBe(4)
    sound(x, 8)
    expect(areaOf(x)).toBeGreaterThan(areaOf(w) + 2 * (H + R * Math.PI / 2) * 0.9)
  })

  it('both ends of a cylinder patch, and all four edges at once, close every corner', async () => {
    const w = await quarterWall()
    for (const mode of ['natural', 'tangent'] as const) {
      const two = await run('surfaceExtend', { id: 'x', name: 'x', key: w.key, edges: [...botArc(w), ...xEdge(w)], distance: 1.5, mode })
      sound(two, 8)
      const all = await run('surfaceExtend', { id: 'a', name: 'a', key: w.key, edges: edgeIdx(w, () => true), distance: 1.5, mode })
      expect(faceCount(all)).toBe(9)
      sound(all, 12)
      if (mode === 'natural') {
        const d = 1.5, th = Math.PI / 2
        near(areaOf(all), (R * th + 2 * d) * (H + 2 * d), 8e-3)
      }
    }
  })

  it('a cylinder patch extended further than the wall is tall still closes', async () => {
    const w = await quarterWall()
    const x = await run('surfaceExtend', { id: 'x', name: 'x', key: w.key, edges: [...topArc(w), ...yEdge(w)], distance: 6, mode: 'natural' })
    sound(x, 8)
    const [lo, hi] = spread(x, axial)
    expect(lo).toBeGreaterThan(R - 0.03)
    expect(hi).toBeLessThan(R + 0.03)
  })

  // a lat-long window of a sphere of radius 10: two parallels (arcs) and two meridians
  const sphereWindow = () => {
    const r = 10, a1 = Math.PI / 6, a2 = Math.PI / 3
    const arc: PathSeg = { k: 'a', a: [r * Math.sin(a1), 0, r * Math.cos(a1)], m: [r * Math.sin((a1 + a2) / 2), 0, r * Math.cos((a1 + a2) / 2)], b: [r * Math.sin(a2), 0, r * Math.cos(a2)], id: 'arc' }
    return run('surfaceRevolve', { id: 'c', name: 'c', curves: [chain([arc])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 90 })
  }
  const radius = (x: number, y: number, z: number) => Math.hypot(x, y, z)
  const parallelOf = (b: Body) => edgeIdx(b, (s, t) => Math.abs(s[2] - 10 * Math.cos(Math.PI / 3)) < 1e-4 && Math.abs(t[2] - 10 * Math.cos(Math.PI / 3)) < 1e-4)
  const meridianOf = (b: Body) => edgeIdx(b, (s, t) => Math.abs(s[0]) < 1e-6 && Math.abs(t[0]) < 1e-6)

  it('a doubly curved patch, two edges that meet at a corner, natural: the corner stays on the sphere and is closed', async () => {
    const win = await sphereWindow()
    sound(win, 4)
    expect(parallelOf(win).length).toBe(1)
    expect(meridianOf(win).length).toBe(1)
    const x = await run('surfaceExtend', { id: 'x', name: 'x', key: win.key, edges: [...parallelOf(win), ...meridianOf(win)], distance: 1.5, mode: 'natural' })
    expect(faceCount(x)).toBe(4)
    sound(x, 8)
    const [lo, hi] = spread(x, radius)
    expect(lo).toBeGreaterThan(10 - 0.03)
    expect(hi).toBeLessThan(10 + 0.03)
  })

  it('a doubly curved patch, all four edges, natural: nine faces on the sphere, one closed rim', async () => {
    const win = await sphereWindow()
    const x = await run('surfaceExtend', { id: 'x', name: 'x', key: win.key, edges: edgeIdx(win, () => true), distance: 1.5, mode: 'natural' })
    expect(faceCount(x)).toBe(9)
    sound(x, 12)
    const [lo, hi] = spread(x, radius)
    expect(lo).toBeGreaterThan(10 - 0.03)
    expect(hi).toBeLessThan(10 + 0.03)
  })

  it('a doubly curved patch, tangent: the edges leave the sphere along their tangents and every corner is closed', async () => {
    const win = await sphereWindow()
    const two = await run('surfaceExtend', { id: 'x', name: 'x', key: win.key, edges: [...parallelOf(win), ...meridianOf(win)], distance: 1.5, mode: 'tangent' })
    expect(faceCount(two)).toBe(4)
    sound(two, 8)
    const all = await run('surfaceExtend', { id: 'a', name: 'a', key: win.key, edges: edgeIdx(win, () => true), distance: 1.5, mode: 'tangent' })
    expect(faceCount(all)).toBe(9)
    sound(all, 12)
    // straight out of a sphere leaves it: the tangent result sits outside the natural one
    expect(spread(all, radius)[1]).toBeGreaterThan(10 + 0.01)
  })

  it('a free-form patch (a saddle): natural carries on along the patch past its boundary, corners included', async () => {
    // the natural continuation has to leave the patch's own parameter range: a point projected back onto the patch would be clamped to its edge
    const P: [number, number, number][] = [[0, 0, 0], [10, 0, 2], [10, 10, 0], [0, 10, 2]]
    const outline = chain(P.map((q, i) => line(q, P[(i + 1) % 4], 'k' + i)), true)
    for (const continuity of ['g0', 'g1'] as const) {
      const saddle = await run('surfacePatch', { id: 'S', name: 'S', boundary: [outline], continuity })
      const two = edgeIdx(saddle, (s, t) => (Math.abs(s[0] - 10) < 1e-6 && Math.abs(t[0] - 10) < 1e-6) || (Math.abs(s[1] - 10) < 1e-6 && Math.abs(t[1] - 10) < 1e-6))
      for (const mode of ['natural', 'tangent'] as const) for (const d of [1, 3]) {
        const x = await run('surfaceExtend', { id: 'x', name: 'x', key: saddle.key, edges: two, distance: d, mode })
        expect(faceCount(x)).toBe(4)
        sound(x, 8)
        // the corner patch is a real d x d piece of surface, not a sliver (the edge strips alone are 10 d each)
        const corner = topoOf(getBrep(x.key) as unknown as AnyShape).faces.map((f) => measureArea(f as never)).sort((p, q) => p - q)[0]
        expect(corner).toBeGreaterThan(0.9 * d * d)
        expect(corner).toBeLessThan(1.4 * d * d)
        const all = await run('surfaceExtend', { id: 'a', name: 'a', key: saddle.key, edges: edgeIdx(saddle, () => true), distance: d, mode })
        expect(faceCount(all)).toBe(9)
        sound(all, 12)
      }
    }
  })

  it('a reflex corner on a curved surface is mitred like a flat one', async () => {
    // a notch cut into the top of a cylinder wall: the material wraps round the notch's two bottom corners
    const w = await quarterWall()
    const cutter = mkBox('cb', [3.5, 3.5, 8], [2.5, 2.5, 6])
    const notched = await run('surfaceTrim', { id: 't', name: 't', key: w.key, tool: { kind: 'body', key: cutter.key }, keep: 'front' })
    sound(notched, 8)
    const notch = edgeIdx(notched, (s, t) => !(Math.abs(s[2] - H) < 1e-6 && Math.abs(t[2] - H) < 1e-6) && !(Math.abs(s[2]) < 1e-6 && Math.abs(t[2]) < 1e-6) && !(Math.abs(s[1]) < 1e-6 && Math.abs(t[1]) < 1e-6) && !(Math.abs(s[0]) < 1e-6 && Math.abs(t[0]) < 1e-6))
    expect(notch.length).toBe(3)
    for (const mode of ['natural', 'tangent'] as const) {
      const x = await run('surfaceExtend', { id: 'x', name: 'x', key: notched.key, edges: notch, distance: 0.6, mode })
      // natural strips lie on the wall and meet on the mitre; tangent ones leave it on separate sheets, so a thin face closes each mitre
      expect(faceCount(x)).toBe(mode === 'natural' ? 4 : 6)
      // five untouched outline edges, the three far edges and the two ends of the outer strips (tangent: the two rim edges of the closing faces too)
      sound(x, mode === 'natural' ? 10 : 12)
    }
  })

  it('an extension that runs into a pole says so instead of leaving a broken corner', async () => {
    // a sphere window whose top edge is 3 from the pole: 4 further would go over the top
    const r = 10, a1 = 0.3, a2 = 1.2
    const arc: PathSeg = { k: 'a', a: [r * Math.sin(a1), 0, r * Math.cos(a1)], m: [r * Math.sin((a1 + a2) / 2), 0, r * Math.cos((a1 + a2) / 2)], b: [r * Math.sin(a2), 0, r * Math.cos(a2)], id: 'arc' }
    const win = await run('surfaceRevolve', { id: 'c', name: 'c', curves: [chain([arc])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 150 })
    const all = edgeIdx(win, () => true)
    await expect(run('surfaceExtend', { id: 'x', name: 'x', key: win.key, edges: all, distance: 4, mode: 'natural' })).rejects.toThrow(/pole/)
    await expect(run('surfaceExtend', { id: 'x', name: 'x', key: win.key, edges: all, distance: 4, mode: 'tangent' })).rejects.toThrow(/pole|valid/)
    // short of the pole it is fine
    const x = await run('surfaceExtend', { id: 'x', name: 'x', key: win.key, edges: all, distance: 1, mode: 'natural' })
    sound(x, 12)
  })

  it('a torus patch (curved both ways, with opposite signs) closes its corners too', async () => {
    // revolve a quarter of a circle of radius 2 centred at x = 6 around the z axis by 90 degrees
    const rr = 2, cx = 6
    const arc: PathSeg = { k: 'a', a: [cx + rr, 0, 0], m: [cx + rr * Math.SQRT1_2, 0, rr * Math.SQRT1_2], b: [cx, 0, rr], id: 'arc' }
    const win = await run('surfaceRevolve', { id: 't', name: 't', curves: [chain([arc])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 90 })
    sound(win, 4)
    for (const mode of ['natural', 'tangent'] as const) {
      const x = await run('surfaceExtend', { id: 'x', name: 'x', key: win.key, edges: edgeIdx(win, () => true), distance: 0.8, mode })
      expect(faceCount(x)).toBe(9)
      sound(x, 12)
    }
  })
})

describe('surface delete face', () => {
  it('a box minus its top is an open shell of five faces', async () => {
    const b = mkBox('b', [10, 10, 10])
    const top = faceIdx(b, (_c, n) => n[2] > 0.9)
    const s = await run('surfaceDeleteFace', { id: 'd', name: 'd', key: b.key, faces: top })
    expect(faceCount(s)).toBe(5)
    near(areaOf(s), 500)
    expect(s.surface).toBe(true)
    expect(s.freeEdges).toBe(4)
    // the faces keep their names, so a later feature can still find "the bottom"
    expect(s.mesh.faceNames!.flat()).toContain('b:zmin')
    expect(s.mesh.faceNames!.flat()).not.toContain('b:zmax')
  })
  it('the open edges get names of their own, so one of them can be picked again after an edit', async () => {
    const b = mkBox('b', [10, 10, 10])
    const s = await run('surfaceDeleteFace', { id: 'd', name: 'd', key: b.key, faces: faceIdx(b, (_c, n) => n[2] > 0.9) })
    const topo = topoOf(getBrep(s.key) as unknown as AnyShape)
    const rim = topo.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.startPoint.z - 10) < 1e-6 && Math.abs(e.endPoint.z - 10) < 1e-6).map((x) => x.i)
    expect(rim.length).toBe(4)
    const names = rim.map((i) => s.mesh.edgeNames![i][0])
    expect(new Set(names).size).toBe(4)
    // the edges between two faces keep their `A&B` names
    expect(s.mesh.edgeNames!.flat().filter((n) => n.includes('&')).length).toBeGreaterThan(0)
  })
  it('refuses to delete everything or nothing', async () => {
    const b = mkBox('b', [10, 10, 10])
    await expect(run('surfaceDeleteFace', { id: 'd', name: 'd', key: b.key, faces: [] })).rejects.toThrow()
    await expect(run('surfaceDeleteFace', { id: 'd', name: 'd', key: b.key, faces: [0, 1, 2, 3, 4, 5] })).rejects.toThrow(/every face/)
  })
})

describe('surface unstitch', () => {
  it('a box falls apart into six surfaces', async () => {
    const b = mkBox('b', [10, 10, 10])
    const out = await run<Body[]>('surfaceUnstitch', { id: 'u', name: 'u', key: b.key })
    expect(out.length).toBe(6)
    expect(out.every((x) => x.surface)).toBe(true)
    expect(out.map((x) => x.id)).toEqual(['u', 'u.1', 'u.2', 'u.3', 'u.4', 'u.5'])
    near(out.reduce((s, x) => s + areaOf(x), 0), 600)
  })
  it('picked faces come out, the rest stays one surface', async () => {
    const b = mkBox('b', [10, 10, 10])
    const top = faceIdx(b, (_c, n) => n[2] > 0.9)
    const out = await run<Body[]>('surfaceUnstitch', { id: 'u', name: 'u', key: b.key, faces: top })
    expect(out.length).toBe(2)
    near(areaOf(out[0]), 100)
    near(areaOf(out[1]), 500)
    expect(faceCount(out[1])).toBe(5)
  })
})

describe('surface stitch', () => {
  it('six unstitched faces sew back into a solid', async () => {
    const b = mkBox('b', [10, 10, 10])
    const parts = await run<Body[]>('surfaceUnstitch', { id: 'u', name: 'u', key: b.key })
    const s = await run('surfaceStitch', { id: 's', name: 's', keys: parts.map((p) => p.key), tolerance: 1e-3, solid: true })
    expect(s.surface).toBeUndefined()
    expect(isSolidBody(s)).toBe(true)
    near(volOf(s), 1000)
    expect(faceCount(s)).toBe(6)
  })
  it('five faces stay an open surface and report the open edges', async () => {
    const b = mkBox('b', [10, 10, 10])
    const parts = await run<Body[]>('surfaceUnstitch', { id: 'u', name: 'u', key: b.key })
    const s = await run('surfaceStitch', { id: 's', name: 's', keys: parts.slice(0, 5).map((p) => p.key), tolerance: 1e-3, solid: true })
    expect(s.surface).toBe(true)
    expect(s.freeEdges).toBe(4)
    expect(faceCount(s)).toBe(5)
  })
  it('with solid switched off a closed shell stays a surface', async () => {
    const b = mkBox('b', [10, 10, 10])
    const parts = await run<Body[]>('surfaceUnstitch', { id: 'u', name: 'u', key: b.key })
    const s = await run('surfaceStitch', { id: 's', name: 's', keys: parts.map((p) => p.key), tolerance: 1e-3, solid: false })
    expect(s.surface).toBe(true)
    expect(s.freeEdges).toBe(0)
  })
  it('a gap bigger than the tolerance does not close, a larger tolerance does', async () => {
    const a = await flat('a', 10, 10, 0)
    const c = await run('surfacePatch', { id: 'c', name: 'c', boundary: [chain([line([10.05, 0, 0], [20, 0, 0], 'a'), line([20, 0, 0], [20, 10, 0], 'b'), line([20, 10, 0], [10.05, 10, 0], 'c'), line([10.05, 10, 0], [10.05, 0, 0], 'd')], true)], continuity: 'g0' })
    const tight = await run('surfaceStitch', { id: 's', name: 's', keys: [a.key, c.key], tolerance: 1e-3, solid: false })
    expect(tight.freeEdges).toBe(8)
    const loose = await run('surfaceStitch', { id: 's', name: 's', keys: [a.key, c.key], tolerance: 0.2, solid: false })
    expect(loose.freeEdges).toBe(6)
  })
  it('a solid is refused', async () => {
    const b = mkBox('b', [10, 10, 10])
    await expect(run('surfaceStitch', { id: 's', name: 's', keys: [b.key], tolerance: 1e-3, solid: true })).rejects.toThrow(/solid/)
  })
})

describe('surface thicken', () => {
  it('a flat surface thickens to a slab', async () => {
    const p = await flat('p', 10, 10)
    const t = await run('surfaceThicken', { id: 't', name: 't', key: p.key, distance: 2, sym: false })
    expect(t.surface).toBeUndefined()
    near(volOf(t), 200)
    const bb = bbox(t.mesh.positions)
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(2, 3)
  })
  it('symmetric puts half on each side; a negative distance flips it', async () => {
    const p = await flat('p', 10, 10)
    const sym = await run('surfaceThicken', { id: 't', name: 't', key: p.key, distance: 4, sym: true })
    near(volOf(sym), 400)
    const bb = bbox(sym.mesh.positions)
    expect(bb.max[2]).toBeCloseTo(2, 3)
    expect(bb.min[2]).toBeCloseTo(-2, 3)
    const up = await run('surfaceThicken', { id: 'u', name: 'u', key: p.key, distance: 3, sym: false })
    const down = await run('surfaceThicken', { id: 'd', name: 'd', key: p.key, distance: -3, sym: false })
    const bu = bbox(up.mesh.positions), bd = bbox(down.mesh.positions)
    expect(bu.min[2] * bd.min[2] <= 1e-9 && bu.max[2] * bd.max[2] <= 1e-9).toBe(true)
  })
  it('a curved wall thickens by Pappus volume', async () => {
    const wall = await run('surfaceRevolve', { id: 'w', name: 'w', curves: [chain([line([5, 0, 0], [5, 0, 10], 'l')])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
    const t = await run('surfaceThicken', { id: 't', name: 't', key: wall.key, distance: 1, sym: false })
    expect(t.surface).toBeUndefined()
    // a tube 1 mm thick: pi (R^2 - r^2) h with R and r being 6 and 5, or 5 and 4
    const v = volOf(t)
    expect(Math.min(Math.abs(v - Math.PI * 11 * 10), Math.abs(v - Math.PI * 9 * 10))).toBeLessThan(0.01 * v)
  })
  describe('closed shells', () => {
    const closedBox = async (size = 10) => {
      const b = mkBox('b', [size, size, size])
      const parts = await run<Body[]>('surfaceUnstitch', { id: 'u', name: 'u', key: b.key })
      const s = await run('surfaceStitch', { id: 's', name: 's', keys: parts.map((p) => p.key), tolerance: 1e-3, solid: false })
      expect(s.surface).toBe(true)
      expect(s.freeEdges).toBe(0)
      return s
    }
    const sound = (b: Body) => {
      const shape = getBrep(b.key) as unknown as AnyShape
      expect(b.surface).toBeUndefined()
      expect(isSolidBody(b)).toBe(true)
      expect(openEdges(shape).length).toBe(0)
      expect(shape.solids.length).toBe(1)
      expect(topoOf(shape).faces.length).toBe(12)
    }
    it('thickens a closed box surface outward into a hollow solid', async () => {
      const s = await closedBox()
      const t = await run('surfaceThicken', { id: 't', name: 't', key: s.key, distance: 2, sym: false })
      sound(t)
      // 14^3 outer, 10^3 cavity
      near(volOf(t), 14 ** 3 - 1000, 5e-3)
      const bb = bbox(t.mesh.positions)
      expect(bb.max[0]).toBeCloseTo(7, 2)
      expect(bb.min[2]).toBeCloseTo(-2, 2)
      expect(bb.max[2]).toBeCloseTo(12, 2)
    })
    it('inward and symmetric', async () => {
      const s = await closedBox()
      const inward = await run('surfaceThicken', { id: 'i', name: 'i', key: s.key, distance: -2, sym: false })
      sound(inward)
      near(volOf(inward), 1000 - 6 ** 3, 5e-3)
      expect(bbox(inward.mesh.positions).max[0]).toBeCloseTo(5, 2)
      expect(bbox(inward.mesh.positions).min[2]).toBeCloseTo(0, 2)
      const sym = await run('surfaceThicken', { id: 'y', name: 'y', key: s.key, distance: 2, sym: true })
      sound(sym)
      near(volOf(sym), 12 ** 3 - 8 ** 3, 5e-3)
      expect(bbox(sym.mesh.positions).max[0]).toBeCloseTo(6, 2)
    })
    it('thickens a sphere surface into a hollow ball', async () => {
      const r = 10
      const arc: PathSeg = { k: 'a', a: [0, 0, r], m: [r * Math.SQRT1_2, 0, r * Math.SQRT1_2], b: [r, 0, 0], id: 'arc' }
      const half: PathSeg = { k: 'a', a: [r, 0, 0], m: [r * Math.SQRT1_2, 0, -r * Math.SQRT1_2], b: [0, 0, -r], id: 'arc2' }
      const ball = await run('surfaceRevolve', { id: 'w', name: 'w', curves: [chain([arc, half])], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
      expect(ball.freeEdges).toBe(0)
      const t = await run('surfaceThicken', { id: 't', name: 't', key: ball.key, distance: 1, sym: false })
      expect(t.surface).toBeUndefined()
      expect(openEdges(getBrep(t.key) as unknown as AnyShape).length).toBe(0)
      const v = volOf(t)
      // a shell 1 mm thick, either outside (R 11) or inside (r 9) the sphere
      const shell = (R: number, q: number) => (4 / 3) * Math.PI * (R ** 3 - q ** 3)
      expect(Math.min(Math.abs(v - shell(11, 10)), Math.abs(v - shell(10, 9)))).toBeLessThan(0.01 * v)
    })
    it('a thickness the shape cannot take is refused with a clear message', async () => {
      const s = await closedBox()
      await expect(run('surfaceThicken', { id: 't', name: 't', key: s.key, distance: -6, sym: false })).rejects.toThrow(/closed surface.*not possible/)
    })
  })
  it('refuses a solid and a zero thickness', async () => {
    const b = mkBox('b', [10, 10, 10])
    await expect(run('surfaceThicken', { id: 't', name: 't', key: b.key, distance: 1, sym: false })).rejects.toThrow(/surface/)
    const p = await flat('p')
    await expect(run('surfaceThicken', { id: 't', name: 't', key: p.key, distance: 0, sym: false })).rejects.toThrow()
  })
  it('stitching a box of patches and thickening a bent surface give solids with sensible volumes', async () => {
    const wall = await run('surfaceExtrude', { id: 'w', name: 'w', curves: [chain([line([0, 0, 0], [10, 0, 0], 'a'), line([10, 0, 0], [10, 10, 0], 'b')])], dir: [0, 0, 1], from: 0, to: 5 })
    const t = await run('surfaceThicken', { id: 't', name: 't', key: wall.key, distance: 1, sym: false })
    expect(t.surface).toBeUndefined()
    expect(volOf(t)).toBeGreaterThan(90)
    expect(volOf(t)).toBeLessThan(120)
  })
})

describe('surface replace face', () => {
  const closed = (b: Body) => openEdges(getBrep(b.key) as unknown as AnyShape).length === 0
  const topOf = (b: Body) => faceIdx(b, (_c, n) => n[2] > 0.9)
  const replace = (b: Body, faces: number[], target: unknown) => run('surfaceReplaceFace', { id: 'r', name: 'r', key: b.key, faces, target })
  const plane = (z: number) => ({ kind: 'plane', origin: [0, 0, z], normal: [0, 0, 1] })
  /** a 20 x 20 x 10 block centred on the origin: its top is at z = 5 */
  const block = () => mkBox('b', [20, 20, 10], [0, 0, -5])
  /** area under a circle of radius 20 for x = -10 .. 10, measured from its centre line */
  const arc = 2 * (5 * Math.sqrt(300) + 200 * Math.asin(0.5))

  it('a plane below the top cuts the block down', async () => {
    const b = block()
    const r = await replace(b, topOf(b), plane(2))
    expect(r.surface).toBeFalsy()
    expect(isSolidBody(r)).toBe(true)
    expect(closed(r)).toBe(true)
    near(volOf(r), 20 * 20 * 7)
    expect(faceCount(r)).toBe(6)
    expect(bbox(r.mesh.positions).max[2]).toBeCloseTo(2, 4)
  })
  it('a plane above the top builds the block up', async () => {
    const b = block()
    const r = await replace(b, topOf(b), plane(8))
    expect(closed(r)).toBe(true)
    near(volOf(r), 20 * 20 * 13)
    expect(faceCount(r)).toBe(6)
    expect(bbox(r.mesh.positions).max[2]).toBeCloseTo(8, 4)
  })
  it('a plane already on the face changes nothing', async () => {
    const b = block()
    const r = await replace(b, topOf(b), plane(5))
    near(volOf(r), 4000)
    expect(faceCount(r)).toBe(6)
  })
  it('a tilted plane cuts one side and builds the other', async () => {
    const b = block()
    // x + z = 6: the top rises to 16 at one end and the other end is cut down to -4
    const r = await replace(b, topOf(b), { kind: 'plane', origin: [0, 0, 6], normal: [1 / Math.SQRT2, 0, 1 / Math.SQRT2] })
    expect(closed(r)).toBe(true)
    // the mean height of a tilted plane over the footprint is its height in the middle
    near(volOf(r), 20 * 20 * 11)
    expect(bbox(r.mesh.positions).max[2]).toBeCloseTo(16, 3)
    expect(faceCount(r)).toBe(6)
  })
  it('a cylindrical surface cuts a curved top into the block', async () => {
    const b = block()
    // an arc of radius 20 whose top touches z = 5 at x = 0 (axis along Y at z = -15), spanning x = -12 .. 12
    const cyl = await run('surfaceRevolve', { id: 'c', name: 'c', curves: [chain([line([-12, -15, 1], [-12, 15, 1], 'l')])], axisOrigin: [0, 0, -15], axisDir: [0, 1, 0], angle: 73.74 })
    const r = await replace(b, topOf(b), { kind: 'body', key: cyl.key })
    expect(closed(r)).toBe(true)
    expect(isSolidBody(r)).toBe(true)
    near(volOf(r), 20 * (arc - 200), 5e-3)
    expect(volOf(r)).toBeLessThan(4000)
    expect(faceCount(r)).toBe(6)
    expect(bbox(r.mesh.positions).max[2]).toBeGreaterThan(4.9)
    expect(bbox(r.mesh.positions).max[2]).toBeLessThan(5.001)
  })
  it('a bowl that dips below the top and rises above it at the sides does both', async () => {
    const b = block()
    // the bottom of a circle of radius 20 centred at z = 24: z = 4 at x = 0, 6.68 at x = +-10
    const bowl = await run('surfaceRevolve', { id: 'c', name: 'c', curves: [chain([line([12, -15, 8], [12, 15, 8], 'l')])], axisOrigin: [0, 0, 24], axisDir: [0, 1, 0], angle: 73.74 })
    const r = await replace(b, topOf(b), { kind: 'body', key: bowl.key })
    expect(closed(r)).toBe(true)
    near(volOf(r), 20 * (29 * 20 - arc), 5e-3)
    expect(bbox(r.mesh.positions).max[2]).toBeGreaterThan(6.5)
    expect(faceCount(r)).toBe(6)
  })
  it('a B-spline patch becomes the new top', async () => {
    const b = block()
    const pt = (x: number, y: number, z: number): [number, number, number] => [x, y, z]
    const c = chain([line(pt(-14, -14, 2), pt(14, -14, -2), 'a'), line(pt(14, -14, -2), pt(14, 14, 2), 'b'), line(pt(14, 14, 2), pt(-14, 14, -2), 'c'), line(pt(-14, 14, -2), pt(-14, -14, 2), 'd')], true)
    const patch = await run('surfacePatch', { id: 'p', name: 'p', boundary: [c], continuity: 'g0' })
    const r = await replace(b, topOf(b), { kind: 'body', key: patch.key })
    expect(closed(r)).toBe(true)
    expect(isSolidBody(r)).toBe(true)
    // the top now lies between z = -2 and 2 over the block: about 5 thick instead of 10
    expect(volOf(r)).toBeGreaterThan(20 * 20 * 3)
    expect(volOf(r)).toBeLessThan(20 * 20 * 7)
    expect(bbox(r.mesh.positions).max[2]).toBeLessThan(2.01)
    expect(faceCount(r)).toBe(6)
    // the face on the patch has a name of the feature
    expect(r.mesh.faceNames!.some((n) => n.some((x) => x === 'r:replace'))).toBe(true)
  })
  it('a face of another body works as the target', async () => {
    const b = block()
    const other = mkBox('o', [30, 30, 4], [0, 0, 18])
    const r = await replace(b, topOf(b), { kind: 'faces', key: other.key, faces: faceIdx(other, (_c, n) => n[2] < -0.9) })
    near(volOf(r), 20 * 20 * 23)
  })
  it('several faces move together, one cut and one built up', async () => {
    const a = mkBox('a', [10, 10, 10], [-5, 0, -5])
    const c = mkBox('c', [10, 10, 8], [5, 0, -5])
    const u = await api.boolean({ id: 'u', name: 'u', op: 'union', base: a.key, tools: [c.key] })
    const tops = faceIdx(u, (_c, n) => n[2] > 0.9)
    expect(tops.length).toBe(2)
    const r = await replace(u, tops, plane(4))
    expect(closed(r)).toBe(true)
    near(volOf(r), 20 * 10 * 9)
    const down = await replace(u, tops, plane(1))
    near(volOf(down), 20 * 10 * 6)
    expect(faceCount(down)).toBe(6)
  })
  describe('on a tapered block the slanted walls carry on up to the target', () => {
    const XYP = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
    const sq = [{ k: 'l', a: [0, 0], b: [20, 0] }, { k: 'l', a: [20, 0], b: [20, 20] }, { k: 'l', a: [20, 20], b: [0, 20] }, { k: 'l', a: [0, 20], b: [0, 0] }]
    const taper = async (outer: unknown) => run('extrudeTool', { id: 'e', name: 'e', faces: [], mode: 'one', d1: 10, d2: 0, faceDir: 1, taper: 10, groups: [{ plane: XYP, profiles: [{ outer, holes: [] }] }] })
    const t = Math.tan((10 * Math.PI) / 180)
    /** volume of the frustum with 20 mm base up to height z */
    const frustumTo = (z: number) => (20 ** 3 - (20 - 2 * t * z) ** 3) / (6 * t)
    it('raised to a plane, with no step', async () => {
      const b = await taper(sq)
      const r = await replace(b, topOf(b), plane(15))
      expect(closed(r)).toBe(true)
      near(volOf(r), frustumTo(15), 2e-3)
      expect(faceCount(r)).toBe(6)
    })
    it('cut down to a plane, with no ledge', async () => {
      const b = await taper(sq)
      const r = await replace(b, topOf(b), plane(6))
      expect(closed(r)).toBe(true)
      near(volOf(r), frustumTo(6), 2e-3)
      expect(faceCount(r)).toBe(6)
    })
    it('raised to a curved surface', async () => {
      const b = await taper(sq)
      // a bowl: the bottom of a circle of radius 30 centred at z = 42 above x = 10 (z = 12 in the middle, about 13.7 at the walls)
      const bowl = await run('surfaceRevolve', { id: 'c', name: 'c', curves: [chain([line([25, -5, 16.0192], [25, 25, 16.0192], 'l')])], axisOrigin: [10, 0, 42], axisDir: [0, 1, 0], angle: 60 })
      const r = await replace(b, topOf(b), { kind: 'body', key: bowl.key })
      expect(closed(r)).toBe(true)
      expect(faceCount(r)).toBe(6)
      // numeric volume: up to the bowl or to where the slanted walls meet, whichever is lower
      let v = 0
      const n = 400, dx = 20 / n
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = (i + 0.5) * dx, y = (j + 0.5) * dx
        const zt = 42 - Math.sqrt(900 - (x - 10) ** 2)
        const zw = (10 - Math.max(Math.abs(x - 10), Math.abs(y - 10))) / t
        v += Math.max(0, Math.min(zt, zw)) * dx * dx
      }
      near(volOf(r), v, 4e-3)
    })
    it('curved walls that lean are refused with a sentence', async () => {
      const cone = await taper([{ k: 'c', c: [10, 10], r: 10 }])
      await expect(replace(cone, topOf(cone), plane(15))).rejects.toThrow(/neighbours are flat/)
    })
  })
  it('a target that does not reach over the face is refused', async () => {
    const b = block()
    const small = await run('surfacePatch', { id: 'p', name: 'p', boundary: [chain([line([0, 0, 0], [5, 0, 0], 'a'), line([5, 0, 0], [5, 5, 0], 'b'), line([5, 5, 0], [0, 5, 0], 'c'), line([0, 5, 0], [0, 0, 0], 'd')], true)], continuity: 'g0' })
    await expect(replace(b, topOf(b), { kind: 'body', key: small.key })).rejects.toThrow(/does not cover the face/)
  })
  it('says what is wrong with a bad pick', async () => {
    const b = block()
    await expect(replace(b, [], plane(2))).rejects.toThrow(/Select the faces/)
    await expect(replace(b, [99], plane(2))).rejects.toThrow(/no longer exists/)
    await expect(replace(b, topOf(b), { kind: 'plane', origin: [0, 0, 0], normal: [1, 0, 0] })).rejects.toThrow(/runs along the face/)
    await expect(replace(b, topOf(b), { kind: 'body', key: b.key })).rejects.toThrow(/surface/)
    const s = await flat('s', 10, 10)
    await expect(replace(s, [0], plane(2))).rejects.toThrow(/solid body/)
    // a plane below the whole block
    await expect(replace(b, topOf(b), plane(-20))).rejects.toThrow()
  })
})

void volOf
