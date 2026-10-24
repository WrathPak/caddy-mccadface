/** Fur, scales, spikes and grass: surface generators built on the hair pipeline. */
import { Cactus, Fish, PawPrint, Plant, type Icon } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { GenOpArgs, GenPreview } from '@/kernel/detail-ops'
import type { GenKind } from '@/kernel/generators/params'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { createRunner } from '../previewKit'
import { clearHairView, useHairView } from '../hair/store'
import type { HairPreviewResult } from '@/kernel/hair-ops'
import { extractOthers, regionFromSelection } from '../hair/region'
import { bindRegion, surfaceOf } from './common'
import { GEN_SCHEMAS } from './genSchema'
import { clearDetailView, useDetailView } from './store'

const LABELS: Record<GenKind, { label: string; noun: string; icon: Icon; mode: 'brush' | 'click' }> = {
  fur: { label: 'Fur', noun: 'strands', icon: PawPrint, mode: 'brush' },
  scales: { label: 'Scales', noun: 'scales', icon: Fish, mode: 'brush' },
  spikes: { label: 'Spikes', noun: 'spikes', icon: Cactus, mode: 'brush' },
  grass: { label: 'Grass', noun: 'blades', icon: Plant, mode: 'brush' },
}

function args(kind: GenKind, schema: ParamSchema, raw: ParamValues, bodies: Body[], mode: 'preview' | 'final'): { op: GenOpArgs; body: Body } {
  const v = resolveParams(schema, raw)
  const { rs, positions, indices } = surfaceOf(v.region as string[], bodies, LABELS[kind].label.toLowerCase())
  return { op: { kind, params: v, positions, indices, obstacle: extractOthers(rs), mode }, body: rs.body }
}

/** Per-triangle copy of an indexed mesh, so it is shaded flat (scales and spikes are faceted solids). */
function unindexed(positions: Float32Array, indices: Uint32Array) {
  const out = new Float32Array(indices.length * 3)
  for (let i = 0; i < indices.length; i++) out.set(positions.subarray(indices[i] * 3, indices[i] * 3 + 3), i * 3)
  return { positions: out, indices: Uint32Array.from({ length: indices.length }, (_, i) => i) }
}

function register(kind: GenKind) {
  const schema = GEN_SCHEMAS[kind]
  const { label, icon } = LABELS[kind]
  registerFeature({
    type: kind,
    label,
    icon,
    schema,
    async compute(ctx, raw) {
      const { op, body } = args(kind, schema, raw, ctx.bodies, 'final')
      op.targetKey = body.key
      op.ids = { target: body.id, targetName: body.name, hair: ctx.newBodyId(), wall: ctx.newBodyId(1) }
      const r = (await ctx.kernel.call('surfaceGenerate', op)) as { bodies: Body[]; warnings: string[] }
      return { bodies: r.bodies, warning: r.warnings.length ? r.warnings.join('. ') : undefined }
    },
    preview: (ctx) => preview(kind, schema, ctx),
  })
}

function preview(kind: GenKind, schema: ParamSchema, { values, setValues }: PreviewCtx): PreviewHandle {
  let cur: ParamValues = values
  const geometry = () => useDoc.getState().geometry
  const faces = bindRegion((region) => { cur = { ...cur, region }; setValues(cur) }, (cur.region as string[]).length ? 'off' : LABELS[kind].mode)
  faces.show(cur.region as string[])
  const runner = createRunner(async (stale) => {
    try {
      const v = resolveParams(schema, cur)
      if (!(v.region as string[]).length) { clearHairView(); useDetailView.setState({ readout: null, busy: false }); useUi.setState({ inspectorNotice: null }); return }
      useDetailView.setState({ busy: true })
      const { op } = args(kind, schema, cur, geometry(), 'preview')
      const res = (await getKernel().call('surfaceGenerate', op)) as GenPreview
      if (stale()) return
      const faceted = kind === 'scales' || kind === 'spikes'
      const result: HairPreviewResult = {
        strands: faceted ? unindexed(res.positions, res.indices) : { positions: res.positions, indices: res.indices },
        wall: res.wall,
        stats: undefined as never,
      }
      useHairView.setState({ result, error: null, busy: false, visible: true })
      const s = res.stats
      const extra = [s.edgeRejected ? `${s.edgeRejected} kept off edges` : '', s.dropped ? `${s.dropped} skipped` : '', s.capped ? 'capped' : ''].filter(Boolean).join(', ')
      useDetailView.setState({
        readout: `${s.count.toLocaleString()} ${LABELS[kind].noun}${extra ? ` (${extra})` : ''} | ${Math.round(res.stats.triangles / 1000).toLocaleString()}k triangles | ${res.stats.ms} ms`,
        busy: false,
      })
      useUi.setState({ inspectorNotice: null })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!stale()) { clearHairView(); useDetailView.setState({ readout: null, busy: false }); useUi.setState({ inspectorNotice: msg }) }
    }
  }, 260)
  runner.schedule()
  return {
    update(v) {
      cur = v
      faces.sync(v.region as string[])
      runner.schedule()
    },
    dispose() {
      runner.dispose()
      faces.dispose()
      clearHairView()
      clearDetailView()
      useUi.setState({ inspectorNotice: null })
    },
  }
}

for (const k of ['fur', 'scales', 'spikes', 'grass'] as const) register(k)

export function startGenerator(kind: GenKind) {
  const region = regionFromSelection(useUi.getState().selection, useDoc.getState().geometry)
  createFeature(kind, { region }, 'detail.' + kind)
}
