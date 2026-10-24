import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeBaseBox, makeCylinder, measureVolume, type AnyShape } from 'replicad'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import { weld } from './meshutil'
import { initManifold } from './mesh'
import { initOcc, tessellate, topoOf, type Shape } from './occ'
import { bodyFromShape, getBrep, getOp, helpers } from './store'
import { ISO_SIZES, boreRadius, checkProfile, coreRadius, isoProfile, nearestIso, rootFlat, sectionOf } from './threads'
import type { Body } from './types'
import './model-ops'
import './solid-ops'
import './detail-ops'
import type { ThreadOpArgs } from './detail-ops'

let W: ManifoldToplevel
const owned: Manifold[] = []
const own = (m: Manifold) => (owned.push(m), m)
beforeAll(async () => { await initOcc(); W = await initManifold() })
afterAll(() => { for (const m of owned) m.delete() })

const run = async (name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as Body
const vol = (b: Body) => Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never))
const cylFace = (b: Body) => topoOf(getBrep(b.key)).faces.findIndex((f) => f.geomType === 'CYLINDRE')

/** A manifold from a fine tessellation of a B-rep body. */
function manifoldOf(b: Body): Manifold {
  const m = tessellate(getBrep(b.key), 0.004, 0.08)
  const w = weld(m.positions, m.indices)
  return own(W.Manifold.ofMesh(new W.Mesh({ numProp: 3, vertProperties: w.positions, triVerts: w.indices })))
}

const M8 = isoProfile(1.25)
const args = (b: Body, over: Partial<ThreadOpArgs> = {}): ThreadOpArgs => ({
  id: b.id, name: b.name, key: b.key, face: cylFace(b), kind: 'auto', profile: M8, clearance: 0.2, length: 0, fromEnd: 'start', leftHand: false, ...over,
})

async function bolt(height = 20) {
  return run('cylinderTool', { id: 'bolt', name: 'Bolt', radius: 4, height, origin: [0, 0, 0], dir: [0, 0, 1] })
}
async function nut(z = 6, height = 8) {
  // makeBaseBox is centred on the axis in x and y
  const block = (makeBaseBox(14, 14, height) as unknown as Shape).translate(0, 0, z) as unknown as Shape
  const hole = makeCylinder(4, height, [0, 0, z], [0, 0, 1])
  return bodyFromShape('nut', 'Nut', block.cut(hole as unknown as AnyShape) as unknown as Shape)
}

/** Threads take seconds each: build every variant once and share it between the tests. */
const memo = new Map<string, Promise<Body>>()
const once = (key: string, make: () => Promise<Body>) => {
  let p = memo.get(key)
  if (!p) memo.set(key, (p = make()))
  return p
}
const M8Bolt = () => once('bolt', async () => run('threadFace', args(await bolt())))
const NUT_Z = 6.25
const M8Nut = () => once('nut', async () => run('threadFace', args(await nut(NUT_Z, 8))))

describe('ISO profile', () => {
  it('has the basic metric proportions', () => {
    const p = isoProfile(1.25)
    expect(p.angle).toBe(60)
    expect(p.depth).toBeCloseTo(0.5413 * 1.25, 3)
    expect(p.crest).toBeCloseTo(1.25 / 8, 6)
    // the tooth is three quarters of the pitch wide at its root, so the groove between teeth is a quarter
    expect(rootFlat(p)).toBeCloseTo(0.75 * 1.25, 3)
  })
  it('finds the nearest standard size', () => {
    expect(nearestIso(8.02).size.d).toBe(8)
    expect(nearestIso(8.02).size.coarse).toBe(1.25)
    expect(nearestIso(10.6).off).toBeCloseTo(0.6, 6)
    expect(ISO_SIZES.every((s) => s.fine < s.coarse)).toBe(true)
  })
  it('refuses profiles that cannot be cut', () => {
    expect(checkProfile({ pitch: 1, angle: 60, depth: 0.5, crest: 0.1 })).toBeNull()
    expect(checkProfile({ pitch: 1, angle: 60, depth: 2, crest: 0.1 })).toMatch(/wider than its pitch/)
    expect(checkProfile({ pitch: 0.05, angle: 60, depth: 0.02, crest: 0.01 })).toMatch(/pitch/)
  })
  it('the clearance slims the bolt tooth, widens the nut groove and lowers the bolt crest', () => {
    const base = { radius: 4, profile: M8, length: 10, leftHand: false } as const
    const toothWidth = (pts: [number, number][]) => Math.abs(pts[pts.length - 2][1] - pts[1][1])
    const tight = sectionOf({ ...base, kind: 'external', clearance: 0 }), loose = sectionOf({ ...base, kind: 'external', clearance: 0.2 })
    expect(toothWidth(loose)).toBeLessThan(toothWidth(tight))
    expect(Math.max(...loose.map((p) => p[0]))).toBeCloseTo(4 - 0.1, 6)
    expect(Math.max(...tight.map((p) => p[0]))).toBeCloseTo(4, 6)
    expect(coreRadius({ ...base, kind: 'external', clearance: 0.2 })).toBeLessThan(coreRadius({ ...base, kind: 'external', clearance: 0 }))
    // the groove of the nut is wider at its root and sits deeper in the wall
    const rootWidth = (pts: [number, number][]) => Math.abs(pts[pts.length - 1][1] - pts[0][1])
    const nutTight = sectionOf({ ...base, kind: 'internal', clearance: 0 }), nutLoose = sectionOf({ ...base, kind: 'internal', clearance: 0.2 })
    expect(rootWidth(nutLoose)).toBeGreaterThan(rootWidth(nutTight))
    expect(nutLoose[0][0]).toBeCloseTo(nutTight[0][0] + 0.1, 6)
    expect(boreRadius({ ...base, kind: 'internal', clearance: 0.2 })).toBeGreaterThan(boreRadius({ ...base, kind: 'internal', clearance: 0 }))
  })
})

describe('external thread', () => {
  it('turns the shaft down and grows a helical tooth: one valid solid with the right size', async () => {
    const b = await bolt()
    const t = await M8Bolt()
    const m = manifoldOf(t)
    expect(m.status()).toBe('NoError')
    expect(m.decompose().length).toBe(1)
    expect(m.genus()).toBe(0)
    expect(vol(t)).toBeLessThan(vol(b) * 0.97)
    expect(vol(t)).toBeGreaterThan(vol(b) * 0.6)
    // the crest is the nominal radius less half the clearance
    const bb = m.boundingBox()
    expect(bb.max[0]).toBeLessThanOrEqual(3.9 + 0.003)
    expect(bb.max[0]).toBeGreaterThan(3.85)
    expect(bb.min[2]).toBeCloseTo(0, 3)
    expect(bb.max[2]).toBeCloseTo(20, 3)
  })
  it('is parametric: the result is a B-rep with named faces', async () => {
    const t = await M8Bolt()
    expect(t.kind).toBe('brep')
    expect(t.mesh.faceNames!.length).toBe(t.mesh.faceCount)
    expect(new Set(t.mesh.faceNames!.map((n) => n[0])).size).toBe(t.mesh.faceNames!.length)
  })
  it('a coarse pitch is deeper than a fine one, and a deeper tooth leaves a thinner core', async () => {
    const b = await bolt(8)
    const fine = vol(await run('threadFace', args(b, { profile: isoProfile(0.75) })))
    const coarse = vol(await run('threadFace', args(b, { profile: isoProfile(1.25) })))
    expect(coarse).toBeLessThan(fine)
    const shallow = vol(await run('threadFace', args(b, { profile: { pitch: 1.5, angle: 60, depth: 0.3, crest: 0.2 } })))
    const deep = vol(await run('threadFace', args(b, { profile: { pitch: 1.5, angle: 60, depth: 0.6, crest: 0.2 } })))
    expect(deep).toBeLessThan(shallow)
  })
  it('a partial thread leaves the rest of the shaft round', async () => {
    const b = await bolt(16)
    const m = manifoldOf(await run('threadFace', args(b, { length: 6, fromEnd: 'end' })))
    expect(m.status()).toBe('NoError')
    // the thread runs 6 mm from the far end: below z = 10 the shaft is untouched
    const lower = own(m.trimByPlane([0, 0, -1], -9.5))
    expect(lower.volume()).toBeCloseTo(Math.PI * 16 * 9.5, 0)
    // and the threaded part is lighter than a plain cylinder
    const upper = own(m.trimByPlane([0, 0, 1], 10.5))
    expect(upper.volume()).toBeLessThan(Math.PI * 16 * 5.5 * 0.97)
  })
  it('left hand threads are the mirror image of right hand ones', async () => {
    const b = await bolt(8)
    const r = manifoldOf(await run('threadFace', args(b, { leftHand: false })))
    const l = manifoldOf(await run('threadFace', args(b, { leftHand: true })))
    expect(Math.abs(r.volume() - l.volume())).toBeLessThan(r.volume() * 0.005)
    // only the teeth tell them apart (the core is round): look at the shell between the root and the crest
    const shell = own(W.Manifold.cylinder(8, 3.95, 3.95, 96).subtract(own(W.Manifold.cylinder(8, 3.3, 3.3, 96))))
    const teeth = (m: Manifold) => own(W.Manifold.intersection(m, shell))
    const lt = teeth(l), rt = teeth(r)
    // reflecting a right hand thread in a plane through its axis gives a left hand one
    const mirrored = own(W.Manifold.intersection(own(rt.mirror([0, 1, 0])), lt)).volume() / lt.volume()
    // while the right hand thread itself only overlaps the left hand one where the helices cross
    const straight = own(W.Manifold.intersection(rt, lt)).volume() / lt.volume()
    expect(mirrored).toBeGreaterThan(0.95)
    expect(straight).toBeLessThan(mirrored - 0.1)
  })
  it('refuses a flat face and a type that does not match the face', async () => {
    const b = await bolt(8)
    const flat = topoOf(getBrep(b.key)).faces.findIndex((f) => f.geomType === 'PLANE')
    await expect(Promise.resolve().then(() => run('threadFace', args(b, { face: flat })))).rejects.toThrow(/cylindrical face/)
    await expect(Promise.resolve().then(() => run('threadFace', args(b, { kind: 'internal' })))).rejects.toThrow(/shaft/)
  })
})

describe('internal thread', () => {
  it('opens the hole by the clearance and fuses a helical ridge into the wall', async () => {
    const t = await M8Nut()
    const m = manifoldOf(t)
    expect(m.status()).toBe('NoError')
    expect(m.decompose().length).toBe(1)
    expect(m.genus()).toBe(1)
    // the crests of the ridges stay outside the minor radius, and the ridges really stand in the hole
    const axisClear = own(W.Manifold.cylinder(8, 3.35, 3.35, 96).translate(0, 0, NUT_Z))
    expect(own(W.Manifold.intersection(m, axisClear)).volume()).toBeLessThan(1e-6)
    const insideNominal = own(W.Manifold.cylinder(8, 4, 4, 96).translate(0, 0, NUT_Z))
    expect(own(W.Manifold.intersection(m, insideNominal)).volume()).toBeGreaterThan(20)
  })
  it('refuses a hole being given an external thread', async () => {
    const n = await nut()
    await expect(Promise.resolve().then(() => run('threadFace', args(n, { kind: 'external' })))).rejects.toThrow(/hole/)
  })
})

describe('bolt and nut fit', () => {
  /** A real nut is screwed on: turn it about the axis until it meshes with the bolt (the overlap volume vanishes). */
  function engage(bm: Manifold, nm: Manifold): { nut: Manifold; angle: number; overlaps: number[] } {
    const overlaps: number[] = []
    let best = { v: Infinity, a: 0 }
    for (let a = 0; a < 360; a += 10) {
      const v = own(W.Manifold.intersection(bm, own(nm.rotate([0, 0, a])))).volume()
      overlaps.push(v)
      if (v < best.v) best = { v, a }
    }
    // the middle of the run of free angles is the most relaxed position
    const free = overlaps.map((v) => v < 1e-9)
    let mid = best.a
    const n = overlaps.length
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue
      let len = 0
      while (free[(i + len) % n] && len < n) len++
      if (len >= n) break
      if (!free[(i + n - 1) % n]) { mid = ((i + Math.floor(len / 2)) % n) * 10; break }
    }
    return { nut: own(nm.rotate([0, 0, mid])), angle: mid, overlaps }
  }

  it('an M8 bolt and a nut made with the default clearance mesh without touching anywhere', async () => {
    const bm = manifoldOf(await M8Bolt()), nm = manifoldOf(await M8Nut())
    const { nut, overlaps } = engage(bm, nm)
    const x = own(W.Manifold.intersection(bm, nut))
    expect(x.isEmpty()).toBe(true)
    expect(x.volume()).toBe(0)
    // a wide range of turn angles is free (the play of the clearance), and the opposite phase jams
    expect(overlaps.filter((v) => v < 1e-9).length).toBeGreaterThan(6)
    expect(Math.max(...overlaps)).toBeGreaterThan(1)
    // they really are engaged: the nut surrounds the threaded part of the shaft, ridges standing in the grooves
    expect(nut.boundingBox().min[2]).toBeCloseTo(NUT_Z, 3)
    expect(bm.boundingBox().max[2]).toBeGreaterThan(nut.boundingBox().max[2])
    const both = own(W.Manifold.union(bm, nut))
    expect(both.volume()).toBeCloseTo(bm.volume() + nut.volume(), 3)
  })
  it('the nut turns freely: screwing it along the thread never makes it touch the bolt', async () => {
    const bm = manifoldOf(await M8Bolt()), nm = manifoldOf(await M8Nut())
    const { angle } = engage(bm, nm)
    for (const turn of [30, 90, 200, 330]) {
      // a right hand nut that turns by `turn` degrees about the axis advances by pitch * turn / 360
      const moved = own(own(nm.rotate([0, 0, angle + turn])).translate([0, 0, (1.25 * turn) / 360]))
      expect(own(W.Manifold.intersection(bm, moved)).volume()).toBeLessThan(1e-6)
    }
    // the same turn without advancing runs the ridges into the teeth
    const jammed = own(nm.rotate([0, 0, angle + 180]))
    expect(own(W.Manifold.intersection(bm, jammed)).volume()).toBeGreaterThan(1)
  })
  it('the gap between the threads is the clearance and grows with it', async () => {
    const bm = manifoldOf(await M8Bolt()), nm = manifoldOf(await M8Nut())
    const gap = bm.minGap(engage(bm, nm).nut, 2)
    // the default clearance is 0.2, half from each part: the closest approach is about 0.1
    expect(gap).toBeGreaterThan(0.08)
    expect(gap).toBeLessThan(0.25)
    const b = manifoldOf(await run('threadFace', args(await bolt(12), { clearance: 0.4 })))
    const n = manifoldOf(await run('threadFace', args(await nut(NUT_Z - 4, 8), { clearance: 0.4 })))
    expect(b.minGap(engage(b, n).nut, 2)).toBeGreaterThan(gap + 0.06)
  })
  it('more clearance means a lighter bolt', async () => {
    const b = await bolt(8)
    const tight = vol(await run('threadFace', args(b, { clearance: 0 })))
    const loose = vol(await run('threadFace', args(b, { clearance: 0.4 })))
    expect(loose).toBeLessThan(tight)
  })
})