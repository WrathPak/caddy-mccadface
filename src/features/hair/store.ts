/** Live hair preview state shared between the feature, the viewport layer and the status bar. */
import { create } from 'zustand'
import type { HairPreviewResult } from '@/kernel/hair-ops'
import type { Glyphs } from './glyphs'
import type { V3 } from './schema'

interface HairView {
  /** strands + wall mesh from the last preview run */
  result: HairPreviewResult | null
  error: string | null
  busy: boolean
  /** "Preview Strands" ribbon toggle */
  visible: boolean
  /** direction arrows on the selected faces */
  glyphs: Glyphs | null
  /** the Direction section is the active one: show the arrows */
  showGlyphs: boolean
  /** Fixed direction: current vector and how to change it from the viewport arrow */
  fixed: { dir: V3; set: (d: V3) => void } | null
}

export const useHairView = create<HairView>(() => ({ result: null, error: null, busy: false, visible: true, glyphs: null, showGlyphs: true, fixed: null }))
export const clearHairView = () => useHairView.setState({ result: null, error: null, busy: false, glyphs: null, fixed: null, showGlyphs: true })
