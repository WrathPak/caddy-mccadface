/** File actions: new / open / save / save as / import / export, plus autosave + crash recovery. */
import { del, get, set } from 'idb-keyval'
import { create } from 'zustand'
import { regenerate, clearCache } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import { getKernel } from '@/kernel/client'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import { viewportBus } from '@/viewport/bus'
import { downloadFile, MODEL_EXTS, pickFiles, pickProject, writeProject, type FileHandleLike } from './files'
import { loadProject, serializeProject } from './project'
import { write3mf } from './threemf'
import { writeStl } from './stl'
import type { ParamSchema } from '@/ui/schema'

let handle: FileHandleLike | null = null
const baseName = (n: string) => n.replace(/\.[^.]+$/, '')
const fail = (what: string, e: unknown) => {
  console.error(e)
  toast(`${what}: ${e instanceof Error ? e.message : String(e)}`, 'error')
}

function confirmDiscard() {
  return !useDoc.getState().dirty || window.confirm('Discard unsaved changes?')
}

export async function newDocument() {
  if (!confirmDiscard()) return
  handle = null
  clearCache()
  useDoc.getState().newDocument()
  void del(AUTOSAVE_KEY)
}

async function frameWhenReady() {
  await regenerate()
  viewportBus.emit('frame', undefined)
}

export async function openDocument() {
  if (!confirmDiscard()) return
  try {
    const f = await pickProject()
    if (!f) return
    loadProject(f.bytes)
    handle = f.handle
    useDoc.setState({ name: baseName(f.name) })
    void del(AUTOSAVE_KEY)
    await frameWhenReady()
  } catch (e) {
    fail('Open failed', e)
  }
}

export async function saveDocument(asNew = false) {
  try {
    const bytes = await serializeProject()
    const name = useDoc.getState().name || 'Untitled'
    const h = await writeProject(bytes, name, asNew ? null : handle)
    if (h === undefined) return // cancelled
    handle = h
    if (h) useDoc.setState({ name: baseName(h.name) })
    useDoc.getState().markClean()
    void del(AUTOSAVE_KEY)
    toast(h ? `Saved ${h.name}` : 'Downloaded project file')
  } catch (e) {
    fail('Save failed', e)
  }
}

// ---------------- import
export async function importFiles(files: File[]) {
  for (const f of files) {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const d = useDoc.getState()
      if (ext === '.caddy') {
        if (!confirmDiscard()) continue
        loadProject(bytes)
        handle = null
        useDoc.setState({ name: baseName(f.name) })
      } else if (ext === '.stl' || ext === '.3mf') {
        const blob = d.addBlob(bytes)
        d.addFeature('importMesh', { blob, format: ext.slice(1), fileName: f.name, scale: 1 }, baseName(f.name))
      } else if (ext === '.step' || ext === '.stp') {
        const blob = d.addBlob(bytes)
        d.addFeature('importStep', { blob, fileName: f.name }, baseName(f.name))
      } else {
        toast(`Unsupported file type: ${f.name}`, 'error')
        continue
      }
      await frameWhenReady()
      const err = useDoc.getState().features.find((x) => x.state === 'error')
      if (err) toast(`${err.name}: ${err.error}`, 'error')
    } catch (e) {
      fail(`Import of ${f.name} failed`, e)
    }
  }
}

export async function importDialog() {
  const files = await pickFiles([...MODEL_EXTS, '.caddy'].join(','), true)
  if (files.length) await importFiles(files)
}

// ---------------- export
export const exportSchema: ParamSchema = {
  id: 'export',
  title: 'Export',
  params: [
    {
      type: 'enum', key: 'format', help: 'STL and 3MF are meshes for 3D printing (3MF keeps units and colours). STEP keeps exact curved surfaces for other CAD programs.', label: 'Format', display: 'segmented', default: 'stl',
      options: [{ value: 'stl', label: 'STL' }, { value: '3mf', label: '3MF' }, { value: 'step', label: 'STEP' }],
    },
    { type: 'enum', key: 'scope', help: 'Export only the selected bodies, or every visible body.', label: 'Bodies', display: 'segmented', default: 'all', options: [{ value: 'selection', label: 'Selection' }, { value: 'all', label: 'All visible' }] },
  ],
}

export function exportDialog() {
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  const hasSel = ui.selection.length > 0
  const close = () => { useUi.getState().closeInspector() }
  ui.openInspector({
    schema: exportSchema,
    values: { format: 'stl', scope: hasSel ? 'selection' : 'all' },
    onCancel: close,
    onOk: (v) => {
      close()
      void exportBodies(v.format as 'stl' | '3mf' | 'step', v.scope as 'selection' | 'all')
    },
  })
}

export async function exportBodies(format: 'stl' | '3mf' | 'step', scope: 'selection' | 'all') {
  const s = useDoc.getState()
  const ui = useUi.getState()
  const selIds = new Set(ui.selection.map((r) => r.id))
  let bodies = s.geometry.filter((b) => !ui.hiddenIds[b.id])
  if (scope === 'selection') bodies = bodies.filter((b) => selIds.has(b.id))
  if (format === 'step') bodies = bodies.filter((b) => b.kind === 'brep')
  if (!bodies.length) return toast(format === 'step' ? 'STEP export needs at least one B-rep body' : 'Nothing to export', 'error')
  const name = s.name || 'Untitled'
  const label = (b: { id: string; name: string }) => s.bodyNames[b.id] ?? b.name
  try {
    const k = getKernel()
    if (format === 'step') {
      const buf = await k.exportStep(bodies.map((b) => ({ key: b.key, name: label(b) })))
      downloadFile(`${name}.step`, buf, 'model/step')
    } else {
      const meshes = await k.exportMeshes(bodies.map((b) => b.key))
      if (format === 'stl') downloadFile(`${name}.stl`, writeStl(meshes), 'model/stl')
      else downloadFile(`${name}.3mf`, write3mf(meshes.map((mesh, i) => ({ name: label(bodies[i]), mesh }))), 'model/3mf')
    }
    toast(`Exported ${bodies.length} ${bodies.length === 1 ? 'body' : 'bodies'} as ${format.toUpperCase()}`)
  } catch (e) {
    fail('Export failed', e)
  }
}

// ---------------- autosave + recovery
const AUTOSAVE_KEY = 'caddy-autosave'
interface AutosaveRecord { bytes: Uint8Array; name: string; savedAt: number }

export const useRecovery = create<{ record: AutosaveRecord | null }>(() => ({ record: null }))

export async function recover() {
  const r = useRecovery.getState().record
  useRecovery.setState({ record: null })
  if (!r) return
  try {
    loadProject(r.bytes)
    useDoc.setState({ name: r.name, dirty: true })
    await frameWhenReady()
  } catch (e) {
    fail('Recovery failed', e)
  }
}
export function discardRecovery() {
  useRecovery.setState({ record: null })
  void del(AUTOSAVE_KEY)
}

/** Call once at startup: offer crash recovery, then autosave every 30 s while there are unsaved edits. */
export async function initPersistence() {
  try {
    const r = await get<AutosaveRecord>(AUTOSAVE_KEY)
    if (r?.bytes) useRecovery.setState({ record: r })
  } catch { /* IndexedDB unavailable */ }
  setInterval(async () => {
    const d = useDoc.getState()
    if (!d.dirty || useRecovery.getState().record) return
    try {
      await set(AUTOSAVE_KEY, { bytes: await serializeProject(false), name: d.name, savedAt: Date.now() } satisfies AutosaveRecord)
    } catch { /* quota or private mode */ }
  }, 30_000)
}
