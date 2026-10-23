import { create } from 'zustand'
import type { ParamSchema, ParamValues } from '@/ui/schema'

export type Workspace = 'solid' | 'surface' | 'mesh' | 'hair'
export type DisplayMode = 'shaded' | 'shadedEdges' | 'wireframe' | 'xray'
export type Projection = 'perspective' | 'orthographic'
export type Theme = 'dark' | 'light'
export type SelectionFilter = 'body' | 'face' | 'edge'
export type EntityKind = 'body' | 'face' | 'edge' | 'sketch' | 'mesh' | 'plane' | 'axis' | 'feature'

export interface SelectionRef {
  kind: EntityKind
  /** entity id (body id, or `${bodyId}` for face/edge with index below) */
  id: string
  /** face / edge index within the entity */
  index?: number
}

export interface SectionState { on: boolean; axis: 'X' | 'Y' | 'Z'; offset: number; flip: boolean }

/** Origin planes start hidden (like Fusion); the Browser's eye toggles show them. */
export const DEFAULT_HIDDEN: Record<string, true> = { planeXY: true, planeXZ: true, planeYZ: true }

export interface InspectorSession {
  schema: ParamSchema
  values: ParamValues
  /** called on every change for live preview */
  onChange?: (values: ParamValues) => void
  onOk: (values: ParamValues) => void
  onCancel: () => void
}

interface UiState {
  workspace: Workspace
  /** contextual SKETCH tab visible/active */
  sketchMode: boolean
  activeTool: string | null
  displayMode: DisplayMode
  projection: Projection
  ssao: boolean
  showOrigin: boolean
  showGrid: boolean
  theme: Theme
  units: 'mm' | 'in'
  snap: boolean
  selectionFilter: SelectionFilter
  selection: SelectionRef[]
  hover: SelectionRef | null
  hiddenIds: Record<string, true>
  paletteOpen: boolean
  inspector: InspectorSession | null
  /** a selection field that accepts sketches is active: finished sketch curves become clickable */
  pickSketches: boolean
  /** extra entities drawn highlighted without being selected (e.g. both Measure picks) */
  highlight: SelectionRef[]
  /** section analysis clipping plane */
  section: SectionState
  /** viewport stats */
  triangles: number
  kernelBusy: boolean

  setWorkspace: (w: Workspace) => void
  setSketchMode: (on: boolean) => void
  setActiveTool: (id: string | null) => void
  setDisplayMode: (m: DisplayMode) => void
  setProjection: (p: Projection) => void
  toggleSsao: () => void
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  toggleSnap: () => void
  setUnits: (u: 'mm' | 'in') => void
  setSelectionFilter: (f: SelectionFilter) => void
  setSelection: (s: SelectionRef[], additive?: boolean) => void
  clearSelection: () => void
  setHover: (h: SelectionRef | null) => void
  toggleHidden: (id: string) => void
  setPaletteOpen: (o: boolean) => void
  openInspector: (s: InspectorSession) => void
  closeInspector: () => void
  setStats: (p: { triangles?: number; kernelBusy?: boolean }) => void
  setSection: (p: Partial<SectionState>) => void
  /** hide everything except `id` (or show everything again when it is already isolated) */
  isolate: (id: string, all: string[]) => void
}

const sameRef = (a: SelectionRef, b: SelectionRef) => a.kind === b.kind && a.id === b.id && a.index === b.index

export const useUi = create<UiState>((set, get) => ({
  workspace: 'solid',
  sketchMode: false,
  activeTool: null,
  displayMode: 'shadedEdges',
  projection: 'perspective',
  ssao: true,
  showOrigin: true,
  showGrid: true,
  theme: 'dark',
  units: 'mm',
  snap: true,
  selectionFilter: 'face',
  selection: [],
  hover: null,
  hiddenIds: { ...DEFAULT_HIDDEN },
  paletteOpen: false,
  inspector: null,
  pickSketches: false,
  highlight: [],
  section: { on: false, axis: 'Z', offset: 0, flip: false },
  triangles: 0,
  kernelBusy: false,

  setWorkspace: (workspace) => set({ workspace }),
  setSketchMode: (sketchMode) => set({ sketchMode }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setProjection: (projection) => set({ projection }),
  toggleSsao: () => set((s) => ({ ssao: !s.ssao })),
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme
    set({ theme })
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  toggleSnap: () => set((s) => ({ snap: !s.snap })),
  setUnits: (units) => set({ units }),
  setSelectionFilter: (selectionFilter) => set({ selectionFilter }),
  setSelection: (next, additive) =>
    set((s) => {
      if (!additive) return { selection: next }
      const out = [...s.selection]
      for (const r of next) {
        const i = out.findIndex((x) => sameRef(x, r))
        if (i >= 0) out.splice(i, 1)
        else out.push(r)
      }
      return { selection: out }
    }),
  clearSelection: () => set({ selection: [] }),
  setHover: (hover) => set({ hover }),
  toggleHidden: (id) =>
    set((s) => {
      const h = { ...s.hiddenIds }
      if (h[id]) delete h[id]
      else h[id] = true
      return { hiddenIds: h }
    }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openInspector: (inspector) => set({ inspector }),
  closeInspector: () => set({ inspector: null }),
  setStats: (p) => set(p),
  setSection: (p) => set((s) => ({ section: { ...s.section, ...p } })),
  isolate: (id, all) =>
    set((s) => {
      const others = all.filter((x) => x !== id)
      const isolated = !s.hiddenIds[id] && others.every((x) => s.hiddenIds[x])
      if (isolated) return { hiddenIds: { ...DEFAULT_HIDDEN } }
      const h: Record<string, true> = { ...DEFAULT_HIDDEN }
      for (const x of others) h[x] = true
      delete h[id]
      return { hiddenIds: h }
    }),
}))
