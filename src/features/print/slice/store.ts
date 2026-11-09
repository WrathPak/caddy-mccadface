/** State of the Slice panel: what is open, which page, the settings documents the engine returned, and the resolved presets. */
import type { SettingPrompt, SettingsView } from '@muon3d/slicer-engine-protocol'
import { create } from 'zustand'
import type { Resolved } from '../engine/profiles'
import type { PanelMode } from './profile'

export type SheetTab = 'quick' | 'process' | 'filament' | 'printer' | 'objects'
export type PresetScopeTab = 'process' | 'filament' | 'machine'

export interface SlicerState {
  sheetOpen: boolean
  tab: SheetTab
  /** the open page of each preset tab */
  page: Record<PresetScopeTab, string>
  mode: PanelMode
  search: string
  /** the filament slot the Filament tab edits (0-based) */
  slot: number
  /** the object the Objects tab edits */
  objectId: string | null
  /** presets with defaults, user presets and overrides applied; null until they are read */
  resolved: Resolved | null
  /** the settings documents of the open tab */
  view: SettingsView | null
  objectView: SettingsView | null
  /** Orca's questions about the last edit */
  prompts: SettingPrompt[]
  /** what Orca told the person about a value it changed on its own */
  notices: string[]
  /** the engine or the profile set could not be reached */
  error: string | null
  openSheet: (tab?: SheetTab) => void
  closeSheet: () => void
  set: (p: Partial<SlicerState>) => void
}

const MODE_KEY = 'caddy.slicer.mode'
const savedMode = (): PanelMode => {
  try {
    const m = localStorage.getItem(MODE_KEY)
    return m === 'simple' || m === 'expert' ? m : 'advanced'
  } catch { return 'advanced' }
}
export const saveMode = (m: PanelMode) => { try { localStorage.setItem(MODE_KEY, m) } catch { /* private mode */ } }

export const useSlicer = create<SlicerState>((set) => ({
  sheetOpen: false,
  tab: 'quick',
  page: { process: '', filament: '', machine: '' },
  mode: savedMode(),
  search: '',
  slot: 0,
  objectId: null,
  resolved: null,
  view: null,
  objectView: null,
  prompts: [],
  notices: [],
  error: null,
  openSheet: (tab) => set((s) => ({ sheetOpen: true, tab: tab ?? s.tab })),
  closeSheet: () => set({ sheetOpen: false, prompts: [], notices: [] }),
  set: (p) => set(p),
}))
