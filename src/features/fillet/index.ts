/** Fillet and Chamfer: round / bevel selected B-rep edges. */
import { Circle, Polygon, type Icon } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { decodeRef, encodeSelection, resolveEdge } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, setPreview } from '@/viewport/preview'
import { liveEnv, type Env } from '../modeling'
import { createRunner, watchSelection } from '../previewKit'

type Mode = 'fillet' | 'chamfer'

const schemaFor = (mode: Mode): ParamSchema => ({
  id: mode,
  title: mode === 'fillet' ? 'Fillet' : 'Chamfer',
  params: [
    { type: 'selection-ref', key: 'edges', label: 'Edges', accepts: ['edge'], multiple: true, default: [] },
    { type: 'number', key: 'size', label: mode === 'fillet' ? 'Radius' : 'Distance', unit: 'mm', min: 0.001, step: 0.25, default: 1 },
  ],
})

/** Group the edge refs by body, resolving each against the current geometry. */
function resolveEdges(refs: string[], env: Env): { body: Body; edges: number[] }[] {
  const by = new Map<string, { body: Body; edges: number[] }>()
  let missing = 0
  for (const s of refs) {
    const ref = decodeRef(s)
    if (!ref || ref.kind !== 'edge') { missing++; continue }
    const r = resolveEdge(ref, env.bodies)
    if (!r) { missing++; continue }
    const g = by.get(r.body.id) ?? by.set(r.body.id, { body: r.body, edges: [] }).get(r.body.id)!
    if (!g.edges.includes(r.index)) g.edges.push(r.index)
  }
  if (!by.size) throw new Error(missing ? 'The selected edges no longer exist' : 'Select the edges to ' + 'modify')
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
      const groups = resolveEdges(p.edges as string[], { bodies: ctx.bodies, dataOf: ctx.dataOf })
      const bodies: Body[] = []
      for (const g of groups) {
        bodies.push((await ctx.kernel.call('edgeMod', { id: g.body.id, name: g.body.name, key: g.body.key, edges: g.edges, size: p.size as number, mode })) as Body)
      }
      return { bodies }
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
    try { groups = resolveEdges(p.edges as string[], liveEnv()) } catch { clearPreview(); return }
    const out: Body[] = []
    for (const g of groups) out.push((await getKernel().call('edgeMod', { id: g.body.id, name: g.body.name, key: g.body.key, edges: g.edges, size: p.size as number, mode })) as Body)
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
