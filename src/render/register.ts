/** Render workspace: the Appearance feature, commands and the ribbon tab. The only hook into the shared code is the import of this file. */
import { Aperture, Camera, Crosshair, FilmStrip, Palette } from '@phosphor-icons/react'
import { RIBBON_TABS } from '@/app/ribbon'
import { registerCommand } from '@/app/commands'
import { RefError, RefReport } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useSketch } from '@/sketch/store'
import { useDoc } from '@/doc/store'
import { toast } from '@/ui/Modal'
import { appearanceSchema, applyAppearance } from './appearanceMap'
import { focusOnSelection, openAppearanceDialog } from './assign'
import { renderImage, renderTurntableVideo } from './job'
import { useRenderSettings } from './settings'

registerFeature({
  type: 'appearance',
  label: 'Appearance',
  icon: Palette,
  schema: appearanceSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const found = applyAppearance(new Map(), ctx.bodies, p.targets as string[], { material: String(p.material), color: String(p.color ?? '') }, report)
    if (!found) throw new RefError('The bodies or faces for this material no longer exist. Pick them again.', report.lostRefs)
    return { warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
})

/** Tools are unavailable while a sketch is open (finish it first). */
const idle = (fn: () => void) => () => { if (!useSketch.getState().active) fn() }
/** Render jobs need something to render. */
const needsBody = (fn: () => void) => () => {
  if (!useDoc.getState().geometry.length) return toast('There is nothing to render yet: make a body first', 'error')
  fn()
}

registerCommand({ id: 'render.assign', label: 'Appearance', tip: 'Give the selected bodies or faces a material from the library', icon: Palette, category: 'Render', run: idle(openAppearanceDialog) })
registerCommand({ id: 'render.focus', label: 'Focus', tip: 'Set the depth of field focus to the selection, or to the whole model', icon: Crosshair, category: 'Render', run: () => void focusOnSelection() })
registerCommand({
  id: 'render.dof', label: 'Depth of Field', tip: 'Blur what is in front of and behind the focus distance', icon: Aperture, category: 'Render',
  run: () => { const st = useRenderSettings.getState(); st.set({ dof: !st.s.dof }) },
})
registerCommand({ id: 'render.image', label: 'Render Image', tip: 'Path traced image at the size set in the panel, saved as a PNG', icon: Camera, category: 'Render', run: needsBody(() => void renderImage()) })
registerCommand({ id: 'render.turntable', label: 'Turntable', tip: 'Record the model turning once around as a WebM video', icon: FilmStrip, category: 'Render', run: needsBody(() => void renderTurntableVideo()) })

const at = RIBBON_TABS.findIndex((t) => t.id === 'sketch')
RIBBON_TABS.splice(at < 0 ? RIBBON_TABS.length : at, 0, {
  id: 'render',
  label: 'Render',
  groups: [
    { label: 'Material', items: [{ cmd: 'render.assign' }] },
    { label: 'Camera', items: [{ cmd: 'render.focus' }, { cmd: 'render.dof' }] },
    { label: 'Output', items: [{ cmd: 'render.image' }, { cmd: 'render.turntable' }] },
  ],
})
