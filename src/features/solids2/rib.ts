/** Rib and Web: a sketched line thickened to a wall that grows from the line up to the faces it meets. */
import { Wall, ArrowsOutLineVertical } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { bodyIdsOf } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import { getKernel, type KernelClient } from '@/kernel/client'
import type { RibArgs } from '@/kernel/solids2-ops'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, setPreview } from '@/viewport/preview'
import { ctxEnv, liveEnv, type Env } from '../modeling'
import { createRunner } from '../previewKit'
import { sketchDataOf, sketchSegments } from './kit'

type Kind = 'rib' | 'web'

const schemaFor = (kind: Kind): ParamSchema => ({
  id: kind,
  title: kind === 'rib' ? 'Rib' : 'Web',
  params: [
    { type: 'selection-ref', key: 'curves', help: kind === 'rib' ? 'The sketch with the line or curve the rib grows from. Click it in the viewport or the Browser.' : 'The sketch with the lines the webs are built on. Every line becomes a wall.', label: 'Sketch', accepts: ['sketch'], required: true, pick: true, default: [] },
    { type: 'number', key: 'thickness', help: 'How thick the wall is, in mm.', label: 'Thickness', unit: 'mm', min: 0.001, step: 0.5, default: 2 },
    { type: 'enum', key: 'thickMode', help: 'Symmetric: the thickness is shared by both sides of the line. One side: it all grows to one side of the line.', label: 'Thickness side', display: 'segmented', default: 'symmetric', options: [{ value: 'symmetric', label: 'Symmetric' }, { value: 'one', label: 'One side' }] },
    {
      type: 'enum', key: 'direction', help: 'In plane: the wall stands in the sketch plane and grows sideways from the line (a rib across a cavity). Normal: it grows out of the sketch plane, like a web standing on the sketch.', label: 'Direction', display: 'segmented',
      default: kind === 'rib' ? 'plane' : 'normal', options: [{ value: 'plane', label: 'In plane' }, { value: 'normal', label: 'Normal' }],
    },
    { type: 'bool', key: 'flip', help: 'Grow the wall the other way.', label: 'Flip direction', default: false },
    ...(kind === 'web' ? [{ type: 'bool', key: 'both', help: 'Grow the wall both ways from the sketch.', label: 'Both ways', default: false } as const] : []),
    { type: 'enum', key: 'extent', help: 'To next: the wall grows until it meets a face of the body. Distance: it grows exactly this far.', label: 'Extent', display: 'segmented', default: 'next', options: [{ value: 'next', label: 'To next' }, { value: 'distance', label: 'Distance' }] },
    { type: 'number', key: 'depth', help: 'How far the wall grows, in mm.', label: 'Distance', unit: 'mm', min: 0.001, step: 1, default: 10, visibleWhen: (v) => v.extent === 'distance' },
    { type: 'selection-ref', key: 'targets', help: 'The body the wall is joined to. Leave empty to use the body the wall reaches.', label: 'Target body', accepts: ['body'], multiple: true, default: [] },
  ],
})
export const ribSchema = schemaFor('rib')
export const webSchema = schemaFor('web')

/** Build the wall on the first body it can attach to. */
async function build(p: ParamValues, env: Env, kernel: Pick<KernelClient, 'call'>, id: (b: Body) => string, fid: string): Promise<Body> {
  const data = sketchDataOf(p.curves as string[], env, 'rib')
  const segs = sketchSegments(data)
  if (!segs.length) throw new Error('The sketch has no lines or curves')
  const explicit = bodyIdsOf((p.targets as string[]) ?? [])
  const pool = env.bodies.filter((b) => b.kind === 'brep' && !b.surface && (!explicit.length || explicit.includes(b.id)))
  if (!pool.length) throw new Error('There is no solid body for the wall to grow into')
  let last: unknown = null
  for (const b of pool) {
    const args: RibArgs = {
      id: id(b), name: b.name, key: b.key, segs, normal: data.plane.normal, thickness: p.thickness as number, symmetric: p.thickMode !== 'one',
      direction: p.direction === 'normal' ? 'normal' : 'plane', flip: !!p.flip, both: !!p.both, depth: p.extent === 'distance' ? (p.depth as number) : 0, fid,
    }
    try { return (await kernel.call('ribTool', args)) as Body } catch (e) { last = e }
  }
  throw last instanceof Error ? last : new Error('The wall does not reach a body')
}

function register(kind: Kind, label: string, icon: typeof Wall) {
  const schema = schemaFor(kind)
  registerFeature({
    type: kind,
    label,
    icon,
    schema,
    async compute(ctx, p) {
      const out = await build(p, ctxEnv(ctx), ctx.kernel, (b) => b.id, ctx.feature.id)
      return { bodies: [out] }
    },
    preview({ values }) {
      let cur = values
      const runner = createRunner(async (stale) => {
        let p: ParamValues
        try { p = resolveParams(schema, cur) } catch { clearPreview(); return }
        let out: Body | null = null
        try { out = await build(p, liveEnv(), getKernel(), (b) => 'preview-' + b.id, 'preview') } catch { /* incomplete input */ }
        if (stale()) return
        if (!out) return clearPreview()
        const id = out.id.replace('preview-', '')
        setPreview([{ mesh: out.mesh, kind: 'result' }], [id])
      })
      runner.schedule()
      return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clearPreview() } }
    },
  })
}
register('rib', 'Rib', ArrowsOutLineVertical)
register('web', 'Web', Wall)

/** Start from the selected sketch, else from the only sketch of the document that has curves but no closed region. */
function start(kind: Kind, tool: string) {
  const sel = useUi.getState().selection.filter((r) => r.kind === 'sketch').map((r) => r.id)
  const doc = useDoc.getState()
  let curves = sel.slice(0, 1)
  if (!curves.length) {
    const open = doc.features.filter((f, i) => f.type === 'sketch' && i < doc.rollback && !f.suppressed)
    if (open.length === 1) curves = [open[0].id]
  }
  createFeature(kind, { curves }, tool)
}
export const startRib = () => start('rib', 'solid.rib')
export const startWeb = () => start('web', 'solid.web')
