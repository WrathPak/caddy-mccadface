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
import { isCoarse } from '@/app/device'

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
/** How sharp the viewport is drawn: the cap on the device pixel ratio. Auto keeps phones and tablets at 1.5 so they stay smooth. */
export type PixelRatio = 'auto' | '1' | '1.5' | '2' | 'native'
export const PIXEL_RATIOS: { value: PixelRatio; label: string }[] = [
  { value: 'auto', label: 'Auto' }, { value: '1', label: '1x (fastest)' }, { value: '1.5', label: '1.5x' }, { value: '2', label: '2x' }, { value: 'native', label: 'Full (sharpest)' },
]
/** Ambient occlusion costs three extra passes: it starts off on touch screens, where the GPU is the weak part. */
const defaultSsao = () => !isCoarse()
/** The pixel-ratio range the canvas may use. */
export const dprRange = (p: PixelRatio, coarse: boolean): [number, number] => (p === 'auto' ? [1, coarse ? 1.5 : 2] : p === 'native' ? [1, 4] : [1, Number(p)])

interface Persisted {
  units: 'mm' | 'in'
  defaultWorkspace: string
  themeMode: ThemeMode
  showGrid: boolean
  ssao: boolean
  displayMode: DisplayMode
  gridDensity: GridDensity
  pixelRatio: PixelRatio
  showOrigin: boolean
  selectionColor: string
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
  pixelRatio: 'auto',
  showOrigin: true,
  selectionColor: '',
  autosave: true,
  autosaveSeconds: 30,
  tooltips: true,
  beginnerTips: true,
  tourSeen: false,
}

/** A selection colour is '#rrggbb', or empty for the theme's accent. */
export const validSelectionColor = (v: unknown): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '')

const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS, ssao: defaultSsao() }
    const v = JSON.parse(raw) as Partial<Persisted>
    return {
      units: oneOf(v.units, ['mm', 'in'], DEFAULTS.units),
      defaultWorkspace: oneOf(v.defaultWorkspace, WORKSPACES.map((w) => w.id), DEFAULTS.defaultWorkspace),
      themeMode: oneOf(v.themeMode, ['dark', 'light', 'system'], DEFAULTS.themeMode),
      showGrid: v.showGrid !== false,
      ssao: typeof v.ssao === 'boolean' ? v.ssao : defaultSsao(),
      displayMode: oneOf(v.displayMode, ['shaded', 'shadedEdges', 'wireframe', 'xray'], DEFAULTS.displayMode),
      gridDensity: oneOf(v.gridDensity, ['fine', 'normal', 'coarse'], DEFAULTS.gridDensity),
      pixelRatio: oneOf(v.pixelRatio, ['auto', '1', '1.5', '2', 'native'], DEFAULTS.pixelRatio),
      showOrigin: v.showOrigin !== false,
      selectionColor: validSelectionColor(v.selectionColor),
      autosave: v.autosave !== false,
      autosaveSeconds: AUTOSAVE_CHOICES.includes(v.autosaveSeconds as number) ? (v.autosaveSeconds as number) : DEFAULTS.autosaveSeconds,
      tooltips: v.tooltips !== false,
      beginnerTips: v.beginnerTips !== false,
      tourSeen: v.tourSeen === true,
    }
  } catch {
    return { ...DEFAULTS, ssao: defaultSsao() }
  }
}

interface SettingsState {
  defaultWorkspace: string
  themeMode: ThemeMode
  gridDensity: GridDensity
  pixelRatio: PixelRatio
  /** Colour of selected and pre-selected (hovered) things in the viewport; empty means the accent. */
  selectionColor: string
  autosave: boolean
  autosaveSeconds: number
  tooltips: boolean
  beginnerTips: boolean
  tourSeen: boolean
  setSelectionColor: (c: string) => void
  setPixelRatio: (p: PixelRatio) => void
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
    pixelRatio: init.pixelRatio,
    selectionColor: init.selectionColor,
    autosave: init.autosave,
    autosaveSeconds: init.autosaveSeconds,
    tooltips: init.tooltips,
    beginnerTips: init.beginnerTips,
    tourSeen: init.tourSeen,
    setPixelRatio: (pixelRatio) => set({ pixelRatio }),
    setSelectionColor: (c) => set({ selectionColor: validSelectionColor(c) }),
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
      set({ pixelRatio: d.pixelRatio, selectionColor: d.selectionColor, defaultWorkspace: d.defaultWorkspace, autosave: d.autosave, autosaveSeconds: d.autosaveSeconds, tooltips: d.tooltips, beginnerTips: d.beginnerTips })
      useUi.setState({ units: d.units, showGrid: d.showGrid, showOrigin: d.showOrigin, ssao: defaultSsao(), displayMode: d.displayMode })
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
    pixelRatio: s.pixelRatio,
    showOrigin: u.showOrigin,
    selectionColor: s.selectionColor,
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
  useUi.setState({ units: init.units, showGrid: init.showGrid, showOrigin: init.showOrigin, ssao: init.ssao, displayMode: init.displayMode })
  ui.setTheme(resolveTheme(init.themeMode))
  const ws = init.defaultWorkspace
  if (ws !== 'solid') ui.setWorkspace(ws as Workspace)
  useSettings.subscribe(save)
  useUi.subscribe((s, p) => {
    if (s.units !== p.units || s.showGrid !== p.showGrid || s.showOrigin !== p.showOrigin || s.ssao !== p.ssao || s.displayMode !== p.displayMode) save()
    // a theme change from anywhere that is not the setting itself (a plugin, a test) becomes the explicit choice
    if (s.theme !== p.theme && resolveTheme(useSettings.getState().themeMode) !== s.theme) useSettings.setState({ themeMode: s.theme })
  })
  try {
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (useSettings.getState().themeMode === 'system') useUi.getState().setTheme(systemTheme())
    })
  } catch { /* no matchMedia */ }
}
