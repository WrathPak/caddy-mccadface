import { create } from 'zustand'

/** Whether the title block template dialog is open. */
export const useTemplateDialog = create<{ open: boolean; set: (o: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }))
