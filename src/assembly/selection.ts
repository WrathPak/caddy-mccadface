/** What the current selection means for assembly commands: the component instances it points at. */
import { useDoc } from '@/doc/store'
import { useUi, type SelectionRef } from '@/store/ui'
import { flatten } from './instances'

/** The instance a selection entry belongs to: a component node, or anything picked inside a component. */
export const instanceOfRef = (r: SelectionRef): string | null => (r.kind === 'component' ? r.id : r.path || null)

/** Instances (occurrence paths) in the selection, in order, without repeats. Only ones that exist. */
export function selectedInstances(selection: SelectionRef[] = useUi.getState().selection): string[] {
  const live = new Set(flatten(useDoc.getState().assembly).map((n) => n.id))
  const out: string[] = []
  for (const r of selection) {
    const p = instanceOfRef(r)
    if (p && live.has(p) && !out.includes(p)) out.push(p)
  }
  return out
}
