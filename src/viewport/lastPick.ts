/** Where the last body click landed (world coordinates): lets tools such as Hole place something at the clicked point. */
import { create } from 'zustand'
import type { SelectionRef } from '@/store/ui'

export const useLastPick = create<{ point: [number, number, number] | null; ref: SelectionRef | null; seq: number }>(() => ({ point: null, ref: null, seq: 0 }))
