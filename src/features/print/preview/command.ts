/** The Preview command: enter or leave the layer preview. */
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import { setPreview, useSlice } from '../engine/sliceStore'

export function togglePreview() {
  const s = useSlice.getState()
  if (s.preview) return setPreview(false)
  if (!s.result?.toolpaths?.extrusions.count) return toast('Slice the plate first, then preview the layers', 'info')
  useUi.getState().setActiveTool('print.preview')
  setPreview(true)
}
