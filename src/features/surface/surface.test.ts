/**
 * The surface features end to end in Node: real features, the real regeneration engine and real OpenCascade. A timeline
 * builds a closed box out of surfaces, then edits the sketch under it: every reference the surface tools hold (curves by
 * chain, open edges by name) has to follow, and a surface that no longer closes has to say so.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/kernel/client', async () => {
  const { api } = await import('@/kernel/api')
  return { getKernel: () => api as never }
})

import { measureArea, measureVolume, type AnyShape } from 'replicad'
import { initOcc } from '@/kernel/occ'
import { getBrep } from '@/kernel/store'
import type { Body } from '@/kernel/types'
import { clearCache, regenerate } from '@/doc/engine'
import { encodeRef, refFromSelection } from '@/doc/refs'
import { useDoc, type Feature } from '@/doc/store'
import { useSketchData } from '@/sketch/draw'
import { addLine, addPoint } from '@/sketch/model'
import { ensureSolver } from '@/sketch/solver'
import { emptyModel, type PlaneDef } from '@/sketch/types'
import '@/features/basic'
import '@/features/sketch'
import '@/features/solids'
import '@/features/modeling-tools/register'
import './register'
import { chainsOf, curveRef } from './curves'

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
const body = (id: string): Body => doc().geometry.find((b) => b.id === id)!
const area = (b: Body) => Math.abs(measureArea(getBrep(b.key) as unknown as AnyShape as never))
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
const states = () => doc().features.map((f) => f.state)

/** A rectangle sketch of loose lines (no constraints), `w` x `h` from the origin. */
function rectParams(w: number, h: number) {
  const m = emptyModel()
  const p = [addPoint(m, 0, 0), addPoint(m, w, 0), addPoint(m, w, h), addPoint(m, 0, h)]
  p.forEach((id, i) => addLine(m, id, p[(i + 1) % 4]))
  return { sketch: JSON.stringify({ plane: XY, face: null, model: m }) }
}
const chainRef = (sketchId: string) => { const c = chainsOf(useSketchData.getState().data[sketchId])[0]; return curveRef(sketchId, c) }
/** Edge refs of the body's edges lying at height z, the way a pick in the viewport stores them. */
function edgesAt(b: Body, z: number): string[] {
  const out = new Set<number>()
  const e = b.mesh.edges, ids = b.mesh.edgeIds!
  for (let s = 0; s < e.length / 6; s++) if (Math.abs(e[s * 6 + 2] - z) < 1e-4 && Math.abs(e[s * 6 + 5] - z) < 1e-4) out.add(ids[s])
  return [...out].map((index) => encodeRef(refFromSelection({ kind: 'edge', id: b.id, index }, [b])!))
}

describe('a box built from surfaces', () => {
  it('stitches to a solid, and follows the sketch when it is edited', async () => {
    const sk = await add('sketch', rectParams(20, 10))
    const ref = chainRef(sk)
    const bottom = await add('surfacePatch', { boundary: [ref], continuity: 'g0' })
    const walls = await add('surfaceExtrude', { curves: [ref], direction: 'one', distance: 8, distance2: 5, axis: 'normal' })
    expect(body(walls).surface).toBe(true)
    expect(body(walls).freeEdges).toBe(8) // the open tube: four edges at each end
    const lid = await add('surfacePatch', { boundary: edgesAt(body(walls), 8), continuity: 'g0' })
    const stitch = await add('surfaceStitch', { surfaces: [bottom, walls, lid], tolerance: 0.01, solid: true })
    expect(states()).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    expect(feat(stitch).warning).toBeUndefined()
    expect(body(bottom).surface).toBeUndefined()
    near(vol(body(bottom)), 20 * 10 * 8)
    expect(doc().surfaces).toEqual([])
    expect(doc().bodies.map((b) => b.id)).toEqual([bottom])

    // a bigger rectangle: the curve is found again by its entities, the lid by the names of the open edges
    await edit(sk, rectParams(30, 14))
    expect(states()).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    for (const id of [bottom, walls, lid, stitch]) expect(feat(id).warning, id).toBeUndefined()
    near(vol(body(bottom)), 30 * 14 * 8)
  })

  it('a lid that does not fit leaves the shell open and the stitch says how many edges are left', async () => {
    const sk = await add('sketch', rectParams(20, 10))
    const ref = chainRef(sk)
    const bottom = await add('surfacePatch', { boundary: [ref], continuity: 'g0' })
    const walls = await add('surfaceExtrude', { curves: [ref], direction: 'one', distance: 8, distance2: 5, axis: 'normal' })
    const stitch = await add('surfaceStitch', { surfaces: [bottom, walls], tolerance: 0.01, solid: true })
    expect(feat(stitch).state).toBe('warning')
    expect(feat(stitch).warning).toMatch(/4 open edges left/)
    expect(body(bottom).surface).toBe(true)
    expect(body(bottom).freeEdges).toBe(4)
  })
})

describe('thicken and delete face', () => {
  it('thicken turns the surface into a solid; keeping the surface adds a body instead', async () => {
    const sk = await add('sketch', rectParams(20, 10))
    const patch = await add('surfacePatch', { boundary: [chainRef(sk)], continuity: 'g0' })
    const thick = await add('surfaceThicken', { surfaces: [patch], distance: 3, side: 'front', keep: false })
    expect(feat(thick).state, feat(thick).error).toBe('ok')
    expect(body(patch).surface).toBeUndefined()
    near(vol(body(patch)), 20 * 10 * 3)

    const sk2 = await add('sketch', rectParams(8, 8))
    const p2 = await add('surfacePatch', { boundary: [chainRef(sk2)], continuity: 'g0' })
    const sym = await add('surfaceThicken', { surfaces: [p2], distance: 4, side: 'sym', keep: true })
    expect(feat(sym).state, feat(sym).error).toBe('ok')
    expect(body(p2).surface).toBe(true) // the surface is still there
    near(vol(body(sym)), 8 * 8 * 4)
    const bb = body(sym).mesh.positions
    let lo = Infinity, hi = -Infinity
    for (let i = 2; i < bb.length; i += 3) { lo = Math.min(lo, bb[i]); hi = Math.max(hi, bb[i]) }
    expect([lo, hi].map((v) => +v.toFixed(3))).toEqual([-2, 2])
  })

  it('delete face turns a solid into an open surface, and the solid tools then refuse it', async () => {
    const box = await add('box', { width: 10, depth: 10, height: 10, position: [0, 0, 0] })
    const b = body(box)
    const top = b.mesh.faceNames!.findIndex((n) => n[0] === `${box}:zmax`)
    const ref = encodeRef(refFromSelection({ kind: 'face', id: box, index: top }, [b])!)
    const del = await add('surfaceDeleteFace', { faces: [ref] })
    expect(feat(del).state, feat(del).error).toBe('ok')
    expect(body(box).surface).toBe(true)
    near(area(body(box)), 500)
    // Shell needs a solid
    const shell = await add('shell', { faces: [encodeRef(refFromSelection({ kind: 'face', id: box, index: 0 }, [body(box)])!)], thickness: 1, side: 'inside' })
    expect(feat(shell).state).toBe('error')
    expect(feat(shell).error).toMatch(/solid/)
    expect(feat(shell).error).toMatch(/open surface/)
  })
})

describe('the surface tools say what is wrong', () => {
  it('an extrude without curves, a trim by a surface that misses, a stitch of a solid', async () => {
    const none = await add('surfaceExtrude', { curves: [], direction: 'one', distance: 5, distance2: 5, axis: 'normal' })
    expect(feat(none).state).toBe('error')
    expect(feat(none).error).toMatch(/Select the curves/)
    const box = await add('box', { width: 10, depth: 10, height: 10, position: [0, 0, 0] })
    const stitch = await add('surfaceStitch', { surfaces: [box], tolerance: 0.01, solid: true })
    expect(feat(stitch).state).toBe('error')
    expect(feat(stitch).error).toMatch(/solid/)
  })
})
