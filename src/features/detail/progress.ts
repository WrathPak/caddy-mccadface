/**
 * Progress while a slow exact build runs: a chip in the status bar ("building thread...") and a spinner on the feature's chip in the
 * timeline. Nothing is blocked: the build runs in the kernel worker, so the interface stays fully usable.
 */
import { create } from 'zustand'
import { useDoc } from '@/doc/store'

interface Building { featureId: string; label: string }
export const useBuilding = create<{ jobs: Building[] }>(() => ({ jobs: [] }))

/** Run `work` and show progress for feature `featureId` meanwhile. */
export async function withProgress<T>(featureId: string, label: string, work: () => Promise<T>): Promise<T> {
  const job = { featureId, label }
  useBuilding.setState((s) => ({ jobs: [...s.jobs, job] }))
  try {
    return await work()
  } finally {
    useBuilding.setState((s) => ({ jobs: s.jobs.filter((j) => j !== job) }))
  }
}

const CHIP = 'detail-progress'

/** Reflect the running jobs in the DOM (the status bar and timeline belong to other modules, so this only adds / marks elements). */
function paint() {
  if (typeof document === 'undefined') return
  const jobs = useBuilding.getState().jobs
  const status = document.querySelector('.status')
  const chip = status?.querySelector('.' + CHIP) ?? null
  if (!jobs.length) {
    chip?.remove()
  } else if (status) {
    const text = jobs.length > 1 ? `${jobs[0].label} (+${jobs.length - 1})` : jobs[0].label
    if (chip) { if (chip.lastChild?.textContent !== text) chip.lastChild!.textContent = text }
    else {
      const el = document.createElement('span')
      el.className = 'cell ' + CHIP
      el.setAttribute('role', 'status')
      el.setAttribute('data-testid', 'detail-progress')
      el.innerHTML = '<span class="detail-spinner"></span><span></span>'
      el.lastChild!.textContent = text
      status.appendChild(el)
    }
  }
  const features = useDoc.getState().features
  const busy = new Set(jobs.map((j) => features.findIndex((f) => f.id === j.featureId)))
  document.querySelectorAll<HTMLElement>('.tl-track .chip').forEach((c, i) => {
    if (busy.has(i)) c.setAttribute('data-busy', 'true'); else c.removeAttribute('data-busy')
  })
}

if (typeof document !== 'undefined') {
  useBuilding.subscribe(paint)
  // the timeline re-renders as features regenerate: keep the marks on the right chips
  useDoc.subscribe(() => { if (useBuilding.getState().jobs.length) setTimeout(paint, 0) })
}
