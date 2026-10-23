/** Built-in features: Box primitive, Delete body, Import mesh (STL/3MF), Import STEP. */
import * as Comlink from 'comlink'
import { Cube, GridFour, Package, Trash } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import type { FeatureCtx } from '@/doc/types'
import { bodyIdsOf } from '@/doc/refs'
import { parseStl } from '@/io/stl'
import { parse3mf } from '@/io/threemf'
import { resolveParams } from '@/doc/params'
import { getKernel } from '@/kernel/client'
import { clearPreview, setPreview } from '@/viewport/preview'
import { createRunner } from './previewKit'
import type { ParamSchema, ParamValues } from '@/ui/schema'

export const boxSchema: ParamSchema = {
  id: 'box',
  title: 'Box',
  params: [
    { type: 'number', key: 'width', label: 'Width (X)', unit: 'mm', min: 0.001, step: 1, default: 20 },
    { type: 'number', key: 'depth', label: 'Depth (Y)', unit: 'mm', min: 0.001, step: 1, default: 20 },
    { type: 'number', key: 'height', label: 'Height (Z)', unit: 'mm', min: 0.001, step: 1, default: 20 },
    { type: 'vector3', key: 'position', label: 'Base center', unit: 'mm', step: 1, default: [0, 0, 0] },
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
  preview({ values }) {
    let cur: ParamValues = values
    const runner = createRunner(async (stale) => {
      let p: ParamValues
      try { p = resolveParams(boxSchema, cur) } catch { clearPreview(); return }
      const [px, py, pz] = p.position as [number, number, number]
      const body = await getKernel().makeBox({ id: 'preview', name: 'preview', size: [p.width as number, p.depth as number, p.height as number], position: [px, py, pz] })
      if (!stale()) setPreview([{ mesh: body.mesh, kind: 'add' }])
    })
    runner.schedule()
    return {
      update(v) { cur = v; runner.schedule() },
      dispose() { runner.dispose(); clearPreview() },
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
    params: [{ type: 'selection-ref', key: 'bodyIds', label: 'Bodies', accepts: ['body'], multiple: true, default: [] }],
  },
  async compute(ctx, p) {
    return { remove: bodyIdsOf(p.bodyIds as string[]) }
  },
})

/** Wrap parsed triangle soups into mesh bodies in the kernel. */
async function toBodies(ctx: FeatureCtx, parts: { name: string; positions: Float32Array }[], scale: number, baseName: string, creaseDeg: number) {
  const bodies = []
  for (let i = 0; i < parts.length; i++) {
    const positions = parts[i].positions
    if (scale !== 1) for (let k = 0; k < positions.length; k++) positions[k] *= scale
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
  schema: { id: 'importMesh', title: 'Import mesh', params: [
      { type: 'number', key: 'scale', label: 'Scale', unit: '', min: 0.0001, step: 0.1, default: 1 },
      { type: 'number', key: 'creaseAngle', label: 'Face split angle', unit: 'deg', min: 1, max: 89, step: 1, default: 20 },
    ],
  },
  async compute(ctx, p) {
    const bytes = ctx.blob(p.blob as string)
    if (!bytes) throw new Error('Source file missing from document')
    const parts = p.format === '3mf' ? parse3mf(bytes) : parseStl(bytes)
    return toBodies(ctx, parts, p.scale as number, (p.fileName as string).replace(/\.[^.]+$/, ''), (p.creaseAngle as number | undefined) ?? 20)
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

