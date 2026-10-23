/**
 * Wires the document engine into the command registry (replaces the Step 1 stubs).
 * Imported after './commands' so these registrations win.
 */
import { FloppyDiskBack, Function as FunctionIcon } from '@phosphor-icons/react'
import { getCommand, registerCommand, runCommand, type Command } from './commands'
import '@/doc/engine'
import '@/features/basic'
import { startMove } from '@/features/move'
import { createFeature } from '@/doc/editor'
import { useDoc } from '@/doc/store'
import { exportDialog, importDialog, newDocument, openDocument, saveDocument } from '@/io/actions'
import { useParamsDialog } from '@/ui/DocUi'
import { useUi } from '@/store/ui'

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
override('solid.box', () => createFeature('box', {}, 'solid.box'))
override('solid.move', startMove)
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
registerCommand({ id: 'edit.redo2', label: 'Redo', icon: getCommand('edit.redo')!.icon, shortcut: 'Ctrl+Shift+Z', category: 'Edit', run: () => runCommand('edit.redo') })
registerCommand({ id: 'doc.parameters', label: 'Parameters', icon: FunctionIcon, category: 'Document', run: () => useParamsDialog.getState().set(true) })
