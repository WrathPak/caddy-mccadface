/** Browser file plumbing: File System Access API with download / <input> fallbacks. */

interface WritableLike { write(d: Blob | BufferSource): Promise<void>; close(): Promise<void> }
export interface FileHandleLike { name: string; getFile(): Promise<File>; createWritable(): Promise<WritableLike> }
interface PickerWindow {
  showOpenFilePicker?: (o: unknown) => Promise<FileHandleLike[]>
  showSaveFilePicker?: (o: unknown) => Promise<FileHandleLike>
}
const w = window as unknown as PickerWindow

const PROJECT_TYPES = [{ description: 'WeebCAD project', accept: { 'application/zip': ['.weebcad'] } }]
export const MODEL_EXTS = ['.stl', '.3mf', '.step', '.stp']

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

export function downloadFile(name: string, bytes: Uint8Array | ArrayBuffer, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** Ask for files via a hidden <input>. Resolves [] on cancel. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve([...(input.files ?? [])])
    input.oncancel = () => resolve([])
    input.click()
  })
}

/** Open a project: returns the bytes and (when supported) a handle for in-place saving. */
export async function pickProject(): Promise<{ bytes: Uint8Array; name: string; handle: FileHandleLike | null } | null> {
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({ types: PROJECT_TYPES, multiple: false })
      const f = await h.getFile()
      return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, handle: h }
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  const [f] = await pickFiles('.weebcad')
  return f ? { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, handle: null } : null
}

/** Write to `handle`, or ask where to save. Returns the handle used (null for download fallback), undefined on cancel. */
export async function writeProject(bytes: Uint8Array, suggested: string, handle: FileHandleLike | null): Promise<FileHandleLike | null | undefined> {
  if (w.showSaveFilePicker) {
    try {
      const h = handle ?? (await w.showSaveFilePicker({ suggestedName: suggested + '.weebcad', types: PROJECT_TYPES }))
      const wr = await h.createWritable()
      await wr.write(bytes as BufferSource)
      await wr.close()
      return h
    } catch (e) {
      if (isAbort(e)) return undefined
      throw e
    }
  }
  downloadFile(suggested + '.weebcad', bytes, 'application/zip')
  return null
}
