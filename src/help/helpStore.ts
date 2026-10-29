import { create } from 'zustand'
import { useSettings } from '@/settings/settings'

export type HelpPage =
  | { kind: 'start' }
  | { kind: 'shortcuts' }
  | { kind: 'about' }
  | { kind: 'guide'; id: string; section?: string }

interface HelpState {
  open: boolean
  page: HelpPage
  /** the intro tour is running */
  tour: boolean
  tourStep: number
  show: (page: HelpPage) => void
  close: () => void
  startTour: () => void
  setTourStep: (n: number) => void
  /** leave the tour (finished or skipped): it does not come back by itself */
  endTour: () => void
}

export const useHelp = create<HelpState>((set) => ({
  open: false,
  page: { kind: 'start' },
  tour: false,
  tourStep: 0,
  show: (page) => set({ open: true, page, tour: false }),
  close: () => set({ open: false }),
  startTour: () => set({ tour: true, tourStep: 0, open: false }),
  setTourStep: (tourStep) => set({ tourStep }),
  endTour: () => {
    set({ tour: false })
    useSettings.getState().setTourSeen(true)
  },
}))

/** Open the guide of a workspace (and a section of it). */
export const openGuide = (id: string, section?: string) => useHelp.getState().show({ kind: 'guide', id, section })
