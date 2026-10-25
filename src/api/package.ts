/**
 * Turning what the user picked (a .js file, or a folder with an optional plugin.json) into a plugin package. Pure: no app
 * imports, so the unit tests read the example plugins through it.
 */
import { PERMISSIONS } from './runtime/surface.js'

const MAX_FILES = 200
const MAX_BYTES = 3 * 1024 * 1024
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/

export const slug = (s: string) => s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plugin'

/** What a plugin asks for to be installed. */
export interface Package { id: string; name: string; version: string; description: string; origin: string; entry: string; files: Record<string, string>; permissions: string[] }

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Read plugin.json (when there is one) and check it. */
export function parseManifest(text: string): { id?: string; name?: string; version?: string; description?: string; main?: string; permissions: string[] } {
  let j: unknown
  try { j = JSON.parse(text) } catch (e) { throw new Error(`plugin.json is not valid JSON: ${(e as Error).message}`) }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('plugin.json must be an object')
  const o = j as Record<string, unknown>
  const id = clean(o.id, 41)
  if (id && !ID_RE.test(id)) throw new Error('plugin.json: "id" may only use lower case letters, digits, - and _')
  const perms = Array.isArray(o.permissions) ? o.permissions : []
  for (const p of perms) if (!PERMISSIONS.includes(p as string)) throw new Error(`plugin.json: unknown permission ${JSON.stringify(p)} (known: ${PERMISSIONS.join(', ')})`)
  return { id: id || undefined, name: clean(o.name, 60) || undefined, version: clean(o.version, 20) || undefined, description: clean(o.description, 300) || undefined, main: clean(o.main, 120) || undefined, permissions: perms as string[] }
}

/** A single .js file is a whole plugin. */
export async function packageFromFile(file: File): Promise<Package> {
  if (!/\.(m?js)$/i.test(file.name)) throw new Error('A plugin is a .js file (or a folder with a plugin.json)')
  if (file.size > MAX_BYTES) throw new Error('That file is too big for a plugin (3 MB at most)')
  const base = slug(file.name)
  return { id: base, name: file.name.replace(/\.[^.]+$/, ''), version: '', description: '', origin: file.name, entry: file.name, files: { [file.name]: await file.text() }, permissions: [] }
}

/** A folder: plugin.json (optional, `main` names the entry, default index.js) and its .js files. `files` maps relative path to File. */
export async function packageFromFolder(name: string, files: Map<string, File>): Promise<Package> {
  const texts: Record<string, string> = {}
  let total = 0
  let manifestText: string | null = null
  for (const [path, f] of files) {
    const p = path.replace(/^\/+/, '')
    if (p.split('/').some((s) => s.startsWith('.') || s === 'node_modules')) continue
    if (p === 'plugin.json') { manifestText = await f.text(); continue }
    if (!/\.(m?js)$/i.test(p)) continue
    total += f.size
    if (Object.keys(texts).length >= MAX_FILES || total > MAX_BYTES) throw new Error('That folder is too big for a plugin (200 files, 3 MB at most)')
    texts[p] = await f.text()
  }
  const m = manifestText ? parseManifest(manifestText) : { permissions: [] as string[] }
  const entry = ('main' in m && m.main) || 'index.js'
  if (!Object.prototype.hasOwnProperty.call(texts, entry)) throw new Error(`The folder has no ${entry}${manifestText ? ' (the "main" of plugin.json)' : '. Add an index.js or a plugin.json that names the entry file'}`)
  const id = ('id' in m && m.id) || slug(name)
  return { id, name: ('name' in m && m.name) || name, version: ('version' in m && m.version) || '', description: ('description' in m && m.description) || '', origin: name + '/', entry, files: texts, permissions: m.permissions }
}

/** Files of a picked folder, from a directory handle (File System Access) or from a webkitdirectory input. */
export async function filesFromHandle(dir: FileSystemDirectoryHandle): Promise<Map<string, File>> {
  const out = new Map<string, File>()
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (name.startsWith('.') || name === 'node_modules') continue
      if (h.kind === 'directory') { if (depth < 6) await walk(h as FileSystemDirectoryHandle, prefix + name + '/', depth + 1) }
      else out.set(prefix + name, await (h as FileSystemFileHandle).getFile())
    }
  }
  await walk(dir, '', 0)
  return out
}

export function filesFromInput(list: File[]): { name: string; files: Map<string, File> } {
  const out = new Map<string, File>()
  let root = ''
  for (const f of list) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    const parts = rel.split('/')
    root = parts.length > 1 ? parts[0] : root
    out.set(parts.length > 1 ? parts.slice(1).join('/') : rel, f)
  }
  return { name: root || 'plugin', files: out }
}

