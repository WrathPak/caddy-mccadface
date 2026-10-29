/** Browser file plumbing: File System Access API with download / <input> fallbacks. */

interface WritableLike { write(d: Blob | BufferSource): Promise<void>; close(): Promise<void> }
export interface FileHandleLike { name: string; getFile(): Promise<File>; createWritable(): Promise<WritableLike> }
interface PickerWindow {
  showOpenFilePicker?: (o: unknown) => Promise<FileHandleLike[]>
  showSaveFilePicker?: (o: unknown) => Promise<FileHandleLike>
}
// (the unit tests import this module in Node, where there is no window)
const w = (typeof window === 'undefined' ? {} : window) as unknown as PickerWindow

const PROJECT_TYPES = [{ description: 'CADdy McCADFace project', accept: { 'application/zip': ['.caddy'] } }]
export const MODEL_EXTS = ['.stl', '.3mf', '.step', '.stp']

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent)
/** iPhone, iPad (which says it is a Mac) and iPod: their file picker greys out file types it does not know, so it gets no filter. */
export const isIos = () => /iPad|iPhone|iPod/.test(ua()) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isMobileOs = () => isIos() || /Android/i.test(ua())
const coarsePointer = () => { try { return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches } catch { return false } }

/**
 * On a phone or tablet the share sheet is the way to put a file somewhere useful (Save to Files, Drive, AirDrop), and a plain
 * download often lands in a folder you never find. Used where the browser can share files; refused or unavailable, the download runs.
 */
function shareFile(file: File): boolean {
  try {
    if (!coarsePointer() || !isMobileOs() || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) return false
  } catch { return false }
  navigator.share({ files: [file], title: file.name }).catch((e: unknown) => {
    if (e instanceof DOMException && e.name === 'AbortError') return // the person closed the sheet
    anchorDownload(file) // not allowed after a long wait (the browser wants a fresh tap), or the type is refused
  })
  return true
}

function anchorDownload(file: File) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function downloadFile(name: string, bytes: Uint8Array | ArrayBuffer, mime = 'application/octet-stream') {
  const file = new File([bytes as BlobPart], name, { type: mime })
  if (shareFile(file)) return
  anchorDownload(file)
}


/** Ask for files via a hidden <input>. Resolves [] on cancel. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (!isIos()) input.accept = accept
    input.multiple = multiple
    // (in the page, hidden: some mobile browsers drop a picker opened from an input that was never attached)
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0'
    const done = (files: File[]) => { input.remove(); resolve(files) }
    input.onchange = () => done([...(input.files ?? [])])
    input.oncancel = () => done([])
    document.body.appendChild(input)
    input.click()
  })
}

/** Open a project: returns the bytes and (when supported) a handle for in-place saving. */
export async function pickProject(): Promise<{ bytes: Uint8Array; name: string; handle: FileHandleLike | null; /** lastModified of the file */ stamp: number } | null> {
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({ types: PROJECT_TYPES, multiple: false })
      const f = await h.getFile()
      return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, handle: h, stamp: f.lastModified }
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  const [f] = await pickFiles('.caddy')
  if (f && !/\.caddy$/i.test(f.name)) throw new Error(`${f.name} is not a CADdy project (.caddy)`)
  return f ? { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, handle: null, stamp: f.lastModified } : null
}

/** Write to `handle`, or ask where to save. Returns the handle used (null for download fallback), undefined on cancel. */
export async function writeProject(bytes: Uint8Array, suggested: string, handle: FileHandleLike | null): Promise<FileHandleLike | null | undefined> {
  // a handle only exists where the File System Access API works (the Projects panel gives one too), so it is always usable
  if (handle || w.showSaveFilePicker) {
    try {
      const h = handle ?? (await w.showSaveFilePicker!({ suggestedName: suggested + '.caddy', types: PROJECT_TYPES }))
      const wr = await h.createWritable()
      await wr.write(bytes as BufferSource)
      await wr.close()
      return h
    } catch (e) {
      if (isAbort(e)) return undefined
      throw e
    }
  }
  downloadFile(suggested + '.caddy', bytes, 'application/zip')
  return null
}
