/**
 * Builds a multi-color plate for scripts/slice-check-print.mjs through the app's own pipeline (painted B-rep faces, a body painted as a
 * whole, a mesh body, arrangement, the Bambu 3MF writer) and writes model.3mf plus a sidecar describing what was painted
 * to $PRINT_3MF_OUT. Skipped unless that variable is set.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { box, initOcc } from '@/kernel/occ'
import { initManifold } from '@/kernel/mesh'
import { bodyFromShape, bodyFromTopo, getOp, getTopo, helpers } from '@/kernel/store'
import type { ExportMesh } from '@/kernel/print-ops'
import '@/kernel/print-ops'
import type { Body } from '@/kernel/types'
import { applyPaint, type PaintMap } from './paint'
import { exportSlots, planPlate } from './plate'
import { defaultSettings } from './settings'
import { colorById } from './palette'
import { writeBambu3mf } from './threemf'
import { refFromSelection, encodeRef } from '@/doc/refs'

const out = process.env.PRINT_3MF_OUT

beforeAll(async () => { await Promise.all([initOcc(), initManifold()]) })

describe.skipIf(!out)('export the slicer check plate', () => {
  it('writes model.3mf and model.json', async () => {
    const block = bodyFromShape('block', 'Block', box([30, 30, 12], [0, 0, 0]))
    const cube = bodyFromShape('cube', 'Cube', box([20, 20, 20], [0, 0, 0]))
    const meshy = bodyFromTopo('meshy', 'Mesh slab', getTopo(bodyFromShape('tmp', 'tmp', box([24, 24, 8], [0, 0, 0])).key))
    const bodies: Body[] = [block, cube, meshy]
    // the +Z face of the block goes to filament 2, the whole cube to filament 3, the mesh slab stays on filament 1
    const topFace = block.mesh.faceIds[Array.from({ length: block.mesh.indices.length / 3 }, (_, t) => t).find((t) => block.mesh.normals[block.mesh.indices[t * 3] * 3 + (process.env.PAINT_AXIS === 'x' ? 0 : 2)] > 0.99)!]
    const paint: PaintMap = new Map()
    applyPaint(paint, bodies, [encodeRef(refFromSelection({ kind: 'face', id: 'block', index: topFace }, bodies)!)], 2)
    applyPaint(paint, bodies, ['cube'], 3)
    const meshes = (await getOp('printMeshes')!({ keys: bodies.map((b) => b.key) } as never, helpers)) as ExportMesh[]
    const settings = { ...defaultSettings(), layerHeight: 0.16, wallLoops: 4, infill: 25 }
    const items = bodies.map((b, i) => ({ name: b.name, mesh: meshes[i], slots: exportSlots(b, paint.get(b.id), meshes[i]) }))
    const plan = planPlate(items, settings)
    expect(plan.fits).toBe(true)
    const bytes = writeBambu3mf(plan.objects, plan.placements, settings)
    fs.mkdirSync(out!, { recursive: true })
    fs.writeFileSync(path.join(out!, 'model.3mf'), bytes)
    const tops = items[0].slots!
    const rect = (m: ExportMesh, off: number[]) => {
      const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity]
      for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], m.positions[i + k] + off[k]); hi[k] = Math.max(hi[k], m.positions[i + k] + off[k]) }
      return { lo, hi }
    }
    fs.writeFileSync(path.join(out!, 'model.json'), JSON.stringify({
      objects: items.map((it, i) => ({ name: it.name, extruder: i === 1 ? 3 : 1, rect: rect(it.mesh, plan.placements[i].offset), height: Math.max(...Array.from({ length: it.mesh.positions.length / 3 }, (_, k) => it.mesh.positions[k * 3 + 2])) })),
      blockSlot2Tris: tops.reduce((n, s) => n + (s === 2 ? 1 : 0), 0),
      settings: { layerHeight: settings.layerHeight, wallLoops: settings.wallLoops, infill: settings.infill },
      colours: [0, 1, 2].map((i) => colorById(settings.slotColors[i]).hex.toUpperCase()),
    }, null, 1))
  })
})
