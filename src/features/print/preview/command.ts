/** The Preview command: enter or leave the layer preview. */
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import { setPreview, useSlice } from '../engine/sliceStore'

/** Show the layers: the preview is the active tool while it is on (Esc or another tool leaves it). */
export function showPreview() {
  // nothing stays selected over the layers (the bodies are hidden)
  useUi.getState().setSelection([])
  useUi.getState().setActiveTool('print.preview')
  setPreview(true)
}

export function togglePreview() {
  const s = useSlice.getState()
  if (s.preview) return setPreview(false)
  if (!s.result?.toolpaths?.extrusions.count) return toast('Slice the plate first, then preview the layers', 'info')
  showPreview()
}
