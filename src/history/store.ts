/**
 * The version history of the open project. The heavy parts (snapshot text, blob bytes) live in a plain module variable; the
 * zustand store only carries what the History panel shows.
 */
import { create } from 'zustand'
import { DEFAULT_SETTINGS, emptyHistory, historySize, type HistoryData, type HistorySettings, type VersionMeta } from './pack'

const SETTINGS_KEY = 'caddy-history-settings'

function loadSettings(): HistorySettings {
  try {
    const j = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<HistorySettings> | null
    if (j) {
      const v = Number(j.maxVersions), m = Number(j.maxMB)
      return { maxVersions: v >= 1 ? Math.floor(v) : DEFAULT_SETTINGS.maxVersions, maxMB: m >= 0 ? m : DEFAULT_SETTINGS.maxMB }
    }
  } catch { /* storage unavailable or damaged */ }
  return { ...DEFAULT_SETTINGS }
}

interface HistoryUi {
  versions: VersionMeta[]
  /** bytes the history adds to the file */
  bytes: number
  settings: HistorySettings
  /** the version on show in a read-only preview */
  previewing: number | null
  /** text for the next version, set by Restore */
  pendingNote: string | null
  setSettings: (s: Partial<HistorySettings>) => void
}

export const useHistory = create<HistoryUi>((set, get) => ({
  versions: [],
  bytes: 0,
  settings: loadSettings(),
  previewing: null,
  pendingNote: null,
  setSettings: (p) => {
    const next = { ...get().settings, ...p }
    next.maxVersions = Math.max(1, Math.floor(Number(next.maxVersions) || DEFAULT_SETTINGS.maxVersions))
    next.maxMB = Math.max(0, Number(next.maxMB) || 0)
    set({ settings: next })
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch { /* the setting just lasts for this session */ }
  },
}))

let data: HistoryData = emptyHistory()
export const historyData = () => data

/** Make `d` the open project's history. */
export function setHistory(d: HistoryData) {
  data = d
  useHistory.setState({ versions: [...d.versions], bytes: historySize(d) })
}

/** A new or just opened project starts with the history it came with (none for a new one). */
export const resetHistory = () => {
  setHistory(emptyHistory())
  useHistory.setState({ pendingNote: null, previewing: null })
}

/** Copy to append to without touching the live history until the save has worked. */
export const cloneHistory = (d: HistoryData = data): HistoryData => ({ versions: [...d.versions], docs: new Map(d.docs), blobs: new Map(d.blobs) })
