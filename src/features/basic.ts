/** Built-in features: Box primitive, Delete body, Import mesh (STL/3MF), Import STEP. */
import * as Comlink from 'comlink'
import { Cube, GridFour, Package, Trash } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import type { FeatureCtx } from '@/doc/types'
import { bodyIdsOf } from '@/doc/refs'
import { parseStl } from '@/io/stl'
import { parse3mf } from '@/io/threemf'
import { parseObj } from '@/io/obj'
import { placementShift, shiftAll, UNIT_FACTOR, type Placement } from '@/io/place'
import { resolveParams } from '@/doc/params'
import { getKernel } from '@/kernel/client'
import { importMeshPooled, POOL_IMPORT_BYTES, sourceOf } from '@/io/meshImport'
import { clearPreview, resetManip, setPreview } from '@/viewport/preview'
import { createRunner } from './previewKit'
import { showArrows } from './handleKit'
import type { ParamSchema, ParamValues } from '@/ui/schema'

export const boxSchema: ParamSchema = {
  id: 'box',
  title: 'Box',
  params: [
    { type: 'number', key: 'width', help: 'Size of the box along the X axis, in mm.', label: 'Width (X)', unit: 'mm', min: 0.001, step: 1, default: 20 },
    { type: 'number', key: 'depth', help: 'Size of the box along the Y axis, in mm.', label: 'Depth (Y)', unit: 'mm', min: 0.001, step: 1, default: 20 },
    { type: 'number', key: 'height', help: 'Size of the box along the Z (vertical) axis, in mm.', label: 'Height (Z)', unit: 'mm', min: 0.001, step: 1, default: 20 },
    { type: 'vector3', key: 'position', help: 'Where the middle of the box bottom sits, as X, Y, Z in mm. 0, 0, 0 is the origin.', label: 'Base center', unit: 'mm', step: 1, default: [0, 0, 0] },
  ],
}

registerFeature({
  type: 'box',
  label: 'Box',
  icon: Cube,
  schema: boxSchema,
  async compute(ctx, p) {
    const [px, py, pz] = p.position as [number, number, number]
    const w = p.width as number, d = p.depth as number, h = p.height as number
    const body = await ctx.kernel.makeBox({ id: ctx.newBodyId(), name: ctx.feature.name, size: [w, d, h], position: [px, py, pz] })
    return { bodies: [body] }
  },
  preview({ values, setValues }) {
    let cur: ParamValues = values
    const runner = createRunner(async (stale) => {
      let p: ParamValues
      try { p = resolveParams(boxSchema, cur) } catch { clearPreview(); resetManip(); return }
      const [px, py, pz] = p.position as [number, number, number]
      // one arrow per size: the height from the middle of the base up, width and depth from the middle of the box out to the faces
      // (the faces move with the pointer, so those arrows edit half the size)
      const h = p.height as number
      showArrows([
        { origin: [px, py, pz], dir: [0, 0, 1], key: 'height', min: 0.001 },
        { origin: [px, py, pz + h / 2], dir: [1, 0, 0], key: 'width', factor: 2, min: 0.001 },
        { origin: [px, py, pz + h / 2], dir: [0, 1, 0], key: 'depth', factor: 2, min: 0.001 },
      ], p, (patch) => { cur = { ...cur, ...patch }; setValues(cur) })
      const body = await getKernel().makeBox({ id: 'preview', name: 'preview', size: [p.width as number, p.depth as number, p.height as number], position: [px, py, pz] })
      if (!stale()) setPreview([{ mesh: body.mesh, kind: 'add' }])
    })
    runner.schedule()
    return {
      update(v) { cur = v; runner.schedule() },
      dispose() { runner.dispose(); clearPreview(); resetManip() },
    }
  },
})

registerFeature({
  type: 'delete',
  label: 'Delete',
  icon: Trash,
  schema: {
    id: 'delete',
    title: 'Delete body',
    params: [{ type: 'selection-ref', key: 'bodyIds', help: 'The bodies to delete. Click them in the viewport or the Browser.', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [] }],
  },
  async compute(ctx, p) {
    return { remove: bodyIdsOf(p.bodyIds as string[]) }
  },
})

/** Wrap parsed triangle soups into mesh bodies in the kernel. */
async function toBodies(ctx: FeatureCtx, parts: { name: string; positions: Float32Array }[], scale: number, baseName: string, creaseDeg: number, place: Placement = 'keep') {
  const bodies = []
  if (scale !== 1) for (const q of parts) for (let k = 0; k < q.positions.length; k++) q.positions[k] *= scale
  const shift = placementShift(parts.map((q) => q.positions), place)
  for (const q of parts) shiftAll(q.positions, shift)
  for (let i = 0; i < parts.length; i++) {
    const positions = parts[i].positions
    bodies.push(
      await ctx.kernel.createMesh(
        Comlink.transfer({ id: ctx.newBodyId(i || undefined), name: parts.length > 1 ? `${baseName} ${parts[i].name}` : baseName, positions, creaseDeg }, [positions.buffer]),
      ),
    )
  }
  return { bodies }
}

registerFeature({
  type: 'importMesh',
  label: 'Import Mesh',
  icon: GridFour,
  schema: { id: 'importMesh', title: 'Insert Mesh', params: [
      {
        type: 'enum', key: 'units', label: 'Units', display: 'segmented', default: 'mm',
        help: 'The unit the file was made in. The model is brought into millimetres: a file in inches is made 25.4 times bigger. STL has no unit of its own, so check this against the size you expect.',
        options: [{ value: 'mm', label: 'mm' }, { value: 'cm', label: 'cm' }, { value: 'm', label: 'm' }, { value: 'in', label: 'in' }, { value: 'ft', label: 'ft' }],
      },
      {
        type: 'enum', key: 'placement', label: 'Placement', display: 'select', default: 'keep',
        help: 'Where the model lands. Keep position leaves it where the file put it, Center on origin puts the middle of the model on the origin, Drop to ground puts its underside on the ground plane and its middle over the origin.',
        options: [{ value: 'keep', label: 'Keep position' }, { value: 'center', label: 'Center on origin' }, { value: 'ground', label: 'Drop to ground plane' }],
      },
      { type: 'number', key: 'scale', help: 'Multiplies the size of the imported model after the units are applied. 1 keeps it as is.', label: 'Scale', unit: '', min: 0.0001, step: 0.1, default: 1 },
      { type: 'number', key: 'creaseAngle', help: 'Neighbouring triangles that meet at a sharper angle than this become separate faces you can pick. Lower values give more, smaller faces. Meshes over 400 thousand triangles stay one face so they remain fast.', label: 'Face split angle', unit: 'deg', min: 1, max: 89, step: 1, default: 20 },
    ],
  },
  async compute(ctx, p) {
    const bytes = ctx.blob(p.blob as string)
    if (!bytes) throw new Error('Source file missing from document')
    const baseName = (p.fileName as string).replace(/\.[^.]+$/, '')
    const crease = (p.creaseAngle as number | undefined) ?? 20
    const scale = (p.scale as number) * (UNIT_FACTOR[(p.units as string) ?? 'mm'] ?? 1)
    const place = ((p.placement as string) ?? 'keep') as Placement
    const format = p.format === '3mf' ? '3mf' : p.format === 'obj' ? 'obj' : 'stl'
    // big files are parsed, welded and decimated in the compute pool, never on the main thread
    if (bytes.length >= POOL_IMPORT_BYTES) {
      const bodies = await importMeshPooled(sourceOf(bytes), { format, scale, place, creaseDeg: crease, baseName, bodyId: (n) => ctx.newBodyId(n || undefined) })
      return { bodies }
    }
    const parts = format === '3mf' ? parse3mf(bytes) : format === 'obj' ? parseObj(bytes) : parseStl(bytes)
    return toBodies(ctx, parts, scale, baseName, crease, place)
  },
})

registerFeature({
  type: 'importStep',
  label: 'Import STEP',
  icon: Package,
  schema: { id: 'importStep', title: 'Import STEP', params: [] },
  async compute(ctx, p) {
    const bytes = ctx.blob(p.blob as string)
    if (!bytes) throw new Error('Source file missing from document')
    const copy = bytes.slice().buffer
    const body = await ctx.kernel.importStep(Comlink.transfer({ id: ctx.newBodyId(), name: (p.fileName as string).replace(/\.[^.]+$/, ''), bytes: copy }, [copy]))
    return { bodies: [body] }
  },
})

