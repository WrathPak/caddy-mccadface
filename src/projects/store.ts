/** State of the Projects panel: the picked folder (kept across sessions), its listing, search, recent files and the actions. */
import { del, get, set } from 'idb-keyval'
import { create } from 'zustand'
import { openProjectFile } from '@/io/actions'
import type { FileHandleLike } from '@/io/files'
import { toast } from '@/ui/Modal'
import type { DirLike } from './fsTypes'
import {
  baseOf, createFolder, createProject, duplicateProject, flatten, listTrash, renameProject, restoreFromTrash, scanLibrary, trashProject,
  type DirNode, type FileNode, type TrashItem,
} from './library'

const ROOT_KEY = 'caddy-projects-root'
const RECENT_KEY = 'caddy-projects-recent'
const MAX_RECENT = 8

export type Access = 'none' | 'granted' | 'prompt' | 'denied'
export interface Recent { path: string[]; name: string; at: number }

interface PickerWindow { showDirectoryPicker?: (o?: unknown) => Promise<DirLike> }
const win = (typeof window === 'undefined' ? {} : window) as unknown as PickerWindow
export const canPickFolder = () => typeof win.showDirectoryPicker === 'function'

/** Stable identity of a project inside the folder. */
export const keyOf = (n: { path: string[]; name: string }) => [...n.path, n.name].join('/')

const loadRecent = (): Recent[] => {
  try { return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Recent[]).filter((r) => Array.isArray(r.path) && r.name) } catch { return [] }
}

interface ProjectsState {
  root: DirLike | null
  access: Access
  tree: DirNode | null
  files: FileNode[]
  trash: TrashItem[]
  loading: boolean
  error: string | null
  query: string
  recent: Recent[]
  selected: string | null
  renaming: string | null
  /** folders the user collapsed, by path */
  collapsed: Record<string, true>

  init: () => Promise<void>
  chooseFolder: () => Promise<void>
  reconnect: () => Promise<void>
  forget: () => Promise<void>
  refresh: () => Promise<void>
  setQuery: (q: string) => void
  select: (k: string | null) => void
  startRename: (k: string | null) => void
  toggleFolder: (k: string) => void
  open: (n: FileNode) => Promise<void>
  newProject: (dir?: DirNode) => Promise<void>
  newFolder: (name: string, parent?: DirNode) => Promise<void>
  rename: (n: FileNode, name: string) => Promise<void>
  duplicate: (n: FileNode) => Promise<void>
  trashFile: (n: FileNode) => Promise<void>
  restore: (name: string) => Promise<void>
}

const fail = (what: string, e: unknown) => {
  console.error(e)
  toast(`${what}: ${e instanceof Error ? e.message : String(e)}`, 'error')
}

export const useProjects = create<ProjectsState>((set_, get_) => {
  const bump = (s: Partial<ProjectsState>) => set_(s)
  const run = async (what: string, fn: () => Promise<void>) => {
    try { await fn(); await get_().refresh() } catch (e) { fail(what, e) }
  }
  return {
    root: null,
    access: 'none',
    tree: null,
    files: [],
    trash: [],
    loading: false,
    error: null,
    query: '',
    recent: loadRecent(),
    selected: null,
    renaming: null,
    collapsed: {},

    async init() {
      if (get_().root) return
      try {
        const h = await get<DirLike>(ROOT_KEY)
        if (!h) return
        const perm = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
        bump({ root: h, access: perm })
        if (perm === 'granted') await get_().refresh()
      } catch (e) {
        console.warn('[projects] could not restore the project folder', e)
      }
    },

    async chooseFolder() {
      if (!win.showDirectoryPicker) return toast('This browser cannot pick a folder. Chrome and Edge can.', 'error')
      try {
        const h = await win.showDirectoryPicker({ id: 'caddy-projects', mode: 'readwrite' })
        await set(ROOT_KEY, h)
        bump({ root: h, access: 'granted', selected: null, query: '' })
        await get_().refresh()
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
        fail('Could not open the folder', e)
      }
    },

    async reconnect() {
      const h = get_().root
      if (!h) return
      try {
        const perm = (await h.requestPermission?.({ mode: 'readwrite' })) ?? 'granted'
        bump({ access: perm })
        if (perm === 'granted') await get_().refresh()
      } catch (e) {
        fail('Could not reconnect the folder', e)
      }
    },

    async forget() {
      await del(ROOT_KEY).catch(() => {})
      bump({ root: null, access: 'none', tree: null, files: [], trash: [], selected: null, error: null })
    },

    async refresh() {
      const root = get_().root
      if (!root) return
      bump({ loading: true, error: null })
      try {
        const [tree, trash] = await Promise.all([scanLibrary(root), listTrash(root)])
        bump({ tree, files: flatten(tree), trash, loading: false })
      } catch (e) {
        bump({ loading: false, error: e instanceof Error ? e.message : String(e) })
      }
    },

    setQuery: (query) => bump({ query }),
    select: (selected) => bump({ selected }),
    startRename: (renaming) => bump({ renaming }),
    toggleFolder: (k) => set_((s) => {
      const collapsed = { ...s.collapsed }
      if (collapsed[k]) delete collapsed[k]; else collapsed[k] = true
      return { collapsed }
    }),

    async open(n) {
      try {
        const file = await n.handle.getFile()
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (await openProjectFile(bytes, n.name, n.handle as FileHandleLike)) {
          const recent = [{ path: n.path, name: n.name, at: Date.now() }, ...get_().recent.filter((r) => keyOf(r) !== keyOf(n))].slice(0, MAX_RECENT)
          bump({ recent, selected: keyOf(n) })
          try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)) } catch { /* the list just lasts for this session */ }
        }
      } catch (e) {
        fail(`Could not open ${n.name}`, e)
      }
    },

    newProject: (dir) => run('Could not make the project', async () => {
      const root = get_().root
      const h = await createProject((dir ?? get_().tree)?.handle ?? root!)
      bump({ selected: [...(dir?.path ?? []), h.name].join('/'), renaming: [...(dir?.path ?? []), h.name].join('/') })
    }),
    newFolder: (name, parent) => run('Could not make the folder', async () => { await createFolder((parent ?? get_().tree)!.handle, name) }),
    rename: (n, name) => run('Could not rename', async () => {
      const f = await renameProject(n.dir, n.handle, name)
      bump({ selected: [...n.path, f.name].join('/'), renaming: null })
      // keep the recent list pointing at the new name
      const recent = get_().recent.map((r) => (keyOf(r) === keyOf(n) ? { ...r, name: f.name } : r))
      bump({ recent })
    }),
    duplicate: (n) => run('Could not duplicate', async () => { const f = await duplicateProject(n.dir, n.handle); bump({ selected: [...n.path, f.name].join('/') }) }),
    trashFile: (n) => run('Could not move to the trash', async () => {
      await trashProject(get_().root!, n.dir, n.handle)
      bump({ selected: null, recent: get_().recent.filter((r) => keyOf(r) !== keyOf(n)) })
      toast(`${baseOf(n.name)} is in the trash`)
    }),
    restore: (name) => run('Could not restore', async () => { await restoreFromTrash(get_().root!, name) }),
  }
})
