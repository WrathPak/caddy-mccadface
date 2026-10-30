/** Split (with connectors), hollow (with drain holes) and the export mesh, on real OpenCascade / manifold geometry. */
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCylinder, measureVolume, type AnyShape } from 'replicad'
import { box, initOcc } from './occ'
import { initManifold } from './mesh'
import { topoVolume } from './meshutil'
import { bodyFromShape, bodyFromTopo, getBrep, getOp, getTopo, helpers } from './store'
import { bbox, type Body, type TopoMesh, type Vec3 } from './types'
import './model-ops'
import './print-ops'
import type { ConnectorSpec, HollowArgs, SplitArgs, SplitResult } from './print-ops'

const run = async <T>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T
const vol = (b: Body) => (b.kind === 'brep' ? Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never)) : Math.abs(topoVolume(getTopo(b.key))))
const near = (a: number, b: number, rel = 1e-3) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))

beforeAll(async () => { await Promise.all([initOcc(), initManifold()]) })

const slab = () => bodyFromShape('b', 'Block', box([40, 30, 20], [0, 0, -10])) // centred on the origin
const meshOf = (b: Body): TopoMesh => getTopo(b.key)
const ids = (n = 8) => Array.from({ length: n }, (_, i) => (i ? `s.${i}` : 'b'))
const planeZ = (z: number) => ({ kind: 'plane' as const, origin: [0, 0, z] as Vec3, normal: [0, 0, 1] as Vec3 })
const split = (b: Body, cutter: SplitArgs['cutter'], connectors?: ConnectorSpec) =>
  run<SplitResult>('printSplit', { id: b.id, name: b.name, key: b.key, ids: ids(), cutter, connectors, fid: 's' } satisfies SplitArgs)
const spec = (p: Partial<ConnectorSpec>): ConnectorSpec => ({ type: 'round', count: 1, size: 6, depth: 6, clearance: 0.2, angle: 15, ...p })

describe('split', () => {
  it('cuts a B-rep with a plane into two bodies that add up to the original', async () => {
    const b = slab()
    const r = await split(b, planeZ(0))
    expect(r.bodies.map((x) => x.id)).toEqual(['b', 's.1'])
    expect(r.bodies.map((x) => x.name)).toEqual(['Block 1', 'Block 2'])
    expect(r.bodies.every((x) => x.kind === 'brep')).toBe(true)
    near(vol(r.bodies[0]), 12000)
    near(vol(r.bodies[1]), 12000)
    // part 1 is the positive side
    expect(bbox(r.bodies[0].mesh.positions).min[2]).toBeCloseTo(0, 4)
    expect(bbox(r.bodies[1].mesh.positions).max[2]).toBeCloseTo(0, 4)
    // the cut faces carry persistent names
    expect(r.bodies[0].mesh.faceNames!.length).toBe(r.bodies[0].mesh.faceCount)
  })

  it('rejects a plane that misses the body', async () => {
    await expect(split(slab(), planeZ(50))).rejects.toThrow(/does not go through/)
  })

  it('splits where the plane is far from the body in-plane (uses the nearest point)', async () => {
    const r = await split(slab(), { kind: 'plane', origin: [900, -400, 5], normal: [0, 0, 1] })
    near(vol(r.bodies[0]), 40 * 30 * 5)
    near(vol(r.bodies[1]), 40 * 30 * 15)
  })

  it('cuts with a sketch line (path) and keeps the left side first', async () => {
    const b = slab()
    // a line along +X at y = 5 in the XY plane: left is +Y
    const r = await split(b, { kind: 'path', points: [[-30, 5, 0], [30, 5, 0]], normal: [0, 0, 1] })
    near(vol(r.bodies[0]), 40 * 10 * 20)
    near(vol(r.bodies[1]), 40 * 20 * 20)
    expect(bbox(r.bodies[0].mesh.positions).min[1]).toBeCloseTo(5, 4)
  })

  it('cuts with a bent sketch line', async () => {
    const r = await split(slab(), { kind: 'path', points: [[-30, 0, 0], [0, 0, 0], [0, 25, 0]], normal: [0, 0, 1] })
    expect(r.bodies).toHaveLength(2)
    near(vol(r.bodies[0]) + vol(r.bodies[1]), 24000)
    expect(vol(r.bodies[0])).toBeGreaterThan(1000)
    expect(vol(r.bodies[1])).toBeGreaterThan(1000)
  })

  it('cuts with a closed sketch shape: inside and outside', async () => {
    const sq = (x0: number, y0: number, x1: number, y1: number) => [
      { k: 'l' as const, a: [x0, y0] as [number, number], b: [x1, y0] as [number, number] },
      { k: 'l' as const, a: [x1, y0] as [number, number], b: [x1, y1] as [number, number] },
      { k: 'l' as const, a: [x1, y1] as [number, number], b: [x0, y1] as [number, number] },
      { k: 'l' as const, a: [x0, y1] as [number, number], b: [x0, y0] as [number, number] },
    ]
    const r = await split(slab(), { kind: 'profiles', groups: [{ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, profiles: [{ outer: sq(-5, -5, 5, 5), holes: [] }] }] })
    near(vol(r.bodies[0]), 10 * 10 * 20)
    near(vol(r.bodies[1]), 24000 - 2000)
  })

  it('makes every disconnected piece its own body', async () => {
    // a cut that leaves two separate slabs on one side
    const b = slab()
    const prof = (x0: number, x1: number) => ({
      outer: [
        { k: 'l' as const, a: [x0, -40] as [number, number], b: [x1, -40] as [number, number] },
        { k: 'l' as const, a: [x1, -40] as [number, number], b: [x1, 40] as [number, number] },
        { k: 'l' as const, a: [x1, 40] as [number, number], b: [x0, 40] as [number, number] },
        { k: 'l' as const, a: [x0, 40] as [number, number], b: [x0, -40] as [number, number] },
      ], holes: [],
    })
    const r = await split(b, { kind: 'profiles', groups: [{ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, profiles: [prof(-15, -10), prof(10, 15)] }] })
    // two strips inside, plus the three blocks outside them
    expect(r.bodies.length).toBe(5)
    near(r.bodies.reduce((s, x) => s + vol(x), 0), 24000)
  })

  it('round pins: part 1 gains pins, part 2 gets slightly larger sockets', async () => {
    const r = await split(slab(), planeZ(0), spec({ type: 'round', count: 2, size: 6, depth: 6, clearance: 0.25 }))
    const pin = Math.PI * 9 * 6, hole = Math.PI * (3.25 * 3.25) * 6.25
    near(vol(r.bodies[0]), 12000 + 2 * pin, 5e-3)
    near(vol(r.bodies[1]), 12000 - 2 * hole, 5e-3)
    expect(bbox(r.bodies[0].mesh.positions).min[2]).toBeCloseTo(-6, 3)
  })

  it('square pins and clearance: the socket is bigger than the pin on every side', async () => {
    const r = await split(slab(), planeZ(0), spec({ type: 'square', count: 1, size: 8, depth: 5, clearance: 0.3 }))
    near(vol(r.bodies[0]), 12000 + 64 * 5, 5e-3)
    near(vol(r.bodies[1]), 12000 - 8.6 * 8.6 * 5.3, 5e-3)
  })

  it('dovetails run edge to edge and are trimmed to the body', async () => {
    const r = await split(slab(), planeZ(0), spec({ type: 'dovetail', count: 1, size: 6, depth: 5, clearance: 0.2, angle: 15 }))
    const tan = Math.tan((15 * Math.PI) / 180)
    const area = ((6 + 6 + 2 * 5 * tan) / 2) * 5 // trapezoid cross-section
    near(vol(r.bodies[0]), 12000 + area * 30, 0.01) // it slides along the section's Y (30 mm), edge to edge
    expect(vol(r.bodies[1])).toBeLessThan(12000 - area * 30)
  })

  it('reports when fewer connectors fit, and clamps a depth that would pierce the other part', async () => {
    const small = bodyFromShape('b', 'Small', box([14, 14, 10], [0, 0, -5]))
    const r = await split(small, planeZ(0), spec({ type: 'round', count: 4, size: 6, depth: 30 }))
    expect(r.warning).toMatch(/Only \d of 4 connectors fit/)
    expect(r.warning).toMatch(/depth reduced/)
    expect(bbox(r.bodies[0].mesh.positions).min[2]).toBeGreaterThan(-5)
  })

  it('refuses connectors on a curved cut', async () => {
    const sq = [
      { k: 'l' as const, a: [-5, -5] as [number, number], b: [5, -5] as [number, number] }, { k: 'l' as const, a: [5, -5] as [number, number], b: [5, 5] as [number, number] },
      { k: 'l' as const, a: [5, 5] as [number, number], b: [-5, 5] as [number, number] }, { k: 'l' as const, a: [-5, 5] as [number, number], b: [-5, -5] as [number, number] },
    ]
    await expect(split(slab(), { kind: 'profiles', groups: [{ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, profiles: [{ outer: sq, holes: [] }] }] }, spec({}))).rejects.toThrow(/flat cut/)
  })

  it('reports where the first connector stands, for the drag handles', async () => {
    const round = (await split(slab(), planeZ(0), spec({ type: 'round', count: 1 }))).connector!
    expect(round.origin[2]).toBeCloseTo(0, 4)
    // it goes down into the part behind the cut (the normal points from that part towards the other one), size measured across the cut
    expect(Math.abs(round.down[2])).toBeCloseTo(1, 4)
    expect(Math.abs(round.across[2])).toBeLessThan(1e-6)
    expect(round.flare).toBeUndefined()
    const tail = (await split(slab(), planeZ(0), spec({ type: 'dovetail', count: 1 }))).connector!
    expect(tail.flare).toBeDefined()
    // the flare turns about the line the dovetail runs along, which lies in the cut plane and across `across`
    expect(Math.abs(tail.flare!.axis[2])).toBeLessThan(1e-6)
    expect(Math.abs(tail.flare!.axis[0] * tail.across[0] + tail.flare!.axis[1] * tail.across[1])).toBeLessThan(1e-6)
    expect((await split(slab(), planeZ(0))).connector).toBeUndefined()
  })

  it('splits a mesh body (manifold) and adds connectors to it', async () => {
    const b = bodyFromTopo('m', 'Mesh', meshOf(slab()))
    const r = await run<SplitResult>('printSplit', { id: 'm', name: 'Mesh', key: b.key, ids: ids(), cutter: planeZ(0), connectors: spec({ type: 'round', count: 1, size: 6, depth: 5, clearance: 0.25 }), fid: 's' } satisfies SplitArgs)
    expect(r.bodies.every((x) => x.kind === 'mesh')).toBe(true)
    const pin = Math.PI * 9 * 5, hole = Math.PI * 3.25 * 3.25 * 5.25
    near(vol(r.bodies[0]), 12000 + pin, 0.01)
    near(vol(r.bodies[1]), 12000 - hole, 0.01)
  })
})

describe('hollow', () => {
  const args = (b: Body, p: Partial<HollowArgs> = {}): HollowArgs => ({ id: b.id, name: b.name, key: b.key, thickness: 2, drains: [], diameter: 3, fid: 'h', ...p })

  it('hollows a B-rep into a closed shell of the wall thickness', async () => {
    const b = slab()
    const h = await run<Body>('printHollow', args(b))
    near(vol(h), 24000 - 36 * 26 * 16, 5e-3)
    expect(h.kind).toBe('brep')
    // an inner skin exists: twice the faces
    expect(h.mesh.faceCount).toBe(12)
  })

  it('drain holes pierce the wall and open the cavity', async () => {
    const b = slab()
    const closed = await run<Body>('printHollow', args(b))
    const open = await run<Body>('printHollow', args(b, { drains: [{ p: [0, 0, 10], n: [0, 0, 1] }, { p: [20, 5, 0], n: [1, 0, 0] }], diameter: 4 }))
    const removed = vol(closed) - vol(open)
    // each hole removes a 4 mm cylinder through the 2 mm wall (cavity side is empty)
    near(removed, 2 * Math.PI * 4 * 2, 0.02)
    // the topology gained the hole walls
    expect(open.mesh.faceCount!).toBeGreaterThan(closed.mesh.faceCount!)
  })

  it('rejects a wall that leaves no cavity', async () => {
    await expect(run('printHollow', args(slab(), { thickness: 11 }))).rejects.toThrow(/thinner than half/)
  })

  it('hollows a mesh body through manifold, drains included', async () => {
    const b = bodyFromTopo('m', 'Mesh', meshOf(slab()))
    const h = await run<Body>('printHollow', args(b, { drains: [{ p: [0, 0, 10], n: [0, 0, 1] }], diameter: 4 }))
    expect(h.kind).toBe('mesh')
    near(vol(h), 24000 - 36 * 26 * 16 - Math.PI * 4 * 2, 0.03)
  })

  it('hollows a curved body (cylinder)', async () => {
    const c = bodyFromShape('c', 'Cyl', makeCylinder(15, 30) as never)
    const h = await run<Body>('printHollow', args(c, { thickness: 1.5 }))
    near(vol(h), Math.PI * 15 * 15 * 30 - Math.PI * 13.5 * 13.5 * 27, 0.01)
  })
})

describe('printMeshes', () => {
  it('returns a welded mesh with a face id per triangle for B-reps and mesh bodies', async () => {
    const b = slab()
    const m = bodyFromTopo('m', 'Mesh', meshOf(b))
    const [a, c] = await run<{ positions: Float32Array; indices: Uint32Array; faceIds: Uint32Array }[]>('printMeshes', { keys: [b.key, m.key] })
    expect(a.faceIds.length).toBe(a.indices.length / 3)
    expect(new Set(a.faceIds).size).toBe(6)
    expect(new Set(c.faceIds).size).toBe(6)
    // welded: a box has 8 vertices
    expect(a.positions.length / 3).toBe(8)
  })
})
