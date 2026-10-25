/** The Render workspace's settings store, saved next to the document as render.json. */
import { create } from 'zustand'
import { registerProjectSection } from '@/io/project'
import { DEFAULT_SETTINGS, normalizeSettings, settingsToJson, type RenderSettings } from './settingsCore'

export * from './settingsCore'

interface SettingsState { s: RenderSettings; set: (p: Partial<RenderSettings>) => void; setTurntable: (p: Partial<RenderSettings['turntable']>) => void; reset: () => void }

export const useRenderSettings = create<SettingsState>((set) => ({
  s: DEFAULT_SETTINGS,
  set: (p) => set((st) => ({ s: normalizeSettings({ ...st.s, ...p }) })),
  setTurntable: (p) => set((st) => ({ s: normalizeSettings({ ...st.s, turntable: { ...st.s.turntable, ...p } }) })),
  reset: () => set({ s: DEFAULT_SETTINGS }),
}))

registerProjectSection({
  file: 'render.json',
  save: () => settingsToJson(useRenderSettings.getState().s),
  load: (json) => useRenderSettings.setState({ s: json ? normalizeSettings(json) : DEFAULT_SETTINGS }),
})
