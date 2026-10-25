/** What the History panel does: preview a version read-only, restore one as a new version, compare two, prune. */
import { strToU8, zipSync } from 'fflate'
import { clearCache, regenerate } from '@/doc/engine'
import { useDoc, type HistoryItem } from '@/doc/store'
import type { DocData } from '@/doc/types'
import { currentFile, onClosePreview, saveDocument } from '@/io/actions'
import { useUi } from '@/store/ui'
import { parseProject } from '@/io/project'
import { toast } from '@/ui/Modal'
import { viewportBus } from '@/viewport/bus'
import { diffDocs, parseSnapshot, type DocDiff } from './diff'
import { hashOf, pruneHistory, snapshotOf } from './pack'
import { historyData, setHistory, useHistory, cloneHistory } from './store'

/** Read a stored snapshot the way opening a `.caddy` does (the same parser, so older and newer fields stay in step). */
function dataOfSnapshot(doc: string, blobs: Record<string, Uint8Array>): { data: DocData; blobs: Record<string, Uint8Array> } {
  const files: Record<string, Uint8Array> = { 'document.json': strToU8(doc) }
  for (const [id, b] of Object.entries(blobs)) files['blobs/' + id] = b
  return parseProject(zipSync(files, { level: 0 }))
}

interface Stash { data: DocData; blobs: Record<string, Uint8Array>; stacks: { past: HistoryItem[]; future: HistoryItem[] }; dirty: boolean; name: string; selectedFeatureId: string | null; hidden: Record<string, true>; activeOcc: string | null }
let stash: Stash | null = null

/** Show version `n` in the viewport and timeline, read-only; the project as it was comes back with exitPreview(). */
export async function previewVersion(n: number) {
  const snap = snapshotOf(historyData(), n)
  if (!snap) return toast(`Version ${n} can no longer be read`, 'error')
  const d = useDoc.getState()
  if (!stash) {
    stash = { data: d.getData(), blobs: d.blobs, stacks: d.takeStacks(), dirty: d.dirty, name: d.name, selectedFeatureId: d.selectedFeatureId, hidden: useUi.getState().hiddenIds, activeOcc: d.activeOcc }
  }
  const { data, blobs } = dataOfSnapshot(snap.doc, snap.blobs)
  d.setReadOnly(false) // loadDocument is not an edit
  clearCache()
  useDoc.getState().loadDocument(data, blobs)
  useDoc.setState({ name: stash.name })
  useDoc.getState().setReadOnly(true)
  useHistory.setState({ previewing: n })
  await regenerate()
  viewportBus.emit('frame', undefined)
}

/** Leave the preview: the project goes back exactly as it was, undo history included. */
export async function exitPreview() {
  if (!stash) return
  const s = stash
  stash = null
  const d = useDoc.getState()
  d.setReadOnly(false)
  clearCache()
  d.loadDocument(s.data, s.blobs)
  useDoc.getState().putStacks(s.stacks)
  useDoc.setState({ name: s.name, dirty: s.dirty, selectedFeatureId: s.selectedFeatureId, activeOcc: s.activeOcc })
  useUi.setState({ hiddenIds: s.hidden })
  useHistory.setState({ previewing: null })
  await regenerate()
}

/**
 * Make version `n` the project again, as an edit you can undo. When the project has a file it is saved straight away, so the
 * restore shows up as a new version; otherwise the next save carries a note saying so.
 */
export async function restoreVersion(n: number) {
  const snap = snapshotOf(historyData(), n)
  if (!snap) return toast(`Version ${n} can no longer be read`, 'error')
  if (stash) await exitPreview()
  const { data, blobs } = dataOfSnapshot(snap.doc, snap.blobs)
  const d = useDoc.getState()
  // the version may use import sources the project no longer holds
  const missing = Object.fromEntries(Object.entries(blobs).filter(([id]) => !d.blobs[id]))
  if (Object.keys(missing).length) useDoc.setState((s) => ({ blobs: { ...s.blobs, ...missing } }))
  clearCache()
  d.commit(`Restore version ${n}`, (cur) => ({ ...data, name: cur.name }))
  useHistory.setState({ pendingNote: `Restored version ${n}` })
  await regenerate()
  if (currentFile()) {
    await saveDocument(false)
    toast(`Restored version ${n}`)
  } else toast(`Restored version ${n}. Save to keep it as a new version.`)
}

/** What differs between two versions. */
export function compareVersions(a: number, b: number): DocDiff | null {
  const sa = snapshotOf(historyData(), a), sb = snapshotOf(historyData(), b)
  if (!sa || !sb) return null
  return diffDocs(parseSnapshot(sa.doc), parseSnapshot(sb.doc))
}

/** Apply the cap now (the file shrinks the next time it is saved). Returns how many versions went. */
export async function pruneNow(): Promise<number> {
  const h = cloneHistory()
  const d = useDoc.getState()
  const referenced = new Set<string>()
  for (const f of d.features) for (const v of Object.values(f.params)) if (typeof v === 'string' && d.blobs[v]) referenced.add(v)
  const current = new Set(await Promise.all([...referenced].map((id) => hashOf(d.blobs[id]))))
  const dropped = pruneHistory(h, useHistory.getState().settings, current)
  if (dropped) setHistory(h)
  return dropped
}

onClosePreview(() => void exitPreview())
