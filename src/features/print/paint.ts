/** Color painting: a timeline feature that assigns a filament slot to whole bodies or to faces / triangles. */
import { PaintBrush } from '@phosphor-icons/react'
import { create } from 'zustand'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, decodeRef, encodeSelection, resolveFace } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { Feature, PreviewCtx, PreviewHandle } from '@/doc/types'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema } from '@/ui/schema'
import { decodeTris, resolveRegionSet } from '../hair/region'
import { loadSelection, setPaint } from '../hair/paint'
import { SLOT_COUNT, colorById } from './palette'
import { currentSettings } from './settings'

/** Filament slot of every triangle of every body (index = viewport triangle; 0 = unpainted). */
export type PaintMap = Map<string, Uint8Array>

export const paintSchema: ParamSchema = {
  id: 'paint',
  title: 'Paint',
  params: [
    {
      type: 'selection-ref', key: 'targets', label: 'Bodies or faces', accepts: ['body', 'face'], multiple: true, required: true, pick: true, default: [],
      help: 'What to color: whole bodies, or faces. Paint faces with the brush, the face click or the fill tool in the viewport bar.',
    },
    {
      type: 'enum', key: 'slot', label: 'Filament', display: 'select', default: '1',
      options: [{ value: '0', label: 'Clear color' }, ...Array.from({ length: SLOT_COUNT }, (_, i) => ({ value: String(i + 1), label: `Filament ${i + 1}` }))],
      help: 'The filament slot to paint with. Its color is set in Print settings. Clear color takes the paint off again.',
    },
    {
      type: 'info', key: 'swatch', label: 'Color', default: '',
      help: 'The color of the chosen filament slot, as set in Print settings.',
      text: (v) => {
        const slot = Number(v.slot)
        if (!slot) return 'Back to the default color'
        const s = currentSettings()
        return `Filament ${slot}: ${colorById(s.slotColors[slot - 1]).label}`
      },
    },
  ],
}

/** Paint `slot` onto the bodies / faces / triangles named by `targets`. Returns how many targets were found. */
export function applyPaint(map: PaintMap, bodies: Body[], targets: string[], slot: number, report?: RefReport): number {
  let found = 0
  const slotsOf = (b: Body) => {
    let s = map.get(b.id)
    if (!s || s.length !== b.mesh.indices.length / 3) map.set(b.id, (s = new Uint8Array(b.mesh.indices.length / 3)))
    return s
  }
  for (const t of targets) {
    const tris = decodeTris(t)
    if (tris) {
      const body = bodies.find((b) => b.id === tris.bodyId)
      if (!body) { report?.lost.set(t, 'The body this paint belonged to no longer exists'); continue }
      const s = slotsOf(body)
      for (const i of tris.tris) if (i < s.length) s[i] = slot
      found++
      continue
    }
    const ref = decodeRef(t)
    if (!ref) { report?.lost.set(t, 'A painted reference could not be read'); continue }
    if (ref.kind === 'body') {
      const body = bodies.find((b) => b.id === ref.bodyId)
      if (!body) { report?.lost.set(t, 'The body this paint belonged to no longer exists'); continue }
      slotsOf(body).fill(slot)
      found++
    } else if (ref.kind === 'face') {
      const res = resolveFace(ref, bodies, report)
      if (!res) continue
      const ids = res.body.mesh.faceIds
      const s = slotsOf(res.body)
      for (let i = 0; i < ids.length; i++) if (ids[i] === res.index) s[i] = slot
      found++
    }
  }
  return found
}

/** Everything the active Paint features did, resolved against the final bodies (later paints win). */
export function computePaintMap(features: Feature[], rollback: number, bodies: Body[]): PaintMap {
  const map: PaintMap = new Map()
  for (let i = 0; i < Math.min(rollback, features.length); i++) {
    const f = features[i]
    if (f.type !== 'paint' || f.suppressed) continue
    try {
      const p = resolveParams(paintSchema, f.params)
      applyPaint(map, bodies, p.targets as string[], Number(p.slot))
    } catch { /* an invalid paint feature shows its error on the timeline */ }
  }
  for (const [id, s] of map) if (!s.some((x) => x)) map.delete(id)
  return map
}

/** Filament slots in use, ascending. */
export function usedSlots(map: PaintMap): number[] {
  const set = new Set<number>()
  for (const s of map.values()) for (const x of s) if (x) set.add(x)
  return [...set].sort((a, b) => a - b)
}

registerFeature({
  type: 'paint',
  label: 'Paint',
  icon: PaintBrush,
  schema: paintSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const found = applyPaint(new Map(), ctx.bodies, p.targets as string[], Number(p.slot), report)
    if (!found) throw new RefError('The bodies or faces to paint no longer exist. Pick them again.', report.lostRefs)
    return { warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview: (ctx) => paintPreview(ctx),
})

/** Paint tool state the viewport layer reads for the not-yet-confirmed paint. */
export const usePendingPaint = create<{ map: PaintMap | null }>(() => ({ map: null }))

let nextMode: 'brush' | 'off' = 'brush'

function paintPreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  let lastKey = ''
  const geometry = () => useDoc.getState().geometry
  const refresh = () => {
    let p
    try { p = resolveParams(paintSchema, cur) } catch { return }
    const map: PaintMap = new Map()
    applyPaint(map, geometry(), p.targets as string[], Number(p.slot))
    usePendingPaint.setState({ map: map.size ? map : null })
  }
  const syncSelection = (v: typeof values) => {
    const key = ((v.targets as string[]) ?? []).join('|')
    if (key === lastKey) return
    lastKey = key
    const rs = resolveRegionSet(v.targets as string[], geometry())
    loadSelection(rs?.body.id ?? null, rs?.kind ?? null, rs?.set ?? new Set())
  }
  setPaint({
    visible: true,
    mode: nextMode,
    sink: (region) => {
      lastKey = region.join('|')
      cur = { ...cur, targets: region }
      setValues(cur)
    },
  })
  nextMode = 'brush'
  syncSelection(cur)
  refresh()
  return {
    update(v) { cur = v; syncSelection(v); refresh() },
    dispose() {
      usePendingPaint.setState({ map: null })
      setPaint({ visible: false, mode: 'off', sink: null })
      loadSelection(null, null, new Set())
    },
  }
}

/** Ribbon entry point: paint faces with the brush (`faces`) or whole bodies (`body`). */
export function startPaint(kind: 'faces' | 'body') {
  const ui = useUi.getState()
  const doc = useDoc.getState()
  let targets: string[] = []
  if (kind === 'body') {
    const ids = [...new Set(ui.selection.map((r) => r.id))].filter((id) => doc.geometry.some((b) => b.id === id))
    targets = encodeSelection(ids.map((id) => ({ kind: 'body' as const, id })), doc.geometry)
    nextMode = 'off'
    ui.setSelectionFilter('body')
  } else {
    const faces = ui.selection.filter((r) => r.kind === 'face')
    targets = faces.length ? encodeSelection(faces, doc.geometry) : []
    nextMode = 'brush'
  }
  createFeature('paint', { targets, slot: String(nextSlot()) }, kind === 'body' ? 'print.paintBody' : 'print.paintFaces')
}

/** The slot after the highest one a Paint feature used so far (slot 1 is the default color of the print, so the first paint is slot 2). */
function nextSlot(): number {
  const { features, rollback } = useDoc.getState()
  let last = 1
  for (let i = 0; i < Math.min(rollback, features.length); i++) if (features[i].type === 'paint') last = Math.max(last, Number(features[i].params.slot) || 0)
  return Math.min(SLOT_COUNT, last + 1)
}
