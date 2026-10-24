/** Hand the plate to a slicer: save the 3MF (File System Access API, or a download), then open the slicer through its URL scheme. */
import { downloadFile } from '@/io/files'
import { toast } from '@/ui/Modal'
import { buildPlate } from './plate'

export type Slicer = 'bambu' | 'orca'

export const SLICERS: Record<Slicer, { label: string; scheme: string }> = {
  bambu: { label: 'Bambu Studio', scheme: 'bambustudio' },
  orca: { label: 'OrcaSlicer', scheme: 'orcaslicer' },
}

const FOLDER_KEY = 'caddy-slicer-folder'

interface SaveWindow {
  showSaveFilePicker?: (o: unknown) => Promise<{ name: string; createWritable(): Promise<{ write(d: BufferSource): Promise<void>; close(): Promise<void> }> }>
}

/** The URL scheme link that asks the slicer to open a file. */
export function protocolUrl(slicer: Slicer, folder: string, fileName: string): string {
  const dir = folder.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const file = /^[A-Za-z]:/.test(dir) ? `file:///${dir}/${fileName}` : `file://${dir}/${fileName}`
  return `${SLICERS[slicer].scheme}://open?file=${encodeURIComponent(file)}`
}

/** Replaceable so tests can see what would have been launched. */
export const launcher = { open: (url: string) => { window.location.href = url } }

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

function rememberedFolder(): string {
  try { return localStorage.getItem(FOLDER_KEY) ?? '' } catch { return '' }
}

/** Save the plate as a 3MF and open it in the slicer. Falls back to a download with a hint where saving to a chosen place is unsupported. */
export async function sendToSlicer(slicer: Slicer): Promise<void> {
  const { label } = SLICERS[slicer]
  let plate
  try { plate = await buildPlate() } catch (e) { return void toast(e instanceof Error ? e.message : String(e), 'error') }
  const summary = `${plate.count} ${plate.count === 1 ? 'body' : 'bodies'}${plate.colors > 1 ? `, ${plate.colors} filaments` : ''}`
  const w = window as unknown as SaveWindow
  if (!w.showSaveFilePicker) {
    downloadFile(plate.fileName, plate.bytes, 'model/3mf')
    return void toast(`Downloaded ${plate.fileName} (${summary}). This browser cannot open ${label} directly: open the file in ${label} with File > Open, or drag it in.`)
  }
  let name = plate.fileName
  try {
    const h = await w.showSaveFilePicker({ suggestedName: plate.fileName, types: [{ description: '3MF model', accept: { 'model/3mf': ['.3mf'] } }] })
    const wr = await h.createWritable()
    await wr.write(plate.bytes as BufferSource)
    await wr.close()
    name = h.name
  } catch (e) {
    if (isAbort(e)) return
    return void toast(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
  // a browser never learns where the file went, so the slicer link needs the folder once
  let folder = rememberedFolder()
  if (!folder) {
    folder = window.prompt(`Saved ${name}. To open it in ${label} straight away, type the folder you saved it in (leave empty to open it yourself).`) ?? ''
    try { if (folder.trim()) localStorage.setItem(FOLDER_KEY, folder.trim()) } catch { /* storage unavailable */ }
  }
  if (!folder.trim()) return void toast(`Saved ${name} (${summary}). Open it in ${label} with File > Open.`)
  launcher.open(protocolUrl(slicer, folder, name))
  toast(`Saved ${name} (${summary}) and asked ${label} to open it. If nothing opens, use File > Open in ${label}.`)
}

/** Save the plate as a 3MF without opening anything. */
export async function exportPlate3mf(): Promise<void> {
  try {
    const plate = await buildPlate()
    downloadFile(plate.fileName, plate.bytes, 'model/3mf')
    toast(`Exported ${plate.fileName} (${plate.count} ${plate.count === 1 ? 'body' : 'bodies'}${plate.fits ? '' : ', larger than the plate'})`)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error')
  }
}
