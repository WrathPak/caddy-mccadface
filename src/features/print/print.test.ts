/** Paint, 3MF writer, plate layout, split and hollow feature logic, on real geometry. */
import { strFromU8, unzipSync } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import { box, initOcc } from '@/kernel/occ'
import { initManifold } from '@/kernel/mesh'
import { bodyFromShape, getOp, helpers } from '@/kernel/store'
import '@/kernel/model-ops'
import '@/kernel/print-ops'
import type { ExportMesh } from '@/kernel/print-ops'
import type { Body, Vec3 } from '@/kernel/types'
import { encodeRef, refFromSelection } from '@/doc/refs'
import type { Feature } from '@/doc/types'
import type { ParamDef, ParamSchema } from '@/ui/schema'
import { allFeatures } from '@/doc/registry'
import { applyPaint, computePaintMap, paintSchema, usedSlots } from './paint'
import { defaultSettings, printSettingsSchema } from './settings'
import { arrangeOnPlate, objectSlots, paintColorCode, projectConfig, slotFromPaintCode, writeBambu3mf } from './threemf'
import { exportSlots, planPlate } from './plate'
import { assignDrains, decodeDrain, distanceToMesh, encodeDrain, hollowSchema } from './hollow'
import { cutterOf, pathPoints, runSplit, splitSchema, type SplitP } from './split'
import { orientSchema } from './orientTool'
import { RefReport } from '@/doc/refs'

beforeAll(async () => { await Promise.all([initOcc(), initManifold()]) })

const call = async (name: string, args: unknown) => getOp(name)!(args as never, helpers)
const slab = (id = 'b', z = -10) => bodyFromShape(id, id, box([40, 30, 20], [0, 0, z]))
const faceWithNormal = (b: Body, n: Vec3) => {
  const m = b.mesh
  for (let t = 0; t < m.indices.length / 3; t++) {
    const i = m.indices[t * 3] * 3
    if (Math.abs(m.normals[i] - n[0]) + Math.abs(m.normals[i + 1] - n[1]) + Math.abs(m.normals[i + 2] - n[2]) < 1e-3) return m.faceIds[t]
  }
  return -1
}
const feature = (id: string, type: string, params: Feature['params']): Feature => ({ id, type, name: id, state: 'ok', suppressed: false, params })

describe('paint', () => {
  it('colors one face, a whole body, and later paints win', () => {
    const a = slab('a'), b = slab('b')
    const top = faceWithNormal(a, [0, 0, 1])
    const ref = encodeRef(refFromSelection({ kind: 'face', id: 'a', index: top }, [a, b])!)
    const map = new Map()
    expect(applyPaint(map, [a, b], [ref], 2)).toBe(1)
    const sa = map.get('a')!
    const paintedTris = sa.reduce((n: number, x: number) => n + (x === 2 ? 1 : 0), 0)
    expect(paintedTris).toBe(2) // a box face is two triangles
    expect(map.has('b')).toBe(false)
    applyPaint(map, [a, b], ['b'], 3)
    expect(map.get('b')!.every((x: number) => x === 3)).toBe(true)
    applyPaint(map, [a, b], ['a'], 4) // a whole-body paint covers the earlier face paint
    expect(map.get('a')!.every((x: number) => x === 4)).toBe(true)
    applyPaint(map, [a, b], ['a'], 0) // clear
    expect(map.get('a')!.every((x: number) => x === 0)).toBe(true)
  })

  it('reports references that no longer resolve', () => {
    const a = slab('a')
    const report = new RefReport()
    expect(applyPaint(new Map(), [a], ['gone'], 2, report)).toBe(0)
    expect(report.lostRefs).toEqual(['gone'])
  })

  it('computes the map from the active Paint features only', () => {
    const a = slab('a')
    const feats = [feature('f1', 'paint', { targets: ['a'], slot: '2' }), feature('f2', 'paint', { targets: ['a'], slot: '3' }), feature('f3', 'box', {})]
    expect(usedSlots(computePaintMap(feats, 3, [a]))).toEqual([3])
    expect(usedSlots(computePaintMap(feats, 1, [a]))).toEqual([2]) // rolled back before the second paint
    feats[1].suppressed = true
    expect(usedSlots(computePaintMap(feats, 3, [a]))).toEqual([2])
    expect(computePaintMap([feature('f', 'paint', { targets: ['a'], slot: '0' })], 1, [a]).size).toBe(0)
  })
})

describe('3MF writer', () => {
  const tri = (): { positions: Float32Array; indices: Uint32Array } => ({ positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) })

  it('paint codes round trip for every slot', () => {
    for (let s = 1; s <= 8; s++) expect(slotFromPaintCode(paintColorCode(s))).toBe(s)
    expect(paintColorCode(1)).toBe('4')
    expect(paintColorCode(2)).toBe('8')
    expect(paintColorCode(3)).toBe('0C')
  })

  it('splits triangle slots into the object filament and the exceptions', () => {
    expect(objectSlots(undefined, 4)).toEqual({ extruder: 1, tris: new Map() })
    expect(objectSlots(Uint8Array.from([3, 3, 3, 3]), 4)).toEqual({ extruder: 3, tris: new Map() })
    const mixed = objectSlots(Uint8Array.from([0, 0, 2, 0]), 4)
    expect(mixed.extruder).toBe(1)
    expect([...mixed.tris]).toEqual([[2, 2]])
  })

  it('writes names, filaments, placement and settings the slicers read', () => {
    const s = { ...defaultSettings(), layerHeight: 0.16, wallLoops: 4, infill: 25, support: 'tree' as const, overhang: 50 }
    const bytes = writeBambu3mf(
      [{ name: 'Lid & <base>', ...tri(), slots: Uint8Array.from([0, 2, 0, 0]) }, { name: 'Pin', ...tri(), slots: Uint8Array.from([3, 3, 3, 3]) }],
      [{ offset: [100, 120, 0] }, { offset: [140, 120, 5] }], s,
    )
    const z = unzipSync(bytes)
    expect(Object.keys(z)).toEqual(expect.arrayContaining(['3D/3dmodel.model', 'Metadata/model_settings.config', 'Metadata/project_settings.config', '3D/Objects/object_1.model', '3D/Objects/object_2.model']))
    const ms = strFromU8(z['Metadata/model_settings.config'])
    expect(ms).toContain('value="Lid &amp; &lt;base&gt;"')
    expect([...ms.matchAll(/<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"\/>\s*<metadata key="extruder" value="(\d+)"/g)].map((m) => m.slice(1, 4).join(':'))).toEqual(['2:Lid &amp; &lt;base&gt;:1', '4:Pin:3'])
    const o1 = strFromU8(z['3D/Objects/object_1.model'])
    expect(o1.match(/paint_color="8"/g)).toHaveLength(1)
    expect(strFromU8(z['3D/Objects/object_2.model'])).not.toContain('paint_color')
    const model = strFromU8(z['3D/3dmodel.model'])
    expect(model).toContain('transform="1 0 0 0 1 0 0 0 1 100 120 0"')
    expect(model).toContain('transform="1 0 0 0 1 0 0 0 1 140 120 5"')
    expect(model).toMatch(/Application">BambuStudio-/)
    const cfg = JSON.parse(strFromU8(z['Metadata/project_settings.config']))
    expect(cfg).toMatchObject({ layer_height: '0.16', wall_loops: '4', sparse_infill_density: '25%', enable_support: '1', support_type: 'tree(auto)', support_threshold_angle: '40' })
    // three filaments are needed (the pin uses slot 3): every list has three entries, the purge tables 3x3 and 2x3
    expect(cfg.filament_colour).toHaveLength(3)
    expect(cfg.filament_settings_id).toHaveLength(3)
    expect(cfg.flush_volumes_matrix).toHaveLength(9)
    expect(cfg.flush_volumes_vector).toHaveLength(6)
    expect(cfg.filament_colour[0]).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('project config keeps lists in step with the filament count', () => {
    for (const n of [1, 2, 8]) {
      const c = projectConfig(defaultSettings(), n) as Record<string, unknown[]>
      expect(c.filament_colour).toHaveLength(n)
      expect(c.filament_type).toHaveLength(n)
      expect(c.flush_volumes_matrix).toHaveLength(n * n)
    }
  })
})

describe('plate layout', () => {
  const overlap = (a: { c: [number, number]; w: number; d: number }, b: { c: [number, number]; w: number; d: number }) =>
    Math.abs(a.c[0] - b.c[0]) < (a.w + b.w) / 2 && Math.abs(a.c[1] - b.c[1]) < (a.d + b.d) / 2
  it('arranges footprints without overlap, on the plate and centred', () => {
    const fp = [{ w: 60, d: 40 }, { w: 30, d: 30 }, { w: 80, d: 20 }, { w: 50, d: 50 }, { w: 25, d: 10 }]
    const { centres, fits } = arrangeOnPlate(fp, [256, 256])
    expect(fits).toBe(true)
    const items = fp.map((f, i) => ({ ...f, c: centres[i] }))
    for (let i = 0; i < items.length; i++) {
      expect(items[i].c[0] - items[i].w / 2).toBeGreaterThanOrEqual(0)
      expect(items[i].c[0] + items[i].w / 2).toBeLessThanOrEqual(256)
      expect(items[i].c[1] - items[i].d / 2).toBeGreaterThanOrEqual(0)
      expect(items[i].c[1] + items[i].d / 2).toBeLessThanOrEqual(256)
      for (let j = i + 1; j < items.length; j++) expect(overlap(items[i], items[j])).toBe(false)
    }
    const lo = Math.min(...items.map((i) => i.c[1] - i.d / 2)), hi = Math.max(...items.map((i) => i.c[1] + i.d / 2))
    expect(Math.abs((lo + hi) / 2 - 128)).toBeLessThan(0.5)
  })
  it('says when the parts do not fit', () => {
    expect(arrangeOnPlate([{ w: 200, d: 200 }, { w: 200, d: 200 }], [256, 256]).fits).toBe(false)
  })

  it('plans painted bodies from real print meshes: grounded, arranged, slots follow the faces', async () => {
    const a = slab('a', 5), b = slab('b', 0)
    const meshes = (await call('printMeshes', { keys: [a.key, b.key] })) as ExportMesh[]
    const top = faceWithNormal(a, [0, 0, 1])
    const paint = new Map()
    applyPaint(paint, [a, b], [encodeRef(refFromSelection({ kind: 'face', id: 'a', index: top }, [a, b])!)], 2)
    const slotsA = exportSlots(a, paint.get('a'), meshes[0])!
    expect(slotsA).not.toBeNull()
    expect(slotsA.length).toBe(meshes[0].indices.length / 3)
    // only the triangles of the top face carry the slot
    let n = 0
    for (let t = 0; t < slotsA.length; t++) if (slotsA[t] === 2) { n++; expect(meshes[0].faceIds[t]).toBe(meshes[0].faceIds[slotsA.findIndex((x) => x === 2)]) }
    expect(n).toBe(2)
    expect(exportSlots(b, paint.get('b'), meshes[1])).toBeNull()
    const plan = planPlate([{ name: 'a', mesh: meshes[0], slots: slotsA }, { name: 'b', mesh: meshes[1], slots: null }], defaultSettings())
    expect(plan.fits).toBe(true)
    // each body sits on the plate: its lowest point plus the placement is z = 0
    expect(plan.placements[0].offset[2]).toBeCloseTo(-5, 4)
    expect(plan.placements[1].offset[2]).toBeCloseTo(0, 4)
  })
})

describe('split feature', () => {
  const base: SplitP = { bodies: ['b'], mode: 'plane', plane: 'XY', face: [], offset: 0, sketch: [], connector: 'none', count: 2, size: 6, depth: 6, clearance: 0.2, angle: 15 }
  const env = (bodies: Body[], data: Record<string, unknown> = {}) => ({ bodies, dataOf: (id: string) => data[id] })
  const ids = (n: number) => `s.${n}`

  it('cuts along a flat face, offset along its normal', async () => {
    const b = slab()
    const top = faceWithNormal(b, [0, 0, 1])
    const ref = encodeRef(refFromSelection({ kind: 'face', id: 'b', index: top }, [b])!)
    const cutter = cutterOf({ ...base, plane: 'face', face: [ref], offset: -4 }, env([b]), new RefReport())
    expect(cutter).toMatchObject({ kind: 'plane' })
    if (cutter.kind === 'plane') { expect(cutter.origin[2]).toBeCloseTo(6, 3); expect(cutter.normal[2]).toBeCloseTo(1, 3) }
    const r = await runSplit({ ...base, plane: 'face', face: [ref], offset: -4 }, env([b]), call, ids, 'f')
    expect(r.bodies).toHaveLength(2)
  })

  it('splits several bodies and skips the ones the cut misses', async () => {
    const a = slab('a'), c = bodyFromShape('c', 'c', box([10, 10, 5], [200, 0, 0]))
    const r = await runSplit({ ...base, bodies: ['a', 'c'] }, env([a, c]), call, ids, 'f')
    expect(r.bodies.map((x) => x.id)).toEqual(['a', 's.1'])
    expect(r.warning).toMatch(/c is not touched/)
    await expect(runSplit({ ...base, bodies: ['c'] }, env([c]), call, ids, 'f')).rejects.toThrow(/does not go through/)
  })

  it('turns a sketch line (with an arc) into a path and cuts with it', async () => {
    const data = {
      plane: { origin: [0, 0, 0] as Vec3, xDir: [1, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 },
      entities: [
        { id: 'p1', type: 'point', x: -30, y: 5 }, { id: 'p2', type: 'point', x: 30, y: 5 }, { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' },
      ],
      constraints: [], profiles: [],
    }
    const b = slab()
    const r = await runSplit({ ...base, mode: 'sketch', sketch: ['sk'] }, env([b], { sk: data }), call, ids, 'f')
    expect(r.bodies).toHaveLength(2)
    expect(r.cutter.kind).toBe('path')
    const arc = pathPoints([{ k: 'a', a: [0, 0, 0], m: [5, 5, 0], b: [10, 0, 0] }])
    expect(arc.length).toBeGreaterThan(10)
    for (const p of arc) expect(Math.hypot(p[0] - 5, p[1], p[2])).toBeCloseTo(5, 3) // on the circle through the three points
    expect(Math.max(...arc.map((p) => p[1]))).toBeCloseTo(5, 1) // and it bulges through the middle point
  })

  it('refuses a missing sketch with a readable error', () => {
    expect(() => cutterOf({ ...base, mode: 'sketch', sketch: [] }, env([slab()]), new RefReport())).toThrow(/Pick a sketch/)
  })
})

describe('hollow feature', () => {
  it('drain holes survive encoding and find the body whose surface they sit on', () => {
    const a = slab('a'), c = bodyFromShape('c', 'c', box([10, 10, 10], [100, 0, 0]))
    const d1 = { p: [0, 0, 10] as Vec3, n: [0, 0, 1] as Vec3 }, d2 = { p: [100, 0, 10] as Vec3, n: [0, 0, 1] as Vec3 }, far = { p: [50, 50, 50] as Vec3, n: [0, 0, 1] as Vec3 }
    expect(decodeDrain(encodeDrain(d1))).toEqual(d1)
    expect(decodeDrain('nonsense')).toBeNull()
    const per = assignDrains([d1, d2, far], [a, c])
    expect(per.get('a')).toHaveLength(1)
    expect(per.get('c')).toHaveLength(1)
    expect([...per.values()].flat()).toHaveLength(2) // the one floating in air belongs to nobody
    expect(distanceToMesh([0, 0, 13], a.mesh)).toBeCloseTo(3, 4)
    expect(distanceToMesh([0, 0, 10], a.mesh)).toBeCloseTo(0, 4)
  })
})

describe('every setting explains itself', () => {
  it('has help text on each parameter of the Print dialogs', () => {
    const missing = (schema: ParamSchema) => {
      const out: string[] = []
      const walk = (defs: ParamDef[]) => defs.forEach((d) => (d.type === 'group' ? walk(d.children) : !d.help || d.help.trim().length < 12 ? out.push(`${schema.id}.${d.key}`) : null))
      walk(schema.params)
      return out
    }
    const types = new Set(allFeatures().map((f) => f.type))
    for (const t of ['printSettings', 'paint', 'split', 'hollow']) expect(types.has(t)).toBe(true)
    for (const s of [printSettingsSchema, paintSchema, splitSchema, hollowSchema, orientSchema]) expect(missing(s)).toEqual([])
  })
})
