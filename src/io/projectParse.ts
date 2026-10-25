/** Reading a `.caddy` (zip of document.json + blobs). Kept apart from project.ts so linked components can read files without the viewport. */
import { strFromU8, unzipSync } from 'fflate'
import { normalizeAssembly } from '@/assembly/types'
import type { DocData, Feature } from '@/doc/types'

interface RawFeature { id: string; type: string; name: string; suppressed?: boolean; params: Feature['params']; component?: string }

export function parseProject(bytes: Uint8Array): { data: DocData; blobs: Record<string, Uint8Array> } {
  const files = unzipSync(bytes)
  const raw = files['document.json']
  if (!raw) throw new Error('Not a CADdy McCADFace project (document.json missing)')
  const j = JSON.parse(strFromU8(raw))
  const blobs: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(files)) if (k.startsWith('blobs/')) blobs[k.slice(6)] = v
  const data: DocData = {
    name: j.name ?? 'Untitled',
    features: (j.features ?? []).map((f: RawFeature) => ({
      ...f, suppressed: !!f.suppressed, state: f.suppressed ? 'suppressed' : 'ok',
    })),
    rollback: j.rollback ?? (j.features ?? []).length,
    userParams: j.userParams ?? [],
    bodyNames: j.bodyNames ?? {},
    configs: j.configs ?? [],
    activeConfig: j.activeConfig ?? null,
    // documents saved before assemblies have no component tree: they open as a single root component
    assembly: normalizeAssembly(j.assembly),
  }
  return { data, blobs }
}
