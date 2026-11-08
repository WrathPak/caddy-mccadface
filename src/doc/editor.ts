/** Opens the schema-driven Inspector to create or edit timeline features. */
import { useUi, type InspectorSession } from '@/store/ui'
import { missingRequired, schemaDefaults, type ParamValues } from '@/ui/schema'
import { getFeature } from './registry'
import { setEditRollback, useDoc } from './store'
import type { FeatureDef, PreviewHandle } from './types'

let formSeq = 0

/** The feature dialog that is open right now (creating or editing), with the values as the form holds them: what a reload puts back (see io/session.ts). */
export interface OpenDialog { type: string; tool: string; /** the feature being edited; absent when creating one */ featureId?: string; values: ParamValues }
let openDialog: OpenDialog | null = null
const dialogWatchers = new Set<() => void>()
export const currentDialog = (): OpenDialog | null => openDialog
/** Called whenever the dialog opens, closes or its values change. Returns the stop function. */
export function watchDialog(fn: () => void) {
  dialogWatchers.add(fn)
  return () => { dialogWatchers.delete(fn) }
}
const dialogChanged = () => dialogWatchers.forEach((f) => f())

function openSession(def: FeatureDef, start: ParamValues, tool: string, onOk: (v: ParamValues) => void, restore?: () => void, featureId?: string) {
  const formId = ++formSeq
  const ui = useUi.getState()
  ui.inspector?.onCancel() // only one dialog at a time
  let handle: PreviewHandle | void
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (openDialog === mine) { openDialog = null; dialogChanged() }
    handle?.dispose()
    useUi.getState().closeInspector()
    useUi.getState().setActiveTool(null)
    restore?.()
  }
  // the values as the form holds them now, shared by every session object of this dialog (the form keeps calling the one it was handed first)
  let live = start
  const mine: OpenDialog = { type: def.type, tool, featureId, values: start }
  const session = (values: ParamValues): InspectorSession => {
    const s: InspectorSession = {
      schema: def.schema,
      values,
      featureId,
      formId,
      get latest() { return live },
      onChange: (v: ParamValues) => { live = v; mine.values = v; dialogChanged(); handle?.update(v) },
      onOk: (v: ParamValues) => {
        // the dialog disables OK while required selections are missing; never create a feature in an error state from an empty dialog
        if (missingRequired(def.schema, v).length) return
        finish()
        onOk(v)
      },
      onCancel: finish,
      onActiveGroup: (id: string) => handle?.activeGroup?.(id),
    }
    return s
  }
  handle = def.preview?.({ values: start, setValues: (v) => { live = v; mine.values = v; dialogChanged(); useUi.getState().openInspector(session(v)); handle?.update(v) } })
  ui.setActiveTool(tool)
  ui.openInspector(session(start))
  handle?.update(start)
  openDialog = mine
  dialogChanged()
}

/** Start creating a feature of `type`; OK appends it at the rollback marker. */
export function createFeature(type: string, initial: ParamValues = {}, tool = type) {
  const def = getFeature(type)
  if (!def) return console.warn('[editor] unknown feature', type)
  openSession(def, { ...schemaDefaults(def.schema), ...initial }, tool, (v) => useDoc.getState().addFeature(type, def.beforeAccept ? def.beforeAccept(v, true) : v))
}

/** Edit an existing feature; the timeline is rolled back to just before it while the dialog is open. */
export function editFeature(id: string, initial: ParamValues = {}) {
  const d = useDoc.getState()
  const idx = d.features.findIndex((f) => f.id === id)
  const f = d.features[idx]
  const def = f && getFeature(f.type)
  if (!def) return
  if (def.edit) return def.edit(id, f.params)
  const prev = d.rollback
  d.setRollback(idx)
  setEditRollback(prev)
  openSession(
    def,
    { ...schemaDefaults(def.schema), ...f.params, ...initial },
    f.type,
    (v) => useDoc.getState().updateFeature(id, def.beforeAccept ? def.beforeAccept(v, false) : v),
    () => { useDoc.getState().setRollback(prev); setEditRollback(null) },
    id,
  )
}
