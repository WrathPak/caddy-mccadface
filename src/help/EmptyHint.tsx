import { useDoc } from '@/doc/store'
import { useSketch } from '@/sketch/store'
import { useSketchPick } from '@/sketch/create'
import { useSettings } from '@/settings/settings'
import { useUi } from '@/store/ui'
import { useDevice } from '@/app/device'

/** What to do first, per workspace, while the document is empty. */
export const EMPTY_HINTS: Record<string, string> = {
  solid: 'Start with a sketch, or import an STL',
  assemble: 'Make a part first, or insert another .caddy file as a component',
  surface: 'Draw some curves with Create Sketch, then turn them into a surface',
  mesh: 'Import an STL or 3MF file to clean up',
  hair: 'Hair grows on a model: make a body or import an STL first',
  detail: 'Make a body first, then add text or texture to one of its faces',
  print: 'Make or import a body first, then check it for printing here',
  drawing: 'Make a body first, then place views of it on a sheet',
  render: 'Make or import a body first, then give it a material',
}

/** A quiet line in the middle of the empty viewport. It goes away as soon as there is any geometry, a feature or a sketch. */
export function EmptyHint() {
  const on = useSettings((s) => s.beginnerTips)
  const empty = useDoc((s) => s.geometry.length === 0 && s.features.length === 0 && s.assembly.occurrences.length === 0)
  const sketching = useSketch((s) => s.active)
  const picking = useSketchPick((s) => s.picking)
  const workspace = useUi((s) => s.workspace)
  const tool = useUi((s) => s.activeTool)
  const inspector = useUi((s) => !!s.inspector)
  const coarse = useDevice((s) => s.coarse)
  if (!on || !empty || sketching || picking || inspector || tool) return null
  const text = EMPTY_HINTS[workspace] ?? EMPTY_HINTS.solid
  return (
    <div className="empty-hint" data-testid="empty-hint" role="note">
      <div className="empty-hint-text">{text}</div>
      <div className="empty-hint-sub">{coarse ? 'Tap a tool above to begin. The ... menu has search and help.' : 'Press S to search every command, or open the ? menu for help.'}</div>
    </div>
  )
}
