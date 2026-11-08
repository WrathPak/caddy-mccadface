/** Reads OrcaSlicer's presets from the profile set served next to the app and flattens them (the reference flow of PROFILES.md). */
import {
  flattenPreset, type Config, type ProfileIndex, type ProfileIndexVendor, type VendorBundle,
} from '@muon3d/slicer-engine-protocol'
import type { EnginePresets, PresetSelection } from './types'

const base = () => `${import.meta.env.BASE_URL}slicer/profiles/`

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as T
}

/** A bundle is gzip under a neutral type; a server that already decoded it sends plain JSON, so look at the first bytes. */
async function bundle(url: string): Promise<VendorBundle> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const text = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    return JSON.parse(text) as VendorBundle
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as VendorBundle
}

export interface ProfileSet {
  index: ProfileIndex
  /** bytes fetched for the index and every bundle read so far (compressed, as stored) */
  bytes: number
  vendor(id: string): Promise<VendorBundle>
}

let setPromise: Promise<ProfileSet> | null = null

/** The index (printers of every vendor) is read once; vendor bundles are read when first used. */
export function loadProfileSet(): Promise<ProfileSet> {
  setPromise ??= (async () => {
    const latest = await json<{ index: string }>(`${base()}latest.json`)
    const indexUrl = `${base()}${latest.index}`
    const res = await fetch(indexUrl)
    if (!res.ok) throw new Error(`${indexUrl}: HTTP ${res.status}`)
    const raw = await res.arrayBuffer()
    const index = JSON.parse(new TextDecoder().decode(raw)) as ProfileIndex
    const dir = indexUrl.slice(0, indexUrl.lastIndexOf('/') + 1)
    const cache = new Map<string, Promise<VendorBundle>>()
    const set: ProfileSet = {
      index,
      bytes: raw.byteLength,
      vendor(id) {
        let p = cache.get(id)
        if (!p) {
          const v: ProfileIndexVendor | undefined = index.vendors.find((x) => x.id === id)
          if (!v) return Promise.reject(new Error(`no vendor "${id}" in the profile set`))
          set.bytes += v.bundle.bytes
          p = bundle(dir + v.bundle.path)
          cache.set(id, p)
        }
        return p
      },
    }
    return set
  })()
  return setPromise
}

/**
 * Flatten the chosen presets. `colours` (one hex per slot) repeats a single filament choice for every slot of the plate and is
 * written as each filament's `filament_colour`: a filament preset has none, a project does, and with several filaments the
 * engine reads past the end of that list ("memory access out of bounds") when it is missing.
 */
export async function resolvePresets(sel: PresetSelection, colours: string[]): Promise<EnginePresets> {
  const set = await loadProfileSet()
  const [vendor, library] = await Promise.all([set.vendor(sel.vendor), set.vendor(set.index.library)])
  const sources = { vendor, library, defaults: set.index.defaults }
  const names = Array.from({ length: Math.max(colours.length, 1) }, (_, i) => sel.filaments[i] ?? sel.filaments[0])
  const filaments: Config[] = names.map((n, i) => ({ ...flattenPreset('filament', n, sources), filament_colour: [colours[i] ?? '#FFFFFF'] }))
  return { machine: flattenPreset('machine', sel.machine, sources), process: flattenPreset('process', sel.process, sources), filaments }
}

/** The presets the spike checks against the desktop slicers. */
export const SPIKE_PRESETS: Record<'a1' | 'mk4s' | 'mk4', PresetSelection> = {
  a1: { vendor: 'BBL', machine: 'Bambu Lab A1 0.4 nozzle', process: '0.20mm Standard @BBL A1', filaments: ['Bambu PLA Basic @BBL A1'] },
  mk4s: { vendor: 'Prusa', machine: 'Prusa MK4S 0.4 nozzle', process: '0.20mm SPEED @MK4S 0.4', filaments: ['Generic PLA @Prusa MK4S'] },
  mk4: { vendor: 'Prusa', machine: 'Prusa MK4 0.4 nozzle', process: '0.20mm Standard @MK4', filaments: ['Generic PLA @Prusa MK4'] },
}
