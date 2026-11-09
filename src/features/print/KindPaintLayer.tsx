/** Support, seam and fuzzy skin marks on the bodies in the colors Orca uses: enforcers green, blockers red, seam blue and amber, fuzzy skin purple. */
import { useMemo } from 'react'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { sectionPlane } from '@/viewport/section'
import { computeKindMaps, usePendingPaint, type PaintKind, type PaintMap } from './paint'
import { PaintedBody } from './PrintCanvas'

export const MARK_COLORS: Record<'supports' | 'seam' | 'fuzzy', Record<number, string>> = {
  supports: { 1: '#3fbf72', 2: '#e5484d' },
  seam: { 1: '#3b82f6', 2: '#f0a030' },
  fuzzy: { 1: '#a855f7' },
}

export function KindPaintLayer() {
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const geometry = useDoc((s) => s.geometry)
  const hidden = useUi((s) => s.hiddenIds)
  const mode = useUi((s) => s.displayMode)
  const section = useUi((s) => s.section)
  const pending = usePendingPaint((s) => s.kindMap)
  const pendingKind = usePendingPaint((s) => s.kind)
  const maps = useMemo(() => computeKindMaps(features, rollback, geometry), [features, rollback, geometry])
  const clip = useMemo(() => (section.on ? [sectionPlane(section)] : []), [section])
  if (mode === 'wireframe') return null
  const opacity = mode === 'xray' ? 0.4 : 1
  const layers: { kind: Exclude<PaintKind, 'filament'>; map: PaintMap; tag: string }[] = [
    { kind: 'supports', map: maps.supports, tag: 'supports' }, { kind: 'seam', map: maps.seam, tag: 'seam' }, { kind: 'fuzzy', map: maps.fuzzy, tag: 'fuzzy' },
  ]
  if (pending && pendingKind !== 'filament') layers.push({ kind: pendingKind as Exclude<PaintKind, 'filament'>, map: pending, tag: 'pending' })
  return (
    <group name="print-kind-layer">
      {layers.flatMap((l) => geometry.map((b) => {
        const m = l.map.get(b.id)
        return m && !hidden[b.id] ? <PaintedBody key={`${b.key}:${l.tag}`} body={b} map={m} colors={MARK_COLORS[l.kind]} clip={clip} opacity={opacity} /> : null
      }))}
    </group>
  )
}
