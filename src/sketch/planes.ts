/** Main-thread mirror of the construction planes (like useSketchData for sketches); id 'preview' is the open dialog's plane. */
import { create } from 'zustand'
import type { PlaneDef } from './types'

export const usePlanes = create<{ data: Record<string, PlaneDef>; set: (id: string, p: PlaneDef | null) => void }>((set) => ({
  data: {},
  set: (id, p) => set((s) => {
    const data = { ...s.data }
    if (p) data[id] = p
    else delete data[id]
    return { data }
  }),
}))
