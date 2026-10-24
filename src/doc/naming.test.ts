/**
 * Persistent topological naming, end to end: real features, the real regeneration engine and real OpenCascade, all in
 * Node. Each test builds a small timeline, edits something UPSTREAM of a feature that references a face / edge, and checks
 * that the reference still points at the same logical face / edge (or fails loudly and safely when it cannot).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// the kernel runs in-process instead of behind a Worker
vi.mock('@/kernel/client', async () => {
  const { api } = await import('@/kernel/api')
  return { getKernel: () => api as never }
})

import { measureVolume, type AnyShape } from 'replicad'
import { initOcc } from '@/kernel/occ'
import { getBrep } from '@/kernel/store'
import { bbox, type Body } from '@/kernel/types'
import { clearCache, regenerate } from '@/doc/engine'
import { decodeRef, edgeSigs, encodeRef, faceSigs, refFromSelection, resolveEdge, resolveFace, type EdgeRef, type FaceRef } from '@/doc/refs'
import { useDoc, type Feature } from '@/doc/store'
import { useSketchData } from '@/sketch/draw'
import { usePlanes } from '@/sketch/planes'
import { ensureSolver } from '@/sketch/solver'
import { addCircle, addConstraint, addCoincident, addLine, addPoint } from '@/sketch/model'
import { ORIGIN, emptyModel, type PlaneDef, type SketchModel } from '@/sketch/types'
import '@/features/basic'
import '@/features/sketch'
import '@/features/extrude'
import '@/features/fillet'
import '@/features/solids'
import '@/features/offsetPlane'

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }

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
const body = (): Body => bodies()[0]
const vol = (b: Body) => Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never))

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

/** Index of the edge whose midpoint is nearest `p` among edges running along `dir` (a unit axis). */
function edgeAt(b: Body, p: [number, number, number], axis: 0 | 1 | 2) {
  const sigs = edgeSigs(b)
  let best = -1, bd = Infinity
  sigs.forEach((s, i) => {
    if (Math.abs(s.direction[axis]) < 0.99) return
    const d = Math.hypot(s.midpoint[0] - p[0], s.midpoint[1] - p[1], s.midpoint[2] - p[2])
    if (d < bd) { bd = d; best = i }
  })
  return best
}
function faceAt(b: Body, normal: [number, number, number], p: [number, number, number]) {
  const sigs = faceSigs(b)
  let best = -1, bd = Infinity
  sigs.forEach((s, i) => {
    if (s.normal[0] * normal[0] + s.normal[1] * normal[1] + s.normal[2] * normal[2] < 0.99) return
    const d = Math.hypot(s.centroid[0] - p[0], s.centroid[1] - p[1], s.centroid[2] - p[2])
    if (d < bd) { bd = d; best = i }
  })
  return best
}
const refEdge = (b: Body, i: number) => encodeRef(refFromSelection({ kind: 'edge', id: b.id, index: i }, [b])!)
const refFace = (b: Body, i: number) => encodeRef(refFromSelection({ kind: 'face', id: b.id, index: i }, [b])!)

/** Faces of a body whose primary name contains `part`. */
const namedFaces = (b: Body, part: string) => (b.mesh.faceNames ?? []).map((n, i) => ({ n: n[0], i })).filter((x) => x.n.includes(part)).map((x) => x.i)

/** A w x h rectangle sketch (corner at the origin) with named dimension expressions. */
function rectModel(w: number, h: number): { model: SketchModel; corner: string } {
  const m = emptyModel()
  const p = [addPoint(m, 0, 0), addPoint(m, w, 0), addPoint(m, w, h), addPoint(m, 0, h)]
  const l = p.map((id, i) => addLine(m, id, p[(i + 1) % 4]).id)
  addConstraint(m, { type: 'horizontal', refs: [l[0]] })
  addConstraint(m, { type: 'horizontal', refs: [l[2]] })
  addConstraint(m, { type: 'vertical', refs: [l[1]] })
  addConstraint(m, { type: 'vertical', refs: [l[3]] })
  addCoincident(m, p[0], ORIGIN)
  addConstraint(m, { type: 'hdist', refs: [p[0], p[1]], value: w, sgn: 1, expr: String(w), off: [0, 0] })
  addConstraint(m, { type: 'vdist', refs: [p[1], p[2]], value: h, sgn: 1, expr: String(h), off: [0, 0] })
  return { model: m, corner: p[2] }
}
const sketchParams = (model: SketchModel, plane = XY, face: string | null = null) => ({ sketch: JSON.stringify({ plane, face, model }) })
const profileOf = (sketchId: string) => `prof:${sketchId}:${useSketchData.getState().data[sketchId].profiles[0].key}`

describe('persistent names on bodies', () => {
  it('a box names its faces by direction and its edges by the faces they join', async () => {
    await add('box', box(20, 10, 5))
    const f = body().mesh.faceNames!.map((n) => n[0]).sort()
    expect(f).toEqual(['f1:xmax', 'f1:xmin', 'f1:ymax', 'f1:ymin', 'f1:zmax', 'f1:zmin'])
    const e = body().mesh.edgeNames!.map((n) => n[0])
    expect(new Set(e).size).toBe(12)
    expect(e).toContain('f1:xmax&f1:zmax')
  })

  it('refs capture the name; old refs without a name still resolve by signature, silently', async () => {
    await add('box', box(20, 10, 5))
    const b = body()
    const i = faceAt(b, [0, 0, 1], [0, 0, 5])
    const ref = decodeRef(refFace(b, i)) as FaceRef
    expect(ref.name).toBe('f1:zmax')
    const legacy = { ...ref, name: undefined } as FaceRef
    expect(resolveFace(legacy, [b])!.index).toBe(i)
    expect(JSON.parse(JSON.stringify(legacy)).name).toBeUndefined()
  })
})

describe('fillet follows its edge through upstream edits', () => {
  it('box: fillet a top edge, resize and move the box, the fillet stays on the same logical edge', async () => {
    const boxId = await add('box', box(20, 20, 10))
    const b0 = body()
    const e = edgeAt(b0, [10, 0, 10], 1) // top edge on the +X side
    const filletId = await add('fillet', { edges: [refEdge(b0, e)], size: 1 })
    expect(feat(filletId).state).toBe('ok')
    const faces = (b: Body) => namedFaces(b, ':fillet:')
    expect(faces(body())).toHaveLength(1)
    const name = body().mesh.faceNames![faces(body())[0]][0]
    const where = (b: Body) => faceSigs(b)[faces(b)[0]].centroid

    await edit(boxId, box(40, 30, 25))
    expect(feat(filletId).state).toBe('ok')
    expect(feat(filletId).warning).toBeUndefined()
    expect(body().mesh.faceNames![faces(body())[0]][0]).toBe(name)
    let c = where(body())
    expect(c[0]).toBeGreaterThan(19) // x = +20 (the +X side of the 40 wide box)
    expect(c[2]).toBeGreaterThan(24) // z = 25

    // moving the box 25 along X: the nearest edge to the old position is the OTHER top edge; the name must win
    await edit(boxId, box(40, 30, 25, [60, 0, 0]))
    expect(feat(filletId).state).toBe('ok')
    expect(feat(filletId).warning).toBeUndefined()
    c = where(body())
    expect(c[0]).toBeGreaterThan(79) // x = 60 + 20
    expect(vol(body())).toBeLessThan(40 * 30 * 25)
  })

  it('sketch rect -> extrude -> fillet a vertical edge; changing a dimension and adding a point keeps the fillet on that corner', async () => {
    const { model, corner } = rectModel(40, 20)
    const sk = await add('sketch', sketchParams(model))
    const ex = await add('extrude', { profiles: [profileOf(sk)], distance: 10, operation: 'join' })
    const b0 = body()
    const e = edgeAt(b0, [40, 20, 5], 2)
    expect(e).toBeGreaterThanOrEqual(0)
    const fl = await add('fillet', { edges: [refEdge(b0, e)], size: 2 })
    expect(feat(fl).state).toBe('ok')
    expect(namedFaces(body(), ':fillet:')).toHaveLength(1)

    // widen the rectangle and drop an unrelated point into the sketch
    const m2 = JSON.parse(JSON.stringify(model)) as SketchModel
    const dim = m2.constraints.find((c) => c.type === 'hdist')!
    dim.expr = '70'; dim.value = 70
    addPoint(m2, 5, 5)
    await edit(sk, sketchParams(m2))
    expect(feat(sk).state).toBe('ok')
    expect(feat(ex).state).toBe('ok')
    expect(feat(fl).state).toBe('ok')
    expect(feat(fl).warning).toBeUndefined()
    const f = namedFaces(body(), ':fillet:')
    expect(f).toHaveLength(1)
    const c = faceSigs(body())[f[0]].centroid
    expect(c[0]).toBeGreaterThan(68) // the +X,+Y corner moved from x=40 to x=70
    expect(c[1]).toBeGreaterThan(18)
    expect(corner).toBeTruthy()
    const bb = bbox(body().mesh.positions)
    expect(bb.max[0]).toBeCloseTo(70, 1)
  })
})

describe('sketch on a face follows the face', () => {
  it('extrude -> sketch on top -> extrude again; changing the first height moves the second sketch with the top', async () => {
    const base = rectModel(40, 20)
    const sk1 = await add('sketch', sketchParams(base.model))
    const ex1 = await add('extrude', { profiles: [profileOf(sk1)], distance: 10, operation: 'join' })
    const top = faceAt(body(), [0, 0, 1], [20, 10, 10])
    const faceRef = refFace(body(), top)
    const small = rectModel(10, 5)
    const sk2 = await add('sketch', sketchParams(small.model, { origin: [20, 10, 10], xDir: [1, 0, 0], normal: [0, 0, 1] }, faceRef))
    expect(feat(sk2).state).toBe('ok')
    const ex2 = await add('extrude', { profiles: [profileOf(sk2)], distance: 4, operation: 'join' })
    expect(feat(ex2).state).toBe('ok')
    expect(bbox(body().mesh.positions).max[2]).toBeCloseTo(14, 3)

    // a big change: the top face moves 50 mm, far outside any signature tolerance
    await edit(ex1, { profiles: [profileOf(sk1)], distance: 60, operation: 'join' })
    expect(feat(sk2).state).toBe('ok')
    expect(feat(sk2).warning).toBeUndefined()
    expect(useSketchData.getState().data[sk2].plane.origin[2]).toBeCloseTo(60, 3)
    expect(feat(ex2).state).toBe('ok')
    expect(bbox(body().mesh.positions).max[2]).toBeCloseTo(64, 3)
    expect(bodies()).toHaveLength(1)
  })
})

describe('shell keeps removing the same face', () => {
  it('shell the top of a box; after resizing it is still the top that is open', async () => {
    const boxId = await add('box', box(30, 30, 20))
    const topRef = refFace(body(), faceAt(body(), [0, 0, 1], [0, 0, 20]))
    const sh = await add('shell', { faces: [topRef], thickness: 2, side: 'inside' })
    expect(feat(sh).state).toBe('ok')
    const open = (h: number, w: number) => {
      const sigs = faceSigs(body())
      const upFaces = sigs.filter((s) => s.normal[2] > 0.99).map((s) => s.centroid[2])
      expect(upFaces.some((z) => Math.abs(z - 2) < 1e-3)).toBe(true) // the inner floor
      expect(upFaces.some((z) => Math.abs(z - (h - 2)) < 1e-3)).toBe(false) // no inner ceiling: the top is open
      expect(vol(body())).toBeCloseTo(w * w * h - (w - 4) * (w - 4) * (h - 2), 0)
    }
    open(20, 30)
    await edit(boxId, box(50, 50, 80))
    expect(feat(sh).state).toBe('ok')
    expect(feat(sh).warning).toBeUndefined()
    open(80, 50)
  })
})

describe('references that cannot survive', () => {
  it('an edit that truly deletes the referenced edge puts the fillet in an error state (no crash) and it recovers when the edge is back', async () => {
    const { model } = rectModel(40, 20)
    const sk = await add('sketch', sketchParams(model))
    await add('extrude', { profiles: [profileOf(sk)], distance: 10, operation: 'join' })
    const b0 = body()
    const fl = await add('fillet', { edges: [refEdge(b0, edgeAt(b0, [40, 20, 5], 2))], size: 2 })
    expect(feat(fl).state).toBe('ok')

    // replace the rectangle with a circle: no corner edge survives anywhere near the old one
    const circle = emptyModel()
    const c = addPoint(circle, 10, 10)
    addCircle(circle, c, 8)
    await edit(sk, sketchParams(circle))
    const f = feat(fl)
    expect(f.state).toBe('error')
    expect(f.error).toMatch(/no longer exist/i)
    expect(f.lostRefs).toHaveLength(1)
    expect(bodies().length).toBeGreaterThan(0) // upstream geometry is still shown

    await edit(sk, sketchParams(model))
    expect(feat(fl).state).toBe('ok')
    expect(feat(fl).lostRefs).toBeUndefined()
  })

  it('a cut that splits a referenced face resolves deterministically to one piece, with a warning', async () => {
    const boxId = await add('box', box(40, 20, 10))
    const topRef = refFace(body(), faceAt(body(), [0, 0, 1], [0, 0, 10]))
    // a slot through the whole box splits the top face in two
    const slot = emptyModel()
    const p = [addPoint(slot, -30, -2), addPoint(slot, 30, -2), addPoint(slot, 30, 2), addPoint(slot, -30, 2)]
    p.forEach((id, i) => addLine(slot, id, p[(i + 1) % 4]))
    const sk = await add('sketch', sketchParams(slot, { origin: [0, 0, -1], xDir: [1, 0, 0], normal: [0, 0, 1] }))
    await add('extrude', { profiles: [profileOf(sk)], distance: 20, operation: 'cut' })
    expect(body().mesh.faceNames!.filter((n) => n[0].startsWith('f1:zmax~'))).toHaveLength(2)
    const op = await add('offsetPlane', { base: 'face', face: [topRef], distance: 5 })
    expect(feat(op).state).toBe('warning')
    expect(feat(op).warning).toMatch(/split/i)
    expect(feat(op).reboundRefs).toEqual([topRef])
    const origin = () => usePlanes.getState().data[op].origin
    const first = origin()
    expect(first[2]).toBeCloseTo(15, 6)
    // same answer after a from-scratch regeneration
    clearCache()
    await edit(boxId, box(40, 20, 10))
    expect(origin()).toEqual(first)
  })

  it('a ref to a face that no longer exists anywhere is an error, not a crash', async () => {
    await add('box', box(20, 20, 20))
    const b = body()
    const ref = decodeRef(refFace(b, faceAt(b, [0, 0, 1], [0, 0, 20]))) as FaceRef
    const gone: FaceRef = { ...ref, name: 'f9:nothing', sig: { normal: [0, 0, 1], centroid: [500, 500, 500], area: 5 } }
    expect(resolveFace(gone, [b])).toBeNull()
    const goneEdge: EdgeRef = { kind: 'edge', bodyId: b.id, index: 0, name: 'f9:a&f9:b', sig: { midpoint: [500, 500, 500], direction: [0, 0, 1], length: 3 } }
    expect(resolveEdge(goneEdge, [b])).toBeNull()
  })
})
