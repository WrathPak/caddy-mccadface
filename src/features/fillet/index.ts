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
import { useUi, type SelectionRef } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { useFaceEdges } from '@/viewport/faceEdges'
import { clearPreview, resetManip, setPreview, useManip } from '@/viewport/preview'
import { liveEnv, minDim, niceFloor, workBody, type Env } from '../modeling'
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
  for (const g of by.values()) if (g.body.kind !== 'brep' || g.body.surface) throw new Error('Fillet and Chamfer need a solid body' + (g.body.surface ? ': this one is an open surface, stitch it closed or thicken it first' : ', not a mesh'))
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

/** A fillet radius / chamfer distance that fits the part: about a twentieth of its smallest dimension (1 mm on an ordinary part). */
export function sizeFor(bodyIds: string[]): number {
  const b = workBody(bodyIds)
  return b ? Math.max(0.05, niceFloor(minDim(b) * 0.05)) : 1
}

type Groups = { body: Body; edges: number[] }[]
const callEdgeMod = (g: { body: Body; edges: number[] }, size: number, mode: Mode) =>
  getKernel().call('edgeMod', { id: g.body.id, name: g.body.name, key: g.body.key, edges: g.edges, size, mode, fid: 'preview' }) as Promise<Body>

/** Does the fillet / chamfer build at `size` on every picked body? */
async function buildsAt(groups: Groups, size: number, mode: Mode): Promise<boolean> {
  try {
    for (const g of groups) await callEdgeMod(g, size, mode)
    return true
  } catch { return false }
}

/**
 * The largest size that still builds, found by bisection between a tiny size and the one that failed (about eight kernel runs,
 * each on the picked edges only). 0 when not even a tiny size builds; null when `stale` says the dialog has moved on.
 */
export async function largestSize(groups: Groups, failed: number, mode: Mode, stale: () => boolean): Promise<number | null> {
  const tiny = Math.min(failed / 50, 0.05)
  if (!(await buildsAt(groups, tiny, mode))) return stale() ? null : 0
  let lo = tiny, hi = failed
  for (let i = 0; i < 8; i++) {
    if (stale()) return null
    const mid = (lo + hi) / 2
    if (await buildsAt(groups, mid, mode)) lo = mid
    else hi = mid
  }
  if (stale()) return null
  // rounded down to what the box shows, then checked once more so the number promised is one that really builds
  const r = Math.floor(lo * 100) / 100
  return r > 0 && (await buildsAt(groups, r, mode)) ? r : lo
}

const NAME: Record<Mode, { noun: string; size: string }> = { fillet: { noun: 'Fillet', size: 'radius' }, chamfer: { noun: 'Chamfer', size: 'distance' } }
const mm = (v: number) => `${+v.toFixed(2)} mm`

function edgePreview(mode: Mode, schema: ParamSchema, { values, setValues }: PreviewCtx): PreviewHandle {
  let cur: ParamValues = values
  // the largest size known to build on the edges now picked (found when a size fails); the drag arrow stops there
  let fit: { key: string; max: number } | null = null
  // the size follows the part until the person sets one themselves
  let auto = values.size as number
  const ui = useUi
  const prevFilter = ui.getState().selectionFilter
  ui.getState().setSelectionFilter('edge')
  const runner = createRunner(async (stale) => {
    let p: ParamValues
    try { p = resolveParams(schema, cur) } catch { clearPreview(); ui.setState({ inspectorNotice: null }); return }
    let groups: Groups
    try { groups = resolveEdges(p.edges as string[], liveEnv()) } catch { clearPreview(); resetManip(); ui.setState({ inspectorNotice: null }); return }
    const key = JSON.stringify(p.edges)
    if (fit && fit.key !== key) fit = null
    // drag arrow on the first selected edge: pulling it away from the edge grows the radius / distance
    try {
      const first = groups[0]
      const frames = (await getKernel().call('edgeFrames', { key: first.body.key, edges: first.edges.slice(0, 1) })) as (EdgeFrame | null)[]
      const f = frames[0]
      if (f && !stale()) {
        useManip.setState({
          active: true, origin: f.mid, dir: f.dir, tip: p.size as number, factor: 1,
          label: (v) => `${v.toFixed(2)} mm`,
          onChange: (v) => { cur = { ...cur, size: Math.min(fit && fit.key === key && fit.max > 0 ? fit.max : Infinity, Math.max(0.05, v)) }; setValues(cur) },
        })
      }
    } catch { resetManip() }
    const out: Body[] = []
    const size = p.size as number
    let failure: string | null = null
    // a size above the one known to fail is not tried again
    if (fit && fit.key === key && size > fit.max + 1e-9) failure = 'known'
    else {
      try { for (const g of groups) out.push(await callEdgeMod(g, size, mode)) } catch (e) { failure = e instanceof Error ? e.message : String(e) }
    }
    if (stale()) return
    if (failure !== null) {
      // say so in the dialog, with the biggest size that does work, and stop showing a stale preview of some other size
      clearPreview()
      const known = fit && fit.key === key ? fit.max : await largestSize(groups, size, mode, stale)
      if (known === null || stale()) return
      fit = { key, max: known }
      const { noun, size: word } = NAME[mode]
      ui.setState({
        inspectorNotice: known > 0
          ? `${noun} of ${mm(size)} is not possible on these edges: it is more than the part can take there. The largest ${word} that works is ${mm(known)}.`
          : `${noun} is not possible on these edges at any ${word}${failure !== 'known' ? ` (${failure.replace(/^.*\((.*)\)$/, '$1')})` : ''}. Try other edges, or change the shape first.`,
      })
      return
    }
    ui.setState({ inspectorNotice: null })
    // the original stays faint and pickable, so more edges (or faces) can still be clicked while the dialog is open
    setPreview(out.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), [], out.map((b) => b.id))
  })
  const off = watchSelection(['edge'], () => {
    const picked = ui.getState().selection.filter((r) => r.kind === 'edge')
    cur = { ...cur, edges: encodeSelection(picked, useDoc.getState().geometry) }
    if (cur.size === auto) { auto = sizeFor(picked.map((r) => r.id)); cur = { ...cur, size: auto } }
    setValues(cur)
  })
  // a click on a face takes all of its edges (or lets them all go when they are all picked already)
  useFaceEdges.setState({
    onFace: async (face) => {
      const b = useDoc.getState().geometry.find((x) => x.id === face.id)
      if (!b || b.kind !== 'brep' || b.surface || face.index === undefined) return
      let idx: number[]
      try { idx = (await getKernel().call('faceEdges', { key: b.key, faces: [face.index] })) as number[] } catch { return }
      const sel = ui.getState().selection
      const has = (i: number) => sel.some((r) => r.kind === 'edge' && r.id === face.id && r.index === i)
      const all = idx.length > 0 && idx.every(has)
      const rest = sel.filter((r) => r.kind === 'edge' && !(all && r.id === face.id && idx.includes(r.index!)))
      const add: SelectionRef[] = all ? [] : idx.filter((i) => !has(i)).map((index) => ({ kind: 'edge', id: face.id, index, path: face.path }))
      ui.getState().setSelection([...rest, ...add])
    },
  })
  runner.schedule()
  return {
    update(v) { cur = v; runner.schedule() },
    dispose() {
      useFaceEdges.setState({ onFace: null })
      off()
      runner.dispose()
      clearPreview()
      resetManip()
      ui.setState({ inspectorNotice: null })
      ui.getState().setSelectionFilter(prevFilter)
    },
  }
}

register('fillet', Circle)
register('chamfer', Polygon)

/** Ribbon command: starts from the selected edges, or from the edges of the selected faces (as in Fusion), with a size that fits the part. */
export async function startEdgeMod(mode: Mode) {
  const ui = useUi.getState()
  const geometry = useDoc.getState().geometry
  const edgeSel = ui.selection.filter((r) => r.kind === 'edge')
  const faceSel = ui.selection.filter((r) => r.kind === 'face')
  let edges = encodeSelection(edgeSel, geometry)
  if (!edges.length && faceSel.length) {
    const byBody = new Map<string, number[]>()
    for (const f of faceSel) if (f.index !== undefined) byBody.set(f.id, [...(byBody.get(f.id) ?? []), f.index])
    const picked: SelectionRef[] = []
    for (const [id, faces] of byBody) {
      const b = geometry.find((x) => x.id === id)
      if (!b || b.kind !== 'brep' || b.surface) continue
      try {
        const idx = (await getKernel().call('faceEdges', { key: b.key, faces })) as number[]
        for (const index of idx) picked.push({ kind: 'edge', id, index })
      } catch { /* no edges: the dialog opens empty */ }
    }
    edges = encodeSelection(picked, geometry)
  }
  const ids = [...edgeSel, ...faceSel].map((r) => r.id)
  createFeature(mode, { edges, size: sizeFor(ids) }, mode === 'fillet' ? 'solid.fillet' : 'solid.chamfer')
}
