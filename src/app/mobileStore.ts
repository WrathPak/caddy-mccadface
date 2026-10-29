/** Which phone-layout sheets are open. The Browser (and the extra panels beside it) slides in from the left, the Timeline from the bottom. */
import { create } from 'zustand'

export type InspectorSnap = 'peek' | 'half' | 'full'

interface MobileState {
  /** the left sheet: null = closed, 'browser' or the id of an extra panel (history, projects, plugins, script) */
  left: string | null
  timeline: boolean
  /** how far the Inspector sheet is pulled up */
  snap: InspectorSnap
  openLeft: (id?: string) => void
  closeLeft: () => void
  setTimeline: (on: boolean) => void
  setSnap: (s: InspectorSnap) => void
  closeAll: () => void
}

export const useMobile = create<MobileState>((set) => ({
  left: null,
  timeline: false,
  snap: 'half',
  openLeft: (id = 'browser') => set({ left: id, timeline: false }),
  closeLeft: () => set({ left: null }),
  setTimeline: (timeline) => set(timeline ? { timeline, left: null } : { timeline }),
  setSnap: (snap) => set({ snap }),
  closeAll: () => set({ left: null, timeline: false }),
}))
