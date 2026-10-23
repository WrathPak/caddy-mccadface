/**
 * Document store. Holds the feature timeline + user parameters (undoable), the blobs (import sources),
 * and the geometry produced by the regeneration engine (engine.ts).
 */
import { create } from 'zustand'
import type { Body } from '@/kernel/types'
import type { ParamValues } from '@/ui/schema'
import { getFeature } from './registry'
import { setUserParams as applyUserParams } from './params'
import type { DocData, Feature, FeatureState, UserParam } from './types'

export type { Feature, FeatureState } from './types'
export interface TreeEntity { id: string; name: string }
type Coll = 'bodies' | 'sketches' | 'meshes' | 'features'

interface HistoryItem { label: string; data: DocData }

interface DocState extends DocData {
  selectedFeatureId: string | null
  /** import sources etc., keyed by blob id (saved in the .weebcad zip) */
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
  // engine hooks
  setGeometry: (g: Body[]) => void
  applyStatus: (s: Record<string, { state: FeatureState; error?: string }>) => void
}

let regenHandler: () => void = () => {}
/** Set by engine.ts. */
export const setRegenHandler = (fn: () => void) => { regenHandler = fn }

const past: HistoryItem[] = []
const future: HistoryItem[] = []

const empty = (): DocData => ({ name: 'Untitled', features: [], rollback: 0, userParams: [], bodyNames: {} })

function derive(s: Pick<DocState, 'geometry' | 'bodyNames' | 'features'>) {
  const name = (b: Body) => s.bodyNames[b.id] ?? b.name
  return {
    bodies: s.geometry.filter((b) => b.kind === 'brep').map((b) => ({ id: b.id, name: name(b) })),
    meshes: s.geometry.filter((b) => b.kind === 'mesh').map((b) => ({ id: b.id, name: name(b) })),
    sketches: s.features.filter((f) => f.type === 'sketch').map((f) => ({ id: f.id, name: f.name })),
  }
}

const nextId = (features: Feature[]) =>
  'f' + (features.reduce((m, f) => Math.max(m, parseInt(f.id.slice(1), 10) || 0), 0) + 1)

export const useDoc = create<DocState>((set, get) => {
  const pick = (): DocData => {
    const s = get()
    return { name: s.name, features: s.features, rollback: s.rollback, userParams: s.userParams, bodyNames: s.bodyNames }
  }
  const apply = (d: DocData, extra: Partial<DocState> = {}) => {
    applyUserParams(d.userParams)
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
      const feature: Feature = { id, type, name: name ?? `${def?.label ?? type}${count}`, state: 'ok', suppressed: false, params }
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
      apply(empty(), { blobs: {}, selectedFeatureId: null, dirty: false })
    },
    loadDocument: (data, blobs) => {
      past.length = 0
      future.length = 0
      apply({ ...empty(), ...data }, { blobs, selectedFeatureId: null, dirty: false })
    },
    getData: pick,
    markClean: () => set({ dirty: false }),

    setGeometry: (geometry) => set((s) => ({ geometry, ...derive({ geometry, bodyNames: s.bodyNames, features: s.features }) })),
    applyStatus: (st) =>
      set((s) => {
        let changed = false
        const features = s.features.map((f) => {
          const n = st[f.id]
          if (!n || (n.state === f.state && n.error === f.error)) return f
          changed = true
          return { ...f, state: n.state, error: n.error }
        })
        return changed ? { features } : {}
      }),
  }
})
