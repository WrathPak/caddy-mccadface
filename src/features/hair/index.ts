/** Hair feature: surface selection -> strands (+ optional sacrificial wall), previewed live, unioned on OK. */
import { Spiral } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { decodeRef, edgeSigs, encodeSelection, resolveEdge } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { HairArgs, HairPreviewResult } from '@/kernel/hair-ops'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import { createRunner, watchSelection } from '../previewKit'
import { directionGlyphs } from './glyphs'
import { loadSelection, setPaint, type PaintMode } from './paint'
import { extractOthers, extractRegion, regionFromSelection, resolveRegionSet, type RegionSet } from './region'
import { hairSchema, type HairValues, type V3 } from './schema'
import { clearHairView, useHairView } from './store'
import type { Axis } from './wall'

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/** World axis used by radial directions and cylindrical walls. */
function axisOf(v: HairValues, bodies: Body[]): Axis {
  switch (v.axisMode) {
    case 'worldX': return { o: [0, 0, 0], d: [1, 0, 0] }
    case 'worldY': return { o: [0, 0, 0], d: [0, 1, 0] }
    case 'points': {
      const d = sub(v.axisP2, v.axisP1)
      if (!Math.hypot(...d)) throw new Error('Axis points must differ')
      return { o: v.axisP1, d }
    }
    case 'edge': {
      const ref = v.axisEdge[0] ? decodeRef(v.axisEdge[0]) : null
      if (!ref || ref.kind !== 'edge') throw new Error('Select an edge for the axis')
      const r = resolveEdge(ref, bodies)
      if (!r) throw new Error('The axis edge no longer exists')
      const sg = edgeSigs(r.body)[r.index]
      return { o: sg.midpoint, d: sg.direction }
    }
    default: return { o: [0, 0, 0], d: [0, 0, 1] }
  }
}

function buildArgs(v: HairValues, bodies: Body[], mode: 'preview' | 'final'): { args: HairArgs; region: RegionSet } {
  const region = resolveRegionSet(v.region, bodies)
  if (!region) throw new Error('Select the surface to grow hair on (Face, Brush or Fill tool)')
  const { positions, indices } = extractRegion(region)
  if (!positions.length) throw new Error('The selected surface is empty')
  return { args: { mode, p: v, axis: axisOf(v, bodies), positions, indices, obstacle: extractOthers(region) }, region }
}

registerFeature({
  type: 'hair',
  label: 'Hair',
  icon: Spiral,
  schema: hairSchema,
  async compute(ctx, raw) {
    const { args, region } = buildArgs(raw as unknown as HairValues, ctx.bodies, 'final')
    args.targetKey = region.body.key
    args.ids = { target: region.body.id, targetName: region.body.name, hair: ctx.newBodyId(), wall: ctx.newBodyId(1) }
    const bodies = (await ctx.kernel.call('hairGenerate', args)) as Body[]
    return { bodies }
  },
  preview: (ctx) => hairPreview(ctx),
})

/** Paint mode the next opened dialog starts in (set by the ribbon commands). */
let nextMode: PaintMode = 'off'

function hairPreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  let lastRegion = ''
  const geometry = () => useDoc.getState().geometry

  const runner = createRunner(async (stale) => {
    try {
      const v = resolveParams(hairSchema, cur) as unknown as HairValues
      if (!v.region.length) { clearHairView(); return }
      useHairView.setState({ busy: true })
      const { args } = buildArgs(v, geometry(), 'preview')
      try {
        const g = directionGlyphs(args.positions, args.indices, v, args.axis)
        useHairView.setState({
          glyphs: g,
          fixed: v.dirMode === 'fixed' ? { dir: v.fixedDir, set: (d) => { cur = { ...cur, fixedDir: d }; setValues(cur) } } : null,
        })
      } catch { useHairView.setState({ glyphs: null }) }
      const res = (await getKernel().call('hairGenerate', args)) as HairPreviewResult
      if (!stale()) { useHairView.setState({ result: res, error: null, busy: false }); useUi.setState({ inspectorNotice: null }) }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!stale()) { useHairView.setState({ result: null, error: msg, busy: false }); useUi.setState({ inspectorNotice: msg }) }
    }
  }, 250)

  const syncRegion = (v: typeof values) => {
    const region = (v.region as string[]) ?? []
    const key = region.join('|')
    if (key === lastRegion) return
    lastRegion = key
    const rs = resolveRegionSet(region, geometry())
    loadSelection(rs?.body.id ?? null, rs?.kind ?? null, rs?.set ?? new Set())
  }

  setPaint({
    visible: true,
    mode: nextMode,
    sink: (region) => {
      lastRegion = region.join('|')
      cur = { ...cur, region }
      setValues(cur)
    },
  })
  nextMode = 'off'
  syncRegion(cur)

  const off = watchSelection(['edge'], () => {
    if (cur.dirMode !== 'radial' || cur.axisMode !== 'edge') return
    cur = { ...cur, axisEdge: encodeSelection(useUi.getState().selection.filter((r) => r.kind === 'edge').slice(0, 1), geometry()) }
    setValues(cur)
  })
  runner.schedule()
  return {
    activeGroup(id: string) { useHairView.setState({ showGlyphs: id === 'direction' }) },
    update(v) {
      if (v.dirMode === 'radial' && v.axisMode === 'edge' && !(cur.dirMode === 'radial' && cur.axisMode === 'edge')) {
        useUi.getState().setSelectionFilter('edge')
        setPaint({ mode: 'off' })
      }
      // choosing Fixed direction starts the arrow along the selected faces' normal (the stored default would often lie flat on them)
      if (v.dirMode === 'fixed' && cur.dirMode !== 'fixed') {
        const n = useHairView.getState().glyphs?.normal
        if (n) { v = { ...v, fixedDir: [+n[0].toFixed(3), +n[1].toFixed(3), +n[2].toFixed(3)] }; setTimeout(() => setValues(v), 0) }
      }
      cur = v
      syncRegion(v)
      runner.schedule()
    },
    dispose() {
      off()
      runner.dispose()
      useUi.setState({ inspectorNotice: null })
      clearHairView()
      setPaint({ visible: false, mode: 'off', sink: null })
      loadSelection(null, null, new Set())
    },
  }
}

/** Ribbon entry points. */
export function startHair(kind: 'create' | 'faces' | 'wall') {
  const region = regionFromSelection(useUi.getState().selection, useDoc.getState().geometry)
  nextMode = region.length && kind === 'create' ? 'off' : 'brush'
  createFeature('hair', { region, ...(kind === 'wall' ? { wall: true } : {}) }, 'hair.' + kind)
}

export const toggleHairPreview = () => useHairView.setState((s) => ({ visible: !s.visible }))
