/**
 * Export G-code: a Bambu printer gets a `.gcode.3mf` (the 3MF the slicers write, with the G-code, its md5, the renders and the
 * plate's numbers inside); every other printer gets a plain `.gcode` with the thumbnail blocks its profile asks for.
 */
import { strToU8 } from 'fflate'
import { downloadFile } from '@/io/files'
import { toast } from '@/ui/Modal'
import { useSlice } from '../engine/sliceStore'
import { writeBambu3mf, type GcodeExtras, type SliceInfo } from '../threemf'
import { md5Hex } from './md5'
import { plateFileName } from './plates'
import { flatProjectConfig } from './projectConfig'
import { type SliceSnapshot } from './run'
import { insertThumbnails, pngBytes, renderPlate, scaleImage, thumbnailSection } from './thumbnail'

interface SaveWindow {
  showSaveFilePicker?: (o: unknown) => Promise<{ name: string; createWritable(): Promise<{ write(d: BufferSource): Promise<void>; close(): Promise<void> }> }>
}
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

/** "6m 15s" or "1h 2m 3s" as seconds. */
export function secondsOf(text: string | null): number {
  if (!text) return 0
  const g = (u: string) => +(new RegExp(`(\\d+)\\s*${u}`).exec(text)?.[1] ?? 0)
  return g('d') * 86400 + g('h') * 3600 + g('m') * 60 + g('s')
}

export interface Built { name: string; bytes: Uint8Array; mime: string }

/** Assemble the file for the current slice. */
export async function buildExport(snap: SliceSnapshot, gcodeBytes: Uint8Array): Promise<Built> {
  const { resolved, profile, plate, placed } = snap
  const bed = profile.bed
  const colours = resolved.filaments.map((f) => first(f.filament_colour) || '#FFFFFF')
  const text = new TextDecoder().decode(gcodeBytes)
  const stats = useSlice.getState().result?.stats
  if (profile.vendor === 'BBL') {
    const full = flatProjectConfig(resolved, profile)
    const lit = renderPlate(placed, bed, colours, 512, 'lit')
    const info: SliceInfo = {
      prediction: stats?.printTimeSeconds ?? 0,
      weight: stats?.filamentG ?? 0,
      nozzle: profile.nozzle,
      printerModelId: '',
      firstLayerTime: secondsOf(stats?.firstLayerTimeText ?? null),
      supportUsed: /^; FEATURE: Support/m.test(text) || /^;TYPE:Support/m.test(text),
      filaments: snap.usage.map((u) => ({
        id: u.slot, type: first(resolved.filaments[u.slot - 1]?.filament_type) || 'PLA', color: colours[u.slot - 1] ?? '#FFFFFF',
        usedM: u.mm / 1000, usedG: u.g, trayInfoIdx: first(resolved.filaments[u.slot - 1]?.filament_id),
      })),
      layerCount: stats?.layers ?? 0,
      layerHeight: parseFloat(first(resolved.process.layer_height)) || 0.2,
      bedType: plateFileName(resolved.plate?.current ?? 'Cool Plate'),
    }
    const extras: GcodeExtras = {
      gcode: gcodeBytes,
      md5: md5Hex(gcodeBytes),
      images: {
        plate: await pngBytes(lit),
        small: await pngBytes(scaleImage(lit, 128, 128)),
        noLight: await pngBytes(renderPlate(placed, bed, colours, 512, 'flat')),
        top: await pngBytes(renderPlate(placed, bed, colours, 512, 'top')),
        pick: await pngBytes(renderPlate(placed, bed, colours, 512, 'pick')),
      },
      info,
    }
    const bytes = writeBambu3mf(plate.plan.objects, plate.plan.placements, plate.settings, 'BambuStudio-2.3.2', extras, full)
    return { name: `${snap.name}.gcode.3mf`, bytes, mime: 'model/3mf' }
  }
  const spec = first(resolved.machine.thumbnails)
  const section = spec ? await thumbnailSection(spec, renderPlate(placed, bed, colours, 640, 'lit')) : ''
  return { name: `${snap.name}.gcode`, bytes: strToU8(insertThumbnails(text, section)), mime: 'text/x.gcode' }
}

/** Save through the File System Access API where there is one, else download. */
export async function exportGcode(): Promise<void> {
  const { result, snapshot } = useSlice.getState()
  if (!result || !snapshot) return void toast('Slice the plate first', 'error')
  let built: Built
  try {
    built = await buildExport(snapshot, result.gcode)
  } catch (e) {
    return void toast(`Could not build the file: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
  const w = window as unknown as SaveWindow
  if (!w.showSaveFilePicker) {
    downloadFile(built.name, built.bytes, built.mime)
    return void toast(`Exported ${built.name}`)
  }
  try {
    const bambu = built.name.endsWith('.3mf')
    const h = await w.showSaveFilePicker({
      suggestedName: built.name,
      types: [bambu ? { description: 'Bambu G-code 3MF', accept: { 'model/3mf': ['.3mf'] } } : { description: 'G-code', accept: { 'text/plain': ['.gcode'] } }],
    })
    const wr = await h.createWritable()
    await wr.write(built.bytes as BufferSource)
    await wr.close()
    toast(`Saved ${h.name}`)
  } catch (e) {
    if (!isAbort(e)) toast(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}
