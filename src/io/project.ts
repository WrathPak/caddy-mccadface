/** `.caddy` = zip of document.json + blobs/<id> (import sources, linked component files) + thumbnail.png. Fully regenerable from the timeline. */
import { strToU8, zipSync } from 'fflate'
import { clearCache } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import { captureThumbnail } from '@/viewport/capture'
import { parseProject } from './projectParse'

export { parseProject }

const FORMAT = 1

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
  const thumb = withThumbnail ? await captureThumbnail() : null
  if (thumb) files['thumbnail.png'] = thumb
  return zipSync(files, { level: 3 })
}

export function loadProject(bytes: Uint8Array) {
  const { data, blobs } = parseProject(bytes)
  clearCache()
  useDoc.getState().loadDocument(data, blobs)
}
