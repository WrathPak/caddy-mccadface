/**
 * The project folder: list the `.caddy` files in a folder tree, make, rename, duplicate and trash them. Written against the
 * small interfaces in fsTypes.ts, so it runs on a real folder (File System Access) and on an in-memory one in the tests.
 *
 * Nothing here deletes a project for good. "Delete" moves the file into a `.caddy-trash` folder at the top of the project
 * folder; a file only leaves its old place once the copy in the new place is checked to be complete.
 */
import { strToU8, zipSync } from 'fflate'
import { isDir, type DirLike, type FileLike } from './fsTypes'

export const TRASH = '.caddy-trash'
export const EXT = '.caddy'

export interface FileNode { kind: 'file'; name: string; /** folder names from the top folder down to the one holding the file */ path: string[]; handle: FileLike; dir: DirLike; size: number; modified: number }
export interface DirNode { kind: 'dir'; name: string; path: string[]; handle: DirLike; children: (DirNode | FileNode)[] }

export const isProjectName = (n: string) => n.toLowerCase().endsWith(EXT)
export const baseOf = (n: string) => n.replace(/\.caddy$/i, '')

/** A name that is safe in every file system: no separators or reserved characters, no leading dot, not empty. */
export function cleanName(raw: string): string {
  const n = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '')
  return n.slice(0, 120)
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Walk the folder. Hidden folders (the trash included) are skipped; folders without any project in them are kept, so a new
 * empty folder shows up. Stops at `maxFiles` projects or `maxDepth` levels so a huge disk folder cannot hang the panel.
 */
export async function scanLibrary(root: DirLike, o: { maxDepth?: number; maxFiles?: number } = {}): Promise<DirNode> {
  const maxDepth = o.maxDepth ?? 8
  let budget = o.maxFiles ?? 5000
  async function walk(dir: DirLike, path: string[], depth: number): Promise<DirNode> {
    const node: DirNode = { kind: 'dir', name: dir.name, path, handle: dir, children: [] }
    for await (const [name, entry] of dir.entries()) {
      if (isDir(entry)) {
        if (name.startsWith('.') || depth >= maxDepth) continue
        node.children.push(await walk(entry, [...path, name], depth + 1))
      } else if (isProjectName(name) && budget > 0) {
        budget--
        let size = 0, modified = 0
        try { const f = await entry.getFile(); size = f.size; modified = f.lastModified } catch { /* unreadable: still listed */ }
        node.children.push({ kind: 'file', name, path, handle: entry, dir, size, modified })
      }
    }
    node.children.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1))
    return node
  }
  return walk(root, [], 0)
}

export function flatten(tree: DirNode): FileNode[] {
  const out: FileNode[] = []
  const walk = (d: DirNode) => { for (const c of d.children) (c.kind === 'dir' ? walk(c) : out.push(c)) }
  walk(tree)
  return out
}

/** Projects whose name or folder contains every word of the query, newest first. */
export function filterNodes(files: FileNode[], query: string): FileNode[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return files
  return files
    .filter((f) => {
      const hay = (f.path.join('/') + '/' + baseOf(f.name)).toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .sort((a, b) => b.modified - a.modified)
}

async function exists(dir: DirLike, name: string): Promise<boolean> {
  try { await dir.getFileHandle(name); return true } catch { /* not a file */ }
  try { await dir.getDirectoryHandle(name); return true } catch { return false }
}

/** `base.caddy`, or `base 2.caddy`, `base 3.caddy` ... whichever is free. */
export async function uniqueName(dir: DirLike, base: string, ext = EXT): Promise<string> {
  const b = cleanName(base) || 'Untitled'
  if (!(await exists(dir, b + ext))) return b + ext
  for (let i = 2; i < 10000; i++) if (!(await exists(dir, `${b} ${i}${ext}`))) return `${b} ${i}${ext}`
  throw new Error('Could not find a free name')
}

async function put(dir: DirLike, name: string, data: Uint8Array | ArrayBuffer): Promise<FileLike> {
  const h = await dir.getFileHandle(name, { create: true })
  const w = await h.createWritable()
  await w.write(data as BufferSource)
  await w.close()
  const size = (await h.getFile()).size
  const want = data instanceof Uint8Array ? data.byteLength : data.byteLength
  if (size !== want) throw new Error(`Writing ${name} did not finish (${size} of ${want} bytes)`)
  return h
}

/** The bytes of an empty project (what File > New saves): a document with nothing in it. */
export function emptyProjectBytes(name: string): Uint8Array {
  const doc = { format: 1, app: 'CADdy McCADFace', name, features: [], rollback: 0, userParams: [], bodyNames: {}, configs: [], activeConfig: null }
  return zipSync({ 'document.json': strToU8(JSON.stringify(doc)) })
}

export async function createProject(dir: DirLike, base = 'Untitled'): Promise<FileLike> {
  const name = await uniqueName(dir, base)
  return put(dir, name, emptyProjectBytes(baseOf(name)))
}

export async function createFolder(dir: DirLike, base: string): Promise<DirLike> {
  const n = cleanName(base)
  if (!n || base.trim().startsWith('.')) throw new Error('Give the folder a name (a name starting with a dot is hidden)')
  if (await exists(dir, n)) throw new Error(`"${n}" is already there`)
  return dir.getDirectoryHandle(n, { create: true })
}

const bytesOf = async (f: FileLike) => (await f.getFile()).arrayBuffer()

export async function duplicateProject(dir: DirLike, file: FileLike): Promise<FileLike> {
  const name = await uniqueName(dir, baseOf(file.name) + ' copy')
  return put(dir, name, await bytesOf(file))
}

/**
 * Move `file` from `from` to `to` under `name`. The browser's own move is used when it has one; otherwise the file is copied,
 * the copy is checked, and only then is the original removed.
 */
export async function moveFile(from: DirLike, file: FileLike, to: DirLike, name: string): Promise<FileLike> {
  if (file.move) {
    try {
      if (from === to) await file.move(name)
      else await file.move(to, name)
      return file
    } catch {
      /* not supported for this file system: copy instead */
    }
  }
  const copy = await put(to, name, await bytesOf(file))
  if (!(from === to && file.name === name)) await from.removeEntry(file.name)
  return copy
}

/** Rename a project (the new name is made safe and unique). */
export async function renameProject(dir: DirLike, file: FileLike, newBase: string): Promise<FileLike> {
  const base = cleanName(newBase)
  if (!base) throw new Error('Give the project a name')
  if (base + EXT === file.name) return file
  if (await exists(dir, base + EXT)) throw new Error(`"${base}" is already there`)
  return moveFile(dir, file, dir, base + EXT)
}

async function trashDir(root: DirLike, create: boolean): Promise<DirLike | null> {
  try { return await root.getDirectoryHandle(TRASH, { create }) } catch { return null }
}

/** Move a project into `.caddy-trash`. Returns the name it has there. */
export async function trashProject(root: DirLike, dir: DirLike, file: FileLike): Promise<string> {
  const trash = (await trashDir(root, true))!
  const name = await uniqueName(trash, baseOf(file.name))
  await moveFile(dir, file, trash, name)
  return name
}

export interface TrashItem { name: string; handle: FileLike; size: number; modified: number }

export async function listTrash(root: DirLike): Promise<TrashItem[]> {
  const trash = await trashDir(root, false)
  if (!trash) return []
  const out: TrashItem[] = []
  for await (const [name, e] of trash.entries()) {
    if (isDir(e) || !isProjectName(name)) continue
    const f = await e.getFile()
    out.push({ name, handle: e, size: f.size, modified: f.lastModified })
  }
  return out.sort((a, b) => b.modified - a.modified)
}

/** Put a trashed project back at the top of the project folder. */
export async function restoreFromTrash(root: DirLike, name: string): Promise<FileLike> {
  const trash = await trashDir(root, false)
  if (!trash) throw new Error('The trash is empty')
  const handle = await trash.getFileHandle(name)
  const target = await uniqueName(root, baseOf(name))
  return moveFile(trash, handle, root, target)
}
