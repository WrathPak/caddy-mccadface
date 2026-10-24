/**
 * Wires the document engine into the command registry (replaces the Step 1 stubs).
 * Imported after './commands' so these registrations win.
 */
import { FloppyDiskBack, Function as FunctionIcon } from '@phosphor-icons/react'
import { getCommand, registerCommand, runCommand, type Command } from './commands'
import '@/doc/engine'
import '@/features/basic'
import '@/features/solids'
import '@/features/meshTools'
import '@/features/offsetPlane'
import '@/features/detail/register'
import '@/features/print/register'
import '@/features/sketch'
import { installSketchCommands } from '@/sketch/commands'
import { useSketch } from '@/sketch/store'
import { startRevolve } from '@/features/revolve'
import { startExtrude } from '@/features/extrude'
import { startEdgeMod } from '@/features/fillet'
import { startMove } from '@/features/move'
import { startCombine, startLoft, startShell, startSweep } from '@/features/solids'
import { startMeshTool, MESH_COMMANDS } from '@/features/meshTools'
import { startOffsetPlane } from '@/features/offsetPlane'
import { startMeasure } from '@/features/measure'
import { startSection } from '@/features/section'
import { startHair, toggleHairPreview } from '@/features/hair'
import { createFeature } from '@/doc/editor'
import { useDoc } from '@/doc/store'
import { exportDialog, importDialog, newDocument, openDocument, saveDocument } from '@/io/actions'
import { useParamsDialog } from '@/ui/DocUi'
import { useUi } from '@/store/ui'
import '@/features/modeling-tools/register'

function override(id: string, run: () => void, patch: Partial<Command> = {}) {
  const c = getCommand(id)
  if (!c) return console.warn('[docCommands] missing', id)
  registerCommand({ ...c, ...patch, stub: false, run })
}

override('file.new', () => void newDocument())
override('file.open', () => void openDocument())
override('file.save', () => void saveDocument(false))
override('file.import', () => void importDialog())
override('file.export', () => exportDialog())
override('mesh.import', () => void importDialog())
override('edit.undo', () => useDoc.getState().undo())
override('edit.redo', () => useDoc.getState().redo())
/** Solid tools are unavailable while a sketch is open (finish it first). */
const solid = (fn: () => void) => () => { if (!useSketch.getState().active) fn() }
override('solid.box', solid(() => createFeature('box', {}, 'solid.box')))
override('solid.cylinder', solid(() => createFeature('cylinder', {}, 'solid.cylinder')))
override('solid.sweep', solid(startSweep))
override('solid.loft', solid(startLoft))
override('solid.shell', solid(startShell))
override('solid.combine', solid(() => startCombine('join')))
override('solid.join', solid(() => startCombine('join')))
override('solid.cut', solid(() => startCombine('cut')))
override('solid.intersect', solid(() => startCombine('intersect')))
override('solid.move', solid(startMove))
override('construct.plane', solid(startOffsetPlane))
override('inspect.measure', solid(startMeasure))
override('inspect.section', startSection)
for (const m of MESH_COMMANDS) override(m.id, solid(() => startMeshTool(m.type)))
override('solid.extrude', solid(startExtrude))
override('solid.revolve', solid(startRevolve))
override('solid.fillet', solid(() => startEdgeMod('fillet')))
override('solid.chamfer', solid(() => startEdgeMod('chamfer')))
override('hair.create', solid(() => startHair('create')))
override('hair.faces', solid(() => startHair('faces')))
override('hair.wall', solid(() => startHair('wall')))
override('hair.preview', toggleHairPreview)
override('edit.delete', () => {
  const ui = useUi.getState()
  const ids = [...new Set(ui.selection.map((r) => r.id))].filter((id) => useDoc.getState().geometry.some((b) => b.id === id))
  if (ids.length) {
    useDoc.getState().addFeature('delete', { bodyIds: ids })
    ui.clearSelection()
    return
  }
  const f = useDoc.getState().selectedFeatureId
  if (f) useDoc.getState().removeFeature(f)
})

registerCommand({ id: 'file.saveAs', label: 'Save As...', icon: FloppyDiskBack, shortcut: 'Ctrl+Shift+S', category: 'File', run: () => void saveDocument(true) })
registerCommand({ id: 'edit.redo2', label: 'Redo', icon: getCommand('edit.redo')!.icon, shortcut: 'Ctrl+Shift+Z', category: 'Edit', hidden: true, run: () => runCommand('edit.redo') })
registerCommand({ id: 'doc.parameters', label: 'Parameters', icon: FunctionIcon, category: 'Document', run: () => useParamsDialog.getState().set(true) })

// sketcher commands wrap undo / redo / delete / escape, so install them last
installSketchCommands()
