/**
 * New versions never replace the page under someone. The service worker installs a new version quietly and keeps it waiting; the
 * status bar then shows an "Update ready" button. Clicking it saves first (the autosave write, flushed), and only then reloads
 * onto the new version. Never clicked, the new version takes over by itself the next time every tab of the app has been closed.
 *
 * While the old version is still the active one, its precache keeps serving every file it was built with, lazy-loaded chunks
 * included: the new version's files are cached beside them and the old ones are only dropped when it takes over.
 */
import { create } from 'zustand'
import { flushAutosave } from '@/io/actions'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'

export const UPDATE_CHECK_MS = 60 * 60 * 1000
/** Coming back to a tab checks too, but not more often than this. */
export const UPDATE_FOCUS_GAP_MS = 5 * 60 * 1000

interface UpdateState {
  /** A new version is installed and waiting. */
  ready: boolean
  /** The new version took over in another tab: this tab still runs the old files and should be reloaded soon. */
  switched: boolean
  /** The save-then-reload is under way. */
  applying: boolean
  /** "Later" on the centred card: the status bar pill stays, the card does not come back for this version. */
  cardDismissed: boolean
}
export const useUpdate = create<UpdateState>(() => ({ ready: false, switched: false, applying: false, cardDismissed: false }))

type Updater = (reloadPage?: boolean) => Promise<void> | void
let updater: Updater | null = null

/** Hand over the function `registerSW` returned (or a stand-in, in the specs). */
export function setUpdater(fn: Updater | null) { updater = fn }
/** The service worker said a new version is waiting. */
export function markUpdateReady() { useUpdate.setState({ ready: true, cardDismissed: false }) }

/** Nothing to lose by reloading: an empty, untouched document and no command open. */
function untouched(): boolean {
  const d = useDoc.getState()
  const u = useUi.getState()
  return !d.dirty && d.features.length === 0 && !u.inspector && !u.activeTool
}

/**
 * What the service worker's onNeedRefresh calls. New versions reach people by default, and only someone with work open is asked:
 * - the page did not come from the old worker (first visit, or a hard refresh): it already runs the newest files from the network,
 *   so the waiting worker is switched on quietly and there is nothing to show;
 * - nothing has been done in this tab yet: switch and reload straight away, before any work starts;
 * - otherwise: the centred card and the status bar pill, and nothing happens until one is clicked.
 */
export function newVersionWaiting(o: { controlled: boolean }) {
  if (!o.controlled) { void Promise.resolve(updater?.(false)).catch(() => {}); return }
  if (untouched()) { void applyUpdate(); return }
  markUpdateReady()
}

/**
 * The button: save the work, wait for the save, then switch to the new version and reload.
 * A save that fails does not strand the update: the browser copy is written first and the reload comes back to a recovery prompt.
 */
export async function applyUpdate(): Promise<void> {
  if (useUpdate.getState().applying) return
  useUpdate.setState({ applying: true })
  try {
    try { await flushAutosave() } catch (e) { console.warn('[update] could not save before the update', e) }
    if (!updater) throw new Error('no service worker to update')
    await updater(true)
    // updateSW(true) reloads the page once the new worker is in charge; if that never happens, the button is usable again
    setTimeout(() => useUpdate.setState({ applying: false }), 15000)
  } catch (e) {
    console.error(e)
    useUpdate.setState({ applying: false })
  }
}

/** The minimal slice of a ServiceWorkerRegistration the checker needs. */
export interface Checkable { update(): Promise<unknown> }

/** Look for a new version about hourly, and when someone comes back to the tab. Returns a stop function. */
export function watchForUpdates(reg: Checkable, o: { now?: () => number; everyMs?: number; gapMs?: number } = {}): () => void {
  const now = o.now ?? Date.now
  let lastCheck = now()
  const check = () => {
    lastCheck = now()
    // offline, or the server is down: try again next time
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    void Promise.resolve(reg.update()).catch(() => {})
  }
  const timer = setInterval(check, o.everyMs ?? UPDATE_CHECK_MS)
  const onVisible = () => {
    if (document.visibilityState === 'visible' && now() - lastCheck >= (o.gapMs ?? UPDATE_FOCUS_GAP_MS)) check()
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

/**
 * Another tab clicked "Update ready" and the new version took over the shared worker. This tab's lazy chunks may now be gone from
 * the cache, so it is asked to reload, with the same save first. It is never reloaded on its own.
 */
export function watchForTakeover(sw: Pick<ServiceWorkerContainer, 'addEventListener' | 'controller'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker) {
  if (!sw || !sw.controller) return // a first visit has no old version to be swapped out
  sw.addEventListener('controllerchange', () => {
    if (useUpdate.getState().applying) return
    useUpdate.setState({ ready: true, switched: true, cardDismissed: false })
    void flushAutosave().catch(() => {})
    setUpdater(() => { window.location.reload() })
  })
}
