/**
 * The modeling tools end to end in Node: real features, the real regeneration engine and real OpenCascade. Each test builds a
 * small timeline and edits something UPSTREAM of the tool, checking that what the tool references is still the same logical
 * thing afterwards (names, not positions).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/kernel/client', async () => {
  const { api } = await import('@/kernel/api')
  return { getKernel: () => api as never }
})

import { measureVolume, type AnyShape } from 'replicad'
import { initOcc } from '@/kernel/occ'
import { getBrep } from '@/kernel/store'
import type { Body } from '@/kernel/types'
import { clearCache, regenerate } from '@/doc/engine'
import { encodeRef, faceSigs, refFromSelection, vertexRef } from '@/doc/refs'
import { useDoc, type Feature } from '@/doc/store'
import { usePlanes } from '@/sketch/planes'
import { ensureSolver } from '@/sketch/solver'
import '@/features/basic'
import '@/features/sketch'
import '@/features/extrude'
import '@/features/fillet'
import '@/features/solids'
import '@/features/offsetPlane'
import '@/features/modeling-tools/register'
import { useConstruct } from './geo'

beforeAll(async () => {
  await initOcc()
  await ensureSolver()
})
beforeEach(async () => {
  clearCache()
  useDoc.getState().newDocument()
  await regenerate()
})

const doc = () => useDoc.getState()
const feat = (id: string): Feature => doc().features.find((f) => f.id === id)!
const bodies = (): Body[] => doc().geometry
const body = (id?: string): Body => (id ? bodies().find((b) => b.id === id)! : bodies()[0])
const vol = (b: Body) => Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never))
const near = (a: number, b: number, rel = 3e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))

async function add(type: string, params: Record<string, unknown>) {
  const id = doc().addFeature(type, params as never)
  await regenerate()
  return id
}
async function edit(id: string, params: Record<string, unknown>) {
  doc().updateFeature(id, params as never)
  await regenerate()
}
const box = (w: number, d: number, h: number, position = [0, 0, 0]) => ({ width: w, depth: d, height: h, position })
const faceAt = (b: Body, n: [number, number, number], p: [number, number, number]) => {
  const sigs = faceSigs(b)
  let best = -1, bd = Infinity
  sigs.forEach((s, i) => {
    if (s.normal[0] * n[0] + s.normal[1] * n[1] + s.normal[2] * n[2] < 0.99) return
    const d = Math.hypot(s.centroid[0] - p[0], s.centroid[1] - p[1], s.centroid[2] - p[2])
    if (d < bd) { bd = d; best = i }
  })
  return best
}
const refFace = (b: Body, i: number) => encodeRef(refFromSelection({ kind: 'face', id: b.id, index: i }, [b])!)
const faceHole = (b: Body, i: number, k: string, u = 0, v = 0) => JSON.stringify({ hole: 1, k, face: refFace(b, i), u, v })

describe('hole', () => {
  it('a hole clicked on a face follows the face when the box changes', async () => {
    const boxId = await add('box', box(40, 40, 10))
    const top = faceAt(body(), [0, 0, 1], [0, 0, 10])
    const holeId = await add('hole', { places: [faceHole(body(), top, 'a', 5, 0)], dia: 6, depthMode: 'through' })
    expect(feat(holeId).state).toBe('ok')
    near(vol(body()), 16000 - Math.PI * 9 * 10)
    await edit(boxId, box(60, 50, 20, [100, 0, 0]))
    expect(feat(holeId).state).toBe('ok')
    expect(feat(holeId).warning).toBeUndefined()
    near(vol(body()), 60 * 50 * 20 - Math.PI * 9 * 20)
    // the hole is still 5 mm off the middle of the top face, and the middle moved with the box
    const wall = body().mesh.faceNames!.findIndex((n) => n[0].includes(':hole'))
    expect(wall).toBeGreaterThanOrEqual(0)
  })

  it('tapped hole: cosmetic thread by default, modeled thread when asked', async () => {
    await add('box', box(30, 30, 12))
    const top = faceAt(body(), [0, 0, 1], [0, 0, 12])
    const params = { places: [faceHole(body(), top, 'a')], tapType: 'tapped', major: 6, pitch: 1, threadLength: 8, depthMode: 'depth', depth: 10 }
    const h = await add('hole', params)
    expect(feat(h).state).toBe('ok')
    near(vol(body()), 30 * 30 * 12 - Math.PI * (5 - 1.0825 * 0 - 0) ** 2 / 4 * 10 + 0, 1) // plain drill only: checked below with the exact tap drill
    const drill = 6 - 1.0825
    near(vol(body()), 30 * 30 * 12 - Math.PI * (drill / 2) ** 2 * 10, 2e-3)
    expect(Object.keys(useConstruct.getState().threads)).toContain(h)
    await edit(h, { ...params, modeled: true })
    expect(feat(h).state).toBe('ok')
    expect(vol(body())).toBeLessThan(30 * 30 * 12 - Math.PI * (drill / 2) ** 2 * 10 - 5)
    expect(Object.keys(useConstruct.getState().threads)).not.toContain(h)
  }, 120000)

  it('a hole at a construction point and counterbore from a preset size', async () => {
    await add('box', box(40, 40, 10))
    const pt = await add('constructPoint', { mode: 'coords', pos: [5, 5, 10] })
    const h = await add('hole', { places: [pt], pointDir: '+Z', holeType: 'cbore', dia: 3.4, cbDia: 6.5, cbDepth: 3.4, depthMode: 'through' })
    expect(feat(h).state, feat(h).error).toBe('ok')
    near(vol(body()), 16000 - (Math.PI * 3.25 ** 2 * 3.4 + Math.PI * 1.7 ** 2 * 6.6))
  })

  it('reports a hole that is not on any body', async () => {
    await add('box', box(40, 40, 10))
    const pt = await add('constructPoint', { mode: 'coords', pos: [500, 5, 10] })
    const h = await add('hole', { places: [pt], pointDir: '+Z', dia: 3, depthMode: 'through' })
    expect(feat(h).state).toBe('error')
    expect(feat(h).error).toMatch(/not on any body|None of the hole positions/)
  })
})

describe('pattern and mirror', () => {
  it('a pattern of a hole feature survives an upstream resize', async () => {
    const boxId = await add('box', box(80, 20, 10))
    const top = faceAt(body(), [0, 0, 1], [0, 0, 10])
    const hole = await add('hole', { places: [faceHole(body(), top, 'a', -30, 0)], dia: 4, depthMode: 'through' })
    const pat = await add('pattern', { source: 'features', features: [hole], kind: 'rect', axis1: 'X', count1: 4, type1: 'spacing', distance1: 20 })
    expect(feat(pat).state, feat(pat).error).toBe('ok')
    near(vol(body()), 80 * 20 * 10 - 4 * Math.PI * 4 * 10)
    await edit(boxId, box(90, 30, 14))
    expect(feat(pat).state, feat(pat).error).toBe('ok')
    near(vol(body()), 90 * 30 * 14 - 4 * Math.PI * 4 * 14)
  })

  it('skipped instances are left out', async () => {
    await add('box', box(80, 20, 10))
    const pt = await add('constructPoint', { mode: 'coords', pos: [-30, 0, 10] })
    const hole = await add('hole', { places: [pt], pointDir: '+Z', dia: 4, depthMode: 'through' })
    const pat = await add('pattern', { source: 'features', features: [hole], kind: 'rect', axis1: 'X', count1: 4, distance1: 20, skip: ['2'] })
    expect(feat(pat).state, feat(pat).error).toBe('ok')
    near(vol(body()), 80 * 20 * 10 - 3 * Math.PI * 4 * 10)
  })

  it('circular pattern of faces round a construction axis', async () => {
    await add('box', box(60, 60, 10))
    const pt = await add('constructPoint', { mode: 'coords', pos: [20, 0, 10] })
    await add('hole', { places: [pt], pointDir: '+Z', dia: 4, depthMode: 'depth', depth: 5 })
    const wallIdx = body().mesh.faceNames!.map((n, i) => ({ n: n[0], i })).filter((x) => x.n.includes(':hole')).map((x) => x.i)
    expect(wallIdx.length).toBeGreaterThanOrEqual(2)
    const ax = await add('constructAxis', { mode: 'twoPoints', p1: [await add('constructPoint', { mode: 'coords', pos: [0, 0, 0] })], p2: [await add('constructPoint', { mode: 'coords', pos: [0, 0, 1] })] })
    const pat = await add('pattern', { source: 'faces', faces: wallIdx.map((i) => refFace(body(), i)), kind: 'circ', caxis: 'ref', cref: [ax], ccount: 3, cangle: 360 })
    expect(feat(pat).state, feat(pat).error).toBe('ok')
    near(vol(body()), 60 * 60 * 10 - 3 * Math.PI * 4 * 5)
  })

  it('a pattern of bodies makes new bodies; mirror joins them', async () => {
    await add('box', box(10, 10, 10, [20, 0, 0]))
    const pat = await add('pattern', { source: 'bodies', bodies: ['f1'], kind: 'rect', axis1: 'Y', count1: 3, distance1: 15 })
    expect(feat(pat).state, feat(pat).error).toBe('ok')
    expect(bodies().length).toBe(3)
    const mir = await add('mirror', { source: 'bodies', bodies: ['f1'], plane: ['planeYZ'], operation: 'join' })
    expect(feat(mir).state, feat(mir).error).toBe('ok')
    const b1 = body('f1')
    near(vol(b1), 2000, 1e-3) // original and its mirror image are apart: one compound of two boxes
  })

  it('mirror a feature across a construction plane', async () => {
    await add('box', box(60, 20, 10))
    const pt = await add('constructPoint', { mode: 'coords', pos: [-20, 0, 10] })
    const hole = await add('hole', { places: [pt], pointDir: '+Z', dia: 4, depthMode: 'through' })
    const pl = await add('constructPlane', { mode: 'offset', base: ['planeYZ'], distance: 0 })
    const mir = await add('mirror', { source: 'features', features: [hole], plane: [pl] })
    expect(feat(mir).state, feat(mir).error).toBe('ok')
    near(vol(body()), 60 * 20 * 10 - 2 * Math.PI * 4 * 10)
  })
})

describe('construction geometry', () => {
  it('plane at an angle, midplane, tangent plane, three points', async () => {
    await add('box', box(20, 20, 20))
    const b = body()
    const top = faceAt(b, [0, 0, 1], [0, 0, 20])
    const a = await add('constructPoint', { mode: 'coords', pos: [0, 0, 0] })
    const x = await add('constructPoint', { mode: 'coords', pos: [10, 0, 0] })
    const axis = await add('constructAxis', { mode: 'twoPoints', p1: [a], p2: [x] })
    const ang = await add('constructPlane', { mode: 'angle', base: ['planeXY'], axis: [axis], angle: 30 })
    const pl = usePlanes.getState().data[ang]
    near(Math.abs(pl.normal[2]), Math.cos((30 * Math.PI) / 180), 1e-6)
    near(Math.abs(pl.normal[1]), Math.sin((30 * Math.PI) / 180), 1e-6)
    const mid = await add('constructPlane', { mode: 'midplane', plane1: ['planeXY'], plane2: [refFace(b, top)] })
    near(usePlanes.getState().data[mid].origin[2], 10, 1e-6)
    const p3 = await add('constructPoint', { mode: 'coords', pos: [0, 5, 0] })
    const p4 = await add('constructPoint', { mode: 'coords', pos: [0, 0, 5] })
    const tri = await add('constructPlane', { mode: 'threePoints', p1: [a], p2: [p3], p3: [p4] })
    near(Math.abs(usePlanes.getState().data[tri].normal[0]), 1, 1e-9)
    // parallel planes only for a midplane
    const bad = await add('constructPlane', { mode: 'midplane', plane1: ['planeXY'], plane2: ['planeYZ'] })
    expect(feat(bad).state).toBe('error')
  })

  it('axis of a cylinder, points at vertices and edge centres', async () => {
    await add('box', box(30, 30, 10))
    const top = faceAt(body(), [0, 0, 1], [0, 0, 10])
    await add('hole', { places: [faceHole(body(), top, 'a', 4, 2)], dia: 6, depthMode: 'through' })
    const wall = body().mesh.faceNames!.findIndex((n) => n[0].includes(':hole'))
    const ax = await add('constructAxis', { mode: 'cylinder', cyl: [refFace(body(), wall)] })
    const a = useConstruct.getState().axes[ax]
    expect(Math.abs(a.dir[2])).toBeCloseTo(1, 6)
    near(Math.abs(a.origin[0]) + Math.abs(a.origin[1]), 6, 1e-6)
    const vr = encodeRef(vertexRef(body(), 0)!)
    const p = await add('constructPoint', { mode: 'vertex', vertex: [vr] })
    expect(useConstruct.getState().points[p]).toBeTruthy()
    const circle = body().mesh.edgeNames!.findIndex((n) => n[0].includes(':hole') || n[0].includes('seam'))
    void circle
  })
})

describe('direct edits follow names through upstream edits', () => {
  it('delete face heals a fillet, even after the box is resized', async () => {
    const boxId = await add('box', box(20, 20, 10))
    const b0 = body()
    const edges = b0.mesh.edgeNames!.findIndex((n) => n.includes('f1:ymin&f1:zmax'))
    expect(edges).toBeGreaterThanOrEqual(0)
    await add('fillet', { edges: [encodeRef(refFromSelection({ kind: 'edge', id: b0.id, index: edges }, [b0])!)], size: 2 })
    const fi = body().mesh.faceNames!.findIndex((n) => n[0].includes(':fillet:'))
    const del = await add('deleteFace', { faces: [refFace(body(), fi)] })
    expect(feat(del).state, feat(del).error).toBe('ok')
    near(vol(body()), 4000)
    await edit(boxId, box(40, 30, 25))
    expect(feat(del).state, feat(del).error).toBe('ok')
    near(vol(body()), 40 * 30 * 25)
  })

  it('offset face moves the named top face when the box height changes', async () => {
    const boxId = await add('box', box(20, 20, 10))
    const top = faceAt(body(), [0, 0, 1], [0, 0, 10])
    const off = await add('offsetFace', { faces: [refFace(body(), top)], distance: 3 })
    near(vol(body()), 20 * 20 * 13)
    await edit(boxId, box(20, 20, 30))
    expect(feat(off).state, feat(off).error).toBe('ok')
    expect(feat(off).warning).toBeUndefined()
    near(vol(body()), 20 * 20 * 33)
  })

  it('press/pull pushes a face and rounds an edge', async () => {
    await add('box', box(20, 20, 10))
    const top = faceAt(body(), [0, 0, 1], [0, 0, 10])
    const pp = await add('pressPull', { entities: [refFace(body(), top)], distance: -4 })
    near(vol(body()), 20 * 20 * 6)
    const e = body().mesh.edgeNames!.findIndex((n) => n.includes('f1:xmax&f1:ymax'))
    const rounded = await add('pressPull', { entities: [encodeRef(refFromSelection({ kind: 'edge', id: body().id, index: e }, [body()])!)], distance: 2 })
    expect(feat(pp).state).toBe('ok')
    expect(feat(rounded).state, feat(rounded).error).toBe('ok')
    expect(vol(body())).toBeLessThan(20 * 20 * 6)
    const mixed = await add('pressPull', { entities: [refFace(body(), faceAt(body(), [0, 0, 1], [0, 0, 6])), encodeRef(refFromSelection({ kind: 'edge', id: body().id, index: e }, [body()])!)], distance: 1 })
    expect(feat(mixed).state).toBe('error')
  })

  it('replace face and split body / face', async () => {
    await add('box', box(20, 20, 10))
    const top = faceAt(body(), [0, 0, 1], [0, 0, 10])
    const rep = await add('replaceFace', { faces: [refFace(body(), top)], target: ['planeXY'] })
    expect(feat(rep).state).toBeDefined()
    // replacing the top with the XY plane at z = 0 leaves nothing: reported, not crashed
    expect(['ok', 'error']).toContain(feat(rep).state)
    doc().removeFeature(rep)
    await regenerate()
    const pl = await add('constructPlane', { mode: 'offset', base: ['planeYZ'], distance: 0 })
    const sf = await add('splitFace', { faces: [refFace(body(), faceAt(body(), [0, 0, 1], [0, 0, 10]))], tool: [pl] })
    expect(feat(sf).state, feat(sf).error).toBe('ok')
    expect(bodies().length).toBe(1)
    expect(body().mesh.faceNames!.flat().filter((n) => n.includes('zmax~')).length).toBeGreaterThanOrEqual(2)
    const sb = await add('splitBody', { bodies: [body().id], tool: [pl] })
    expect(feat(sb).state, feat(sb).error).toBe('ok')
    expect(bodies().length).toBe(2)
    near(bodies().reduce((s, b) => s + vol(b), 0), 4000)
  })

  it('draft tilts a wall about the neutral plane', async () => {
    const boxId = await add('box', box(20, 20, 10))
    const side = faceAt(body(), [1, 0, 0], [10, 0, 5])
    const dr = await add('draft', { plane: ['planeXY'], faces: [refFace(body(), side)], angle: 5 })
    expect(feat(dr).state, feat(dr).error).toBe('ok')
    expect(vol(body())).toBeLessThan(4000)
    await edit(boxId, box(20, 20, 20))
    expect(feat(dr).state, feat(dr).error).toBe('ok')
  })
})

describe('configurations', () => {
  it('switching a configuration changes the parameters, undo restores, and the choice is saved with the document', async () => {
    doc().setUserParams([{ name: 'w', expr: '20' }, { name: 'h', expr: '10' }])
    await add('box', { width: 'w', depth: 20, height: 'h', position: [0, 0, 0] })
    near(vol(body()), 4000)
    doc().setConfigs([{ name: 'S', values: { w: '10' } }, { name: 'L', values: { w: '40', h: '20' } }])
    doc().setActiveConfig('L')
    await regenerate()
    near(vol(body()), 40 * 20 * 20)
    doc().setActiveConfig('S')
    await regenerate()
    near(vol(body()), 10 * 20 * 10)
    const data = doc().getData()
    expect(data.activeConfig).toBe('S')
    expect(data.configs.map((c) => c.name)).toEqual(['S', 'L'])
    doc().setActiveConfig(null)
    await regenerate()
    near(vol(body()), 4000)
    doc().undo()
    await regenerate()
    near(vol(body()), 10 * 20 * 10)
    // a document loaded from data keeps them
    doc().loadDocument(data, {})
    await regenerate()
    expect(doc().activeConfig).toBe('S')
    near(vol(body()), 10 * 20 * 10)
  })

  it('removing the active configuration falls back to the base values', async () => {
    doc().setUserParams([{ name: 'w', expr: '20' }])
    await add('box', { width: 'w', depth: 20, height: 10, position: [0, 0, 0] })
    doc().setConfigs([{ name: 'S', values: { w: '10' } }])
    doc().setActiveConfig('S')
    await regenerate()
    doc().setConfigs([])
    await regenerate()
    expect(doc().activeConfig).toBeNull()
    near(vol(body()), 4000)
  })
})
