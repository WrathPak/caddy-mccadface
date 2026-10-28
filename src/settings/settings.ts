/**
 * App preferences, kept in localStorage. Navigation settings live in viewport/navSettings.ts (their own key, older than this).
 *
 * Some preferences are plain app state that other parts of the UI also change (units from the status bar, the grid and AO
 * buttons of the viewport toolbar, the theme button): those stay in the ui store, and this module loads them into it at
 * startup and saves them whenever they change. The rest (autosave, tooltips, tips, tour) lives in `useSettings`.
 */
import { create } from 'zustand'
import { useUi, type DisplayMode, type Theme, type Workspace } from '@/store/ui'
import { setGridDensity, type GridDensity } from '@/viewport/gridMath'

const KEY = 'caddy.settings'

export type ThemeMode = Theme | 'system'
export const WORKSPACES: { id: string; label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'assemble', label: 'Assemble' },
  { id: 'surface', label: 'Surface' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'hair', label: 'Hair' },
  { id: 'detail', label: 'Detail' },
  { id: 'print', label: 'Print' },
  { id: 'drawing', label: 'Drawing' },
  { id: 'render', label: 'Render' },
]
export const AUTOSAVE_CHOICES = [15, 30, 60, 120, 300]

interface Persisted {
  units: 'mm' | 'in'
  defaultWorkspace: string
  themeMode: ThemeMode
  showGrid: boolean
  ssao: boolean
  displayMode: DisplayMode
  gridDensity: GridDensity
  autosave: boolean
  autosaveSeconds: number
  tooltips: boolean
  beginnerTips: boolean
  tourSeen: boolean
}

const DEFAULTS: Persisted = {
  units: 'mm',
  defaultWorkspace: 'solid',
  themeMode: 'dark',
  showGrid: true,
  ssao: true,
  displayMode: 'shadedEdges',
  gridDensity: 'normal',
  autosave: true,
  autosaveSeconds: 30,
  tooltips: true,
  beginnerTips: true,
  tourSeen: false,
}

const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const v = JSON.parse(raw) as Partial<Persisted>
    return {
      units: oneOf(v.units, ['mm', 'in'], DEFAULTS.units),
      defaultWorkspace: oneOf(v.defaultWorkspace, WORKSPACES.map((w) => w.id), DEFAULTS.defaultWorkspace),
      themeMode: oneOf(v.themeMode, ['dark', 'light', 'system'], DEFAULTS.themeMode),
      showGrid: v.showGrid !== false,
      ssao: v.ssao !== false,
      displayMode: oneOf(v.displayMode, ['shaded', 'shadedEdges', 'wireframe', 'xray'], DEFAULTS.displayMode),
      gridDensity: oneOf(v.gridDensity, ['fine', 'normal', 'coarse'], DEFAULTS.gridDensity),
      autosave: v.autosave !== false,
      autosaveSeconds: AUTOSAVE_CHOICES.includes(v.autosaveSeconds as number) ? (v.autosaveSeconds as number) : DEFAULTS.autosaveSeconds,
      tooltips: v.tooltips !== false,
      beginnerTips: v.beginnerTips !== false,
      tourSeen: v.tourSeen === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

interface SettingsState {
  defaultWorkspace: string
  themeMode: ThemeMode
  gridDensity: GridDensity
  autosave: boolean
  autosaveSeconds: number
  tooltips: boolean
  beginnerTips: boolean
  tourSeen: boolean
  setDefaultWorkspace: (w: string) => void
  setThemeMode: (m: ThemeMode) => void
  /** Flip between dark and light (the ribbon button, the palette command). */
  toggleTheme: () => void
  setGridDensity: (d: GridDensity) => void
  setAutosave: (on: boolean) => void
  setAutosaveSeconds: (s: number) => void
  setTooltips: (on: boolean) => void
  setBeginnerTips: (on: boolean) => void
  setTourSeen: (seen: boolean) => void
  /** Back to the defaults, for every preference in the dialog (navigation has its own). */
  resetAll: () => void
}

const systemTheme = (): Theme => {
  try { return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark' } catch { return 'dark' }
}
const resolveTheme = (m: ThemeMode): Theme => (m === 'system' ? systemTheme() : m)

export const useSettings = create<SettingsState>((set, get) => {
  const init = load()
  return {
    defaultWorkspace: init.defaultWorkspace,
    themeMode: init.themeMode,
    gridDensity: init.gridDensity,
    autosave: init.autosave,
    autosaveSeconds: init.autosaveSeconds,
    tooltips: init.tooltips,
    beginnerTips: init.beginnerTips,
    tourSeen: init.tourSeen,
    setDefaultWorkspace: (defaultWorkspace) => set({ defaultWorkspace }),
    setThemeMode: (themeMode) => {
      set({ themeMode })
      useUi.getState().setTheme(resolveTheme(themeMode))
    },
    toggleTheme: () => get().setThemeMode(useUi.getState().theme === 'dark' ? 'light' : 'dark'),
    setGridDensity: (gridDensity) => {
      set({ gridDensity })
      setGridDensity(gridDensity)
      // the grid shader reads this when the next frame is drawn
      useUi.setState({ showGrid: useUi.getState().showGrid })
    },
    setAutosave: (autosave) => set({ autosave }),
    setAutosaveSeconds: (autosaveSeconds) => set({ autosaveSeconds }),
    setTooltips: (tooltips) => set({ tooltips }),
    setBeginnerTips: (beginnerTips) => set({ beginnerTips }),
    setTourSeen: (tourSeen) => set({ tourSeen }),
    resetAll: () => {
      const d = DEFAULTS
      const s = get()
      s.setThemeMode(d.themeMode)
      s.setGridDensity(d.gridDensity)
      set({ defaultWorkspace: d.defaultWorkspace, autosave: d.autosave, autosaveSeconds: d.autosaveSeconds, tooltips: d.tooltips, beginnerTips: d.beginnerTips })
      useUi.setState({ units: d.units, showGrid: d.showGrid, ssao: d.ssao, displayMode: d.displayMode })
    },
  }
})

function save() {
  const s = useSettings.getState()
  const u = useUi.getState()
  const out: Persisted = {
    units: u.units,
    defaultWorkspace: s.defaultWorkspace,
    themeMode: s.themeMode,
    showGrid: u.showGrid,
    ssao: u.ssao,
    displayMode: u.displayMode,
    gridDensity: s.gridDensity,
    autosave: s.autosave,
    autosaveSeconds: s.autosaveSeconds,
    tooltips: s.tooltips,
    beginnerTips: s.beginnerTips,
    tourSeen: s.tourSeen,
  }
  try { localStorage.setItem(KEY, JSON.stringify(out)) } catch { /* private mode / blocked storage: the preferences just last for this session */ }
}

let started = false
/** Push the saved preferences into the app and keep saving them. Call once, before the first render. */
export function startSettings() {
  if (started) return
  started = true
  const init = load()
  setGridDensity(init.gridDensity)
  const ui = useUi.getState()
  useUi.setState({ units: init.units, showGrid: init.showGrid, ssao: init.ssao, displayMode: init.displayMode })
  ui.setTheme(resolveTheme(init.themeMode))
  const ws = init.defaultWorkspace
  if (ws !== 'solid') ui.setWorkspace(ws as Workspace)
  useSettings.subscribe(save)
  useUi.subscribe((s, p) => {
    if (s.units !== p.units || s.showGrid !== p.showGrid || s.ssao !== p.ssao || s.displayMode !== p.displayMode) save()
    // a theme change from anywhere that is not the setting itself (a plugin, a test) becomes the explicit choice
    if (s.theme !== p.theme && resolveTheme(useSettings.getState().themeMode) !== s.theme) useSettings.setState({ themeMode: s.theme })
  })
  try {
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (useSettings.getState().themeMode === 'system') useUi.getState().setTheme(systemTheme())
    })
  } catch { /* no matchMedia */ }
}
