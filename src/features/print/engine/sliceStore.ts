/**
 * The current slice: what the Slice command produced, shared by the slice panel (phase 1) and the layer preview (phase 2).
 * The preview only reads `result`, `filamentColors` and `preview`; the slice side owns everything else.
 */
import { create } from 'zustand'
import type { SliceSnapshot } from '../slice/run'
import type { SliceOutput } from './types'

export type SliceStatus = 'idle' | 'loading' | 'slicing' | 'done' | 'error'

export interface SliceState {
  status: SliceStatus
  /** 0-100 while loading or slicing */
  progress: number
  /** the engine's progress text, or the error */
  message: string
  result: SliceOutput | null
  /** hex color per extruder (index 0 = filament 1), from the filament presets or the plate's slot colors */
  filamentColors: string[]
  /** printer bed size in mm (x, y), so the preview can line up with the plate */
  bed: [number, number] | null
  /** world position of bed coordinate (0,0,0): where the sliced toolpaths sit relative to the bodies. Null until a slice. */
  bedOrigin: [number, number, number] | null
  /** the plate changed after this slice: the result is kept but shown as out of date */
  stale: boolean
  /** show the sliced toolpaths in the viewport instead of the bodies */
  preview: boolean
  /** (slice side) bytes of the engine downloaded so far while it loads */
  download: { loaded: number; total: number } | null
  /** (slice side) what the slice was made from, for the export and the result card */
  snapshot: SliceSnapshot | null
}

export const useSlice = create<SliceState>(() => ({
  status: 'idle',
  progress: 0,
  message: '',
  result: null,
  filamentColors: [],
  bed: null,
  bedOrigin: null,
  stale: false,
  preview: false,
  download: null,
  snapshot: null,
}))

export const setPreview = (preview: boolean) => useSlice.setState({ preview })
