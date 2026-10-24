/** Fillet and Chamfer: round / bevel selected B-rep edges. */
import { Circle, Polygon, type Icon } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, decodeRef, encodeSelection, resolveEdge } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { Body } from '@/kernel/types'
import type { EdgeFrame } from '@/kernel/model-ops'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, resetManip, setPreview, useManip } from '@/viewport/preview'
import { liveEnv, type Env } from '../modeling'
import { createRunner, watchSelection } from '../previewKit'

type Mode = 'fillet' | 'chamfer'

const schemaFor = (mode: Mode): ParamSchema => ({
  id: mode,
  title: mode === 'fillet' ? 'Fillet' : 'Chamfer',
  params: [
    { type: 'selection-ref', key: 'edges', help: 'The edges to round or bevel. Click them in the viewport (the selection filter switches to edges).', label: 'Edges', accepts: ['edge'], multiple: true, required: true, default: [] },
    { type: 'number', key: 'size', help: 'Fillet: the radius of the rounding, in mm. Chamfer: how far the cut starts from the edge on each face, in mm.', label: mode === 'fillet' ? 'Radius' : 'Distance', unit: 'mm', min: 0.001, step: 0.25, default: 1 },
  ],
})

/** Group the edge refs by body, resolving each against the current geometry. */
function resolveEdges(refs: string[], env: Env, report = new RefReport()): { body: Body; edges: number[] }[] {
  const by = new Map<string, { body: Body; edges: number[] }>()
  let missing = 0
  for (const s of refs) {
    const ref = decodeRef(s)
    if (!ref || ref.kind !== 'edge') { missing++; continue }
    const r = resolveEdge(ref, env.bodies, report)
    if (!r) { missing++; continue }
    const g = by.get(r.body.id) ?? by.set(r.body.id, { body: r.body, edges: [] }).get(r.body.id)!
    if (!g.edges.includes(r.index)) g.edges.push(r.index)
  }
  if (!by.size) throw new RefError(missing ? 'The selected edges no longer exist (an edit upstream removed them). Pick them again.' : 'Select the edges to modify', report.lostRefs)
  for (const g of by.values()) if (g.body.kind !== 'brep') throw new Error('Fillet and Chamfer need a solid (B-rep) body')
  return [...by.values()]
}

function register(mode: Mode, icon: Icon) {
  const schema = schemaFor(mode)
  registerFeature({
    type: mode,
    label: schema.title,
    icon,
    schema,
    async compute(ctx, p) {
      const report = new RefReport()
      const groups = resolveEdges(p.edges as string[], { bodies: ctx.bodies, dataOf: ctx.dataOf }, report)
      const bodies: Body[] = []
      for (const g of groups) {
        bodies.push((await ctx.kernel.call('edgeMod', { id: g.body.id, name: g.body.name, key: g.body.key, edges: g.edges, size: p.size as number, mode, fid: ctx.feature.id })) as Body)
      }
      return { bodies, warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
    },
    preview: (ctx) => edgePreview(mode, schema, ctx),
  })
}

function edgePreview(mode: Mode, schema: ParamSchema, { values, setValues }: PreviewCtx): PreviewHandle {
  let cur: ParamValues = values
  const ui = useUi
  const prevFilter = ui.getState().selectionFilter
  ui.getState().setSelectionFilter('edge')
  const runner = createRunner(async (stale) => {
    let p: ParamValues
    try { p = resolveParams(schema, cur) } catch { clearPreview(); return }
    let groups
    try { groups = resolveEdges(p.edges as string[], liveEnv()) } catch { clearPreview(); resetManip(); return }
    // drag arrow on the first selected edge: pulling it away from the edge grows the radius / distance
    try {
      const first = groups[0]
      const frames = (await getKernel().call('edgeFrames', { key: first.body.key, edges: first.edges.slice(0, 1) })) as (EdgeFrame | null)[]
      const f = frames[0]
      if (f && !stale()) {
        useManip.setState({
          active: true, origin: f.mid, dir: f.dir, tip: p.size as number, factor: 1,
          label: (v) => `${v.toFixed(2)} mm`,
          onChange: (v) => { cur = { ...cur, size: Math.max(0.05, v) }; setValues(cur) },
        })
      }
    } catch { resetManip() }
    const out: Body[] = []
    for (const g of groups) out.push((await getKernel().call('edgeMod', { id: g.body.id, name: g.body.name, key: g.body.key, edges: g.edges, size: p.size as number, mode, fid: 'preview' })) as Body)
    if (stale()) return
    setPreview(out.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), out.map((b) => b.id))
  })
  const off = watchSelection(['edge'], () => {
    cur = { ...cur, edges: encodeSelection(ui.getState().selection.filter((r) => r.kind === 'edge'), useDoc.getState().geometry) }
    setValues(cur)
  })
  runner.schedule()
  return {
    update(v) { cur = v; runner.schedule() },
    dispose() {
      off()
      runner.dispose()
      clearPreview()
      resetManip()
      ui.getState().setSelectionFilter(prevFilter)
    },
  }
}

register('fillet', Circle)
register('chamfer', Polygon)

export function startEdgeMod(mode: Mode) {
  const ui = useUi.getState()
  const edges = encodeSelection(ui.selection.filter((r) => r.kind === 'edge'), useDoc.getState().geometry)
  createFeature(mode, { edges }, mode === 'fillet' ? 'solid.fillet' : 'solid.chamfer')
}
