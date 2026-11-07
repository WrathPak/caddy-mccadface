/** Real OpenCascade in Node: the cases that used to come back invalid or with the wrong volume (heal on a rounded corner, shell round fillets, pattern of a cut on a cylinder). */
import { beforeAll, describe, expect, it } from 'vitest'
import { getOC, measureVolume, type AnyShape } from 'replicad'
import { box, initOcc, topoOf } from './occ'
import { bodyFromShape, getBrep, getNamed, getOp, helpers } from './store'
import { boolNamed, boxNames } from './naming'
import { rotationAbout } from './xform'
import { computeFaceSigs, type Body } from './types'
import './model-ops'
import './modeling-ops'
import './solid-ops'

beforeAll(async () => { await initOcc() })
const run = async <T = Body>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T
const vol = (b: Body) => Math.abs(measureVolume(getBrep(b.key) as unknown as AnyShape as never))
const sound = (b: Body) => new (getOC() as unknown as { BRepCheck_Analyzer: new (s: unknown, g: boolean, x: boolean) => { IsValid(): boolean } }).BRepCheck_Analyzer((getBrep(b.key) as unknown as { wrapped: unknown }).wrapped, true, false).IsValid()
const near = (a: number, b: number, rel = 2e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
/** Mesh volume: what the viewport and the volume readout use. */
const meshVol = (b: Body) => {
  const m = b.mesh, P = m.positions, I = m.indices
  let v = 0
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3, q = I[k + 1] * 3, c = I[k + 2] * 3
    v += (P[a] * (P[q + 1] * P[c + 2] - P[q + 2] * P[c + 1]) - P[a + 1] * (P[q] * P[c + 2] - P[q + 2] * P[c]) + P[a + 2] * (P[q] * P[c + 1] - P[q + 1] * P[c])) / 6
  }
  return v
}

describe('solids fixes', () => {
  it('delete face heals a chain of fillets that runs round a rounded corner', async () => {
    const s2 = Math.SQRT1_2
    void s2
    const outer = [
      { k: 'l', a: [0, 0], b: [54, 0], id: 'l1' }, { k: 'a', a: [54, 0], m: [58.242640687119284, 1.7573593128807152], b: [60, 6], c: [54, 6], r: 6, ccw: true, id: 'l4' },
      { k: 'l', a: [60, 6], b: [60, 40], id: 'l7' }, { k: 'l', a: [60, 40], b: [0, 40], id: 'l9' }, { k: 'l', a: [0, 40], b: [0, 0], id: 'l11' },
    ]
    let b = await run('extrudeTool', { id: 'f2', name: 'b', groups: [{ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, profiles: [{ outer, holes: [] }] }], faces: [], mode: 'one', d1: 10, d2: 0, faceDir: 1 }) as Body
    const plain = vol(b)
    const edges = topoOf(getBrep(b.key) as unknown as AnyShape).edges
    const top = edges.map((e, i) => ({ m: e.pointAt(0.5), i })).filter((x) => Math.abs(x.m.z - 10) < 1e-6).map((x) => x.i)
    const chain = await run<number[]>('tangentChain', { key: b.key, edges: [top.find((i) => Math.abs(edges[i].pointAt(0.5).y) < 1e-6)!] })
    expect(chain.length).toBe(3)
    b = await run('edgeMod', { id: 'f2', name: 'b', key: b.key, edges: chain, size: 2, mode: 'fillet', fid: 'f4' })
    const rounded = b.mesh.faceNames!.map((n, i) => ({ n, i })).filter((x) => x.n[0]?.startsWith('f4:fillet')).map((x) => x.i)
    expect(rounded.length).toBe(3)
    const r = await run('deleteFaces', { id: 'f2', name: 'b', key: b.key, faces: rounded.map((i) => ({ index: i, names: b.mesh.faceNames![i] })), fid: 'f5' })
    near(vol(r), plain)
    near(meshVol(r), plain, 5e-3)
    expect(sound(r)).toBe(true)
  }, 120000)

  it('shell after a fillet on the top edges gives the real wall, also when the wall is thicker than the radius', async () => {
    const make = async (R: number) => {
      const bx = box([80, 50, 30], [0, 0, 0])
      let b = helpers.sendBody(bodyFromShape('b', 'b', bx, boxNames(bx, 'b'))) as unknown as Body
      const edges = topoOf(getBrep(b.key) as unknown as AnyShape).edges
      const idx = edges.map((e, i) => ({ m: e.pointAt(0.5), i })).filter((x) => Math.abs(x.m.z - 30) < 1e-6).map((x) => x.i)
      b = await run('edgeMod', { id: 'b', name: 'b', key: b.key, edges: idx, size: R, mode: 'fillet', fid: 'f3' })
      return b
    }
    for (const [R, T, want] of [[3, 1.5, 17000], [2, 3, 31900], [3, 6, 57500]] as const) {
      const b = await make(R)
      const top = computeFaceSigs(b.mesh).findIndex((s) => s.normal[2] > 0.99 && s.centroid[2] > 29.9)
      const r = await run('shellOp', { id: 'b', name: 'b', key: b.key, faces: [top], thickness: T, side: 'inside', fid: 'f4' })
      expect(sound(r)).toBe(true)
      near(vol(r), want, 0.02)
      near(meshVol(r), want, 0.02)
    }
  }, 180000)

  it('a circular pattern of a cut on a revolved neck removes twelve grooves, not twelve slabs', async () => {
    // the profile as a clicked sketch gives it: values a hair off the round numbers
    const L = (a: [number, number], b: [number, number], id: string) => ({ k: 'l', a, b, id })
    const outer = [
      L([0, 0], [18.000006420331378, 0], 'l4'), L([18.000006420331378, 0], [18.000006420331378, 5.999999307850821], 'l9'), L([18.000006420331378, 5.999999307850821], [13.999999116862138, 5.999999307850821], 'l14'),
      L([13.999999116862138, 5.999999307850821], [13.999999116862138, 19.999998424712953], 'l19'), L([13.999999116862138, 19.999998424712953], [7.105427357601002e-15, 19.999998424712953], 'l24'), L([7.105427357601002e-15, 19.999998424712953], [0, 0], 'l31'),
    ]
    const rev = await run('revolveTool', { id: 'r', name: 'r', groups: [{ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] }, profiles: [{ outer, holes: [] }] }], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 }) as Body
    // the groove: a lens of a 2 mm circle clipped by the neck, cut 14 deep (the neck radius is a hair off 14, as a clicked sketch is)
    const R = 13.999999116862138
    const lens = [
      { k: 'a', a: [13.964284829020123, -0.9993620395727899], b: [13.964284829199595, 0.9993620370649924], m: [R, -1.2571071089812143e-9], c: [0, -8.930222400386456e-16], r: R, ccw: true, id: 'l3' },
      { k: 'a', a: [13.964284829199595, 0.9993620370649924], b: [13.964284829020123, -0.9993620395727899], m: [R - 1, 8.979229131728315e-11], c: [R, -8.930222400386456e-16], r: 1, ccw: true, id: 'l7' },
    ]
    const tool = await run('extrudeTool', { id: 'f4', name: 'e', groups: [{ plane: { origin: [0, 0, 19.999998092651367], xDir: [1, 0, 0], normal: [0, 0, 1] }, profiles: [{ outer: lens, holes: [] }] }], faces: [], mode: 'one', d1: -14, d2: 5, faceDir: -1, taper: 0 }) as Body
    const cut = boolNamed('cut', getNamed(rev.key), getNamed(tool.key), 'c')
    const after = helpers.sendBody(bodyFromShape('r', 'r', cut.shape, cut.faces)) as unknown as Body
    const groove = vol(rev) - vol(after)
    expect(groove).toBeGreaterThan(10)
    const xforms = Array.from({ length: 11 }, (_, k) => rotationAbout([0, 0, 0], [0, 0, 1], 30 * (k + 1)))
    const r = await run('patternApply', { id: 'r', name: 'r', fid: 'p', current: after.key, before: rev.key, after: after.key, xforms }) as Body
    near(vol(r), vol(rev) - 12 * groove, 1e-3)
    near(meshVol(r), vol(rev) - 12 * groove, 5e-3)
    expect(sound(r)).toBe(true)
  }, 200000)
})
