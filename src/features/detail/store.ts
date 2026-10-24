/** Live preview state of the DETAIL tools, shared between the features and the viewport layer. */
import { create } from 'zustand'
import type { TopoMesh } from '@/kernel/types'

type V3 = [number, number, number]

export interface EmbossView {
  /** the solid that will be added (emboss) or removed (engrave) */
  mesh: TopoMesh
  mode: 'emboss' | 'engrave'
  /** where the artwork sits on the surface, the surface normal there and its size */
  point: V3
  normal: V3
  width: number
  height: number
  rotation: number
  /** moves the artwork to a point of the surface (from the on-canvas handle) */
  moveTo: (p: V3) => void
  /** turns the artwork about the surface normal to an angle in degrees */
  rotateTo: (deg: number) => void
}

export interface TextureView {
  mesh: TopoMesh
  bodyId: string
}

export interface GeneratorView {
  kind: 'fur' | 'scales' | 'spikes' | 'grass'
  positions: Float32Array
  indices: Uint32Array
  wall: { positions: Float32Array; indices: Uint32Array } | null
}

interface DetailState {
  emboss: EmbossView | null
  texture: TextureView | null
  generator: GeneratorView | null
  /** short readout of the last preview run ("1,240 spikes, 34k triangles") */
  readout: string | null
  busy: boolean
}

export const useDetailView = create<DetailState>(() => ({ emboss: null, texture: null, generator: null, readout: null, busy: false }))
export const clearDetailView = () => useDetailView.setState({ emboss: null, texture: null, generator: null, readout: null, busy: false })
