/** `.caddy` = zip of document.json + blobs/<id> (import sources) + thumbnail.png. Fully regenerable from the timeline. */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { clearCache } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import type { DocData } from '@/doc/types'
import { captureThumbnail } from '@/viewport/capture'

const FORMAT = 1

export async function serializeProject(withThumbnail = true): Promise<Uint8Array> {
  const s = useDoc.getState()
  const data = s.getData()
  const referenced = new Set<string>()
  for (const f of data.features) for (const v of Object.values(f.params)) if (typeof v === 'string' && s.blobs[v]) referenced.add(v)
  // state/error are derived, not persisted
  const features = data.features.map(({ id, type, name, suppressed, params }) => ({ id, type, name, suppressed, params }))
  const files: Record<string, Uint8Array> = {
    'document.json': strToU8(JSON.stringify({ format: FORMAT, app: 'CADdy McCADFace', ...data, features })),
  }
  for (const id of referenced) files['blobs/' + id] = s.blobs[id]
  const thumb = withThumbnail ? await captureThumbnail() : null
  if (thumb) files['thumbnail.png'] = thumb
  return zipSync(files, { level: 3 })
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
}
