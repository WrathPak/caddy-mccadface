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
import { commitSavedHistory, loadProject, resetProjectSections, serializeProject } from './project'
import { resetHistory } from '@/history/store'
import { rememberSource } from './meshImport'
import { shouldAutosave, worthRecovering } from './autosave'
import { parseProject } from './projectParse'
import { write3mf } from './threemf'
import { writeStl } from './stl'
import { assemblyObjects, exportAssemblyStep, mergePlaced } from '@/assembly/exportAssembly'
import { assembledInstances } from '@/assembly/check'
import { persistExternalHandles, restoreExternals, setExternalHost } from '@/assembly/external'
import { within } from '@/assembly/instances'
import type { ParamSchema } from '@/ui/schema'

let handle: FileHandleLike | null = null
const baseName = (n: string) => n.replace(/\.[^.]+$/, '')
/** STL and 3MF describe solids; an open surface has no inside, so it is left out with a note (STEP keeps surfaces as they are). */
export const SURFACE_NOTE = 'Open surfaces are not in the file: STL and 3MF need solids. Stitch or thicken them first, or export STEP.'
const fail = (what: string, e: unknown) => {
  console.error(e)
  toast(`${what}: ${e instanceof Error ? e.message : String(e)}`, 'error')
}

/** The History panel registers how to close a version preview, so New / Open can put the real project back before they ask about it. */
let closePreview: (() => void) | null = null
export const onClosePreview = (fn: () => void) => { closePreview = fn }

function confirmDiscard() {
  if (useDoc.getState().readOnly) closePreview?.()
  return !useDoc.getState().dirty || window.confirm('Discard unsaved changes?')
}

export async function newDocument() {
  if (!confirmDiscard()) return
  handle = null
  clearCache()
  useDoc.getState().newDocument()
  resetHistory()
  resetProjectSections()
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
    if (f) await openProjectBytes(f.bytes, f.name, f.handle)
  } catch (e) {
    fail('Open failed', e)
  }
}

/** Open a project whose bytes are already in hand (the Projects panel reads them from its folder); saving goes back to `h`. */
export async function openProjectFile(bytes: Uint8Array, name: string, h: FileHandleLike | null) {
  if (!confirmDiscard()) return false
  try {
    await openProjectBytes(bytes, name, h)
    return true
  } catch (e) {
    fail('Open failed', e)
    return false
  }
}

async function openProjectBytes(bytes: Uint8Array, name: string, h: FileHandleLike | null) {
  loadProject(bytes)
  handle = h
  useDoc.setState({ name: baseName(name) })
  setExternalHost(name)
  void del(AUTOSAVE_KEY)
  await frameWhenReady()
  // linked components are read again from their files: a newer file raises the update notice
  void restoreExternals()
}

/** The file the open project saves to, if it has one. */
export const currentFile = () => handle
export function setCurrentFile(h: FileHandleLike | null) { handle = h }

/** Save to the open file (or ask where). `note` is the optional text for this version in the History panel. */
export async function saveDocument(asNew = false, note?: string) {
  if (useDoc.getState().readOnly) return toast('A past version is on show: close the preview before saving', 'error')
  try {
    const bytes = await serializeProject(true, { note, append: true })
    const name = useDoc.getState().name || 'Untitled'
    const h = await writeProject(bytes, name, asNew ? null : handle)
    if (h === undefined) return // cancelled
    commitSavedHistory(bytes)
    handle = h
    if (h) useDoc.setState({ name: baseName(h.name) })
    setExternalHost(h?.name ?? (name + '.caddy'))
    void persistExternalHandles()
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
        rememberSource(bytes, f)
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
    { type: 'enum', key: 'configs', help: 'The model as it is now, or one file per configuration (sizes) of the document.', label: 'Configurations', display: 'segmented', default: 'active', options: [{ value: 'active', label: 'Current' }, { value: 'all', label: 'Every configuration' }], visibleWhen: () => useDoc.getState().configs.length > 0 },
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
      if (v.configs === 'all' && useDoc.getState().configs.length) void exportAllConfigs(v.format as 'stl' | '3mf' | 'step', v.scope as 'selection' | 'all')
      else void exportBodies(v.format as 'stl' | '3mf' | 'step', v.scope as 'selection' | 'all')
    },
  })
}

/** One file per configuration: each is switched on, rebuilt and exported; the document ends up as it was. */
export async function exportAllConfigs(format: 'stl' | '3mf' | 'step', scope: 'selection' | 'all') {
  const d = useDoc.getState()
  const keep = d.activeConfig
  try {
    for (const c of d.configs) {
      useDoc.getState().setActiveConfig(c.name)
      await regenerate()
      await exportBodies(format, scope, '-' + c.name.replace(/[^\w.-]+/g, '_'))
    }
  } finally {
    useDoc.getState().setActiveConfig(keep)
    await regenerate()
  }
}

/** An assembly leaves as its structure: STEP products per component instance, 3MF objects per instance, STL as one placed mesh. */
async function exportAssembly(format: 'stl' | '3mf' | 'step', scope: 'selection' | 'all', suffix: string) {
  const s = useDoc.getState()
  const ui = useUi.getState()
  const name = (s.name || 'Untitled') + suffix
  try {
    if (format === 'step') {
      const r = await exportAssemblyStep()
      if (!r.parts) return toast('STEP export needs at least one B-rep body', 'error')
      downloadFile(`${name}.step`, new Uint8Array(r.bytes), 'model/step')
      toast(`Exported ${r.parts} ${r.parts === 1 ? 'part' : 'parts'} as a STEP assembly${r.skipped.length ? `; ${r.skipped.length} mesh ${r.skipped.length === 1 ? 'body was' : 'bodies were'} left out` : ''}`)
      return
    }
    const sel = ui.selection
    const keep = scope === 'selection' && sel.length ? (i: { body: { id: string }; path: string }) => sel.some((r) => r.id === i.body.id || (r.path ? within(i.path, r.path) : false) || (r.kind === 'component' && within(i.path, r.id))) : undefined
    const objects = await assemblyObjects(keep)
    const surfaces = assembledInstances().filter((i) => i.body.surface).length
    if (!objects.length) return toast(surfaces ? `Nothing to export. ${SURFACE_NOTE}` : 'Nothing to export', 'error')
    if (format === 'stl') downloadFile(`${name}.stl`, writeStl([mergePlaced(objects.map((o) => ({ ...o.mesh, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })))]), 'model/stl')
    else downloadFile(`${name}.3mf`, write3mf(objects), 'model/3mf')
    toast(`Exported ${objects.length} ${format === '3mf' ? (objects.length === 1 ? 'object' : 'objects') : 'objects as one mesh'} as ${format.toUpperCase()}${surfaces ? `. ${SURFACE_NOTE}` : ''}`)
  } catch (e) {
    fail('Export failed', e)
  }
}

export async function exportBodies(format: 'stl' | '3mf' | 'step', scope: 'selection' | 'all', suffix = '') {
  const s = useDoc.getState()
  if (s.assembly.occurrences.length) return exportAssembly(format, scope, suffix)
  const ui = useUi.getState()
  const selIds = new Set(ui.selection.map((r) => r.id))
  let bodies = s.geometry.filter((b) => !ui.hiddenIds[b.id])
  if (scope === 'selection') bodies = bodies.filter((b) => selIds.has(b.id))
  if (format === 'step') bodies = bodies.filter((b) => b.kind === 'brep')
  const surfaces = format === 'step' ? 0 : bodies.filter((b) => b.surface).length
  if (surfaces) bodies = bodies.filter((b) => !b.surface)
  if (!bodies.length) return toast(format === 'step' ? 'STEP export needs at least one B-rep body' : surfaces ? `Nothing to export. ${SURFACE_NOTE}` : 'Nothing to export', 'error')
  const name = (s.name || 'Untitled') + suffix
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
    toast(`Exported ${bodies.length} ${bodies.length === 1 ? 'body' : 'bodies'} as ${format.toUpperCase()}${surfaces ? `. ${SURFACE_NOTE}` : ''}`)
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
  // (the e2e fixture sets this flag so a test never meets the recovery prompt of an earlier page load)
  if ((window as unknown as { __e2eNoAutosave?: boolean }).__e2eNoAutosave) return
  try {
    const r = await get<AutosaveRecord>(AUTOSAVE_KEY)
    if (r?.bytes) {
      // a copy with nothing in it is not worth a prompt
      let keep = false
      try { keep = worthRecovering(parseProject(r.bytes).data) } catch { /* unreadable: drop it */ }
      if (keep) useRecovery.setState({ record: r })
      else void del(AUTOSAVE_KEY)
    }
  } catch { /* IndexedDB unavailable */ }
  setInterval(async () => {
    const d = useDoc.getState()
    if (!shouldAutosave(d) || useRecovery.getState().record) return
    try {
      await set(AUTOSAVE_KEY, { bytes: await serializeProject(false), name: d.name, savedAt: Date.now() } satisfies AutosaveRecord)
    } catch { /* quota or private mode */ }
  }, 30_000)
}
