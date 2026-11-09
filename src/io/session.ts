/**
 * The session snapshot: everything needed to put a tab back exactly as it was when the page is reloaded (F5, Ctrl+R, the update
 * button). It is not autosave: it is written whether or not the document is dirty and whatever the autosave setting says, and it
 * belongs to one tab. The tab id lives in sessionStorage, which survives a reload of that tab and is not shared with other tabs,
 * so two tabs never read each other's work. A tab with no snapshot (a new tab, a browser restart) goes through the crash-recovery
 * prompt as before.
 *
 * What it keeps: the document (timeline, rollback marker, parameters, blobs), its name, whether it has unsaved changes, the file
 * handle it saves to, the undo / redo stacks, the project sections (drawings, render settings), the version history, the camera,
 * the workspace and display state, the selection, the sketch that is being edited, and the feature dialog that is open with the
 * values typed so far.
 *
 * Layout in IndexedDB (database `caddy-session`): `rec:<tab>` the record, `blob:<tab>:<id>` each import source (immutable, written
 * once), `hist:<tab>` the version history (written when it changes), `at:<tab>` the time the tab last wrote (for cleaning up).
 */
import { createStore, delMany, get as idbGet, getMany, keys as idbKeys, set as idbSet, setMany, type UseStore } from 'idb-keyval'
import { getEditRollback, setEditRollback, useDoc, type HistoryItem } from '@/doc/store'
import { currentDialog, createFeature, editFeature, watchDialog } from '@/doc/editor'
import type { DocData, Feature } from '@/doc/types'
import { docSig } from '@/doc/sig'
import type { Body, MeshData } from '@/kernel/types'
import { useUi, type SelectionRef, type SectionState, type UiState } from '@/store/ui'
import { beginSketch, useSketch } from '@/sketch/store'
import type { PlaneDef, SketchModel } from '@/sketch/types'
import { emptyHistory, type HistoryData } from '@/history/pack'
import { historyData, setHistory, useHistory } from '@/history/store'
import { loadSections, saveSections, watchSections } from './project'
import { getPoseData, setPoseData, viewportReady, watchPose, type PoseData } from '@/viewport/pose'
import { closeGate } from '@/app/startGate'
import { WARM_KEY } from '@/kernel/warm'
import type { FileHandleLike } from './files'
import type { ParamValues } from '@/ui/schema'

export const SESSION_VERSION = 1
/** A tab's snapshot older than this is dropped the next time any tab starts. */
export const STALE_MS = 24 * 60 * 60 * 1000
/** A change is written this long after the last one, and at the latest this long after the first one that was not written yet. */
export const WRITE_DELAY_MS = 350
export const WRITE_MAX_WAIT_MS = 2000

// ---------------------------------------------------------------- storage

/** The small key-value surface the snapshot needs: IndexedDB in the page, a Map in the unit tests. */
export interface Kv {
  get<T>(key: string): Promise<T | undefined>
  getMany<T>(keys: string[]): Promise<(T | undefined)[]>
  set(key: string, value: unknown): Promise<void>
  setMany(entries: [string, unknown][]): Promise<void>
  delMany(keys: string[]): Promise<void>
  keys(): Promise<string[]>
}

export function idbKv(store: UseStore = createStore('caddy-session', 'kv')): Kv {
  return {
    get: (k) => idbGet(k, store),
    getMany: (ks) => getMany(ks, store),
    set: (k, v) => idbSet(k, v, store),
    setMany: (e) => setMany(e, store),
    delMany: (ks) => delMany(ks, store),
    keys: async () => (await idbKeys(store)).map(String),
  }
}

const recKey = (tab: string) => `rec:${tab}`
const blobKey = (tab: string, id: string) => `blob:${tab}:${id}`
const histKey = (tab: string) => `hist:${tab}`
const atKey = (tab: string) => `at:${tab}`
const geoKey = (tab: string) => `geo:${tab}`
const meshKey = (tab: string, mk: string) => `mesh:${tab}:${mk}`
/** The bodies kept for the next load are not written for a document bigger than this: its regeneration is a task of its own, and every edit would copy the lot. */
export const GHOST_MAX_BYTES = 64 * 1024 * 1024

// ---------------------------------------------------------------- tab id

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
const TAB_KEY = 'caddy-tab'
const makeId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))

/** The id this tab keeps across reloads, or null when there is none yet. */
export function readTabId(storage: StorageLike | null): string | null {
  try { return storage?.getItem(TAB_KEY) || null } catch { return null }
}
/** A new id for this tab (a first visit, or a tab that turned out to be a copy of another one). */
export function newTabId(storage: StorageLike | null, make: () => string = makeId): string {
  const id = make()
  try { storage?.setItem(TAB_KEY, id) } catch { /* no sessionStorage: nothing survives a reload, which is the same as no snapshot */ }
  return id
}

// ---------------------------------------------------------------- packing

/**
 * The undo stack holds up to 200 copies of the document in which almost every feature is the same object. Writing each copy out
 * would repeat them 200 times, so every object is stored once in a table and the copies point at it.
 */
export class Interner {
  table: unknown[] = []
  private ids = new Map<object, number>()
  ref(o: object): number {
    let i = this.ids.get(o)
    if (i === undefined) { i = this.table.length; this.table.push(o); this.ids.set(o, i) }
    return i
  }
}

export interface PackedData {
  name: string
  rollback: number
  activeConfig: string | null
  features: number[]
  userParams: number
  bodyNames: number
  configs: number
  assembly: number
}
export interface PackedItem { label: string; data: PackedData }

export function packData(d: DocData, it: Interner): PackedData {
  return {
    name: d.name, rollback: d.rollback, activeConfig: d.activeConfig,
    features: d.features.map((f) => it.ref(f)),
    userParams: it.ref(d.userParams), bodyNames: it.ref(d.bodyNames), configs: it.ref(d.configs), assembly: it.ref(d.assembly),
  }
}
export function unpackData(p: PackedData, table: unknown[]): DocData {
  return {
    name: p.name, rollback: p.rollback, activeConfig: p.activeConfig,
    features: p.features.map((i) => table[i] as Feature),
    userParams: table[p.userParams] as DocData['userParams'],
    bodyNames: table[p.bodyNames] as DocData['bodyNames'],
    configs: table[p.configs] as DocData['configs'],
    assembly: table[p.assembly] as DocData['assembly'],
  }
}
const packItems = (xs: HistoryItem[], it: Interner): PackedItem[] => xs.map((x) => ({ label: x.label, data: packData(x.data, it) }))
const unpackItems = (xs: PackedItem[], table: unknown[]): HistoryItem[] => xs.map((x) => ({ label: x.label, data: unpackData(x.data, table) }))

// ---------------------------------------------------------------- the bodies

/** The bodies of the document without their meshes: the meshes are stored one by one, so a body that did not change is not written again. */
export interface GeoIndex { sig: string; bodies: (Omit<Body, 'mesh' | 'key'> & { mk: string })[] }

const bytesOf = (v: unknown): number => {
  if (!v || typeof v !== 'object') return 0
  if (ArrayBuffer.isView(v)) return v.byteLength
  if (v instanceof ArrayBuffer) return v.byteLength
  let n = 0
  for (const x of Object.values(v)) n += bytesOf(x)
  return n
}
/** How many bytes of mesh data the bodies carry. */
export const meshBytes = (bodies: Body[]) => bodies.reduce((n, b) => n + bytesOf(b.mesh), 0)
/** The mesh as it is kept: the GPU pieces of a big mesh are cut again by the page, so they are not worth the space. */
const keptMesh = (m: MeshData): MeshData => { const { chunks: _c, ...rest } = m; return rest as MeshData }

export function geoIndexOf(bodies: Body[], sig: string): GeoIndex {
  return { sig, bodies: bodies.map(({ mesh: _m, key, ...rest }) => ({ ...rest, mk: key })) }
}
/** Bodies for display from what was kept; they have no handle in the kernel (`key` is made up), so only things that draw them can use them. */
export function ghostBodies(idx: GeoIndex, meshes: (MeshData | undefined)[]): Body[] | null {
  if (!idx.bodies.length || meshes.length !== idx.bodies.length || meshes.some((m) => !m)) return null
  return idx.bodies.map(({ mk, ...rest }, i) => ({ ...rest, key: 'ghost:' + mk, mesh: meshes[i]! }))
}

// ---------------------------------------------------------------- the record

export interface UiSnap {
  workspace: UiState['workspace']
  displayMode: UiState['displayMode']
  projection: UiState['projection']
  selectionFilter: UiState['selectionFilter']
  selection: SelectionRef[]
  hiddenIds: Record<string, true>
  section: SectionState
}
export interface SketchSnap {
  plane: PlaneDef
  face: string | null
  editing: string | null
  model: SketchModel
  past: SketchModel[]
  future: SketchModel[]
}
export interface DialogSnap { type: string; tool: string; featureId?: string; values: ParamValues }

export interface SessionRecord {
  v: number
  tab: string
  at: number
  table: unknown[]
  doc: PackedData
  past: PackedItem[]
  future: PackedItem[]
  blobIds: string[]
  dirty: boolean
  handle: FileHandleLike | null
  sections: Record<string, unknown>
  ui: UiSnap
  pose: PoseData | null
  sketch: SketchSnap | null
  dialog: DialogSnap | null
  /** the timeline's real rollback marker while an edit (dialog or sketch) holds it lower */
  editRollback: number | null
  selectedFeatureId: string | null
  activeOcc: string | null
}

export const uiSnapshot = (u: UiState): UiSnap => ({
  workspace: u.workspace, displayMode: u.displayMode, projection: u.projection, selectionFilter: u.selectionFilter,
  selection: u.selection, hiddenIds: u.hiddenIds, section: u.section,
})

/** Where the file handle lives (actions.ts owns it); set once at startup. */
export interface SessionHooks {
  getHandle(): FileHandleLike | null
  /** a restored session: the handle (or null) the project saves to, and the file name it came from */
  restored(handle: FileHandleLike | null, name: string): void
}
let hooks: SessionHooks = { getHandle: () => null, restored: () => {} }
export const setSessionHooks = (h: SessionHooks) => { hooks = h }

/** The snapshot of the tab as it is right now, or null while a past version is on show (the real project is what a reload should bring back). */
export function buildRecord(tab: string, now = Date.now()): SessionRecord | null {
  const d = useDoc.getState()
  if (d.readOnly) return null
  const it = new Interner()
  const doc = packData(d.getData(), it)
  const stacks = d.takeStacks()
  const past = packItems(stacks.past, it)
  const future = packItems(stacks.future, it)
  const sk = useSketch.getState()
  const dlg = currentDialog()
  return {
    v: SESSION_VERSION, tab, at: now, table: it.table, doc, past, future,
    blobIds: Object.keys(d.blobs),
    dirty: d.dirty,
    handle: hooks.getHandle(),
    sections: saveSections(),
    ui: uiSnapshot(useUi.getState()),
    pose: getPoseData(),
    sketch: sk.active ? { plane: sk.plane, face: sk.face, editing: sk.editing, model: sk.model, past: sk.past, future: sk.future } : null,
    dialog: dlg ? { type: dlg.type, tool: dlg.tool, featureId: dlg.featureId, values: dlg.values } : null,
    editRollback: getEditRollback(),
    selectedFeatureId: d.selectedFeatureId,
    activeOcc: d.activeOcc,
  }
}

/** A record is usable when it is of this version and everything it points at is there. */
export function usable(r: SessionRecord | undefined, blobs: (Uint8Array | undefined)[]): r is SessionRecord {
  return !!r && r.v === SESSION_VERSION && Array.isArray(r.table) && !!r.doc && blobs.length === r.blobIds.length && blobs.every((b) => !!b)
}

/**
 * Put a record into the stores: the document and everything around it. Does not touch the sketch or the dialog (they need the kernel
 * and the solver; see `reopenEditors`). The document starts its regeneration here, like any load.
 */
export function applyRecord(r: SessionRecord, blobs: Record<string, Uint8Array>, history: HistoryData | undefined, ghost?: Body[] | null) {
  const doc = unpackData(r.doc, r.table)
  useDoc.getState().loadDocument(doc, blobs)
  loadSections(r.sections ?? {})
  setHistory(history ?? emptyHistory())
  useHistory.setState({ pendingNote: null, previewing: null })
  useDoc.getState().putStacks({ past: unpackItems(r.past, r.table), future: unpackItems(r.future, r.table) })
  useDoc.setState({ dirty: r.dirty, selectedFeatureId: r.selectedFeatureId ?? null, activeOcc: r.activeOcc ?? null })
  setEditRollback(r.editRollback ?? null)
  useUi.setState({ ...r.ui, sketchMode: !!r.sketch })
  setPoseData(r.pose)
  // the bodies the page had, until the kernel has made them again
  if (ghost?.length) {
    useDoc.getState().setGhost(ghost)
    // tools wait for the real bodies (see app/startGate.ts)
    const open = closeGate()
    const off = useDoc.subscribe((s) => { if (!s.ghost) { off(); open() } })
  }
  hooks.restored(r.handle ?? null, doc.name)
}

/** Open the sketch that was being edited, and (once the document is regenerated) the feature dialog that was open. */
export async function reopenEditors(r: SessionRecord, afterRegen: Promise<void>) {
  if (r.sketch) {
    const s = r.sketch
    const keep = r.editRollback
    await beginSketch({
      plane: s.plane, face: s.face, model: s.model, editing: s.editing, quiet: true,
      onClose: s.editing && keep != null ? () => { useDoc.getState().setRollback(keep); setEditRollback(null) } : undefined,
    })
    useSketch.setState({ past: s.past, future: s.future })
    // beginSketch clears the selection; the one the page had belongs to the model
    useUi.setState({ selection: r.ui.selection })
  }
  if (r.dialog) {
    const dlg = r.dialog
    await afterRegen
    const d = useDoc.getState()
    if (dlg.featureId) {
      if (!d.features.some((f) => f.id === dlg.featureId)) return
      // editFeature lowers the marker to just before the feature again and remembers the real one
      if (r.editRollback != null) d.setRollback(r.editRollback)
      editFeature(dlg.featureId, dlg.values)
    } else {
      createFeature(dlg.type, dlg.values, dlg.tool)
    }
  }
}

// ---------------------------------------------------------------- writing

/** One tab's snapshot writer. */
export interface SessionWriter {
  /** write the snapshot now; resolves when it is stored */
  flush(): Promise<void>
  /** a change happened: write soon */
  touch(): void
  stop(): void
}

export function createWriter(kv: Kv, tab: string, o: { now?: () => number; delay?: number; maxWait?: number } = {}): SessionWriter {
  const now = o.now ?? Date.now
  const delay = o.delay ?? WRITE_DELAY_MS
  const maxWait = o.maxWait ?? WRITE_MAX_WAIT_MS
  /** blobs that are in the database */
  const written = new Set<string>()
  /** meshes of this page's bodies that are in the database (a body key stands for one geometry for as long as the page lives) */
  const meshesWritten = new Set<string>()
  let lastGeo: Body[] | null = null
  let lastHistory: HistoryData | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let first = 0

  const write = (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    first = 0
    const rec = buildRecord(tab, now())
    if (!rec) return Promise.resolve()
    // the next load of this tab starts the kernel early only if there is a model to make
    try { sessionStorage.setItem(WARM_KEY, useDoc.getState().features.length ? '1' : '0') } catch { /* no sessionStorage */ }
    const d = useDoc.getState()
    const entries: [string, unknown][] = []
    for (const id of rec.blobIds) {
      if (written.has(id)) continue
      written.add(id)
      entries.push([blobKey(tab, id), d.blobs[id]])
    }
    const h = historyData()
    if (h !== lastHistory) { lastHistory = h; entries.push([histKey(tab), h]) }
    const gone = [...written].filter((id) => !(id in d.blobs))
    for (const id of gone) written.delete(id)
    entries.push([atKey(tab), rec.at])
    // the bodies, when they are the ones this document makes (a regeneration still running or queued will bring new ones, and write again)
    const dropMeshes: string[] = []
    if (!d.regenerating && d.geometry !== lastGeo && d.geometrySig && d.geometrySig === docSig(d)) {
      lastGeo = d.geometry
      if (d.geometry.length && meshBytes(d.geometry) <= GHOST_MAX_BYTES) {
        for (const b of d.geometry) {
          if (meshesWritten.has(b.key)) continue
          meshesWritten.add(b.key)
          entries.push([meshKey(tab, b.key), keptMesh(b.mesh)])
        }
        entries.push([geoKey(tab), geoIndexOf(d.geometry, d.geometrySig)])
        const now = new Set(d.geometry.map((b) => b.key))
        for (const k of [...meshesWritten]) if (!now.has(k)) { meshesWritten.delete(k); dropMeshes.push(meshKey(tab, k)) }
      } else {
        // empty or too big to be worth it: nothing is kept for the next load
        for (const k of meshesWritten) dropMeshes.push(meshKey(tab, k))
        meshesWritten.clear()
        dropMeshes.push(geoKey(tab))
      }
    }
    entries.push([recKey(tab), rec])
    // one transaction: the record, the blobs it points at and the history land together or not at all, and a write started as the page
    // goes away is not left waiting for a second step
    const job = kv.setMany(entries)
      .catch(() => {
        // a handle that cannot be cloned (a stand-in object) must not stop the rest being kept
        if (!rec.handle) return
        return kv.setMany(entries.map((e): [string, unknown] => (e[0] === recKey(tab) ? [e[0], { ...rec, handle: null }] : e)))
      })
      .then(() => { const del = [...gone.map((id) => blobKey(tab, id)), ...dropMeshes]; return del.length ? kv.delMany(del) : undefined })
      .catch(() => { /* quota, private mode, storage cleared: the page just keeps going without a snapshot */ })
    return job
  }

  return {
    flush: write,
    touch() {
      const t = now()
      if (!first) first = t
      clearTimeout(timer)
      timer = setTimeout(() => void write(), Math.max(0, Math.min(delay, first + maxWait - t)))
    },
    stop() { clearTimeout(timer) },
  }
}

// ---------------------------------------------------------------- reading

/** The snapshot of `tab`, with its blobs and history, or null when there is none or it is not whole. */
export async function readSession(kv: Kv, tab: string): Promise<{ record: SessionRecord; blobs: Record<string, Uint8Array>; history: HistoryData | undefined; ghost: Body[] | null } | null> {
  const record = await kv.get<SessionRecord>(recKey(tab))
  if (!record || record.v !== SESSION_VERSION) return null
  const [list, history, idx] = await Promise.all([
    kv.getMany<Uint8Array>((record.blobIds ?? []).map((id) => blobKey(tab, id))),
    kv.get<HistoryData>(histKey(tab)),
    kv.get<GeoIndex>(geoKey(tab)),
  ])
  if (!usable(record, list)) return null
  const blobs = Object.fromEntries(record.blobIds.map((id, i) => [id, list[i]!]))
  // the kept bodies are shown only when they were made from exactly this document
  let ghost: Body[] | null = null
  try {
    const sig = docSig({ ...unpackData(record.doc, record.table), blobs })
    if (idx && idx.sig === sig) ghost = ghostBodies(idx, await kv.getMany<MeshData>(idx.bodies.map((b) => meshKey(tab, b.mk))))
  } catch { /* no ghost */ }
  return { record, blobs, history, ghost }
}

/** Every key starts with its kind and the tab it belongs to. */
const KEY_TAB = /^(?:rec|hist|at|geo|blob|mesh):([^:]+)/

/** Tabs whose snapshot has not been written for a day, minus the ones still open. */
export function staleTabs(stamps: Record<string, number>, now: number, live: Set<string>, maxAge = STALE_MS): string[] {
  return Object.entries(stamps).filter(([tab, at]) => now - at > maxAge && !live.has(tab)).map(([tab]) => tab)
}

/** Drop the snapshots of tabs that went away a day ago or more, so the database does not grow for ever. Records without a time stamp (a write that never finished) go too. */
export async function pruneSessions(kv: Kv, now: number, live: Set<string>, maxAge = STALE_MS): Promise<string[]> {
  const all = await kv.keys()
  const tabs = new Set<string>()
  const ats = all.filter((k) => k.startsWith('at:'))
  for (const k of all) {
    const m = KEY_TAB.exec(k)
    if (m) tabs.add(m[1])
  }
  const stamps: Record<string, number> = {}
  const values = await kv.getMany<number>(ats)
  ats.forEach((k, i) => { stamps[k.slice(3)] = values[i] ?? 0 })
  for (const t of tabs) if (!(t in stamps)) stamps[t] = 0
  const dead = staleTabs(stamps, now, live, maxAge)
  if (!dead.length) return []
  const gone = new Set(dead)
  await kv.delMany(all.filter((k) => {
    const m = KEY_TAB.exec(k)
    return !!m && gone.has(m[1])
  }))
  return dead
}

// ---------------------------------------------------------------- startup

/** The e2e fixture switches the whole snapshot off (specs reload pages and expect a blank start); a spec that tests it sets `__e2eSession`. */
export function sessionOffForTests(): boolean {
  const w = window as unknown as Record<string, unknown>
  if (w.__e2eSession === true) return false
  return w.__e2eNoAutosave !== undefined || w.__e2eNoTour !== undefined || w.__e2eNoSession === true
}

/** Hold a lock named for the tab for as long as the page lives: a second page with the same id (a duplicated tab) can see that the id is taken. */
async function claimTab(id: string): Promise<boolean> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return true
  // a reload releases the old page's lock a moment after the new page starts: give it a few tries before calling the id taken
  for (let i = 0; i < 6; i++) {
    const got = await new Promise<boolean>((res) => {
      locks.request(`caddy-tab:${id}`, { ifAvailable: true }, (lock) => {
        if (!lock) { res(false); return undefined }
        res(true)
        return new Promise<void>(() => {}) // held until the page goes away
      }).catch(() => res(true))
    })
    if (got) return true
    await new Promise((r) => setTimeout(r, 40))
  }
  return false
}

async function liveTabs(): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const q = await navigator.locks?.query()
    for (const l of q?.held ?? []) if (l.name?.startsWith('caddy-tab:')) out.add(l.name.slice('caddy-tab:'.length))
  } catch { /* no locks API */ }
  return out
}

export interface StartResult {
  /** the tab's snapshot was put back (the recovery prompt is not for this tab) */
  restored: boolean
  /** the sketch / dialog are open again (they need the solver and the first regeneration) */
  editors: Promise<void>
}

let writer: SessionWriter | null = null
/** Write the snapshot now and wait for it. The update button does this before it reloads. */
export const flushSession = (): Promise<void> => writer?.flush() ?? Promise.resolve()
export const sessionTab = (): string | null => tabId

let tabId: string | null = null
let restoredThisLoad = false
/** This page load put the tab's session back. */
export const wasRestored = () => restoredThisLoad

/** Resolves when the first regeneration after a load is over. */
function nextIdle(): Promise<void> {
  return new Promise((res) => {
    if (!useDoc.getState().regenerating) return res()
    const off = useDoc.subscribe((s) => { if (!s.regenerating) { off(); res() } })
  })
}

/**
 * Call once, before the first render. Puts this tab's snapshot back if it has one and starts keeping it up to date. Never throws:
 * a snapshot that cannot be used just means a normal start.
 */
export async function startSession(kv: Kv = idbKv()): Promise<StartResult> {
  const none: StartResult = { restored: false, editors: Promise.resolve() }
  if (sessionOffForTests() || typeof indexedDB === 'undefined') return none
  try {
    let storage: Storage | null = null
    try { storage = window.sessionStorage } catch { /* blocked */ }
    let id = readTabId(storage)
    let mine = !!id
    if (id && !(await claimTab(id))) { id = null; mine = false } // a copy of another tab: it is a new tab
    if (!id) { id = newTabId(storage); await claimTab(id) }
    tabId = id
    let result = none
    if (mine) {
      const found = await Promise.race([readSession(kv, id), new Promise<null>((r) => setTimeout(() => r(null), 3000))]).catch(() => null)
      if (found) {
        try {
          applyRecord(found.record, found.blobs, found.history, found.ghost)
          const idle = nextIdle()
          // the sketch and the dialog open once the viewport has drawn its first frame: overlays that mount in the very first commit
          // of the page are torn down and rebuilt by React's strict mode in development. The ribbon already shows the sketch tab.
          const needs = !!(found.record.sketch || found.record.dialog)
          const open = needs ? closeGate() : () => {}
          result = {
            restored: true,
            editors: !needs
              ? Promise.resolve()
              : viewportReady
                .then(() => reopenEditors(found.record, idle))
                .catch((e) => {
                  console.warn('[session] could not reopen the editors', e)
                  useUi.setState({ sketchMode: false })
                })
                .finally(open),
          }
        } catch (e) {
          console.warn('[session] could not restore the snapshot', e)
          useDoc.getState().newDocument()
          result = none
        }
      }
    }
    restoredThisLoad = result.restored
    watch(kv, id)
    const own = id
    void whenIdle().then(async () => pruneSessions(kv, Date.now(), new Set([own, ...(await liveTabs())])).catch(() => {}))
    return result
  } catch (e) {
    console.warn('[session] disabled', e)
    return none
  }
}

const whenIdle = () => new Promise<void>((r) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => r(), { timeout: 5000 }) : setTimeout(r, 2000)))

/** Subscribe to everything the snapshot holds, and write when the page is going away. */
function watch(kv: Kv, id: string) {
  writer?.stop()
  const w = (writer = createWriter(kv, id))
  const t = () => w.touch()
  const doc = useDoc.subscribe((s, p) => {
    if (s.features !== p.features || s.rollback !== p.rollback || s.name !== p.name || s.dirty !== p.dirty || s.userParams !== p.userParams || s.bodyNames !== p.bodyNames || s.configs !== p.configs
      || s.activeConfig !== p.activeConfig || s.assembly !== p.assembly || s.blobs !== p.blobs || s.undoDepth !== p.undoDepth || s.redoDepth !== p.redoDepth || s.selectedFeatureId !== p.selectedFeatureId
      || s.activeOcc !== p.activeOcc || s.readOnly !== p.readOnly || s.geometry !== p.geometry) t()
  })
  const ui = useUi.subscribe((s, p) => {
    if (s.workspace !== p.workspace || s.displayMode !== p.displayMode || s.projection !== p.projection || s.selectionFilter !== p.selectionFilter || s.selection !== p.selection
      || s.hiddenIds !== p.hiddenIds || s.section !== p.section || s.sketchMode !== p.sketchMode) t()
  })
  const sk = useSketch.subscribe((s, p) => { if (s.active !== p.active || s.model !== p.model || s.plane !== p.plane || s.past !== p.past || s.future !== p.future) t() })
  const offs = [doc, ui, sk, watchPose(t), watchDialog(t), watchSections(t), useHistory.subscribe((s, p) => { if (s.versions !== p.versions) t() })]
  const now = () => void w.flush()
  const hide = () => { if (document.visibilityState === 'hidden') now() }
  window.addEventListener('pagehide', now)
  window.addEventListener('beforeunload', now)
  document.addEventListener('visibilitychange', hide)
  // a tab that stays open for days keeps its snapshot fresh, so another tab's cleanup never takes it
  const beat = setInterval(() => w.touch(), 60 * 60 * 1000)
  stopWatching = () => {
    offs.forEach((f) => f())
    window.removeEventListener('pagehide', now)
    window.removeEventListener('beforeunload', now)
    document.removeEventListener('visibilitychange', hide)
    clearInterval(beat)
    w.stop()
  }
}
let stopWatching: (() => void) | null = null
/** (unit tests) */
export const stopSession = () => { stopWatching?.(); stopWatching = null; writer = null }
