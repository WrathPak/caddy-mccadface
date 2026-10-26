/** `.caddy` = zip of document.json + blobs/<id> (import sources, linked component files) + thumbnail.png + history/ (older versions). Fully regenerable from the timeline. */
import { strFromU8, strToU8, unzipSync, zip, type Zippable } from 'fflate'
import { clearCache } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import { captureThumbnail } from '@/viewport/capture'
import { appendVersion, hashOf, historyFiles, pruneHistory, readHistory } from '@/history/pack'
import { cloneHistory, historyData, setHistory, useHistory } from '@/history/store'
import { parseProject } from './projectParse'

export { parseProject }

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
 * Extra data that lives next to document.json in the zip (drawings, render settings...). A workspace registers a section
 * with its own file name; sections that have nothing to save return null and leave no file behind.
 */
export interface ProjectSection {
  file: string
  save(): unknown | null
  /** called with the parsed file, or null when the project has none (new / older documents) */
  load(json: unknown | null): void
}
const sections: ProjectSection[] = []
export function registerProjectSection(s: ProjectSection) {
  sections.push(s)
}
/** New document: every section goes back to empty. */
export function resetProjectSections() {
  for (const s of sections) s.load(null)
}

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
  for (const e of data.assembly.externals) if (s.blobs[e.blob]) referenced.add(e.blob)
  // state/error are derived, not persisted
  const features = data.features.map(({ id, type, name, suppressed, params, component }) => ({ id, type, name, suppressed, params, ...(component ? { component } : {}) }))
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
  for (const sec of sections) {
    const v = sec.save()
    if (v != null) files[sec.file] = strToU8(JSON.stringify(v))
  }
  const thumb = withThumbnail ? await captureThumbnail() : null
  if (thumb) files['thumbnail.png'] = thumb
  const out = await zipAsync(files)
  if (opts.append) candidates.set(out, hist)
  return out
}

/** The saved form of every registered section found in a project file. */
export function readSections(bytes: Uint8Array): Record<string, unknown> {
  const files = unzipSync(bytes, { filter: (f) => sections.some((x) => x.file === f.name) }) // only the section files: the big blobs stay deflated
  const out: Record<string, unknown> = {}
  for (const sec of sections) if (files[sec.file]) out[sec.file] = JSON.parse(strFromU8(files[sec.file]))
  return out
}

export function loadProject(bytes: Uint8Array) {
  const { data, blobs } = parseProject(bytes)
  const extras = readSections(bytes)
  clearCache()
  useDoc.getState().loadDocument(data, blobs)
  for (const sec of sections) sec.load(extras[sec.file] ?? null)
  setHistory(readHistory(historyEntries(bytes), blobs))
  useHistory.setState({ pendingNote: null, previewing: null })
}

/** Just the history part of a `.caddy`; the rest of the archive (the big blobs) is not inflated again. */
function historyEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes, { filter: (f) => f.name.startsWith('history/') })
}
