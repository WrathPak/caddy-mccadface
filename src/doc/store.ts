/**
 * Document store. Holds the feature timeline + user parameters (undoable), the blobs (import sources),
 * and the geometry produced by the regeneration engine (engine.ts).
 */
import { create } from 'zustand'
import type { Body } from '@/kernel/types'
import type { ParamValues } from '@/ui/schema'
import { DEFAULT_HIDDEN, useUi } from '@/store/ui'
import { getFeature } from './registry'
import { effectiveParams, setUserParams as applyUserParams } from './params'
import { emptyAssembly, normalizeAssembly, ROOT } from '@/assembly/types'
import { resetAssemblyRuntime } from '@/assembly/runtime'
import type { Config, DocData, Feature, FeatureState, UserParam } from './types'

export type { Feature, FeatureState } from './types'
/** What the engine reports per feature after a pass. */
export interface FeatureStatus { state: FeatureState; error?: string; warning?: string; reboundRefs?: string[]; lostRefs?: string[] }
export interface TreeEntity { id: string; name: string }
type Coll = 'bodies' | 'sketches' | 'meshes' | 'features'

interface HistoryItem { label: string; data: DocData }

interface DocState extends DocData {
  selectedFeatureId: string | null
  /** import sources etc., keyed by blob id (saved in the .caddy zip) */
  blobs: Record<string, Uint8Array>
  /** bodies produced by the regeneration engine (what the viewport renders) */
  geometry: Body[]
  bodies: TreeEntity[]
  sketches: TreeEntity[]
  meshes: TreeEntity[]
  dirty: boolean
  regenerating: boolean
  undoDepth: number
  redoDepth: number
  /** the instance being edited, as an occurrence path (new features go into its component); null is the root component */
  activeOcc: string | null

  // timeline
  setRollback: (n: number) => void
  selectFeature: (id: string | null) => void
  toggleSuppress: (id: string) => void
  addFeature: (type: string, params: ParamValues, name?: string) => string
  updateFeature: (id: string, params: ParamValues) => void
  removeFeature: (id: string) => void
  // tree
  renameEntity: (kind: Coll, id: string, name: string) => void
  deleteEntity: (kind: Coll, id: string) => void
  // params
  setUserParams: (p: UserParam[]) => void
  setConfigs: (c: Config[]) => void
  setActiveConfig: (name: string | null) => void
  // history
  commit: (label: string, fn: (d: DocData) => DocData) => void
  undo: () => void
  redo: () => void
  // documents
  addBlob: (bytes: Uint8Array) => string
  newDocument: () => void
  loadDocument: (data: DocData, blobs: Record<string, Uint8Array>) => void
  getData: () => DocData
  markClean: () => void
  setActiveOcc: (id: string | null) => void
  // engine hooks
  setGeometry: (g: Body[]) => void
  applyStatus: (s: Record<string, FeatureStatus>) => void
}

let regenHandler: () => void = () => {}
/** Set by engine.ts. */
export const setRegenHandler = (fn: () => void) => { regenHandler = fn }

const past: HistoryItem[] = []
const future: HistoryItem[] = []

const empty = (): DocData => ({ name: 'Untitled', features: [], rollback: 0, userParams: [], bodyNames: {}, configs: [], activeConfig: null, assembly: emptyAssembly() })

function derive(s: Pick<DocState, 'geometry' | 'bodyNames' | 'features'>) {
  const name = (b: Body) => s.bodyNames[b.id] ?? b.name
  return {
    bodies: s.geometry.filter((b) => b.kind === 'brep').map((b) => ({ id: b.id, name: name(b) })),
    meshes: s.geometry.filter((b) => b.kind === 'mesh').map((b) => ({ id: b.id, name: name(b) })),
    sketches: s.features.filter((f) => f.type === 'sketch').map((f) => ({ id: f.id, name: f.name })),
  }
}

/** The component definition that new features go into: the one of the active instance (an occurrence path), else the root. */
export function activeDefId(s: { activeOcc: string | null; assembly: DocData['assembly'] }): string {
  const last = s.activeOcc ? s.activeOcc.slice(s.activeOcc.lastIndexOf('/') + 1) : ''
  const o = last ? s.assembly.occurrences.find((x) => x.id === last) : undefined
  return o ? o.component : ROOT
}

const nextId = (features: Feature[]) =>
  'f' + (features.reduce((m, f) => Math.max(m, parseInt(f.id.slice(1), 10) || 0), 0) + 1)

export const useDoc = create<DocState>((set, get) => {
  const pick = (): DocData => {
    const s = get()
    return { name: s.name, features: s.features, rollback: s.rollback, userParams: s.userParams, bodyNames: s.bodyNames, configs: s.configs, activeConfig: s.activeConfig, assembly: s.assembly }
  }
  const apply = (d: DocData, extra: Partial<DocState> = {}) => {
    applyUserParams(effectiveParams(d.userParams, d.configs, d.activeConfig))
    set((s) => ({
      ...d,
      ...derive({ geometry: s.geometry, bodyNames: d.bodyNames, features: d.features }),
      undoDepth: past.length,
      redoDepth: future.length,
      ...extra,
    }))
    regenHandler()
  }

  return {
    ...empty(),
    selectedFeatureId: null,
    blobs: {},
    geometry: [],
    bodies: [],
    sketches: [],
    meshes: [],
    dirty: false,
    regenerating: false,
    undoDepth: 0,
    redoDepth: 0,
    activeOcc: null,

    setRollback: (n) => {
      set({ rollback: Math.max(0, Math.min(get().features.length, n)) })
      regenHandler()
    },
    selectFeature: (selectedFeatureId) => set({ selectedFeatureId }),
    toggleSuppress: (id) =>
      get().commit('Suppress', (d) => ({
        ...d,
        features: d.features.map((f) => (f.id === id ? { ...f, suppressed: !f.suppressed, state: f.suppressed ? 'ok' : 'suppressed' } : f)),
      })),
    addFeature: (type, params, name) => {
      const id = nextId(get().features)
      const def = getFeature(type)
      const count = get().features.filter((f) => f.type === type).length + 1
      const comp = activeDefId(get())
      const feature: Feature = { id, type, name: name ?? `${def?.label ?? type}${count}`, state: 'ok', suppressed: false, params, ...(comp !== ROOT ? { component: comp } : {}) }
      get().commit(`Add ${feature.name}`, (d) => {
        const features = [...d.features]
        features.splice(d.rollback, 0, feature)
        return { ...d, features, rollback: d.rollback + 1 }
      })
      return id
    },
    updateFeature: (id, params) =>
      get().commit('Edit feature', (d) => ({ ...d, features: d.features.map((f) => (f.id === id ? { ...f, params } : f)) })),
    removeFeature: (id) =>
      get().commit('Delete feature', (d) => {
        const i = d.features.findIndex((f) => f.id === id)
        if (i < 0) return d
        return { ...d, features: d.features.filter((f) => f.id !== id), rollback: i < d.rollback ? d.rollback - 1 : d.rollback }
      }),

    renameEntity: (kind, id, name) => {
      if (kind === 'bodies' || kind === 'meshes') get().commit('Rename', (d) => ({ ...d, bodyNames: { ...d.bodyNames, [id]: name } }))
      else get().commit('Rename', (d) => ({ ...d, features: d.features.map((f) => (f.id === id ? { ...f, name } : f)) }))
    },
    deleteEntity: (kind, id) => {
      if (kind === 'bodies' || kind === 'meshes') get().addFeature('delete', { bodyIds: [id] })
      else get().removeFeature(id)
    },

    setUserParams: (userParams) => get().commit('Edit parameters', (d) => ({ ...d, userParams })),
    setConfigs: (configs) => get().commit('Edit configurations', (d) => ({ ...d, configs, activeConfig: configs.some((c) => c.name === d.activeConfig) ? d.activeConfig : null })),
    setActiveConfig: (name) => get().commit(name ? `Switch to ${name}` : 'Switch to base parameters', (d) => (d.activeConfig === name ? d : { ...d, activeConfig: name })),

    commit: (label, fn) => {
      const before = pick()
      const after = fn(before)
      if (after === before) return
      past.push({ label, data: before })
      if (past.length > 200) past.shift()
      future.length = 0
      apply(after, { dirty: true })
    },
    undo: () => {
      const h = past.pop()
      if (!h) return
      future.push({ label: h.label, data: pick() })
      apply(h.data, { dirty: true })
    },
    redo: () => {
      const h = future.pop()
      if (!h) return
      past.push({ label: h.label, data: pick() })
      apply(h.data, { dirty: true })
    },

    addBlob: (bytes) => {
      const id = 'b' + (Object.keys(get().blobs).length + 1) + '_' + Math.random().toString(36).slice(2, 7)
      set((s) => ({ blobs: { ...s.blobs, [id]: bytes } }))
      return id
    },
    newDocument: () => {
      past.length = 0
      future.length = 0
      useUi.setState({ selection: [], hover: null, hiddenIds: { ...DEFAULT_HIDDEN } })
      resetAssemblyRuntime()
      apply(empty(), { blobs: {}, selectedFeatureId: null, dirty: false, activeOcc: null })
    },
    loadDocument: (data, blobs) => {
      past.length = 0
      future.length = 0
      useUi.setState({ selection: [], hover: null, hiddenIds: { ...DEFAULT_HIDDEN } })
      resetAssemblyRuntime()
      apply({ ...empty(), ...data, assembly: normalizeAssembly(data.assembly) }, { blobs, selectedFeatureId: null, dirty: false, activeOcc: null })
    },
    setActiveOcc: (activeOcc) => set({ activeOcc }),
    getData: pick,
    markClean: () => set({ dirty: false }),

    setGeometry: (geometry) => set((s) => ({ geometry, ...derive({ geometry, bodyNames: s.bodyNames, features: s.features }) })),
    applyStatus: (st) =>
      set((s) => {
        let changed = false
        const features = s.features.map((f) => {
          const n = st[f.id]
          const same = (a?: string[], b?: string[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
          if (!n || (n.state === f.state && n.error === f.error && n.warning === f.warning && same(n.reboundRefs, f.reboundRefs) && same(n.lostRefs, f.lostRefs))) return f
          changed = true
          return { ...f, state: n.state, error: n.error, warning: n.warning, reboundRefs: n.reboundRefs, lostRefs: n.lostRefs }
        })
        return changed ? { features } : {}
      }),
  }
})
