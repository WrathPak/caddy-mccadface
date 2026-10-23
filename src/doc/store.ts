/**
 * STUB document store. Agent B replaces this with the real document engine
 * (FeatureRegistry, regeneration, undo). Keep the exported shape (useDoc, Feature, TreeEntity)
 * or update src/ui/Timeline.tsx and src/ui/BrowserTree.tsx accordingly.
 */
import { create } from 'zustand'

export type FeatureState = 'ok' | 'error' | 'suppressed'

export interface Feature {
  id: string
  /** feature type id, e.g. 'sketch', 'extrude' (maps to an icon in ui/featureIcons) */
  type: string
  name: string
  state: FeatureState
  error?: string
}

export interface TreeEntity {
  id: string
  name: string
}

interface DocState {
  name: string
  features: Feature[]
  /** number of features that are active; features at index >= rollback are rolled back */
  rollback: number
  selectedFeatureId: string | null
  bodies: TreeEntity[]
  sketches: TreeEntity[]
  meshes: TreeEntity[]

  setRollback: (n: number) => void
  selectFeature: (id: string | null) => void
  toggleSuppress: (id: string) => void
  renameEntity: (kind: 'bodies' | 'sketches' | 'meshes' | 'features', id: string, name: string) => void
  deleteEntity: (kind: 'bodies' | 'sketches' | 'meshes' | 'features', id: string) => void
}

export const useDoc = create<DocState>((set) => ({
  name: 'Untitled',
  features: [
    { id: 'f1', type: 'sketch', name: 'Sketch1', state: 'ok' },
    { id: 'f2', type: 'extrude', name: 'Extrude1', state: 'ok' },
    { id: 'f3', type: 'sketch', name: 'Sketch2', state: 'ok' },
    { id: 'f4', type: 'fillet', name: 'Fillet1', state: 'ok' },
    { id: 'f5', type: 'chamfer', name: 'Chamfer1', state: 'suppressed' },
    { id: 'f6', type: 'importMesh', name: 'Import Mesh1', state: 'ok' },
    { id: 'f7', type: 'hair', name: 'Hair1', state: 'error', error: 'No faces selected' },
  ],
  rollback: 7,
  selectedFeatureId: null,
  bodies: [{ id: 'body1', name: 'Body1' }],
  sketches: [{ id: 'sk1', name: 'Sketch1' }, { id: 'sk2', name: 'Sketch2' }],
  meshes: [{ id: 'mesh1', name: 'Mesh1' }],

  setRollback: (rollback) => set({ rollback }),
  selectFeature: (selectedFeatureId) => set({ selectedFeatureId }),
  toggleSuppress: (id) =>
    set((s) => ({
      features: s.features.map((f) =>
        f.id === id ? { ...f, state: f.state === 'suppressed' ? 'ok' : 'suppressed' } : f,
      ),
    })),
  renameEntity: (kind, id, name) =>
    set((s) => ({ [kind]: (s[kind] as { id: string; name: string }[]).map((e) => (e.id === id ? { ...e, name } : e)) }) as Partial<DocState>),
  deleteEntity: (kind, id) =>
    set((s) => ({ [kind]: (s[kind] as { id: string }[]).filter((e) => e.id !== id) }) as Partial<DocState>),
}))
