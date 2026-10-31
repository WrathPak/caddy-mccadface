/** Real OpenCascade in Node: patterns, mirror, holes and the direct face edits. */
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCylinder, measureVolume, type AnyShape } from 'replicad'
import { box, initOcc, topoOf, type Shape } from './occ'
import { bodyFromShape, getBrep, getNamed, getOp, helpers } from './store'
import { boolNamed, boxNames, type NShape } from './naming'
import { computeFaceSigs, type Body } from './types'
import { translation, rotationAbout, type Xf } from './xform'
import './model-ops'
import './modeling-ops'

beforeAll(async () => { await initOcc() })

const run = async <T = Body>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T
const vol = (b: Body) => Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never))
const near = (a: number, b: number, rel = 2e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
const mkBox = (id: string, size: [number, number, number], pos: [number, number, number] = [0, 0, 0]): Body => {
  const b = box(size, pos)
  return helpers.sendBody(bodyFromShape(id, id, b, boxNames(b, id))) as unknown as Body
}
/** The face index with the given outward normal whose centre is closest to p. */
function faceAt(b: Body, n: [number, number, number], p: [number, number, number]) {
  const sigs = computeFaceSigs(b.mesh)
  let best = -1, bd = Infinity
  sigs.forEach((s, i) => {
    if (s.normal[0] * n[0] + s.normal[1] * n[1] + s.normal[2] * n[2] < 0.99) return
    const d = Math.hypot(s.centroid[0] - p[0], s.centroid[1] - p[1], s.centroid[2] - p[2])
    if (d < bd) { bd = d; best = i }
  })
  return best
}
const nameOfFace = (b: Body, i: number) => b.mesh.faceNames![i]
const ref = (b: Body, i: number) => ({ index: i, names: nameOfFace(b, i) })
const named = (b: Body): NShape => getNamed(b.key)
const cylTool = (r: number, h: number, at: [number, number, number]): NShape => {
  const s = makeCylinder(r, h, at, [0, 0, 1]) as unknown as Shape
  return { shape: s, faces: topoOf(s as unknown as AnyShape).faces.map(() => []) }
}
const cutWith = (b: Body, tool: NShape, id = 'c'): Body => {
  const r = boolNamed('cut', named(b), tool, id)
  return helpers.sendBody(bodyFromShape(b.id, b.name, r.shape, r.faces)) as unknown as Body
}
const fuseWith = (b: Body, tool: NShape, id = 'u'): Body => {
  const r = boolNamed('fuse', named(b), tool, id)
  return helpers.sendBody(bodyFromShape(b.id, b.name, r.shape, r.faces)) as unknown as Body
}
const bbox = (b: Body) => {
  const p = b.mesh.positions
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]) }
  return { min, max }
}

describe('xform math', () => {
  it('rotationAbout and translation compose to a rigid map', () => {
    const r = rotationAbout([10, 0, 0], [0, 0, 1], 90) as Extract<Xf, { t: 'rigid' }>
    // (20,0,0) is 10 from the axis: a quarter turn takes it to (10,10,0)
    const x = r.R[0] * 20 + r.R[1] * 0 + r.p[0], y = r.R[3] * 20 + r.R[4] * 0 + r.p[1]
    expect(x).toBeCloseTo(10, 9)
    expect(y).toBeCloseTo(10, 9)
  })
})

describe('patterns', () => {
  it('repeats a cut feature (before / after) at each instance', async () => {
    const before = mkBox('b', [60, 20, 10])
    const holeAt = (x: number) => cylTool(2, 30, [x, 0, -5])
    const after = cutWith(before, holeAt(-20))
    const xf: Xf[] = [translation([20, 0, 0]), translation([40, 0, 0])]
    const r = await run('patternApply', { id: 'b', name: 'b', fid: 'f9', current: after.key, before: before.key, after: after.key, xforms: xf })
    near(vol(r), 60 * 20 * 10 - 3 * Math.PI * 4 * 10, 3e-3)
    // names of the original box faces survive the pattern
    expect(r.mesh.faceNames!.flat().some((n) => n.includes('b:zmax'))).toBe(true)
  })

  it('repeats an added feature (a boss) and keeps the material of the original', async () => {
    const base = mkBox('b', [60, 20, 10])
    const withBoss = fuseWith(base, { shape: makeCylinder(3, 5, [-20, 0, 10], [0, 0, 1]) as unknown as Shape, faces: [] })
    const nFaces = topoOf(getBrep(withBoss.key) as unknown as AnyShape).faces.length
    const xf: Xf[] = [translation([20, 0, 0]), translation([40, 0, 0])]
    const r = await run('patternApply', { id: 'b', name: 'b', fid: 'f9', current: withBoss.key, before: base.key, after: withBoss.key, xforms: xf })
    near(vol(r), 60 * 20 * 10 + 3 * Math.PI * 9 * 5, 3e-3)
    expect(topoOf(getBrep(r.key) as unknown as AnyShape).faces.length).toBe(nFaces + 4)
  })

  it('repeats a feature given as faces (the boss walls and top)', async () => {
    const base = mkBox('b', [60, 20, 10])
    const withBoss = fuseWith(base, { shape: makeCylinder(3, 5, [-20, 0, 10], [0, 0, 1]) as unknown as Shape, faces: [] })
    const sigs = computeFaceSigs(withBoss.mesh)
    const bossFaces = sigs.map((s, i) => ({ s, i })).filter(({ s }) => s.centroid[2] > 10.01).map(({ i }) => i)
    expect(bossFaces.length).toBe(2)
    const xf: Xf[] = [translation([20, 0, 0])]
    const r = await run('patternApply', { id: 'b', name: 'b', fid: 'f9', current: withBoss.key, faces: bossFaces, xforms: xf })
    near(vol(r), 60 * 20 * 10 + 2 * Math.PI * 9 * 5, 3e-3)
  })

  it('refuses a selection that changes nothing', async () => {
    const b = mkBox('b', [10, 10, 10])
    await expect(run('patternApply', { id: 'b', name: 'b', fid: 'f9', current: b.key, before: b.key, after: b.key, xforms: [translation([20, 0, 0])] })).rejects.toThrow(/nothing to repeat/)
  })

  it('copies a body rotated, with distinct names', async () => {
    const b = mkBox('b', [10, 10, 10])
    const c = await run('copyBody', { id: 'b.1', name: 'b copy', key: b.key, xform: rotationAbout([0, 0, 0], [0, 0, 1], 90), tag: 'f9.1' })
    near(vol(c), 1000)
    expect(c.mesh.faceNames!.every((n) => n[0].endsWith('@f9.1'))).toBe(true)
  })
})

describe('mirror', () => {
  it('mirrors a cut feature across a plane', async () => {
    const before = mkBox('b', [60, 20, 10])
    const after = cutWith(before, cylTool(2, 30, [-20, 0, -5]))
    const mir: Xf = { t: 'mirror', origin: [0, 0, 0], normal: [1, 0, 0] }
    const r = await run('patternApply', { id: 'b', name: 'b', fid: 'f9', current: after.key, before: before.key, after: after.key, xforms: [mir] })
    near(vol(r), 60 * 20 * 10 - 2 * Math.PI * 4 * 10, 3e-3)
    // the mirrored hole sits at +20
    const bb = bbox(r)
    expect(bb.min[0]).toBeCloseTo(-30, 3)
  })

  it('mirrors a body across a plane (distinct body, mirrored position)', async () => {
    const b = mkBox('b', [10, 10, 10], [20, 0, 0])
    const c = await run('copyBody', { id: 'b.1', name: 'm', key: b.key, xform: { t: 'mirror', origin: [0, 0, 0], normal: [1, 0, 0] }, tag: 'f9.1' })
    near(vol(c), 1000)
    const bb = bbox(c)
    expect(bb.min[0]).toBeCloseTo(-25, 3)
    expect(bb.max[0]).toBeCloseTo(-15, 3)
  })

  it('joins bodies', async () => {
    const a = mkBox('a', [10, 10, 10])
    const b = mkBox('b', [10, 10, 10], [5, 0, 0])
    const j = await run('joinBodies', { id: 'a', name: 'a', keys: [a.key, b.key], fid: 'f9' })
    near(vol(j), 1500)
  })
})

describe('holes', () => {
  const top = (b: Body) => faceAt(b, [0, 0, 1], [0, 0, 10])
  const spec = (over: object) => ({ kind: 'simple', dia: 6, depth: 5, tip: 0, ...over })
  const place = (k: string, x: number, y: number) => ({ k, origin: [x, y, 10] as [number, number, number], dir: [0, 0, 1] as [number, number, number] })

  it('simple blind hole with a flat bottom', async () => {
    const b = mkBox('b', [40, 40, 10])
    const r = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [place('a', 0, 0)], spec: spec({}), fid: 'f2' })
    near(vol(r), 16000 - Math.PI * 9 * 5)
    expect(top(r)).toBeGreaterThanOrEqual(0)
    const names = r.mesh.faceNames!.map((n) => n[0])
    expect(names).toContain('f2:holea:wall')
    expect(names).toContain('f2:holea:floor')
  })

  it('blind hole with a 118 degree drill point', async () => {
    const b = mkBox('b', [40, 40, 10])
    const r = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [place('a', 0, 0)], spec: spec({ tip: 118 }), fid: 'f2' })
    const tipH = 3 / Math.tan((118 / 2) * Math.PI / 180)
    near(vol(r), 16000 - (Math.PI * 9 * 5 + (Math.PI * 9 * tipH) / 3), 3e-3)
    expect(r.mesh.faceNames!.map((n) => n[0])).toContain('f2:holea:tip')
  })

  it('through-all hole goes right through, several at once', async () => {
    const b = mkBox('b', [40, 40, 10])
    const r = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [place('a', -10, 0), place('b', 10, 0)], spec: spec({ depth: null }), fid: 'f2' })
    near(vol(r), 16000 - 2 * Math.PI * 9 * 10)
  })

  it('the preview of a through-all drill is the material it removes: inside the body, nothing sticking out of either side', async () => {
    const b = mkBox('b', [40, 40, 10])
    const r = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [place('a', -10, 0), place('b', 10, 0)], spec: spec({ depth: null }), fid: 'f2', toolOnly: true })
    const bb = bbox(r)
    expect(bb.min[2]).toBeGreaterThan(-1e-6)
    expect(bb.max[2]).toBeLessThan(10 + 1e-6)
    near(vol(r), 2 * Math.PI * 9 * 10)
  })

  it('counterbore', async () => {
    const b = mkBox('b', [40, 40, 10])
    const r = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [place('a', 0, 0)], spec: spec({ kind: 'cbore', cbDia: 10, cbDepth: 3, depth: null }), fid: 'f2' })
    near(vol(r), 16000 - (Math.PI * 25 * 3 + Math.PI * 9 * 7))
    expect(r.mesh.faceNames!.map((n) => n[0])).toContain('f2:holea:cbfloor')
  })

  it('countersink with a 90 degree angle', async () => {
    const b = mkBox('b', [40, 40, 10])
    const r = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [place('a', 0, 0)], spec: spec({ kind: 'csink', cskDia: 10, cskAngle: 90, depth: null }), fid: 'f2' })
    const h = 2
    const cone = (Math.PI * h / 3) * (25 + 9 + 15)
    near(vol(r), 16000 - (cone + Math.PI * 9 * (10 - h)), 3e-3)
  })

  it('holes in a side face use the face normal as the direction', async () => {
    const b = mkBox('b', [40, 40, 10])
    const r = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [{ k: 'a', origin: [20, 0, 5], dir: [1, 0, 0] }], spec: spec({ depth: 8 }), fid: 'f2' })
    near(vol(r), 16000 - Math.PI * 9 * 8)
  })

  it('rejects a counterbore that is not wider than the hole', async () => {
    const b = mkBox('b', [40, 40, 10])
    await expect(run('holes', { id: 'b', name: 'b', key: b.key, holes: [place('a', 0, 0)], spec: spec({ kind: 'cbore', cbDia: 5, cbDepth: 2 }), fid: 'f2' })).rejects.toThrow(/wider/)
  })

  it('a modeled thread cuts the grooves of an M6 internal thread', async () => {
    const b = mkBox('b', [30, 30, 12])
    const minor = 6 - 1.0825 * 1
    const r = await run('holes', {
      id: 'b', name: 'b', key: b.key, holes: [{ k: 'a', origin: [0, 0, 12], dir: [0, 0, 1] }],
      spec: { kind: 'simple', dia: minor, depth: 10, tip: 0, thread: { pitch: 1, major: 6, length: 8 } }, fid: 'f3',
    })
    const plain = 30 * 30 * 12 - Math.PI * (minor / 2) ** 2 * 10
    const removed = plain - vol(r)
    // the thread removes material between the minor and major cylinders over 8 mm: about half of that ring
    const ring = Math.PI * (9 - (minor / 2) ** 2) * 8
    expect(removed).toBeGreaterThan(ring * 0.25)
    expect(removed).toBeLessThan(ring * 0.75)
  }, 120000)
})

describe('direct face edits', () => {
  it('delete face (heal) removes a fillet and returns the sharp corner', async () => {
    const b = mkBox('b', [20, 20, 10])
    const sigs0 = computeFaceSigs(b.mesh)
    void sigs0
    // fillet the top-front edge
    const edges = topoOf(getBrep(b.key) as unknown as AnyShape).edges
    const idx = edges.findIndex((e) => { const m = e.pointAt(0.5); return Math.abs(m.y + 10) < 1e-6 && Math.abs(m.z - 10) < 1e-6 })
    const filleted = await run('edgeMod', { id: 'b', name: 'b', key: b.key, edges: [idx], size: 2, mode: 'fillet', fid: 'f4' })
    expect(vol(filleted)).toBeLessThan(4000 - 1)
    const fi = filleted.mesh.faceNames!.findIndex((n) => n[0].startsWith('f4:fillet'))
    expect(fi).toBeGreaterThanOrEqual(0)
    const r = await run('deleteFaces', { id: 'b', name: 'b', key: filleted.key, faces: [ref(filleted, fi)], fid: 'f5' })
    near(vol(r), 4000)
    expect(topoOf(getBrep(r.key) as unknown as AnyShape).faces.length).toBe(6)
  })

  it('delete face (heal) fills a hole and removes a boss', async () => {
    const b = mkBox('b', [30, 30, 10])
    const holed = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [{ k: 'a', origin: [0, 0, 10], dir: [0, 0, 1] }], spec: { kind: 'simple', dia: 6, depth: 4, tip: 0 }, fid: 'f2' })
    const sigs = computeFaceSigs(holed.mesh)
    const hole = sigs.map((s, i) => ({ s, i })).filter(({ s }) => s.centroid[2] > 5.5 && s.centroid[2] < 9.9).map(({ i }) => i)
    const hole2 = [...hole, faceAt(holed, [0, 0, 1], [0, 0, 6])]
    const healed = await run('deleteFaces', { id: 'b', name: 'b', key: holed.key, faces: [...new Set(hole2)].map((i) => ref(holed, i)), fid: 'f6' })
    near(vol(healed), 9000)
    // a boss
    const boss = fuseWith(b, { shape: makeCylinder(4, 6, [0, 0, 10], [0, 0, 1]) as unknown as Shape, faces: [] })
    const bs = computeFaceSigs(boss.mesh)
    const bossFaces = bs.map((s, i) => ({ s, i })).filter(({ s }) => s.centroid[2] > 10.01).map(({ i }) => i)
    const gone = await run('deleteFaces', { id: 'b', name: 'b', key: boss.key, faces: bossFaces.map((i) => ref(boss, i)), fid: 'f6' })
    near(vol(gone), 9000)
  })

  it('refuses to delete a face that cannot be healed', async () => {
    const b = mkBox('b', [20, 20, 10])
    const f = faceAt(b, [0, 0, 1], [0, 0, 10])
    await expect(run('deleteFaces', { id: 'b', name: 'b', key: b.key, faces: [ref(b, f)], fid: 'f6' })).rejects.toThrow(/cannot be deleted/)
  })

  it('offset face moves a planar face and grows / shrinks the body', async () => {
    const b = mkBox('b', [20, 20, 10])
    const top = faceAt(b, [0, 0, 1], [0, 0, 10])
    const up = await run('offsetFaces', { id: 'b', name: 'b', key: b.key, faces: [ref(b, top)], distance: 4, fid: 'f7' })
    near(vol(up), 20 * 20 * 14)
    const down = await run('offsetFaces', { id: 'b', name: 'b', key: b.key, faces: [ref(b, top)], distance: -3, fid: 'f7' })
    near(vol(down), 20 * 20 * 7)
    // the moved face keeps its name
    expect(down.mesh.faceNames!.flat()).toContain('b:zmax')
    expect(topoOf(getBrep(down.key) as unknown as AnyShape).faces.length).toBe(6)
  })

  it('offset face follows slanted neighbours', async () => {
    // a wedge: box with its +X top edge chamfered away so the +X side is slanted
    const b = mkBox('b', [20, 20, 10])
    const edges = topoOf(getBrep(b.key) as unknown as AnyShape).edges
    const idx = edges.findIndex((e) => { const m = e.pointAt(0.5); return Math.abs(m.x - 10) < 1e-6 && Math.abs(m.z - 10) < 1e-6 })
    const ch = await run('edgeMod', { id: 'b', name: 'b', key: b.key, edges: [idx], size: 4, mode: 'chamfer', fid: 'f4' })
    const v0 = vol(ch)
    const top = faceAt(ch, [0, 0, 1], [-2, 0, 10])
    const up = await run('offsetFaces', { id: 'b', name: 'b', key: ch.key, faces: [ref(ch, top)], distance: 3, fid: 'f7' })
    // the chamfer plane is extended upwards, so the slab narrows from 16 to 13 across its 3 mm height
    near(vol(up) - v0, 20 * 3 * ((16 + 13) / 2))
  })

  it('offset face changes the radius of a cylindrical hole', async () => {
    const b = mkBox('b', [30, 30, 10])
    const holed = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [{ k: 'a', origin: [0, 0, 10], dir: [0, 0, 1] }], spec: { kind: 'simple', dia: 6, depth: null, tip: 0 }, fid: 'f2' })
    const wall = holed.mesh.faceNames!.findIndex((n) => n[0] === 'f2:holea:wall')
    expect(wall).toBeGreaterThanOrEqual(0)
    const r = await run('offsetFaces', { id: 'b', name: 'b', key: holed.key, faces: [ref(holed, wall)], distance: 1, fid: 'f7' })
    // outward offset of the material surface = the hole shrinks: radius 3 -> 2
    near(vol(r), 9000 - Math.PI * 4 * 10, 3e-3)
    const r2 = await run('offsetFaces', { id: 'b', name: 'b', key: holed.key, faces: [ref(holed, wall)], distance: -1, fid: 'f7' })
    near(vol(r2), 9000 - Math.PI * 16 * 10, 3e-3)
  })

  it('replace face moves a face onto a plane', async () => {
    const b = mkBox('b', [20, 20, 10])
    const top = faceAt(b, [0, 0, 1], [0, 0, 10])
    const slanted = await run('replaceFaces', {
      id: 'b', name: 'b', key: b.key, faces: [ref(b, top)], target: { kind: 'plane', origin: [0, 0, 6], normal: [0, 0, 1] }, fid: 'f8',
    })
    near(vol(slanted), 20 * 20 * 6)
    const raised = await run('replaceFaces', {
      id: 'b', name: 'b', key: b.key, faces: [ref(b, top)], target: { kind: 'plane', origin: [0, 0, 13], normal: [0, 0, 1] }, fid: 'f8',
    })
    near(vol(raised), 20 * 20 * 13)
  })

  it('replace face with a face of another body (tilted plane)', async () => {
    const b = mkBox('b', [20, 20, 10])
    const top = faceAt(b, [0, 0, 1], [0, 0, 10])
    const r = await run('replaceFaces', {
      id: 'b', name: 'b', key: b.key, faces: [ref(b, top)], target: { kind: 'plane', origin: [0, 0, 5], normal: [Math.sin(0.3), 0, Math.cos(0.3)] }, fid: 'f8',
    })
    // a tilted plane through z = 5 at x = 0: volume is the same as the flat one at z = 5 (the wedges cancel)
    near(vol(r), 20 * 20 * 5, 5e-3)
  })

  it('split body cuts a body in two along a plane, with stable ids', async () => {
    const b = mkBox('b', [20, 20, 10])
    const pieces = await run<Body[]>('splitBody', { id: 'b', name: 'b', key: b.key, tool: { kind: 'plane', origin: [0, 0, 0], normal: [1, 0, 0] }, fid: 'f9' })
    expect(pieces.map((p) => p.id)).toEqual(['b', 'f9.b.1'])
    near(vol(pieces[0]), 2000)
    near(vol(pieces[1]), 2000)
    expect(bbox(pieces[0]).max[0]).toBeLessThan(0.001)
    // faces that survive keep their names
    expect(pieces[0].mesh.faceNames!.flat()).toContain('b:zmax')
  })

  it('split body by another body', async () => {
    const b = mkBox('b', [20, 20, 10])
    const tool = mkBox('t', [30, 4, 30])
    const pieces = await run<Body[]>('splitBody', { id: 'b', name: 'b', key: b.key, tool: { kind: 'body', key: tool.key }, fid: 'f9' })
    expect(pieces.length).toBe(3)
    near(pieces.reduce((s, p) => s + vol(p), 0), 4000)
  })

  it('split face divides a face but not the body', async () => {
    const b = mkBox('b', [20, 20, 10])
    const top = faceAt(b, [0, 0, 1], [0, 0, 10])
    const r = await run('splitFaces', { id: 'b', name: 'b', key: b.key, faces: [ref(b, top)], tool: { kind: 'plane', origin: [0, 0, 0], normal: [1, 0, 0] }, fid: 'f9' })
    near(vol(r), 4000)
    const f = topoOf(getBrep(r.key) as unknown as AnyShape).faces.length
    expect(f).toBe(7)
    const names = r.mesh.faceNames!.filter((n) => n.includes('b:zmax')).map((n) => n[0]).sort()
    expect(names).toEqual(['b:zmax~0', 'b:zmax~1'])
  })

  it('draft tilts side faces about the neutral plane', async () => {
    const b = mkBox('b', [20, 20, 10])
    const side = faceAt(b, [1, 0, 0], [10, 0, 5])
    const r = await run('draftFaces', { id: 'b', name: 'b', key: b.key, faces: [ref(b, side)], dir: [0, 0, 1], neutral: [0, 0, 0], angle: 5, fid: 'f10' })
    // the top edge of the drafted wall moves in by 10 * tan(5deg)
    const bb = bbox(r)
    expect(bb.max[0]).toBeCloseTo(10, 3)
    const pts = r.mesh.positions
    let topMax = -Infinity
    for (let i = 0; i < pts.length; i += 3) if (pts[i + 2] > 9.99) topMax = Math.max(topMax, pts[i])
    expect(topMax).toBeCloseTo(10 - 10 * Math.tan((5 * Math.PI) / 180), 3)
    expect(r.mesh.faceNames!.flat()).toContain('b:xmax')
  })

  it('refuses to draft a face that faces along the pull direction', async () => {
    const b = mkBox('b', [20, 20, 10])
    const top = faceAt(b, [0, 0, 1], [0, 0, 10])
    await expect(run('draftFaces', { id: 'b', name: 'b', key: b.key, faces: [ref(b, top)], dir: [0, 0, 1], neutral: [0, 0, 0], angle: 5, fid: 'f10' })).rejects.toThrow(/pull direction/)
  })
})

describe('geometry queries', () => {
  it('reports cylinder axes, plane normals and circle edges', async () => {
    const b = mkBox('b', [30, 30, 10])
    const holed = await run('holes', { id: 'b', name: 'b', key: b.key, holes: [{ k: 'a', origin: [5, 6, 10], dir: [0, 0, 1] }], spec: { kind: 'simple', dia: 6, depth: null, tip: 0 }, fid: 'f2' })
    const wall = holed.mesh.faceNames!.findIndex((n) => n[0] === 'f2:holea:wall')
    const g = await run<({ type: string; origin: number[]; dir: number[]; radius: number } | null)[]>('faceGeom', { key: holed.key, faces: [wall, faceAt(holed, [0, 0, 1], [0, 0, 10])] })
    expect(g[0]!.type).toBe('cylinder')
    expect(g[0]!.radius).toBeCloseTo(3, 6)
    expect(Math.abs(g[0]!.dir[2])).toBeCloseTo(1, 6)
    expect(g[0]!.origin[0]).toBeCloseTo(5, 6)
    expect(g[1]!.type).toBe('plane')
    const topo = topoOf(getBrep(holed.key) as unknown as AnyShape)
    const circle = topo.edges.findIndex((e) => String(e.geomType) === 'CIRCLE')
    const e = await run<({ type: string; origin: number[]; radius: number } | null)[]>('edgeGeom', { key: holed.key, edges: [circle] })
    expect(e[0]!.type).toBe('circle')
    expect(e[0]!.radius).toBeCloseTo(3, 6)
    expect(e[0]!.origin[0]).toBeCloseTo(5, 6)
  })
})
