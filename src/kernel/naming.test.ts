/** Name derivation in the worker ops (extrude, revolve, chamfer, shell, boolean), run directly in Node. */
import { beforeAll, describe, expect, it } from 'vitest'
import { box, initOcc } from './occ'
import { bodyFromShape, getOp, helpers } from './store'
import { api } from './api'
import { type Body } from './types'
import type { Loop, PlaneDef } from '../sketch/types'
import { RefReport, edgeSigs, faceSigs, refFromSelection, resolveFace, type FaceRef } from '../doc/refs'

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
const run = async <T = Body>(name: string, args: unknown) => (await getOp(name)!(args as never, helpers)) as T
const rect = (w: number, h: number, ids: string[]): Loop => [
  { k: 'l', a: [0, 0], b: [w, 0], id: ids[0] }, { k: 'l', a: [w, 0], b: [w, h], id: ids[1] },
  { k: 'l', a: [w, h], b: [0, h], id: ids[2] }, { k: 'l', a: [0, h], b: [0, 0], id: ids[3] },
]
const extrudeArgs = (id: string, outer: Loop, d: number, extra: object = {}) => ({
  id, name: id, faces: [], mode: 'one', d1: d, d2: 0, faceDir: 1,
  groups: [{ plane: XY, profiles: [{ outer, holes: [] }] }], ...extra,
})
const names = (b: Body) => b.mesh.faceNames!.map((n) => n[0]).sort()

beforeAll(async () => { await initOcc() })

describe('worker op names', () => {
  it('extrude: side walls are named after the sketch entities, caps after the profile', async () => {
    const b = await run('extrudeTool', extrudeArgs('f1', rect(10, 5, ['l1', 'l2', 'l3', 'l4']), 3))
    expect(names(b)).toEqual(['f1:end:l1+l2+l3+l4', 'f1:side:l1', 'f1:side:l2', 'f1:side:l3', 'f1:side:l4', 'f1:start:l1+l2+l3+l4'])
  })

  it('the same sketch edited (taller, wider) gets exactly the same names; tapered caps keep theirs', async () => {
    const a = await run('extrudeTool', extrudeArgs('f1', rect(10, 5, ['l1', 'l2', 'l3', 'l4']), 3))
    const b = await run('extrudeTool', extrudeArgs('f1', rect(30, 8, ['l1', 'l2', 'l3', 'l4']), 12))
    expect(names(b)).toEqual(names(a))
    const t = await run('extrudeTool', extrudeArgs('f1', rect(10, 5, ['l1', 'l2', 'l3', 'l4']), 3, { taper: 5 }))
    expect(names(t)).toContain('f1:start:l1+l2+l3+l4')
    expect(names(t)).toContain('f1:end:l1+l2+l3+l4')
  })

  it('a segment split in two by another curve yields ~0 / ~1 children that keep the parent name as alias', async () => {
    const loop: Loop = [
      { k: 'l', a: [0, 0], b: [5, 0], id: 'l1' }, { k: 'l', a: [5, 0], b: [10, 0], id: 'l1' },
      { k: 'l', a: [10, 0], b: [10, 5], id: 'l2' }, { k: 'l', a: [10, 5], b: [0, 5], id: 'l3' }, { k: 'l', a: [0, 5], b: [0, 0], id: 'l4' },
    ]
    const b = await run('extrudeTool', extrudeArgs('f1', loop, 3))
    const n = b.mesh.faceNames!
    const kids = n.filter((x) => x[0].startsWith('f1:side:l1~'))
    expect(kids).toHaveLength(2)
    expect(kids.map((k) => k[0])).toEqual(expect.arrayContaining(['f1:side:l1~0', 'f1:side:l1~1']))
    expect(kids.every((k) => k.includes('f1:side:l1'))).toBe(true)
  })

  it('join onto a face: the base keeps its names and the new faces get the extrude feature', async () => {
    const base = await api.makeBox({ id: 'b0', name: 'b0', size: [20, 20, 5], position: [0, 0, 0] })
    const tool = await run('extrudeTool', extrudeArgs('f2', rect(4, 4, ['l1', 'l2', 'l3', 'l4']), 6))
    const r = await api.boolean({ id: 'b0', name: 'b0', op: 'union', base: base.key, tools: [tool.key], fid: 'f2' })
    const n = names(r)
    expect(n).toContain('b0:xmax')
    expect(n).toContain('b0:zmin')
    expect(n.filter((x) => x.startsWith('f2:side:'))).toHaveLength(4)
    // the box top is still one face (with the footprint of the tool cut out of it), and it kept its name
    expect(n.filter((x) => x.startsWith('b0:zmax'))).toHaveLength(1)
    // names are unique within a body
    expect(new Set(n).size).toBe(n.length)
  })

  it('chamfer: the new face is named after the edge it was cut from', async () => {
    const b = bodyFromShape('b', 'b', box([10, 10, 10], [0, 0, 0]))
    const e = edgeSigs(b).findIndex((s) => Math.abs(s.direction[2]) < 0.01 && Math.abs(s.midpoint[2] - 10) < 1e-6 && s.midpoint[0] > 4)
    const c = await run('edgeMod', { id: 'b', name: 'b', key: b.key, edges: [e], size: 1, mode: 'chamfer', fid: 'f9' })
    expect(names(c).filter((x) => x.startsWith('f9:chamfer:'))).toHaveLength(1)
  })

  it('revolve: the walls come from the profile segments', async () => {
    const outer = rect(4, 10, ['l1', 'l2', 'l3', 'l4']).map((s) => ({ ...s })) as Loop
    const sh = (loop: Loop): Loop => loop.map((s) => (s.k === 'l' ? { ...s, a: [s.a[0] + 3, s.a[1]], b: [s.b[0] + 3, s.b[1]] } : s)) as Loop
    const r = await run('revolveTool', { id: 'f5', name: 'f5', groups: [{ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] }, profiles: [{ outer: sh(outer), holes: [] }] }], axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angle: 360 })
    expect(names(r).some((x) => x.startsWith('f5:rev:l'))).toBe(true)
    expect(names(r).filter((x) => x.startsWith('f5:rev:')).length).toBeGreaterThanOrEqual(3)
  })

  it('shell: walls are named from the faces they mirror, the open rim keeps the removed face name', async () => {
    const b = await api.makeBox({ id: 'b0', name: 'b0', size: [20, 20, 20], position: [0, 0, 0] })
    const top = faceSigs(b).findIndex((s) => s.normal[2] > 0.99)
    const s = await run('shellOp', { id: 'b0', name: 'b0', key: b.key, faces: [top], thickness: 2, side: 'inside', fid: 'f7' })
    const n = names(s)
    expect(n.filter((x) => x.startsWith('f7:inner:'))).toHaveLength(5)
    expect(n.filter((x) => x === 'b0:zmax')).toHaveLength(1)
  })
})

describe('mesh bodies', () => {
  it('names are (feature, segment index); a re-cut mesh is re-bound by signature with a warning', async () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 5, 1, 0, 5, 0, 1, 5])
    const idx = new Uint32Array([0, 1, 2, 3, 4, 5])
    const m = await api.createMesh({ id: 'm1', name: 'm1', positions: pos, indices: idx, creaseDeg: 30 })
    const body: Body = { ...m, featureId: 'f3' }
    const sigs = faceSigs(body)
    expect(sigs.length).toBeGreaterThan(1)
    const ref = refFromSelection({ kind: 'face', id: 'm1', index: 1 }, [body])!
    expect((ref as FaceRef).name).toBe('seg:1')
    const same = resolveFace(ref as FaceRef, [body], new RefReport())
    expect(same!.index).toBe(1)
    // the segmentation changed under the ref: segment 1 is now somewhere else entirely
    const moved = { ...(ref as FaceRef), sig: { ...(ref as FaceRef).sig, normal: [1, 0, 0] as [number, number, number], centroid: [0, 0, 5] as [number, number, number] } }
    const report = new RefReport()
    const r = resolveFace(moved, [body], report)
    expect(r === null || report.rebound.size === 1).toBe(true)
  })
})
