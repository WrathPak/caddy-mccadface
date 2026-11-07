/**
 * The Insert Mesh dialog of the Mesh tab: the file is already in the document as an Import Mesh step, and the dialog (units, placement,
 * scale, face split angle) edits that step live, so the model in the viewport is the preview. OK keeps the changes as one undo step;
 * Cancel puts the step back as it was inserted (the mesh stays).
 */
import { schemaDefaults, type ParamValues } from '@/ui/schema'
import { getFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'

export function openInsertDialog(featureId: string) {
  const def = getFeature('importMesh')
  const d = useDoc.getState()
  const f = d.features.find((x) => x.id === featureId)
  if (!def || !f) return
  useUi.getState().inspector?.onCancel()
  const original = f.params
  const stacks = d.takeStacks()
  let cur: ParamValues = { ...schemaDefaults(def.schema), ...original }
  let timer: ReturnType<typeof setTimeout> | undefined
  let applied = JSON.stringify(original)
  const push = (v: ParamValues) => {
    const next = { ...original, ...v }
    const key = JSON.stringify(next)
    if (key === applied || !useDoc.getState().features.some((x) => x.id === featureId)) return
    applied = key
    useDoc.getState().updateFeature(featureId, next)
  }
  const close = () => {
    clearTimeout(timer)
    useUi.getState().closeInspector()
    useUi.getState().setActiveTool(null)
  }
  const session = (values: ParamValues) => ({
    schema: def.schema,
    values,
    featureId,
    formId: 7800,
    get latest() { return cur },
    onChange: (v: ParamValues) => { cur = v; clearTimeout(timer); timer = setTimeout(() => push(cur), 300) },
    onOk: (v: ParamValues) => {
      close()
      push(v)
      // every change made while the dialog was open is one step in the history
      useDoc.getState().putStacks(stacks)
    },
    onCancel: () => {
      close()
      push(original)
      useDoc.getState().putStacks(stacks)
    },
  })
  useUi.getState().setActiveTool('mesh.import')
  useUi.getState().openInspector(session(cur))
}
