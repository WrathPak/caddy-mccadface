/**
 * The slice of the File System Access API the project browser uses. Declared here (instead of relying on the DOM lib) so the
 * folder logic can be tested against an in-memory folder in Node, and so optional methods (move, permissions) are explicit.
 */
export interface WritableLike {
  write(data: Blob | BufferSource): Promise<void>
  close(): Promise<void>
  /** drops what was written so far and leaves the file as it was (a real FileSystemWritableFileStream has it) */
  abort?(): Promise<void>
}

export interface FileLike {
  kind: 'file'
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<WritableLike>
  /** Chrome / Edge: rename or move within the same file system */
  move?(nameOrDir: string | DirLike, name?: string): Promise<void>
}

export interface DirLike {
  kind: 'directory'
  name: string
  entries(): AsyncIterable<[string, FileLike | DirLike]>
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileLike>
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirLike>
  removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
}

export const isDir = (e: FileLike | DirLike): e is DirLike => e.kind === 'directory'
