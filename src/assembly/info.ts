/** The Component Info dialog: the material and description a drawing's parts list shows for a component. */
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import type { ParamSchema } from '@/ui/schema'
import { setComponentInfo } from './actions'

const schema: ParamSchema = {
  id: 'componentInfo',
  title: 'Component info',
  params: [
    { type: 'text', key: 'material', label: 'Material', default: '', placeholder: 'Aluminium 6061', help: 'What the part is made of. It shows in the Material column of a drawing\'s parts list.' },
    { type: 'text', key: 'description', label: 'Description', default: '', placeholder: 'Mounting plate', help: 'A short description of the part. It shows in the Description column of a drawing\'s parts list.' },
  ],
}

/** Open the dialog for a component definition. OK is one undo step. */
export function startComponentInfo(def: string) {
  const c = useDoc.getState().assembly.components.find((x) => x.id === def)
  if (!c) return
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  const close = () => { useUi.getState().closeInspector(); useUi.getState().setActiveTool(null) }
  ui.setActiveTool(null)
  ui.openInspector({
    schema,
    values: { material: c.material ?? '', description: c.description ?? '' },
    onOk: (v) => { close(); setComponentInfo(def, { material: String(v.material ?? ''), description: String(v.description ?? '') }) },
    onCancel: close,
  })
}
