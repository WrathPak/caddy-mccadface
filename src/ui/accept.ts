import { resolveParams } from '@/doc/params'
import { useUi } from '@/store/ui'
import { missingRequired, schemaDefaults } from './schema'

/** Window event the open dialog listens to: flash the validation hint (Enter pressed while the dialog is invalid). */
export const NUDGE_EVENT = 'caddy:inspector-nudge'

/**
 * Accept the open feature dialog with its latest values, like pressing OK. An invalid dialog is not accepted: its validation
 * hint flashes instead. Returns whether the dialog was accepted.
 */
export function acceptInspector(): boolean {
  const s = useUi.getState().inspector
  if (!s) return false
  const values = { ...schemaDefaults(s.schema), ...s.values }
  let bad = missingRequired(s.schema, values).length > 0
  if (!bad) { try { resolveParams(s.schema, values) } catch { bad = true } }
  if (bad) { window.dispatchEvent(new Event(NUDGE_EVENT)); return false }
  s.onOk(values)
  return true
}
