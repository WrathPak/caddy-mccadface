/** `.caddy` = zip of document.json + blobs/<id> (import sources, linked component files) + thumbnail.png. Fully regenerable from the timeline. */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { clearCache } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import { captureThumbnail } from '@/viewport/capture'
import { parseProject } from './projectParse'

export { parseProject }

const FORMAT = 1

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

export async function serializeProject(withThumbnail = true): Promise<Uint8Array> {
  const s = useDoc.getState()
  const data = s.getData()
  const referenced = new Set<string>()
  for (const f of data.features) for (const v of Object.values(f.params)) if (typeof v === 'string' && s.blobs[v]) referenced.add(v)
  for (const e of data.assembly.externals) if (s.blobs[e.blob]) referenced.add(e.blob)
  // state/error are derived, not persisted
  const features = data.features.map(({ id, type, name, suppressed, params, component }) => ({ id, type, name, suppressed, params, ...(component ? { component } : {}) }))
  const files: Record<string, Uint8Array> = {
    'document.json': strToU8(JSON.stringify({ format: FORMAT, app: 'CADdy McCADFace', ...data, features })),
  }
  for (const id of referenced) files['blobs/' + id] = s.blobs[id]
  for (const sec of sections) {
    const v = sec.save()
    if (v != null) files[sec.file] = strToU8(JSON.stringify(v))
  }
  const thumb = withThumbnail ? await captureThumbnail() : null
  if (thumb) files['thumbnail.png'] = thumb
  return zipSync(files, { level: 3 })
}

/** The saved form of every registered section found in a project file. */
export function readSections(bytes: Uint8Array): Record<string, unknown> {
  const files = unzipSync(bytes)
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
}
