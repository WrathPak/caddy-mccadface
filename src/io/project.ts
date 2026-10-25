/** `.caddy` = zip of document.json + blobs/<id> (import sources) + thumbnail.png. Fully regenerable from the timeline. */
import { strFromU8, strToU8, unzipSync, zip, type Zippable } from 'fflate'
import { clearCache } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import type { DocData } from '@/doc/types'
import { captureThumbnail } from '@/viewport/capture'
import { appendVersion, hashOf, historyFiles, pruneHistory, readHistory } from '@/history/pack'
import { cloneHistory, historyData, setHistory, useHistory } from '@/history/store'

const FORMAT = 1

/** The history a save appended, kept with the bytes it went into until they are written (see commitSavedHistory). */
const candidates = new WeakMap<Uint8Array, ReturnType<typeof cloneHistory>>()

/** Call once the bytes from `serializeProject(.., { append: true })` are safely written: the new version becomes part of the open project. */
export function commitSavedHistory(bytes: Uint8Array) {
  const h = candidates.get(bytes)
  if (!h) return
  candidates.delete(bytes)
  setHistory(h)
  useHistory.setState({ pendingNote: null })
}

const zipAsync = (files: Zippable) => new Promise<Uint8Array>((res, rej) => zip(files, { level: 3 }, (e, d) => (e ? rej(e) : res(d))))

/**
 * Build the `.caddy` bytes. `append` adds a version of the document to its history (the Save commands); autosave and the
 * debug handle leave the history as it is. The zip is made by fflate's worker threads, so a project that carries a 150 MB
 * import does not freeze the page.
 */
export async function serializeProject(withThumbnail = true, opts: { note?: string; append?: boolean } = {}): Promise<Uint8Array> {
  const s = useDoc.getState()
  const data = s.getData()
  const referenced = new Set<string>()
  for (const f of data.features) for (const v of Object.values(f.params)) if (typeof v === 'string' && s.blobs[v]) referenced.add(v)
  // state/error are derived, not persisted
  const features = data.features.map(({ id, type, name, suppressed, params }) => ({ id, type, name, suppressed, params }))
  const docText = JSON.stringify({ format: FORMAT, app: 'CADdy McCADFace', ...data, features })
  const files: Record<string, Uint8Array> = { 'document.json': strToU8(docText) }
  for (const id of referenced) files['blobs/' + id] = s.blobs[id]
  // version history: the open project's, with this save added when it is a real save
  const hist = opts.append ? cloneHistory() : historyData()
  if (opts.append) {
    await appendVersion(hist, { docJson: docText, featureCount: features.length, blobs: Object.fromEntries([...referenced].map((id) => [id, s.blobs[id]])), note: opts.note ?? useHistory.getState().pendingNote ?? '' })
    const current = new Set(await Promise.all([...referenced].map((id) => hashOf(s.blobs[id]))))
    pruneHistory(hist, useHistory.getState().settings, current)
  }
  Object.assign(files, historyFiles(hist, new Set(await Promise.all([...referenced].map((id) => hashOf(s.blobs[id]))))))
  const thumb = withThumbnail ? await captureThumbnail() : null
  if (thumb) files['thumbnail.png'] = thumb
  const out = await zipAsync(files)
  if (opts.append) candidates.set(out, hist)
  return out
}

export function parseProject(bytes: Uint8Array): { data: DocData; blobs: Record<string, Uint8Array> } {
  const files = unzipSync(bytes)
  const raw = files['document.json']
  if (!raw) throw new Error('Not a CADdy McCADFace project (document.json missing)')
  const j = JSON.parse(strFromU8(raw))
  const blobs: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(files)) if (k.startsWith('blobs/')) blobs[k.slice(6)] = v
  const data: DocData = {
    name: j.name ?? 'Untitled',
    features: (j.features ?? []).map((f: { id: string; type: string; name: string; suppressed?: boolean; params: DocData['features'][number]['params'] }) => ({
      ...f, suppressed: !!f.suppressed, state: f.suppressed ? 'suppressed' : 'ok',
    })),
    rollback: j.rollback ?? (j.features ?? []).length,
    userParams: j.userParams ?? [],
    bodyNames: j.bodyNames ?? {},
    configs: j.configs ?? [],
    activeConfig: j.activeConfig ?? null,
  }
  return { data, blobs }
}

export function loadProject(bytes: Uint8Array) {
  const { data, blobs } = parseProject(bytes)
  clearCache()
  useDoc.getState().loadDocument(data, blobs)
  setHistory(readHistory(historyEntries(bytes), blobs))
  useHistory.setState({ pendingNote: null, previewing: null })
}

/** Just the history part of a `.caddy`; the rest of the archive (the big blobs) is not inflated again. */
function historyEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes, { filter: (f) => f.name.startsWith('history/') })
}
