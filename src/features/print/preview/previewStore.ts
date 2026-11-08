/** State of the layer preview: what is shown (layers, scrub, color mode, switches) and what the legend knows about the slice. */
import { create } from 'zustand'
import type { ToolpathExtras } from '@muon3d/slicer-engine-protocol'
import type { SliceOutput } from '../engine/types'
import type { ColorMode, RoleStat } from './data'

export interface PreviewInfo {
  layerCount: number
  layerZ: number[]
  /** the engine sent speed / fan / temperature (needed for those color modes and time shares) */
  hasExtras: boolean
  roles: RoleStat[]
  /** per filament, from the G-code footer; null until the scan has run */
  filaments: { grams: number | null; mm: number | null }[] | null
  /** min / max of the active continuous color mode, for the legend */
  range: { min: number; max: number } | null
  /** segments in the toolpath (all layers) */
  segments: number
}

export interface PreviewState {
  /** bottom and top layer shown, 0-based inclusive */
  lo: number
  hi: number
  /** 0..1 of the top layer drawn */
  scrub: number
  playing: boolean
  mode: ColorMode
  /** switched off by role name / filament index */
  roleOff: Record<string, boolean>
  filOff: Record<number, boolean>
  travel: boolean
  info: PreviewInfo | null
}

export const usePreview = create<PreviewState>(() => ({
  lo: 0, hi: 0, scrub: 1, playing: false, mode: 'feature', roleOff: {}, filOff: {}, travel: false, info: null,
}))

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const last = () => Math.max(0, (usePreview.getState().info?.layerCount ?? 1) - 1)

/** A new result: show every layer again. */
export function resetPreview(info: PreviewInfo) {
  usePreview.setState({ lo: 0, hi: Math.max(0, info.layerCount - 1), scrub: 1, playing: false, roleOff: {}, filOff: {}, info })
}

export const setTop = (v: number) => usePreview.setState((s) => {
  const hi = clamp(Math.round(v), 0, last())
  return { hi, lo: Math.min(s.lo, hi), scrub: 1, playing: false }
})
export const setBottom = (v: number) => usePreview.setState((s) => {
  const lo = clamp(Math.round(v), 0, last())
  return { lo, hi: Math.max(s.hi, lo) }
})
export const setScrub = (v: number) => usePreview.setState({ scrub: clamp(v, 0, 1) })
export const setPlaying = (playing: boolean) => usePreview.setState((s) => (playing && s.scrub >= 1 ? { playing, scrub: 0 } : { playing }))
export const setMode = (mode: ColorMode) => usePreview.setState({ mode })
export const toggleRole = (name: string) => usePreview.setState((s) => ({ roleOff: { ...s.roleOff, [name]: !s.roleOff[name] } }))
export const toggleFilament = (i: number) => usePreview.setState((s) => ({ filOff: { ...s.filOff, [i]: !s.filOff[i] } }))
export const setTravel = (travel: boolean) => usePreview.setState({ travel })

/** What `SliceOutput` carries beyond the fixed fields: the engine's per-segment speed, fan, temperature, time. */
export const extrasOf = (r: SliceOutput | null): ToolpathExtras | null => r?.toolpathExtras ?? null
