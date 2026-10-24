/** Hand the plate to a slicer: save the 3MF (File System Access API, or a download) and say how to open it there. */
import { downloadFile } from '@/io/files'
import { toast } from '@/ui/Modal'
import { buildPlate } from './plate'

export type Slicer = 'bambu' | 'orca'

export const SLICERS: Record<Slicer, { label: string }> = {
  bambu: { label: 'Bambu Studio' },
  orca: { label: 'OrcaSlicer' },
}

interface SaveWindow {
  showSaveFilePicker?: (o: unknown) => Promise<{ name: string; createWritable(): Promise<{ write(d: BufferSource): Promise<void>; close(): Promise<void> }> }>
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** Save the plate as a 3MF. Falls back to a download with a hint where saving to a chosen place is unsupported. */
export async function sendToSlicer(slicer: Slicer): Promise<void> {
  const { label } = SLICERS[slicer]
  let plate
  try { plate = await buildPlate() } catch (e) { return void toast(e instanceof Error ? e.message : String(e), 'error') }
  const summary = `${plate.count} ${plate.count === 1 ? 'body' : 'bodies'}${plate.colors > 1 ? `, ${plate.colors} filaments` : ''}`
  const w = window as unknown as SaveWindow
  if (!w.showSaveFilePicker) {
    downloadFile(plate.fileName, plate.bytes, 'model/3mf')
    return void toast(`Downloaded ${plate.fileName} (${summary}). This browser cannot save to a place you choose: open the file in ${label} with File > Open, or drag it in.`)
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
  toast(`Saved ${name} (${summary}). Open it in ${label} with File > Open, or drag it onto the window.`)
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
