/** Second-wave solid ops (sphere, torus, pipe, coil, advanced sweep / loft / revolve, rib, fillet, chamfer, shell, draft, transforms, scale), run directly in Node. */
import { beforeAll, describe, expect, it } from 'vitest'
import { getOC, measureVolume, type AnyShape } from 'replicad'
import { box, initOcc, topoOf } from './occ'
import { bodyFromShape, getBrep, getOp, helpers } from './store'
import { bbox, type Body } from './types'
import './model-ops'
import './solid-ops'
import './modeling-ops'
import './solids2-ops'
import type { Loop, PlaneDef } from '../sketch/types'
import type { PathSeg } from './solid-ops'

const run = async (name: string, args: unknown) => {
  try { return (await getOp(name)!(args as never, helpers)) as Body } catch (e) {
    if (e instanceof Error) throw e
    let m = String(e)
    try { m = 'OpenCascade: ' + (getOC() as unknown as { OCJS: { getStandard_FailureData(x: unknown): { GetMessageString(): string } } }).OCJS.getStandard_FailureData(e).GetMessageString() } catch { /* no message */ }
    throw new Error(`${name}: ${m}`)
  }
}
const vol = (b: Body) => Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never))
const near = (a: number, b: number, rel = 1e-3) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
const rect = (x0: number, y0: number, x1: number, y1: number): Loop => [
  { k: 'l', a: [x0, y0], b: [x1, y0] }, { k: 'l', a: [x1, y0], b: [x1, y1] }, { k: 'l', a: [x1, y1], b: [x0, y1] }, { k: 'l', a: [x0, y1], b: [x0, y0] },
]
const circ = (cx: number, cy: number, r: number): Loop => [{ k: 'c', c: [cx, cy], r }]
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
const at = (z: number): PlaneDef => ({ ...XY, origin: [0, 0, z] })
const mkBox = (id: string, w: number, d: number, h: number, pos: [number, number, number] = [0, 0, 0]) => bodyFromShape(id, id, box([w, d, h], pos))

beforeAll(async () => { await initOcc() })

describe('primitives', () => {
  it('sphere and torus volumes', async () => {
    near(vol(await run('sphereTool', { id: 's', name: 's', radius: 10, origin: [1, 2, 3] })), (4 / 3) * Math.PI * 1000, 5e-3)
    const t = await run('torusTool', { id: 't', name: 't', major: 20, minor: 5, origin: [0, 0, 0], dir: [0, 0, 1] })
    near(vol(t), 2 * Math.PI * Math.PI * 20 * 25, 5e-3)
    await expect(run('torusTool', { id: 't', name: 't', major: 5, minor: 6, origin: [0, 0, 0], dir: [0, 0, 1] })).rejects.toThrow()
  })
  it('pipe: solid and hollow along an L path', async () => {
    const path: PathSeg[] = [{ k: 'l', a: [0, 0, 0], b: [0, 0, 40] }, { k: 'l', a: [0, 0, 40], b: [30, 0, 40] }]
    const solid = await run('pipeTool', { id: 'p', name: 'p', path, section: 'circle', size: 10, hollow: false, wall: 1 })
    near(vol(solid), Math.PI * 25 * 70, 0.06)
    const hollow = await run('pipeTool', { id: 'p', name: 'p', path, section: 'circle', size: 10, hollow: true, wall: 1 })
    expect(vol(hollow)).toBeLessThan(vol(solid) * 0.5)
    expect(vol(hollow)).toBeGreaterThan(0)
    const sq = await run('pipeTool', { id: 'p', name: 'p', path: [path[0]], section: 'square', size: 8, hollow: false, wall: 1 })
    near(vol(sq), 64 * 40, 1e-3)
  })
  it('coil: volume by Pappus', async () => {
    const c = await run('coilTool', { id: 'c', name: 'c', origin: [0, 0, 0], dir: [0, 0, 1], diameter: 30, pitch: 8, height: 40, section: 'circle', size: 4, hollow: false, wall: 1, leftHand: false })
    const turns = 5
    near(vol(c), Math.PI * 4 * Math.hypot(2 * Math.PI * 15, 8) * turns, 0.03)
    const bb = bbox(c.mesh.positions)
    expect(bb.max[0]).toBeGreaterThan(16)
    expect(bb.max[2] - bb.min[2]).toBeGreaterThan(36)
  })
})

describe('advanced sweep', () => {
  const straight: PathSeg[] = [{ k: 'l', a: [0, 0, 0], b: [0, 0, 40] }]
  const groups = [{ plane: XY, profiles: [{ outer: rect(-5, -5, 5, 5), holes: [] }] }]
  it('plain, twisted and tapered', async () => {
    const base = { id: 's', name: 's', groups, path: straight, orientation: 'perpendicular', taper: 0, twist: 0 }
    near(vol(await run('sweepAdv', base)), 100 * 40, 1e-3)
    const tw = await run('sweepAdv', { ...base, twist: 90 })
    near(vol(tw), 100 * 40, 0.03)
    const tp = await run('sweepAdv', { ...base, taper: 5 })
    expect(vol(tp)).toBeLessThan(100 * 40 * 0.85)
    expect(vol(tp)).toBeGreaterThan(100 * 40 * 0.4)
  })
  it('parallel orientation along a curved path and a guide rail', async () => {
    const path: PathSeg[] = [{ k: 'a', a: [0, 0, 0], m: [2.9289, 0, 7.0711], b: [10, 0, 10] }]
    const g = [{ plane: XY, profiles: [{ outer: circ(0, 0, 2), holes: [] }] }]
    const par = await run('sweepAdv', { id: 's', name: 's', groups: g, path, orientation: 'parallel', taper: 0, twist: 0 })
    expect(vol(par)).toBeGreaterThan(0)
    const guide: PathSeg[] = [{ k: 'a', a: [0, 3, 0], m: [2.9289, 3, 7.0711], b: [10, 3, 10] }]
    const gr = await run('sweepAdv', { id: 's', name: 's', groups: g, path, orientation: 'perpendicular', taper: 0, twist: 0, guide })
    expect(vol(gr)).toBeGreaterThan(0)
  })
})

describe('advanced loft', () => {
  const secs = (r0: number, r1: number) => [{ plane: XY, profile: { outer: circ(0, 0, r0), holes: [] } }, { plane: at(30), profile: { outer: circ(0, 0, r1), holes: [] } }]
  it('end conditions change the shape; rails and a centre line build', async () => {
    const base = { id: 'l', name: 'l', sections: secs(10, 5), ruled: false, startCond: 'free', endCond: 'free', startWeight: 0.3, endWeight: 0.3 }
    const v0 = vol(await run('loftAdv', base))
    const v1 = vol(await run('loftAdv', { ...base, startCond: 'normal', endCond: 'normal' }))
    expect(Math.abs(v1 - v0)).toBeGreaterThan(1)
    expect(vol(await run('loftAdv', { ...base, startCond: 'smooth' }))).toBeGreaterThan(0)
    const centre: PathSeg[] = [{ k: 'l', a: [0, 0, 0], b: [0, 0, 30] }]
    expect(vol(await run('loftAdv', { ...base, centre }))).toBeGreaterThan(0)
    const rails: PathSeg[][] = [[{ k: 'l', a: [10, 0, 0], b: [5, 0, 30] }], [{ k: 'l', a: [-10, 0, 0], b: [-5, 0, 30] }]]
    expect(vol(await run('loftAdv', { ...base, rails }))).toBeGreaterThan(0)
  })
})

describe('revolve extents', () => {
  const groups = [{ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 1, 0] } as PlaneDef, profiles: [{ outer: rect(10, 0, 20, 10), holes: [] }] }]
  const base = { id: 'r', name: 'r', groups, axisOrigin: [0, 0, 0] as [number, number, number], axisDir: [0, 0, 1] as [number, number, number] }
  it('one side, symmetric halves and two sides add up', async () => {
    const full = Math.PI * (400 - 100) * 10
    near(vol(await run('revolveAdv', { ...base, angle1: 360, angle2: 0 })), full, 1e-3)
    near(vol(await run('revolveAdv', { ...base, angle1: 90, angle2: 90 })), full / 2, 1e-3)
    const two = await run('revolveAdv', { ...base, angle1: 60, angle2: 30 })
    near(vol(two), full / 4, 1e-3)
    // the 30 degrees on the back side reach the other side of the profile plane
    expect(bbox(two.mesh.positions).min[1]).toBeLessThan(-4)
  })
})

describe('rib', () => {
  const hollowBox = () => {
    const outer = box([60, 60, 40], [0, 0, 0]), inner = box([56, 56, 40], [0, 0, 2])
    return bodyFromShape('b', 'b', (outer as unknown as { cut(o: unknown): AnyShape }).cut(inner) as never)
  }
  it('a line across the cavity grows to the walls', async () => {
    const b = hollowBox()
    const base = vol(b)
    const segs: PathSeg[] = [{ k: 'l', a: [-28, 0, 20], b: [28, 0, 20] }]
    const out = await run('ribTool', { id: 'b', name: 'b', key: b.key, segs, normal: [0, 1, 0], thickness: 2, symmetric: true, direction: 'plane', flip: false, both: false, depth: 0, fid: 'f' })
    // a 56 wide rib from z=20 down to the floor at z=2, 2 thick
    near(vol(out) - base, 56 * 18 * 2, 0.01)
    // the other way the cavity is open at the top: no face to stop at, so a depth is needed
    const up = await run('ribTool', { id: 'b', name: 'b', key: b.key, segs, normal: [0, 1, 0], thickness: 2, symmetric: true, direction: 'plane', flip: true, both: false, depth: 5, fid: 'f' })
    near(vol(up) - base, 56 * 5 * 2, 0.01)
  })
})

describe('fillet and chamfer', () => {
  const edgeIdx = (b: Body, pred: (m: number[], d: number[]) => boolean) => topoOf(getBrep(b.key) as unknown as AnyShape).edges.map((e, i) => ({ i, m: e.pointAt(0.5), t: e.tangentAt(0.5) })).filter((x) => pred([x.m.x, x.m.y, x.m.z], [x.t.x, x.t.y, x.t.z])).map((x) => x.i)
  const baseArgs = { id: 'f', name: 'f', fid: 'f', mode: 'fillet', radiusType: 'constant', size: 2, endSize: 2, midSize: 0, midPos: 0.5, swap: false, chord: 2, setback: 0, continuity: 'g1', rule: 'selected', chamferType: 'equal', dist2: 2, angle: 45, flipFace: false }
  it('variable, chord, G2 and rule fillets', async () => {
    const b = mkBox('b', 30, 30, 10)
    const e = edgeIdx(b, (m, d) => Math.abs(m[1] + 15) < 1e-6 && m[2] > 9.9 && Math.abs(d[0]) > 0.9)
    expect(e.length).toBe(1)
    const sharp = vol(b)
    const c = vol(await run('edgeModAdv', { ...baseArgs, key: b.key, edges: e }))
    const v = vol(await run('edgeModAdv', { ...baseArgs, key: b.key, edges: e, radiusType: 'variable', size: 1, endSize: 4 }))
    expect(v).toBeLessThan(sharp)
    expect(v).toBeGreaterThan(sharp - 30 * (1 - Math.PI / 4) * 16)
    const ch = vol(await run('edgeModAdv', { ...baseArgs, key: b.key, edges: e, radiusType: 'chord', chord: 2 * Math.SQRT2 }))
    near(ch, c + 0, 0.01) // 90 degree edge: chord 2*sqrt2 is radius 2 (same as constant 2)
    expect(vol(await run('edgeModAdv', { ...baseArgs, key: b.key, edges: e, continuity: 'g2' }))).toBeGreaterThan(0)
    expect(vol(await run('edgeModAdv', { ...baseArgs, key: b.key, edges: e, radiusType: 'variable', size: 1, endSize: 1, midSize: 3 }))).toBeGreaterThan(0)
    const top = vol(await run('edgeModAdv', { ...baseArgs, key: b.key, edges: e, rule: 'faceEdges', faces: [] }))
    expect(top).toBeLessThan(c)
    const all = vol(await run('edgeModAdv', { ...baseArgs, key: b.key, edges: e, rule: 'convex', size: 1 }))
    expect(all).toBeLessThan(top + 100)
    expect(all).toBeGreaterThan(0)
  })
  it('setback corner on three edges', async () => {
    const b = mkBox('b', 30, 30, 10)
    const e = edgeIdx(b, (m, d) => (Math.abs(d[0]) > 0.9 && Math.abs(m[1] + 15) < 1e-6 && m[2] > 9.9) || (Math.abs(d[1]) > 0.9 && Math.abs(m[0] + 15) < 1e-6 && m[2] > 9.9) || (Math.abs(d[2]) > 0.9 && Math.abs(m[0] + 15) < 1e-6 && Math.abs(m[1] + 15) < 1e-6))
    expect(e.length).toBe(3)
    const plain = vol(await run('edgeModAdv', { ...baseArgs, key: b.key, edges: e, size: 2 }))
    const sb = vol(await run('edgeModAdv', { ...baseArgs, key: b.key, edges: e, size: 2, setback: 4 }))
    expect(sb).toBeGreaterThan(0)
    expect(Math.abs(sb - plain)).toBeGreaterThan(1e-3)
  })
  it('chamfer: two distances and distance + angle', async () => {
    const b = mkBox('b', 30, 30, 10)
    const e = edgeIdx(b, (m, d) => Math.abs(m[1] + 15) < 1e-6 && m[2] > 9.9 && Math.abs(d[0]) > 0.9)
    const sharp = vol(b)
    const eq = vol(await run('edgeModAdv', { ...baseArgs, mode: 'chamfer', key: b.key, edges: e, size: 2 }))
    near(sharp - eq, 0.5 * 2 * 2 * 30, 1e-3)
    const two = vol(await run('edgeModAdv', { ...baseArgs, mode: 'chamfer', key: b.key, edges: e, size: 2, chamferType: 'twoDist', dist2: 4 }))
    near(sharp - two, 0.5 * 2 * 4 * 30, 1e-3)
    const da = vol(await run('edgeModAdv', { ...baseArgs, mode: 'chamfer', key: b.key, edges: e, size: 2, chamferType: 'distAngle', angle: 30 }))
    // distance 2 on one face and a 30 degree angle: the other leg is 2 * tan 30 or 2 / tan 30 (one of the two, depending on the face)
    const leg = [2 * Math.tan(Math.PI / 6), 2 / Math.tan(Math.PI / 6)].map((l) => 0.5 * 2 * l * 30)
    expect(leg.some((x) => Math.abs(sharp - da - x) / x < 0.01)).toBe(true)
    const flipped = vol(await run('edgeModAdv', { ...baseArgs, mode: 'chamfer', key: b.key, edges: e, size: 2, chamferType: 'twoDist', dist2: 4, flipFace: true }))
    expect(Math.abs(flipped - two)).toBeLessThan(1e-6)
  })
})

describe('shell with a thickness per face', () => {
  it('a thicker bottom', async () => {
    const b = mkBox('b', 40, 40, 20)
    const faces = topoOf(getBrep(b.key) as unknown as AnyShape).faces
    const top = faces.findIndex((f) => f.normalAt().z > 0.99), bottom = faces.findIndex((f) => f.normalAt().z < -0.99)
    const args = { id: 's', name: 's', key: b.key, faces: [top], thickness: 2, side: 'inside', fid: 'f' }
    near(vol(await run('shellAdv', { ...args, special: [] })), 40 * 40 * 20 - 36 * 36 * 18, 1e-3)
    near(vol(await run('shellAdv', { ...args, special: [{ index: bottom, thickness: 5 }] })), 40 * 40 * 20 - 36 * 36 * 15, 1e-3)
    near(vol(await run('shellAdv', { ...args, special: [{ index: bottom, thickness: 1 }] })), 40 * 40 * 20 - 36 * 36 * 19, 1e-3)
  })
})

describe('draft: parting line and step', () => {
  it('drafts both halves of a side wall about the parting line', async () => {
    const b = mkBox('b', 40, 40, 20)
    const faces = topoOf(getBrep(b.key) as unknown as AnyShape).faces
    const side = faces.findIndex((f) => f.normalAt().x > 0.99)
    const common = { id: 'd', name: 'd', key: b.key, faces: [side], dir: [0, 0, 1], line: [20, 0, 10], angle: 5, flip: false, fid: 'f' }
    const parting = await run('draftParting', { ...common, type: 'parting' })
    const step = await run('draftParting', { ...common, type: 'step' })
    const sharp = vol(b)
    // both halves tilt for the parting line, only the pull side for the step: they differ, and both change the part
    expect(Math.abs(vol(parting) - sharp)).toBeGreaterThan(1)
    expect(Math.abs(vol(step) - sharp)).toBeGreaterThan(1)
    expect(Math.abs(vol(step) - vol(parting))).toBeGreaterThan(1)
    expect(Math.abs(vol(parting) - sharp)).toBeGreaterThan(Math.abs(vol(step) - sharp) * 1.5)
  })
})

describe('transforms and scale', () => {
  it('free rigid transform keeps volume, scale about a point', async () => {
    const b = mkBox('b', 10, 20, 30)
    const R = [0, -1, 0, 1, 0, 0, 0, 0, 1]
    const m = await run('bodyXform', { id: 'm', name: 'm', key: b.key, xform: { t: 'rigid', R, p: [5, 5, 5] }, tag: 'c1' })
    near(vol(m), 6000, 1e-6)
    const u = await run('scaleBody', { id: 'u', name: 'u', key: b.key, factors: [2, 2, 2], centre: [0, 0, 0] })
    near(vol(u), 48000, 1e-6)
    const n = await run('scaleBody', { id: 'n', name: 'n', key: b.key, factors: [2, 1, 0.5], centre: [0, 0, 0] })
    near(bbox(n.mesh.positions).max[0], 10, 1e-6)
    near(bbox(n.mesh.positions).max[2], 15, 1e-6)
    expect(n.kind).toBe('mesh')
  })
})
