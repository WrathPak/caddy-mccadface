/**
 * Linked and embedded components: another `.caddy` file used as a component of this document.
 *
 * The bytes the document last read are stored in it (so it opens without the other file); a LINKED component also remembers
 * where the file came from (a file handle, kept in the browser's storage), is checked against it when the document opens and
 * whenever the tab regains focus, and shows an update notice when the file changed. An EMBEDDED copy never changes.
 */
import { del, get, set } from 'idb-keyval'
import { useDoc, activeDefId } from '@/doc/store'
import { regenerate } from '@/doc/engine'
import { parseProject } from '@/io/projectParse'
import { pickFiles } from '@/io/files'
import { toast } from '@/ui/Modal'
import { identity } from './matrix'
import { nextId } from './actions'
import { useAssemblyRuntime } from './runtime'
import type { ExternalRef } from './types'

/** Where the bytes of a linked file can be read again. */
export interface ExternalSource { read(): Promise<{ bytes: Uint8Array; stamp: number }> }

const sources = new Map<string, ExternalSource>()
/** The file handles behind the sources, so they can be stored again when the document is saved under another name. */
const handles = new Map<string, HandleLike>()
export const setExternalSource = (extId: string, s: ExternalSource | null) => { if (s) sources.set(extId, s); else sources.delete(extId) }
export const hasExternalSource = (extId: string) => sources.has(extId)

/** FNV-1a over the bytes, as 8 hex digits. */
export function hashBytes(b: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0') + b.length.toString(16)
}

interface HandleLike { name: string; getFile(): Promise<File>; queryPermission?(o: { mode: 'read' }): Promise<string>; requestPermission?(o: { mode: 'read' }): Promise<string> }
const handleSource = (h: HandleLike): ExternalSource => ({
  async read() {
    const f = await h.getFile()
    return { bytes: new Uint8Array(await f.arrayBuffer()), stamp: f.lastModified }
  },
})

const handleKey = (host: string, extId: string) => `caddy-ext:${host}:${extId}`
let hostKey = 'untitled'
/** Which document the stored file handles belong to (its file name once it is saved or opened). */
export const setExternalHost = (name: string) => { hostKey = name }

/** Insert a .caddy file as a component. The new component becomes a child of the active one, at the origin. */
export async function insertExternal(bytes: Uint8Array, fileName: string, opts: { linked: boolean; stamp?: number; handle?: HandleLike | null; source?: ExternalSource | null }): Promise<{ ext: string; def: string; occ: string; path: string }> {
  const parsed = parseProject(bytes) // throws a readable error when this is not a project file
  const d = useDoc.getState()
  const a = d.assembly
  if (!parsed.data.features.length && !parsed.data.assembly.occurrences.length) throw new Error(`${fileName} has nothing in it to insert`)
  const base = fileName.replace(/\.[^.]+$/, '')
  const ext = nextId(a.externals.map((e) => e.id), 'e')
  const blob = d.addBlob(bytes)
  const def = 'ext:' + ext
  const occ = nextId(a.occurrences.map((o) => o.id), 'o')
  const ref: ExternalRef = { id: ext, fileName, blob, linked: opts.linked, stamp: opts.stamp ?? Date.now(), hash: hashBytes(bytes) }
  const parent = activeDefId(d)
  d.commit(opts.linked ? 'Insert linked component' : 'Insert embedded component', (doc) => ({
    ...doc,
    assembly: {
      ...doc.assembly,
      externals: [...doc.assembly.externals, ref],
      components: [...doc.assembly.components, { id: def, name: parsed.data.name && parsed.data.name !== 'Untitled' ? parsed.data.name : base, external: ext }],
      occurrences: [...doc.assembly.occurrences, { id: occ, name: base, component: def, parent, transform: identity() }],
    },
  }))
  if (opts.linked) {
    if (opts.source) setExternalSource(ext, opts.source)
    else if (opts.handle) {
      setExternalSource(ext, handleSource(opts.handle))
      handles.set(ext, opts.handle)
      try { await set(handleKey(hostKey, ext), opts.handle) } catch { /* storage unavailable: the component still works, it just cannot be re-read automatically */ }
    }
  }
  await regenerate()
  return { ext, def, occ, path: d.activeOcc ? `${d.activeOcc}/${occ}` : occ }
}

/**
 * Re-read every linked file that has a source and compare it with what the document has. A file that changed gets an update
 * notice (nothing is replaced until the user accepts). Returns the ids with a new notice.
 */
export async function checkExternals(): Promise<string[]> {
  const refs = useDoc.getState().assembly.externals.filter((e) => e.linked)
  const changed = { ...useAssemblyRuntime.getState().extChanged }
  const fresh: string[] = []
  for (const ref of refs) {
    const src = sources.get(ref.id)
    if (!src) continue
    try {
      const { bytes, stamp } = await src.read()
      if (stamp === ref.stamp && !changed[ref.id]) continue
      const hash = hashBytes(bytes)
      if (hash === ref.hash) {
        delete changed[ref.id]
        continue
      }
      if (changed[ref.id]?.hash === hash) continue
      changed[ref.id] = { fileName: ref.fileName, stamp, hash, bytes }
      fresh.push(ref.id)
    } catch (e) {
      console.warn(`[external] could not re-read ${ref.fileName}`, e)
    }
  }
  useAssemblyRuntime.getState().setExtChanged(changed)
  return fresh
}

/** Take the changed file as the component's new content. */
export async function applyExternalUpdate(extId: string, bytes?: Uint8Array, stamp?: number): Promise<void> {
  const rt = useAssemblyRuntime.getState()
  const note = rt.extChanged[extId]
  const data = bytes ?? note?.bytes
  if (!data) return
  parseProject(data)
  const d = useDoc.getState()
  const blob = d.addBlob(data)
  const hash = hashBytes(data)
  d.commit('Update linked component', (doc) => ({
    ...doc,
    assembly: { ...doc.assembly, externals: doc.assembly.externals.map((e) => (e.id === extId ? { ...e, blob, hash, stamp: stamp ?? note?.stamp ?? Date.now() } : e)) },
  }))
  const left = { ...useAssemblyRuntime.getState().extChanged }
  delete left[extId]
  useAssemblyRuntime.getState().setExtChanged(left)
  await regenerate()
}

/**
 * Update from file: re-read the file the component is linked to and take it when it changed. A component whose file this browser
 * cannot read by itself (no stored file handle) asks for the file.
 */
export async function refreshExternal(extId: string): Promise<void> {
  const ref = useDoc.getState().assembly.externals.find((e) => e.id === extId)
  if (!ref) return
  try {
    if (sources.has(extId)) {
      await checkExternals()
      const note = useAssemblyRuntime.getState().extChanged[extId]
      if (note) return void (await applyExternalUpdate(extId))
      return void toast(`${ref.fileName} has not changed.`)
    }
    const [f] = await pickFiles('.caddy')
    if (!f) return
    const bytes = new Uint8Array(await f.arrayBuffer())
    if (hashBytes(bytes) === ref.hash) return void toast(`${f.name} is the version already in this document.`)
    await applyExternalUpdate(extId, bytes, f.lastModified)
    toast(`Updated from ${f.name}.`)
  } catch (e) {
    toast(`Update failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

/** Keep the document's copy and stop asking about this change (until the file changes again). */
export function dismissExternalUpdate(extId: string) {
  const ref = useDoc.getState().assembly.externals.find((e) => e.id === extId)
  const note = useAssemblyRuntime.getState().extChanged[extId]
  if (!ref || !note) return
  // remember the stamp so the same version does not nag again; a newer edit of the file still raises a notice
  useDoc.setState((s) => ({ assembly: { ...s.assembly, externals: s.assembly.externals.map((e) => (e.id === extId ? { ...e, stamp: note.stamp } : e)) } }))
  const left = { ...useAssemblyRuntime.getState().extChanged }
  delete left[extId]
  useAssemblyRuntime.getState().setExtChanged(left)
}

/** After a document is opened: find the stored file handles of its linked components, then check them. */
export async function restoreExternals(): Promise<void> {
  sources.clear()
  useAssemblyRuntime.getState().setExtChanged({})
  for (const ref of useDoc.getState().assembly.externals) {
    if (!ref.linked) continue
    try {
      const h = await get<HandleLike>(handleKey(hostKey, ref.id))
      if (!h) continue
      const perm = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted'
      handles.set(ref.id, h)
      if (perm === 'granted') setExternalSource(ref.id, handleSource(h))
      else pendingPermission.set(ref.id, h)
    } catch { /* no storage, no handle */ }
  }
  await checkExternals()
}

/** Handles the browser wants a click to re-open (permission 'prompt'). */
const pendingPermission = new Map<string, HandleLike>()
export const needsPermission = (extId: string) => pendingPermission.has(extId)
export async function grantExternalAccess(extId: string): Promise<boolean> {
  const h = pendingPermission.get(extId)
  if (!h) return false
  if ((await h.requestPermission?.({ mode: 'read' })) !== 'granted') return false
  pendingPermission.delete(extId)
  setExternalSource(extId, handleSource(h))
  await checkExternals()
  return true
}

/** Store the file handles of the linked components under the document's current name. */
export async function persistExternalHandles() {
  for (const [ext, h] of handles) {
    try { await set(handleKey(hostKey, ext), h) } catch { /* storage unavailable */ }
  }
}

export async function forgetExternal(extId: string) {
  sources.delete(extId)
  handles.delete(extId)
  pendingPermission.delete(extId)
  try { await del(handleKey(hostKey, extId)) } catch { /* nothing stored */ }
}

let watching = false
/** Check linked files again when the tab comes back to the front (somebody may have saved them meanwhile). */
export function watchExternals() {
  if (watching) return
  watching = true
  const again = () => { if (document.visibilityState === 'visible') void checkExternals() }
  window.addEventListener('focus', again)
  document.addEventListener('visibilitychange', again)
}
