/** Small utilities shared by solid-feature previews. */
import { useUi, type SelectionRef } from '@/store/ui'

/** Debounced, stale-aware async runner for kernel preview calls. */
export function createRunner(work: (stale: () => boolean) => Promise<void>, ms = 140) {
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    schedule() {
      clearTimeout(timer)
      const my = ++seq
      timer = setTimeout(() => { work(() => my !== seq).catch((e) => console.warn('[preview]', e)) }, ms)
    },
    dispose() {
      seq++
      clearTimeout(timer)
    },
  }
}

/** Calls `onPick` with the matching selection entries whenever the viewport selection changes. */
export function watchSelection(kinds: SelectionRef['kind'][], onPick: (hits: SelectionRef[]) => void) {
  return useUi.subscribe((s, p) => {
    if (s.selection === p.selection) return
    const hits = s.selection.filter((r) => kinds.includes(r.kind))
    if (hits.length) onPick(hits)
  })
}
