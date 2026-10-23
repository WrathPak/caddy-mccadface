/** Opens the schema-driven Inspector to create or edit timeline features. */
import { useUi } from '@/store/ui'
import { missingRequired, schemaDefaults, type ParamValues } from '@/ui/schema'
import { getFeature } from './registry'
import { useDoc } from './store'
import type { FeatureDef, PreviewHandle } from './types'

function openSession(def: FeatureDef, start: ParamValues, tool: string, onOk: (v: ParamValues) => void, restore?: () => void) {
  const ui = useUi.getState()
  ui.inspector?.onCancel() // only one dialog at a time
  let handle: PreviewHandle | void
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    handle?.dispose()
    useUi.getState().closeInspector()
    useUi.getState().setActiveTool(null)
    restore?.()
  }
  const session = (values: ParamValues) => ({
    schema: def.schema,
    values,
    onChange: (v: ParamValues) => handle?.update(v),
    onOk: (v: ParamValues) => {
      // the dialog disables OK while required selections are missing; never create a feature in an error state from an empty dialog
      if (missingRequired(def.schema, v).length) return
      finish()
      onOk(v)
    },
    onCancel: finish,
    onActiveGroup: (id: string) => handle?.activeGroup?.(id),
  })
  handle = def.preview?.({ values: start, setValues: (v) => { useUi.getState().openInspector(session(v)); handle?.update(v) } })
  ui.setActiveTool(tool)
  ui.openInspector(session(start))
  handle?.update(start)
}

/** Start creating a feature of `type`; OK appends it at the rollback marker. */
export function createFeature(type: string, initial: ParamValues = {}, tool = type) {
  const def = getFeature(type)
  if (!def) return console.warn('[editor] unknown feature', type)
  openSession(def, { ...schemaDefaults(def.schema), ...initial }, tool, (v) => useDoc.getState().addFeature(type, v))
}

/** Edit an existing feature; the timeline is rolled back to just before it while the dialog is open. */
export function editFeature(id: string) {
  const d = useDoc.getState()
  const idx = d.features.findIndex((f) => f.id === id)
  const f = d.features[idx]
  const def = f && getFeature(f.type)
  if (!def) return
  if (def.edit) return def.edit(id, f.params)
  const prev = d.rollback
  d.setRollback(idx)
  openSession(
    def,
    { ...schemaDefaults(def.schema), ...f.params },
    f.type,
    (v) => useDoc.getState().updateFeature(id, v),
    () => useDoc.getState().setRollback(prev),
  )
}
