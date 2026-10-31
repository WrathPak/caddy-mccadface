/**
 * The autosave folder: an `Autosave` folder inside the projects folder, holding the newest autosaved copy of each document and a few
 * older ones. Written against the small interfaces in projects/fsTypes.ts so it runs on a real folder and on the in-memory one in tests.
 *
 *   Autosave/Box.caddy       newest copy
 *   Autosave/Box~1.caddy     the one before
 *   Autosave/Box~2.caddy     the one before that ... up to `keep` files in all
 *
 * A file is only ever replaced through createWritable(), which writes to a swap file and swaps it in on close, so a crash or a failed
 * write leaves the old file whole. A write that fails also does not leave an empty new file behind.
 */
import { cleanName, EXT, isProjectName } from '@/projects/library'
import { isDir, type DirLike, type FileLike } from '@/projects/fsTypes'

export const AUTOSAVE_DIR = 'Autosave'

export const slotName = (base: string, k: number) => (k === 0 ? `${base}${EXT}` : `${base}~${k}${EXT}`)
/** `Box~2.caddy` -> { base: 'Box', k: 2 }; `Box.caddy` -> { base: 'Box', k: 0 } */
export function parseSlot(file: string): { base: string; k: number } | null {
  if (!isProjectName(file)) return null
  const stem = file.slice(0, -EXT.length)
  const m = /^(.*)~(\d+)$/.exec(stem)
  return m ? { base: m[1], k: Number(m[2]) } : { base: stem, k: 0 }
}

/** The file name an autosave of this document goes under. */
export const autosaveBase = (docName: string) => cleanName(docName) || 'Untitled'

async function readBytes(f: FileLike): Promise<Uint8Array> {
  return new Uint8Array(await (await f.getFile()).arrayBuffer())
}

/** Write a whole file. The old content stays until the new one is complete; a failure leaves nothing new behind. */
async function writeWhole(dir: DirLike, name: string, bytes: Uint8Array): Promise<void> {
  let existed = true
  try { await dir.getFileHandle(name) } catch { existed = false }
  try {
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    try {
      await w.write(bytes as BufferSource)
      await w.close()
    } catch (e) {
      try { await w.abort?.() } catch { /* already closed */ }
      throw e
    }
  } catch (e) {
    if (!existed) { try { await dir.removeEntry(name) } catch { /* nothing to clean */ } }
    throw e
  }
}

export interface WriteOptions {
  /** Resolves true for a file that is the person's own saved project, so an autosave never replaces it. */
  isProtected?: (f: FileLike) => Promise<boolean>
}

/** Existing files of one document: slot number -> file. */
async function slotsOf(dir: DirLike, base: string): Promise<Map<number, FileLike>> {
  const out = new Map<number, FileLike>()
  for await (const [name, e] of dir.entries()) {
    if (isDir(e)) continue
    const s = parseSlot(name)
    if (s && s.base === base) out.set(s.k, e)
  }
  return out
}

/**
 * Put a new autosaved copy of `docName` into `<root>/Autosave`, push the older ones down a slot and drop what falls past `keep`.
 * Returns the file name of the newest copy.
 */
export async function writeAutosave(root: DirLike, docName: string, bytes: Uint8Array, keep: number, o: WriteOptions = {}): Promise<string> {
  const versions = Math.max(1, Math.floor(keep) || 1)
  const dir = await root.getDirectoryHandle(AUTOSAVE_DIR, { create: true })
  let base = autosaveBase(docName)
  let slots = await slotsOf(dir, base)
  // the person saved their own project into this folder under the same name: keep clear of it
  for (let tries = 0; tries < 5 && o.isProtected; tries++) {
    let clash = false
    for (const f of slots.values()) if (await o.isProtected(f).catch(() => false)) clash = true
    if (!clash) break
    base = `${base} (autosave)`
    slots = await slotsOf(dir, base)
  }
  let rotateError: unknown = null
  // oldest first: slot k-1 moves to slot k, so nothing is overwritten before it has been copied
  for (let k = versions - 1; k >= 1; k--) {
    const from = slots.get(k - 1)
    if (!from) continue
    try { await writeWhole(dir, slotName(base, k), await readBytes(from)) } catch (e) { rotateError ??= e }
  }
  const name = slotName(base, 0)
  await writeWhole(dir, name, bytes)
  // past the limit: gone (a lowered "versions to keep" also trims older copies)
  for (const [k] of slots) if (k >= versions) { try { await dir.removeEntry(slotName(base, k)) } catch { /* already gone */ } }
  if (rotateError) throw rotateError
  return name
}

/** Chrome leaves `<name>.crswap` behind when a tab dies mid-write. They are only ever in this folder because we wrote here. */
export async function sweepSwapFiles(root: DirLike): Promise<number> {
  let dir: DirLike
  try { dir = await root.getDirectoryHandle(AUTOSAVE_DIR) } catch { return 0 }
  const stale: string[] = []
  for await (const [name, e] of dir.entries()) if (!isDir(e) && /\.crswap$/i.test(name)) stale.push(name)
  let n = 0
  for (const name of stale) { try { await dir.removeEntry(name); n++ } catch { /* in use by another tab */ } }
  return n
}

export interface FolderCopy { name: string; file: string; bytes: Uint8Array; savedAt: number }

/** The newest autosaved copy of any document (older versions are for browsing, not for recovery). */
export async function newestCopy(root: DirLike): Promise<FolderCopy | null> {
  let dir: DirLike
  try { dir = await root.getDirectoryHandle(AUTOSAVE_DIR) } catch { return null }
  let best: { file: string; f: FileLike; at: number } | null = null
  for await (const [file, e] of dir.entries()) {
    if (isDir(e)) continue
    const s = parseSlot(file)
    if (!s || s.k !== 0) continue
    try {
      const at = (await e.getFile()).lastModified
      if (!best || at > best.at) best = { file, f: e, at }
    } catch { /* unreadable */ }
  }
  if (!best) return null
  return { name: parseSlot(best.file)!.base, file: best.file, bytes: await readBytes(best.f), savedAt: best.at }
}
