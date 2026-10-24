/** Printability overlays: which map is shown, its thresholds and results. Computed from the visible bodies. */
import { create } from 'zustand'
import { useDoc } from '@/doc/store'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import { overhangMap, smallFeatures, thinWallMap, triInfo, type MeshIn, type SmallFace } from './analysis'
import { currentSettings } from './settings'

export type MapKind = 'overhang' | 'thin' | 'small'

export interface BodyMap {
  bodyId: string
  /** 0 = fine, else (0, 1]: how bad (small features: 1 on every flagged triangle) */
  severity: Float32Array | Uint8Array
  mesh: Body['mesh']
}

export interface MapResult {
  kind: MapKind
  bodies: BodyMap[]
  /** one line per finding for the panel */
  lines: string[]
  /** how many triangles are flagged */
  flagged: number
  /** the flagged area, mm2 */
  area: number
  /** small features found (small-feature map only) */
  faces: (SmallFace & { bodyId: string })[]
}

interface ViewState {
  kind: MapKind | null
  /** overhang angle from vertical, deg */
  angle: number
  /** thinnest wall to accept, mm */
  minThickness: number
  /** narrowest feature to accept, mm */
  minFeature: number
  busy: boolean
  result: MapResult | null
}

export const usePrintView = create<ViewState>(() => {
  const s = currentSettings()
  return { kind: null, angle: s.overhang, minThickness: +(s.nozzle * 2).toFixed(2), minFeature: s.nozzle, busy: false, result: null }
})

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))
const asMesh = (b: Body): MeshIn => ({ positions: b.mesh.positions, indices: b.mesh.indices, faceIds: b.mesh.faceIds })

let seq = 0

/** Compute the current map for the visible bodies (stale runs are dropped). */
export async function runMap(): Promise<void> {
  const st = usePrintView.getState()
  const kind = st.kind
  if (!kind) return
  const my = ++seq
  const hidden = useUi.getState().hiddenIds
  const bodies = useDoc.getState().geometry.filter((b) => !hidden[b.id])
  usePrintView.setState({ busy: true })
  const maps: BodyMap[] = []
  const faces: MapResult['faces'] = []
  let flagged = 0, area = 0, total = 0, thinnest = Infinity
  for (const b of bodies) {
    const m = asMesh(b)
    const info = triInfo(m)
    total += info.area.reduce((s, x) => s + x, 0)
    if (kind === 'overhang') {
      const r = overhangMap(m, info, st.angle)
      maps.push({ bodyId: b.id, severity: r.severity, mesh: b.mesh })
      area += r.area
      flagged += r.severity.reduce((n, x) => n + (x > 0 ? 1 : 0), 0)
    } else if (kind === 'thin') {
      const r = await thinWallMap(m, info, st.minThickness, { shouldStop: () => my !== seq })
      if (my !== seq) return
      maps.push({ bodyId: b.id, severity: r.severity, mesh: b.mesh })
      area += r.area
      thinnest = Math.min(thinnest, r.thinnest)
      flagged += r.severity.reduce((n, x) => n + (x > 0 ? 1 : 0), 0)
    } else {
      const r = smallFeatures(m, info, st.minFeature)
      maps.push({ bodyId: b.id, severity: r.flag, mesh: b.mesh })
      area += r.area
      flagged += r.flag.reduce((n, x) => n + x, 0)
      faces.push(...r.faces.map((f) => ({ ...f, bodyId: b.id })))
    }
  }
  if (my !== seq) return
  const lines: string[] = []
  if (!bodies.length) lines.push('No visible bodies to check.')
  else if (kind === 'overhang') {
    lines.push(area > 0 ? `${fmt(area)} mm2 of overhang (${((100 * area) / Math.max(total, 1e-9)).toFixed(1)} % of the surface) needs support at ${st.angle} deg.` : `No overhang steeper than ${st.angle} deg. This part prints without support.`)
  } else if (kind === 'thin') {
    lines.push(area > 0 ? `${fmt(area)} mm2 of wall is thinner than ${st.minThickness} mm. The thinnest is ${thinnest.toFixed(2)} mm.` : `No wall thinner than ${st.minThickness} mm.${Number.isFinite(thinnest) ? ` The thinnest is ${thinnest.toFixed(2)} mm.` : ''}`)
  } else {
    lines.push(faces.length ? `${faces.length} small ${faces.length === 1 ? 'feature' : 'features'} narrower than ${st.minFeature} mm. The smallest is ${faces[0].size.toFixed(2)} mm wide.` : `No feature narrower than ${st.minFeature} mm.`)
  }
  usePrintView.setState({ result: { kind, bodies: maps, lines, flagged, area, faces }, busy: false })
}

export function showMap(kind: MapKind | null) {
  const s = currentSettings()
  usePrintView.setState({ kind, result: null, angle: s.overhang, minThickness: +(s.nozzle * 2).toFixed(2), minFeature: s.nozzle })
  if (kind) void runMap()
  else seq++
}

/** Overlay colors: a ramp from yellow (just over the limit) to red (worst). */
export function severityColor(sev: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, sev))
  // yellow (0.95, 0.81, 0.18) -> orange (0.94, 0.54, 0.14) -> red (0.84, 0.23, 0.19)
  if (t < 0.5) { const k = t / 0.5; return [0.95 - 0.01 * k, 0.81 - 0.27 * k, 0.18 - 0.04 * k] }
  const k = (t - 0.5) / 0.5
  return [0.94 - 0.1 * k, 0.54 - 0.31 * k, 0.14 + 0.05 * k]
}
export const SMALL_COLOR: [number, number, number] = [0.72, 0.38, 0.92]
