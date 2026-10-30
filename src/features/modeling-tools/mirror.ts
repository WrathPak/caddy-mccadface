/** Mirror: features, faces or bodies reflected across a plane or planar face. */
import { FlipHorizontal } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefReport, encodeSelection } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { stateAround } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, setPreview } from '@/viewport/preview'
import { createRunner } from '../previewKit'
import { liveRefEnv, resolvePlane, type RefEnv } from './geo'
import { repeat, type RepeatEnv, type Source } from './source'
import { mirrorXf } from './transforms'

export const mirrorSchema: ParamSchema = {
  id: 'mirror',
  title: 'Mirror',
  params: [
    { type: 'enum', key: 'source', help: 'What to mirror: earlier features (their effect on the model), faces (a boss, a pocket, a hole...) or whole bodies.', label: 'Mirror', display: 'segmented', default: 'bodies', options: [{ value: 'features', label: 'Features' }, { value: 'faces', label: 'Faces' }, { value: 'bodies', label: 'Bodies' }] },
    { type: 'selection-ref', key: 'features', help: 'Click features in the timeline to mirror what they did to the model. Click again to remove one.', label: 'Features', accepts: ['feature'], multiple: true, required: true, default: [], visibleWhen: (v) => v.source === 'features' },
    { type: 'selection-ref', key: 'faces', help: 'The faces that make up the feature to mirror, for example the walls and top of a boss.', label: 'Faces', accepts: ['face'], multiple: true, required: true, pick: true, default: [], visibleWhen: (v) => v.source === 'faces' },
    { type: 'selection-ref', key: 'bodies', help: 'The bodies to mirror.', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [], visibleWhen: (v) => v.source === 'bodies' },
    { type: 'selection-ref', key: 'plane', help: 'The mirror plane: an origin plane, a construction plane or a flat face of the model.', label: 'Mirror plane', accepts: ['plane', 'face'], pick: true, required: true, default: [] },
    { type: 'enum', key: 'operation', help: 'New bodies: the mirror image is a separate body. Join: it is fused into the original body.', label: 'Operation', display: 'segmented', default: 'new', options: [{ value: 'new', label: 'New body' }, { value: 'join', label: 'Join' }], visibleWhen: (v) => v.source === 'bodies' },
  ],
}

interface MirrorP { source: Source['kind']; features: string[]; faces: string[]; bodies: string[]; plane: string[]; operation: 'new' | 'join' }
const asP = (v: ParamValues) => v as unknown as MirrorP

async function build(p: MirrorP, env: RepeatEnv, report: RefReport) {
  if (!p.plane[0]) throw new Error('Select the mirror plane')
  const pl = await resolvePlane(p.plane[0], env, report)
  const src: Source = { kind: p.source, features: p.features, faces: p.faces, bodies: p.bodies }
  return repeat(env, src, [mirrorXf(pl.origin, pl.normal)], p.operation, report)
}

registerFeature({
  type: 'mirror',
  label: 'Mirror',
  icon: FlipHorizontal,
  schema: mirrorSchema,
  async compute(ctx, raw) {
    const report = new RefReport()
    const env: RepeatEnv = { bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as unknown as RefEnv['kernel'], around: ctx.stateAround, fid: ctx.feature.id, newId: (n) => ctx.newBodyId(n) }
    const r = await build(asP(raw), env, report)
    return { bodies: r.bodies, warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview: (ctx) => mirrorPreview(ctx),
})

function mirrorPreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  const runner = createRunner(async (stale) => {
    let p: MirrorP
    try { p = asP(resolveParams(mirrorSchema, cur)) } catch { clearPreview(); return }
    try {
      const r = await build(p, { ...liveRefEnv(), around: stateAround, fid: 'preview', newId: (n) => `preview.${n}` }, new RefReport())
      if (stale()) return
      const live = useDoc.getState().geometry
      setPreview(r.bodies.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), r.bodies.map((b) => b.id).filter((id) => live.some((x) => x.id === id)))
    } catch { clearPreview() }
  })
  const off = useDoc.subscribe((s, prev) => {
    if (s.selectedFeatureId === prev.selectedFeatureId || !s.selectedFeatureId || cur.source !== 'features') return
    const id = s.selectedFeatureId, list = (cur.features as string[]) ?? []
    cur = { ...cur, features: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] }
    setValues(cur)
  })
  runner.schedule()
  return { update(v) { cur = v; runner.schedule() }, dispose() { off(); runner.dispose(); clearPreview() } }
}

/**
 * Ribbon command: takes what is selected. Bodies plus a plane or a flat face mirror those bodies across it; faces alone are the
 * faces to mirror; a lone body in the document is taken when nothing is selected.
 */
export function startMirror() {
  const ui = useUi.getState()
  const d = useDoc.getState()
  const faces = ui.selection.filter((r) => r.kind === 'face')
  const bodies = ui.selection.filter((r) => r.kind === 'body')
  const plane = ui.selection.find((r) => r.kind === 'plane')
  const init: ParamValues = {}
  const solids = d.geometry.filter((b) => b.kind === 'brep' && !b.surface)
  if (bodies.length) {
    init.bodies = [...new Set(bodies.map((b) => b.id))]
    if (plane) init.plane = [plane.id]
    else if (faces.length) init.plane = encodeSelection(faces.slice(0, 1), d.geometry)
  } else if (faces.length && !plane) { init.source = 'faces'; init.faces = encodeSelection(faces, d.geometry) }
  else if (faces.length && plane) { init.source = 'faces'; init.faces = encodeSelection(faces, d.geometry); init.plane = [plane.id] }
  else if (solids.length === 1) {
    init.bodies = [solids[0].id]
    if (plane) init.plane = [plane.id]
  }
  createFeature('mirror', init, 'solid.mirror')
}
