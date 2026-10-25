/**
 * Version history inside a `.caddy` file. Every save appends a version: a snapshot of document.json plus references to the
 * blobs (import sources) it used. Both are stored once per content hash, so saving twice without a change, or a model that
 * keeps the same 150 MB import through 40 versions, costs almost nothing. Pure data in / data out (no store, no DOM), so it
 * is unit tested on its own.
 *
 * Layout inside the zip, next to document.json / blobs / thumbnail.png:
 *   history/index.json         the version list
 *   history/docs/<sha>.json    snapshot of document.json
 *   history/blobs/<sha>        blob content that no current blob (blobs/<id>) already holds
 */
import { strFromU8, strToU8 } from 'fflate'

export interface VersionMeta {
  /** 1, 2, 3 ... never reused, even after older versions are pruned */
  n: number
  /** epoch milliseconds */
  t: number
  note: string
  /** how many features the document had */
  features: number
  /** hash of the document.json snapshot */
  doc: string
  /** blob id -> content hash for every blob the version used */
  blobs: Record<string, string>
}

export interface HistoryData {
  versions: VersionMeta[]
  /** snapshot text by hash */
  docs: Map<string, string>
  /** blob bytes by hash (every blob any kept version uses) */
  blobs: Map<string, Uint8Array>
}

export interface HistorySettings {
  /** keep at most this many versions (the newest ones) */
  maxVersions: number
  /** keep the stored history under this many megabytes (oldest versions go first) */
  maxMB: number
}

export const DEFAULT_SETTINGS: HistorySettings = { maxVersions: 50, maxMB: 64 }
export const INDEX_FILE = 'history/index.json'
const INDEX_FORMAT = 1

export const emptyHistory = (): HistoryData => ({ versions: [], docs: new Map(), blobs: new Map() })

const hexOf = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const cache = new WeakMap<Uint8Array, string>()

/** SHA-1 of bytes or text, as hex. Cached per byte array, so a big blob is only hashed once. */
export async function hashOf(data: Uint8Array | string): Promise<string> {
  if (typeof data !== 'string') {
    const hit = cache.get(data)
    if (hit) return hit
  }
  const bytes = typeof data === 'string' ? strToU8(data) : data
  const h = hexOf(await crypto.subtle.digest('SHA-1', bytes as BufferSource))
  if (typeof data !== 'string') cache.set(data, h)
  return h
}

/**
 * Read the history out of the (unzipped) `history/` files of a `.caddy`; `current` is the project's own blobs by id. Missing or
 * damaged history reads as empty.
 */
export function readHistory(files: Record<string, Uint8Array>, current: Record<string, Uint8Array> = {}): HistoryData {
  const h = emptyHistory()
  const raw = files[INDEX_FILE]
  if (!raw) return h
  try {
    const j = JSON.parse(strFromU8(raw)) as { format?: number; versions?: VersionMeta[] }
    for (const v of j.versions ?? []) {
      const doc = files[`history/docs/${v.doc}.json`]
      if (!doc) continue // a snapshot that is gone cannot be restored: leave the version out
      const blobs: [string, Uint8Array][] = []
      let ok = true
      for (const [id, sha] of Object.entries(v.blobs ?? {})) {
        // a blob still in the project is stored once, as blobs/<id>; ids are unique, so that is the same content
        const bytes = files[`history/blobs/${sha}`] ?? current[id]
        if (!bytes) { ok = false; break }
        blobs.push([sha, bytes])
      }
      if (!ok) continue
      h.docs.set(v.doc, strFromU8(doc))
      for (const [sha, bytes] of blobs) h.blobs.set(sha, bytes)
      h.versions.push({ n: v.n, t: v.t, note: v.note ?? '', features: v.features ?? 0, doc: v.doc, blobs: v.blobs ?? {} })
    }
    h.versions.sort((a, b) => a.n - b.n)
  } catch {
    return emptyHistory()
  }
  return h
}

/** Append a version for the document as it is now. */
export async function appendVersion(
  h: HistoryData,
  input: { docJson: string; featureCount: number; blobs: Record<string, Uint8Array>; note?: string; now?: number },
): Promise<VersionMeta> {
  const doc = await hashOf(input.docJson)
  h.docs.set(doc, input.docJson)
  const blobs: Record<string, string> = {}
  for (const [id, bytes] of Object.entries(input.blobs)) {
    const sha = await hashOf(bytes)
    blobs[id] = sha
    if (!h.blobs.has(sha)) h.blobs.set(sha, bytes)
  }
  const v: VersionMeta = { n: (h.versions[h.versions.length - 1]?.n ?? 0) + 1, t: input.now ?? Date.now(), note: (input.note ?? '').trim(), features: input.featureCount, doc, blobs }
  h.versions.push(v)
  return v
}

/** Bytes the stored history takes (unique snapshots plus unique blobs). */
export function historySize(h: HistoryData): number {
  let n = 0
  for (const d of h.docs.values()) n += d.length
  for (const b of h.blobs.values()) n += b.length
  return n
}

/** Size of what is only in the history: blobs held by `current` cost nothing extra. */
function extraSize(h: HistoryData, current: Set<string>): number {
  let n = 0
  for (const d of h.docs.values()) n += d.length
  for (const [sha, b] of h.blobs) if (!current.has(sha)) n += b.length
  return n
}

function collect(h: HistoryData) {
  const docs = new Set<string>(), blobs = new Set<string>()
  for (const v of h.versions) {
    docs.add(v.doc)
    for (const sha of Object.values(v.blobs)) blobs.add(sha)
  }
  for (const k of [...h.docs.keys()]) if (!docs.has(k)) h.docs.delete(k)
  for (const k of [...h.blobs.keys()]) if (!blobs.has(k)) h.blobs.delete(k)
}

/**
 * Drop the oldest versions until the history fits the settings. The newest version always stays. Content nothing refers to
 * any more is forgotten. `current` is the hash set of the blobs the project itself holds (they do not count towards the cap).
 */
export function pruneHistory(h: HistoryData, s: HistorySettings, current: Set<string> = new Set()): number {
  let dropped = 0
  const limit = Math.max(1, Math.floor(s.maxVersions))
  while (h.versions.length > limit) { h.versions.shift(); dropped++ }
  collect(h)
  const cap = Math.max(0, s.maxMB) * 1024 * 1024
  while (h.versions.length > 1 && extraSize(h, current) > cap) {
    h.versions.shift()
    dropped++
    collect(h)
  }
  return dropped
}

/** The zip entries for the history. Blobs the project already stores as blobs/<id> are not written a second time. */
export function historyFiles(h: HistoryData, current: Set<string>): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  if (!h.versions.length) return files
  files[INDEX_FILE] = strToU8(JSON.stringify({ format: INDEX_FORMAT, versions: h.versions }))
  for (const [sha, text] of h.docs) files[`history/docs/${sha}.json`] = strToU8(text)
  for (const [sha, bytes] of h.blobs) if (!current.has(sha)) files[`history/blobs/${sha}`] = bytes
  return files
}

/** A version's document text and the blobs it used (by id). */
export function snapshotOf(h: HistoryData, n: number): { meta: VersionMeta; doc: string; blobs: Record<string, Uint8Array> } | null {
  const meta = h.versions.find((v) => v.n === n)
  const doc = meta && h.docs.get(meta.doc)
  if (!meta || doc === undefined) return null
  const blobs: Record<string, Uint8Array> = {}
  for (const [id, sha] of Object.entries(meta.blobs)) {
    const b = h.blobs.get(sha)
    if (!b) return null
    blobs[id] = b
  }
  return { meta, doc, blobs }
}
