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
import type { ParamValues } from '@/ui/schema'
import { createRunner, watchSelection } from '../previewKit'
import { showArrows } from '../handleKit'
import { resetManip } from '@/viewport/preview'
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

/** True when every triangle of the region faces (nearly) straight up or down: no horizontal strand can leave it. */
export function levelOnly(positions: Float32Array, indices: Uint32Array): boolean {
  if (!indices.length) return false
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    if (l < 1e-12) continue
    // (print-aware strands drop below 0.2 of horizontal travel: the same limit)
    if (Math.hypot(nx, ny) / l >= 0.2) return false
  }
  return true
}

function hairPreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  let lastRegion = ''
  // Print-aware strands are horizontal, so a surface that faces straight up or down (a rim, a floor) cannot grow them. Until the
  // person sets Print-aware themselves, such a surface turns it off, so the default look (a comb off a rim) grows vertical strands.
  let printAuto = true
  const geometry = () => useDoc.getState().geometry

  const runner = createRunner(async (stale) => {
    // (a generation error leaves the length arrow up: a length that is too long or too short can be the cause)
    let shown = false
    try {
      const v = resolveParams(hairSchema, cur) as unknown as HairValues
      if (!v.region.length) { clearHairView(); resetManip(); return }
      useHairView.setState({ busy: true })
      const { args } = buildArgs(v, geometry(), 'preview')
      if (printAuto && v.printAware && v.dirMode !== 'radial' && v.dirMode !== 'fixed' && v.dirMode !== 'point' && levelOnly(args.positions, args.indices)) {
        printAuto = false
        cur = { ...cur, printAware: false }
        setValues(cur)
        runner.schedule()
        return
      }
      try {
        const g = directionGlyphs(args.positions, args.indices, v, args.axis)
        // the length arrow follows one strand: out of the surface the way strands point there
        const at = g.data.length >= 6 ? { o: [g.data[0], g.data[1], g.data[2]] as V3, d: [g.data[3], g.data[4], g.data[5]] as V3 } : { o: g.centre, d: g.normal }
        showArrows([{ origin: at.o, dir: at.d, key: 'length', min: 0.5 }], v as unknown as ParamValues, (patch) => { cur = { ...cur, ...patch }; setValues(cur) })
        shown = true
        useHairView.setState({
          glyphs: g,
          fixed: v.dirMode === 'fixed' ? { dir: v.fixedDir, set: (d) => { cur = { ...cur, fixedDir: d }; setValues(cur) } } : null,
        })
      } catch { useHairView.setState({ glyphs: null }); resetManip() }
      const res = (await getKernel().call('hairGenerate', args)) as HairPreviewResult
      if (!stale()) { useHairView.setState({ result: res, error: null, busy: false }); useUi.setState({ inspectorNotice: null }) }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!stale()) { useHairView.setState({ result: null, error: msg, busy: false }); if (!shown) resetManip(); useUi.setState({ inspectorNotice: msg }) }
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
      // a new preset starts from its own Print-aware; touching the box by hand ends the automatic choice
      if (v.preset !== cur.preset) printAuto = true
      else if (v.printAware !== cur.printAware) printAuto = false
      cur = v
      syncRegion(v)
      runner.schedule()
    },
    dispose() {
      off()
      runner.dispose()
      useUi.setState({ inspectorNotice: null })
      clearHairView()
      resetManip()
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
