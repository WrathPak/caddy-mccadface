/** Copy a component and paste it as another instance (they share the component's geometry and everything inside it). */
import { create } from 'zustand'
import { toast } from '@/ui/Modal'
import { useDoc } from '@/doc/store'
import { instanceOf, occLabel } from './actions'
import { flatten } from './instances'

export const useClipboard = create<{ path: string | null }>(() => ({ path: null }))

export function copyComponent(path: string) {
  const a = useDoc.getState().assembly
  if (!flatten(a).some((n) => n.id === path)) return
  useClipboard.setState({ path })
  toast(`Copied ${occLabel(a, path)}. Paste adds an instance that shares its geometry.`)
}

/** Paste the copied component as a new instance beside it; returns the new instance's path. */
export async function pasteComponent(): Promise<string | null> {
  const path = useClipboard.getState().path
  const a = useDoc.getState().assembly
  if (!path || !flatten(a).some((n) => n.id === path)) {
    if (path) useClipboard.setState({ path: null })
    toast('Copy a component first.', 'error')
    return null
  }
  const made = instanceOf(path)
  if (made) toast('Pasted an instance. Its geometry is shared with the original.')
  return made
}
