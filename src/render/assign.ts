/** Giving the selection a material, and aiming the camera's focus at it. */
import { createFeature } from '@/doc/editor'
import { encodeSelection } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import { selectionBounds } from '@/viewport/selectionBounds'
import { liveView } from './liveView'
import { modelBounds } from './sceneBuild'
import { parseHex, presetById } from './presets'
import { useRenderSettings } from './settings'

/** The selected bodies and faces as selection-ref strings (empty when nothing suitable is selected). */
export function selectedTargets(): string[] {
  const { selection } = useUi.getState()
  const { geometry } = useDoc.getState()
  const picks = selection.filter((r) => (r.kind === 'body' || r.kind === 'mesh' || r.kind === 'face') && geometry.some((b) => b.id === r.id))
  return encodeSelection(picks, geometry)
}

/** Give the selection a material right away (one timeline entry). */
export function assignMaterial(material: string, color = ''): boolean {
  const targets = selectedTargets()
  if (!targets.length) {
    toast('Select a body or some faces first')
    return false
  }
  const c = parseHex(color) ?? ''
  useDoc.getState().addFeature('appearance', { targets, material, color: c }, presetById(material).label)
  return true
}

/** Open the Appearance dialog for the current selection. */
export function openAppearanceDialog() {
  createFeature('appearance', { targets: selectedTargets() }, 'render.assign')
}

/** Point the depth of field focus at the selection (or the whole model when nothing is selected). */
export function focusOnSelection(): boolean {
  const cam = liveView.camera
  if (!cam) return false
  const { selection, hiddenIds } = useUi.getState()
  const { geometry } = useDoc.getState()
  const box = (selection.length ? selectionBounds(selection, geometry) : null) ?? modelBounds(geometry, hiddenIds)
  if (box.isEmpty()) {
    toast('Nothing to focus on')
    return false
  }
  const d = cam.position.distanceTo(box.getCenter(cam.position.clone()))
  useRenderSettings.getState().set({ focusDistance: Math.max(1, Math.round(d * 10) / 10) })
  return true
}
