/**
 * Autosave to a real folder: the glue between the autosave timer (actions.ts), the projects folder the person picked (projects/store.ts)
 * and the folder logic (autosaveFolder.ts). The browser copy in IndexedDB stays the always-there fallback; this is on top of it.
 *
 * Writes are async and never block the UI. A problem (folder deleted, access taken away) shows one toast, not one per attempt: the
 * next attempt that works clears it.
 */
import { create } from 'zustand'
import { useProjects } from '@/projects/store'
import type { FileLike } from '@/projects/fsTypes'
import { useSettings } from '@/settings/settings'
import { toast } from '@/ui/Modal'
import { newestCopy, sweepSwapFiles, writeAutosave, type FolderCopy } from './autosaveFolder'

/** What the last folder write did, for the Settings dialog (and the specs). */
export const useDiskAutosave = create<{ lastAt: number; lastFile: string }>(() => ({ lastAt: 0, lastFile: '' }))

let complained = false
function complain(msg: string) {
  console.warn('[autosave]', msg)
  if (complained) return
  complained = true
  toast(msg, 'error')
}

// a new folder, or access coming back, gets a fresh start
let watching = false
function watch() {
  if (watching) return
  watching = true
  useProjects.subscribe((s, p) => {
    if (s.root !== p.root || (s.access === 'granted' && p.access !== 'granted')) complained = false
  })
}

/** The folder, when it can be used right now (it is picked and access is granted). Refreshes the access state the reconnect control shows. */
async function usableRoot() {
  watch()
  const p = useProjects.getState()
  const root = p.root
  if (!root) return null
  const perm = (await root.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
  if (perm !== 'granted') {
    if (p.access !== perm) useProjects.setState({ access: perm })
    return { root: null, perm }
  }
  if (p.access !== 'granted') {
    useProjects.setState({ access: 'granted' })
    void useProjects.getState().refresh()
  }
  return { root, perm }
}

/** Write one copy into the Autosave folder. `own` is the file the open project saves to: an autosave never replaces it. */
export async function writeDiskCopy(bytes: Uint8Array, docName: string, own: { isSameEntry?: (o: unknown) => Promise<boolean> } | null): Promise<void> {
  try {
    const u = await usableRoot()
    if (!u) return
    if (!u.root) {
      // 'prompt' shows the Reconnect control by itself; 'denied' needs words
      if (u.perm === 'denied') complain('The autosave folder is blocked. Allow access again, or pick another folder in Settings. Your work is still kept in this browser.')
      return
    }
    const isProtected = own?.isSameEntry ? async (f: FileLike) => own.isSameEntry!(f) : undefined
    const file = await writeAutosave(u.root, docName, bytes, useSettings.getState().autosaveVersions, { isProtected })
    complained = false
    useDiskAutosave.setState({ lastAt: Date.now(), lastFile: file })
  } catch (e) {
    complain(`Could not write to the autosave folder (${e instanceof Error ? e.message : String(e)}). Your work is still kept in this browser. Pick the folder again in Settings.`)
  }
}

/** The newest copy in the folder, when the folder can be read right now. */
export async function readFolderCopy(): Promise<FolderCopy | null> {
  try {
    const u = await usableRoot()
    if (!u?.root) return null
    return await newestCopy(u.root)
  } catch (e) {
    console.warn('[autosave] could not read the autosave folder', e)
    return null
  }
}

/** Once per start: remove swap files an earlier crash left in the Autosave folder. */
export async function tidyFolder(): Promise<void> {
  try {
    const u = await usableRoot()
    if (u?.root) await sweepSwapFiles(u.root)
  } catch { /* the folder is not reachable: the next write says so */ }
}
