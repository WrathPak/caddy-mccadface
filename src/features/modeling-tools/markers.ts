/** Small clickable dots the open tool draws in the viewport: pattern instances (click to skip) and hole centres (click to remove). */
import { create } from 'zustand'
import type { Vec3 } from '@/kernel/types'

export interface Marker {
  id: string
  pos: Vec3
  /** `on`: counts; `off`: skipped (drawn hollow); `fixed`: the original, not clickable */
  state: 'on' | 'off' | 'fixed'
  label?: string
}

export const useMarkers = create<{ items: Marker[]; onClick: ((id: string) => void) | null }>(() => ({ items: [], onClick: null }))
export const setMarkers = (items: Marker[], onClick: ((id: string) => void) | null) => useMarkers.setState({ items, onClick })
export const clearMarkers = () => useMarkers.setState({ items: [], onClick: null })
