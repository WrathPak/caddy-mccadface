import { create } from 'zustand'
import type { SelectionRef } from '@/store/ui'

/**
 * Edge tools (Fillet, Chamfer) with the Edge filter on: a click on a face of a body stands for all the edges of that face.
 * While `onFace` is set, Bodies lets faces hover and take that click (edges close to the pointer still win).
 */
export const useFaceEdges = create<{ onFace: ((face: SelectionRef) => void) | null }>(() => ({ onFace: null }))
