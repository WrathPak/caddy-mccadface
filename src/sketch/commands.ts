/** Registers the sketch commands (replacing the ribbon stubs) and routes Esc / Delete / Undo / Redo while sketching. */
import { ArrowsVertical, Circle, DotsThree, Equals, Square, Target, Waves } from '@phosphor-icons/react'
import { getCommand, registerCommand, type Command } from '@/app/commands'
import { useUi } from '@/store/ui'
import { startSketchCommand, stopPicking, useSketchPick } from './create'
import {
  copySketch, deleteSelection, enterSketch, escapeSketch, finishSketch, pasteSketch, redoSketch, repeatLastTool, repeatableTool, runConstraintCommand, selectAllSketch, undoKey, setTool, startProject, toggleConstruction, useSketch,
  type ToolId,
} from './store'
import type { CKind } from './constraints'

/** Call once, after the document commands are registered (it wraps undo / redo / delete / escape). */
export function installSketchCommands() {

  function override(id: string, run: () => void, patch: Partial<Command> = {}) {
    const c = getCommand(id)
    if (!c) return console.warn('[sketch] missing command', id)
    registerCommand({ ...c, ...patch, stub: false, run })
  }
  const sketching = () => useSketch.getState().active

  function tool(id: string, t: ToolId) {
    override(id, () => { if (sketching()) setTool(t) })
  }
  function constraint(id: string, kind: CKind) {
    override(id, () => { if (sketching()) runConstraintCommand(kind) })
  }

  override('sketch.create', startSketchCommand)
  override('sketch.finish', finishSketch)
  tool('sketch.line', 'line')
  tool('sketch.rect', 'rect')
  tool('sketch.circle', 'circle')
  tool('sketch.arc', 'arc')
  tool('sketch.dimension', 'dimension')
  tool('sketch.trim', 'trim')
  tool('sketch.offset', 'offset')
  override('sketch.project', () => { if (sketching()) startProject('project') })
  override('sketch.intersect', () => { if (sketching()) startProject('intersect') })
  override('sketch.include3d', () => { if (sketching()) startProject('include3d') })
  override('sketch.projectSurface', () => { if (sketching()) startProject('surface') })
  constraint('sketch.coincident', 'coincident')
  constraint('sketch.horizontal', 'hv')
  constraint('sketch.parallel', 'parallel')
  constraint('sketch.perpendicular', 'perpendicular')
  constraint('sketch.tangent', 'tangent')
  constraint('sketch.equal', 'equal')
  constraint('sketch.fix', 'fix')

  registerCommand({ id: 'sketch.rectCenter', label: 'Center Rectangle', icon: Square, category: 'Sketch', run: () => { if (sketching()) setTool('rectC') } })
  registerCommand({ id: 'sketch.vertical', label: 'Vertical', icon: ArrowsVertical, category: 'Sketch', run: () => { if (sketching()) runConstraintCommand('vertical') } })
  registerCommand({ id: 'sketch.midpoint', label: 'Midpoint', icon: DotsThree, category: 'Sketch', run: () => { if (sketching()) runConstraintCommand('midpoint') } })
  registerCommand({ id: 'sketch.concentric', label: 'Concentric', icon: Target, category: 'Sketch', run: () => { if (sketching()) runConstraintCommand('concentric') } })
  registerCommand({ id: 'sketch.collinear', label: 'Collinear', icon: Equals, category: 'Sketch', run: () => { if (sketching()) runConstraintCommand('collinear') } })
  registerCommand({ id: 'sketch.symmetric', label: 'Symmetry', icon: Circle, category: 'Sketch', run: () => { if (sketching()) runConstraintCommand('symmetric') } })
  registerCommand({ id: 'sketch.smooth', label: 'Smooth', icon: Waves, category: 'Sketch', run: () => { if (sketching()) runConstraintCommand('smooth') } })
  registerCommand({ id: 'sketch.construction', label: 'Construction', icon: DotsThree, shortcut: 'X', category: 'Sketch', run: () => { if (sketching()) toggleConstruction() } })
  registerCommand({ id: 'sketch.selectAll', label: 'Select All', icon: Square, shortcut: 'Ctrl+A', category: 'Sketch', hidden: true, run: () => { if (sketching()) selectAllSketch() } })
  registerCommand({ id: 'sketch.copy', label: 'Copy', icon: Square, shortcut: 'Ctrl+C', category: 'Sketch', hidden: true, run: () => { if (sketching()) copySketch() } })
  registerCommand({ id: 'sketch.paste', label: 'Paste', icon: Square, shortcut: 'Ctrl+V', category: 'Sketch', hidden: true, run: () => { if (sketching()) pasteSketch() } })
  registerCommand({ id: 'sketch.repeat', label: 'Repeat', icon: Square, category: 'Sketch', hidden: true, run: () => { if (sketching() && repeatableTool()) repeatLastTool() } })
  registerCommand({ id: 'sketch.select', label: 'Select', icon: Square, shortcut: 'Q', category: 'Sketch', run: () => { if (sketching()) setTool('select') } })

  /** Wrap a document command so it does something else while a sketch is open. */
  function wrap(id: string, whileSketching: () => void) {
    const c = getCommand(id)
    if (!c) return console.warn('[sketch] missing command', id)
    registerCommand({ ...c, run: () => (sketching() ? whileSketching() : c.run()) })
  }
  wrap('edit.undo', undoKey)
  wrap('edit.redo', redoSketch)
  wrap('edit.delete', deleteSelection)
  wrap('edit.escape', escapeSketch)
  wrap('edit.accept', enterSketch)

  // Esc while waiting for a plane pick cancels the pick
  const esc = getCommand('edit.escape')!
  registerCommand({
    ...esc,
    run: () => {
      if (useSketchPick.getState().picking) { stopPicking(); useUi.getState().setActiveTool(null); return }
      esc.run()
    },
  })
}
