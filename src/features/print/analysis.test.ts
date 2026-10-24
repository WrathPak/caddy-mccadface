/** Overhang, thin wall, small feature and auto orient maths on real OpenCascade geometry. */
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCylinder } from 'replicad'
import { box, initOcc, type Shape } from '@/kernel/occ'
import { initManifold } from '@/kernel/mesh'
import { bodyFromShape, getOp, helpers } from '@/kernel/store'
import '@/kernel/model-ops'
import '@/kernel/print-ops'
import { eulerFromMatrix, rotationBetween } from '@/kernel/print-geom'
import { composeTransform, type Body, type Vec3 } from '@/kernel/types'
import { heightRange, overhangMap, smallFeatures, thinWallMap, triInfo, type MeshIn } from './analysis'
import { autoOrient, candidateDirections, orientMove, transformed } from './orient'

beforeAll(async () => { await Promise.all([initOcc(), initManifold()]) })

const body = (s: Shape, id = 'b') => bodyFromShape(id, id, s)
const meshOf = (b: Body): MeshIn => ({ positions: b.mesh.positions, indices: b.mesh.indices, faceIds: b.mesh.faceIds })
const fuse = (a: Shape, b: Shape) => a.fuse(b) as Shape
const near = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))

/** A plate on a post: the underside of the plate is a flat ceiling. */
const tee = () => fuse(box([10, 10, 20], [0, 0, 0]), box([60, 60, 4], [0, 0, 20]))

describe('overhang map', () => {
  it('flags the flat ceiling of a T and nothing that lies on the plate', () => {
    const m = meshOf(body(tee()))
    const info = triInfo(m)
    const r = overhangMap(m, info, 45)
    near(r.area, 60 * 60 - 10 * 10)
    near(r.contact, 100)
    // every flagged triangle faces straight down
    for (let t = 0; t < info.count; t++) if (r.severity[t] > 0) expect(info.n[t * 3 + 2]).toBeCloseTo(-1, 3)
  })

  it('judges the angle from vertical: 60 degrees leans too far for 45, 30 degrees does not', () => {
    const lean = (deg: number): MeshIn => {
      // a quad whose normal points down and tilts by `deg` from straight down... built as two triangles
      const a = (deg * Math.PI) / 180
      const u: Vec3 = [Math.cos(a), 0, Math.sin(a)]
      const v: Vec3 = [0, 1, 0]
      const P = (s: number, t: number) => [u[0] * s + v[0] * t + 5, u[1] * s + v[1] * t, u[2] * s + v[2] * t + 5]
      return { positions: Float32Array.from([...P(0, 0), ...P(10, 0), ...P(10, 10), ...P(0, 10), 0, 0, 0]), indices: Uint32Array.from([0, 2, 1, 0, 3, 2]) }
    }
    // a surface tilted `deg` from horizontal (ceiling) leans (90 - ... ) : here its normal is `deg` away from straight down
    const flat = overhangMap(lean(20), triInfo(lean(20)), 45) // 20 deg off a ceiling: 70 deg from vertical, flagged
    expect(flat.area).toBeGreaterThan(0)
    const steep = overhangMap(lean(60), triInfo(lean(60)), 45) // 60 deg off a ceiling: 30 deg from vertical, fine
    expect(steep.area).toBe(0)
  })

  it('a different build direction changes the answer', () => {
    const m = meshOf(body(tee()))
    // upside down the plate lies on the bed and the post points up: nothing hangs over
    const r = overhangMap(m, triInfo(m), 45, [0, 0, -1])
    near(r.contact, 3600)
    near(r.area, 0, 1) // nothing but the post end (on top now, facing up)
    expect(r.area).toBeLessThan(1)
  })
})

describe('thin walls', () => {
  it('flags the faces of a thin plate, not a thick block', async () => {
    const plate = meshOf(body(box([40, 40, 0.3], [0, 0, 0])))
    const r = await thinWallMap(plate, triInfo(plate), 0.8)
    near(r.area, 2 * 1600)
    near(r.thinnest, 0.3, 0.02)
    const block = meshOf(body(box([20, 20, 20], [0, 0, 0])))
    const rb = await thinWallMap(block, triInfo(block), 0.8)
    expect(rb.area).toBe(0)
    near(rb.thinnest, 20, 0.02)
  })

  it('finds the thin side of an uneven part', async () => {
    // a block with a 0.5 mm fin standing on it: the fin's two big faces are thin, the block is not
    const fin = fuse(box([30, 30, 10], [0, 0, 0]), box([0.5, 20, 8], [0, 0, 10]))
    const m = meshOf(body(fin))
    const info = triInfo(m)
    const r = await thinWallMap(m, info, 0.8)
    near(r.area, 2 * 20 * 8, 0.03)
    // the flagged triangles are the fin's faces (x = +-0.25, z above the block)
    for (let t = 0; t < info.count; t++) if (r.severity[t] > 0) {
      expect(Math.abs(info.c[t * 3])).toBeLessThanOrEqual(0.2501)
      expect(info.c[t * 3 + 2]).toBeGreaterThan(9.99)
    }
  })

  it('flags both skins of a hollowed body', async () => {
    const b = body(box([30, 30, 30], [0, 0, 0]))
    const h = (await getOp('printHollow')!({ id: 'h', name: 'h', key: b.key, thickness: 0.5, drains: [], diameter: 2, fid: 'h' } as never, helpers)) as Body
    const m = meshOf(h)
    const r = await thinWallMap(m, triInfo(m), 0.8)
    near(r.area, 6 * 900 + 6 * 29 * 29, 0.03)
  })
})

describe('small features', () => {
  it('flags a thin pin and a tiny fillet but not the big faces', () => {
    const pin = fuse(box([30, 30, 10], [0, 0, 0]), box([0.3, 0.3, 6], [0, 0, 10]))
    const m = meshOf(body(pin))
    const r = smallFeatures(m, triInfo(m), 0.4)
    // four sides and the top of the pin
    expect(r.faces).toHaveLength(5)
    expect(r.faces.every((f) => f.size < 0.35)).toBe(true)
    expect(r.faces[0].centre[2]).toBeGreaterThan(9.9)
    expect(smallFeatures(m, triInfo(m), 0.2).faces).toHaveLength(0)
  })

  it('reads a pin of round section by its diameter', () => {
    const pin = fuse(box([30, 30, 10], [0, 0, 0]), makeCylinder(0.15, 6, [0, 0, 10], [0, 0, 1]) as unknown as Shape)
    const m = meshOf(body(pin))
    const r = smallFeatures(m, triInfo(m), 0.4)
    expect(r.faces.length).toBe(2) // side and top cap
    for (const f of r.faces) near(f.size, 0.3, 0.1)
  })

  it('reports nothing for a plain box', () => {
    const m = meshOf(body(box([20, 20, 20], [0, 0, 0])))
    expect(smallFeatures(m, triInfo(m), 0.4).faces).toHaveLength(0)
  })
})

describe('auto orient', () => {
  /** An L bracket (base 60 x 30 x 6, wall 6 x 30 x 30) turned upside down and tipped 35 degrees: the base now hangs off the wall at a slant. */
  const lyingL = () => {
    const l = fuse(box([60, 30, 6], [0, 0, 0]), box([6, 30, 30], [27, 0, 0]))
    return (l.rotate(180, [0, 0, 0], [0, 1, 0]) as Shape).rotate(35, [0, 0, 0], [1, 0, 0]) as Shape
  }

  it('finds an orientation with no overhang and applies it as a Move that sits the part on the plate', () => {
    const b = body(lyingL())
    const m = meshOf(b)
    const info = triInfo(m)
    const before = overhangMap(m, info, 45)
    const res = autoOrient(m, { angle: 45, goal: 'support' })
    expect(before.area).toBeGreaterThan(500)
    expect(res.ranked[0].overhangArea).toBeLessThan(before.area)
    expect(res.ranked[0].overhangArea).toBeLessThan(1)
    expect(res.ranked[0].supportVolume).toBeLessThan(1)
    // the Move values really give that orientation, resting on z = 0
    const mv = orientMove(m, res.ranked[0].down)
    const after = transformed(m, mv)
    const { min } = heightRange(after, [0, 0, 1])
    expect(min).toBeCloseTo(0, 3)
    expect(overhangMap(after, triInfo(after), 45).area).toBeLessThan(1)
  })

  it('weighs the support volume: a wedge-free orientation beats a smaller overhang with a tall support', () => {
    const t = meshOf(body(tee()))
    const res = autoOrient(t, { angle: 45, goal: 'support' })
    // the T is best printed plate-down (no support at all)
    expect(res.ranked[0].supportVolume).toBeLessThan(1)
    expect(res.current.supportVolume).toBeGreaterThan(1000) // plate over a 20 mm post
    expect(res.ranked[0].down[2]).toBeGreaterThan(0.99)
  })

  it('the overhang goal minimises the area instead', () => {
    const m = meshOf(body(lyingL()))
    const res = autoOrient(m, { angle: 45, goal: 'overhang' })
    expect(res.ranked[0].overhangArea).toBeLessThan(1)
  })

  it('offers the flat faces of the part as candidate bottoms', () => {
    const m = meshOf(body(lyingL()))
    const dirs = candidateDirections(triInfo(m))
    // the L has a flat face with normal -X (after the turn): it must be among the candidates
    expect(dirs.some((d) => Math.abs(d[0]) > 0.99 || Math.abs(d[2]) > 0.99)).toBe(true)
    expect(dirs.length).toBeGreaterThan(30)
  })
})

describe('rotation helpers', () => {
  it('rotationBetween maps a onto b, and eulerFromMatrix agrees with composeTransform', () => {
    const cases: [Vec3, Vec3][] = [[[1, 0, 0], [0, 0, -1]], [[0, 0, 1], [0, 0, -1]], [[0.3, -0.5, 0.8], [0, 0, -1]], [[0, 0, -1], [0, 0, -1]], [[0.6, 0.0, 0.8], [0, 0, -1]]]
    for (const [a0, b] of cases) {
      const l = Math.hypot(...a0)
      const a: Vec3 = [a0[0] / l, a0[1] / l, a0[2] / l]
      const R = rotationBetween(a, b)
      const mapped = [R[0] * a[0] + R[1] * a[1] + R[2] * a[2], R[3] * a[0] + R[4] * a[1] + R[5] * a[2], R[6] * a[0] + R[7] * a[1] + R[8] * a[2]]
      expect(mapped[0]).toBeCloseTo(b[0], 6); expect(mapped[1]).toBeCloseTo(b[1], 6); expect(mapped[2]).toBeCloseTo(b[2], 6)
      const e = eulerFromMatrix(R)
      const M = composeTransform({ pivot: [0, 0, 0], translate: [0, 0, 0], rotate: e, scale: 1 })
      const viaEuler = [M[0] * a[0] + M[4] * a[1] + M[8] * a[2], M[1] * a[0] + M[5] * a[1] + M[9] * a[2], M[2] * a[0] + M[6] * a[1] + M[10] * a[2]]
      expect(viaEuler[0]).toBeCloseTo(b[0], 5); expect(viaEuler[1]).toBeCloseTo(b[1], 5); expect(viaEuler[2]).toBeCloseTo(b[2], 5)
    }
  })
})
