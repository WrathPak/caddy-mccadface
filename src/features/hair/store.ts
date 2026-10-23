/** Live hair preview state shared between the feature, the viewport layer and the status bar. */
import { create } from 'zustand'
import type { HairPreviewResult } from '@/kernel/hair-ops'

interface HairView {
  /** strands + wall mesh from the last preview run */
  result: HairPreviewResult | null
  error: string | null
  busy: boolean
  /** "Preview Strands" ribbon toggle */
  visible: boolean
}

export const useHairView = create<HairView>(() => ({ result: null, error: null, busy: false, visible: true }))
export const clearHairView = () => useHairView.setState({ result: null, error: null, busy: false })
