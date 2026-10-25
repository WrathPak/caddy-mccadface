/** An in-memory folder with the shape of the File System Access API, for the unit tests. */
import type { DirLike, FileLike, WritableLike } from './fsTypes'

interface FileData { bytes: Uint8Array; modified: number }

class MemFile implements FileLike {
  kind = 'file' as const
  constructor(private parent: MemDir, public name: string, private data: FileData) {}
  async getFile() {
    return new File([this.data.bytes as BlobPart], this.name, { lastModified: this.data.modified })
  }
  async createWritable(): Promise<WritableLike> {
    const chunks: Uint8Array[] = []
    const data = this.data
    return {
      async write(d) {
        chunks.push(d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : new Uint8Array(d instanceof ArrayBuffer ? d : (d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength)))
      },
      async close() {
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
        let o = 0
        for (const c of chunks) { out.set(c, o); o += c.length }
        data.bytes = out
        data.modified = Date.now()
      },
    }
  }
  /** `withMove: false` folders leave this off, like a browser without the move() method */
  move?: (nameOrDir: string | DirLike, name?: string) => Promise<void>
  _attach(withMove: boolean) {
    if (!withMove) return this
    this.move = async (a, b) => {
      const to = typeof a === 'string' ? this.parent : (a as MemDir)
      const name = typeof a === 'string' ? a : b!
      if (to.files.has(name)) throw new Error('exists')
      this.parent.files.delete(this.name)
      this.parent.handles.delete(this.name)
      this.parent = to
      this.name = name
      to.files.set(name, this.data)
      to.handles.set(name, this)
    }
    return this
  }
}

export class MemDir implements DirLike {
  kind = 'directory' as const
  files = new Map<string, FileData>()
  handles = new Map<string, MemFile>()
  dirs = new Map<string, MemDir>()
  constructor(public name: string, private withMove = true) {}
  async *entries(): AsyncIterable<[string, FileLike | DirLike]> {
    for (const [n] of this.files) yield [n, this.handles.get(n)!]
    for (const [n, d] of this.dirs) yield [n, d]
  }
  async getFileHandle(name: string, o?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!o?.create) throw new DOMException('not found', 'NotFoundError')
      this.files.set(name, { bytes: new Uint8Array(), modified: Date.now() })
      this.handles.set(name, new MemFile(this, name, this.files.get(name)!)._attach(this.withMove))
    }
    return this.handles.get(name)!
  }
  async getDirectoryHandle(name: string, o?: { create?: boolean }) {
    if (!this.dirs.has(name)) {
      if (!o?.create) throw new DOMException('not found', 'NotFoundError')
      this.dirs.set(name, new MemDir(name, this.withMove))
    }
    return this.dirs.get(name)!
  }
  async removeEntry(name: string) {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw new DOMException('not found', 'NotFoundError')
    this.handles.delete(name)
  }
  /** test helper */
  add(name: string, bytes: Uint8Array | string, modified = Date.now()) {
    const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
    const data = { bytes: b, modified }
    this.files.set(name, data)
    this.handles.set(name, new MemFile(this, name, data)._attach(this.withMove))
    return this
  }
  names() { return [...this.files.keys()].sort() }
}
