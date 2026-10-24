/** Assembly state that is not part of the document: transient joint drive values, the explode amount, check results, panels. */
import { create } from 'zustand'
import type { Vec3 } from '@/kernel/types'
import type { DriveMap } from './solver'
import type { Joint } from './types'

export type AssemblyPanel = 'joints' | 'motion' | 'explode' | 'check'

export interface InterferenceHit {
  /** the two occurrences (and bodies) that overlap */
  a: { occ: string; body: string; name: string }
  b: { occ: string; body: string; name: string }
  /** volume of the overlap in mm^3 and its bounding box */
  volume: number
  min: Vec3
  max: Vec3
  /** the overlap solid in world coordinates, drawn red */
  positions: Float32Array
  indices: Uint32Array
}
export interface InterferenceReport { hits: InterferenceHit[]; checked: number; stale: boolean }

export interface ClearanceReport {
  a: { occ: string; name: string }
  b: { occ: string; name: string }
  /** smallest distance between the two components (0 when they touch or overlap) */
  distance: number
  /** the closest points, world coordinates */
  pa: Vec3
  pb: Vec3
}

export interface AssemblyRuntime {
  drive: DriveMap
  setDrive: (joint: string, key: string, value: number) => void
  clearDrive: (joint?: string) => void

  /** 0 collapsed .. 1 fully exploded */
  explode: number
  setExplode: (v: number) => void
  /** which explode step is selected in the panel (its trail is highlighted) */
  explodeStep: string | null
  selectExplodeStep: (id: string | null) => void

  /** errors reading linked components, by external id */
  extErrors: Record<string, string>
  setExtErrors: (e: Record<string, string>) => void
  /** linked files whose content changed on disk since they were read: the update notice */
  extChanged: Record<string, { fileName: string; stamp: number; hash: string; bytes: Uint8Array }>
  setExtChanged: (e: AssemblyRuntime['extChanged']) => void

  interference: InterferenceReport | null
  setInterference: (r: InterferenceReport | null) => void
  clearance: ClearanceReport | null
  setClearance: (r: ClearanceReport | null) => void

  /** the viewport tool that is active: dragging components, or picking joint origins */
  tool: null | 'drag' | 'joint'
  setTool: (t: AssemblyRuntime['tool']) => void
  panel: AssemblyPanel | null
  setPanel: (p: AssemblyPanel | null) => void

  /** motion study playback */
  playing: boolean
  playTime: number
  setPlay: (p: { playing?: boolean; playTime?: number }) => void

  /** the joint of the open Joint dialog, applied to the placement while it is open so the components move as you choose */
  previewJoint: Joint | null
  setPreviewJoint: (j: Joint | null) => void
  /** the joint selected in the panel (its glyph is highlighted) */
  selectedJoint: string | null
  selectJoint: (id: string | null) => void
  /** a component being dragged freely (no joint holds it): its new placement, applied until the drag ends */
  freeMove: { occ: string; transform: number[] } | null
  setFreeMove: (m: AssemblyRuntime['freeMove']) => void
  /** the joint origin snap under the pointer while the joint tool is active */
  snapHover: { inst: string; index: number; near: number[] } | null
  setSnapHover: (h: AssemblyRuntime['snapHover']) => void
}

export const useAssemblyRuntime = create<AssemblyRuntime>((set) => ({
  drive: {},
  setDrive: (joint, key, value) => set((s) => ({ drive: { ...s.drive, [joint]: { ...s.drive[joint], [key]: value } } })),
  clearDrive: (joint) =>
    set((s) => {
      if (!joint) return Object.keys(s.drive).length ? { drive: {} } : {}
      const d = { ...s.drive }
      delete d[joint]
      return { drive: d }
    }),
  explode: 0,
  setExplode: (explode) => set({ explode }),
  explodeStep: null,
  selectExplodeStep: (explodeStep) => set({ explodeStep }),
  extErrors: {},
  setExtErrors: (extErrors) => set({ extErrors }),
  extChanged: {},
  setExtChanged: (extChanged) => set({ extChanged }),
  interference: null,
  setInterference: (interference) => set({ interference }),
  clearance: null,
  setClearance: (clearance) => set({ clearance }),
  tool: null,
  setTool: (tool) => set({ tool }),
  panel: null,
  setPanel: (panel) => set({ panel }),
  playing: false,
  playTime: 0,
  setPlay: (p) => set(p),
  previewJoint: null,
  setPreviewJoint: (previewJoint) => set({ previewJoint }),
  selectedJoint: null,
  selectJoint: (selectedJoint) => set({ selectedJoint }),
  freeMove: null,
  setFreeMove: (freeMove) => set({ freeMove }),
  snapHover: null,
  setSnapHover: (snapHover) => set({ snapHover }),
}))
