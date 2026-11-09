/** Reads OrcaSlicer's presets from the profile set served next to the app and flattens them (the reference flow of PROFILES.md). */
import {
  flattenPreset, type Config, type PresetScope, type ProfileIndex, type ProfileIndexVendor, type VendorBundle,
} from '@muon3d/slicer-engine-protocol'
import { compatiblePresets, type PresetListing } from '../slice/compat'
import { applyPatch, type SliceProfile, type UserRef } from '../slice/profile'
import type { EnginePresets } from './types'

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
  vendor(id: string): Promise<VendorBundle>
}

let setPromise: Promise<ProfileSet> | null = null

/** The index (printers of every vendor) is read once; vendor bundles are read when first used. */
export function loadProfileSet(): Promise<ProfileSet> {
  setPromise ??= (async () => {
    const latest = await json<{ index: string }>(`${base()}latest.json`)
    const indexUrl = `${base()}${latest.index}`
    const index = await json<ProfileIndex>(indexUrl)
    const dir = indexUrl.slice(0, indexUrl.lastIndexOf('/') + 1)
    const cache = new Map<string, Promise<VendorBundle>>()
    const set: ProfileSet = {
      index,
      vendor(id) {
        let p = cache.get(id)
        if (!p) {
          const v: ProfileIndexVendor | undefined = index.vendors.find((x) => x.id === id)
          if (!v) return Promise.reject(new Error(`no vendor "${id}" in the profile set`))
          p = bundle(dir + v.bundle.path)
          cache.set(id, p)
        }
        return p
      },
    }
    return set
  })().catch((e) => { setPromise = null; throw e })
  return setPromise
}

export type VendorGroup = 'Bambu Lab' | 'Prusa' | 'Other vendors'
export interface CatalogModel { vendor: string; model: string; nozzles: { nozzle: string; machine: string }[]; cover?: string }
export interface CatalogVendor { id: string; name: string; group: VendorGroup; models: CatalogModel[] }

/** Every vendor's printers grouped for the picker: Bambu Lab, Prusa, then all other vendors by name. */
export function buildCatalog(index: ProfileIndex): CatalogVendor[] {
  const out: CatalogVendor[] = []
  for (const v of index.vendors) {
    if (v.id === index.library || !v.printers.length) continue
    const byModel = new Map<string, CatalogModel>()
    for (const p of v.printers) {
      const m = byModel.get(p.model) ?? { vendor: v.id, model: p.model, nozzles: [], cover: v.models.find((x) => x.name === p.model)?.cover }
      m.nozzles.push({ nozzle: p.variant || p.nozzle[0] || '', machine: p.name })
      byModel.set(p.model, m)
    }
    const models = [...byModel.values()]
    for (const m of models) m.nozzles.sort((a, b) => parseFloat(a.nozzle) - parseFloat(b.nozzle))
    out.push({ id: v.id, name: v.name, group: v.id === 'BBL' ? 'Bambu Lab' : v.id === 'Prusa' ? 'Prusa' : 'Other vendors', models })
  }
  const rank = { 'Bambu Lab': 0, Prusa: 1, 'Other vendors': 2 }
  return out.sort((a, b) => rank[a.group] - rank[b.group] || a.name.localeCompare(b.name))
}

/** The vendor a machine preset belongs to, found by name in the index. */
export function vendorOfMachine(index: ProfileIndex, machine: string): string | null {
  return index.vendors.find((v) => v.printers.some((p) => p.name === machine))?.id ?? null
}

interface Sources { vendor: VendorBundle; library: VendorBundle; defaults: ProfileIndex['defaults'] }

async function sources(vendorId: string): Promise<Sources> {
  const set = await loadProfileSet()
  const [vendor, library] = await Promise.all([set.vendor(vendorId), set.vendor(set.index.library)])
  return { vendor, library, defaults: set.index.defaults }
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

export interface Resolved extends EnginePresets {
  /** the process and filament preset names in effect (the printer's defaults filled in) */
  processName: string
  filamentNames: string[]
  /** the unmodified presets (user preset applied, no overrides): what "modified" is measured against */
  base: { machine: Config; process: Config; filaments: Config[] }
}

const withUser = (c: Config, u?: UserRef | null): Config => (u ? applyPatch(c, u.keys) : c)

const exists = (type: PresetScope, name: string, src: Sources) => {
  try { flattenPreset(type, name, src); return true } catch { return false }
}

/**
 * The printer's default process or filament. Some of Orca's vendor profiles name a default that isn't in the set (a typo,
 * an empty name, or several names joined with ';'), so like Orca's own picker this takes the first named one that exists,
 * else the first compatible preset.
 */
function defaultPreset(type: 'process' | 'filament', declared: string, src: Sources, machine: Config, machineName: string, process?: string): string {
  for (const n of declared.split(';').map((s) => s.trim())) if (n && exists(type, n, src)) return n
  const compatible = compatiblePresets([src.vendor, src.library], type, machine, machineName, process)[0]?.name
  if (compatible) return compatible
  throw new Error(`${machineName} has no ${type} preset in Orca's profiles. Pick another printer, or a user preset.`)
}

/** Flatten the presets a profile names, apply user presets and overrides, and set each filament's colour. */
export async function resolveProfile(p: SliceProfile, colours: string[]): Promise<Resolved> {
  const src = await sources(p.vendor)
  const baseMachine = withUser(flattenPreset('machine', p.machine, src), p.user.machine)
  const processName = p.process || defaultPreset('process', first(baseMachine.default_print_profile), src, baseMachine, p.machine)
  const baseProcess = withUser(flattenPreset('process', processName, src), p.user.process)
  const needsDefault = p.filaments.some((n) => !n)
  const defaultFilament = needsDefault ? defaultPreset('filament', first(baseMachine.default_filament_profile), src, baseMachine, p.machine, processName) : ''
  const filamentNames = p.filaments.map((n) => n || defaultFilament)
  const baseFilaments = filamentNames.map((n, i) => withUser(flattenPreset('filament', n, src), p.user.filaments[i]))
  const machine = applyPatch(baseMachine, p.overrides.machine)
  const process = applyPatch(baseProcess, p.overrides.process)
  const filaments = baseFilaments.map((f, i) => ({ ...applyPatch(f, p.overrides.filaments[i] ?? {}), filament_colour: [colours[i] ?? '#FFFFFF'] }))
  return { machine, process, filaments, processName, filamentNames, base: { machine: baseMachine, process: baseProcess, filaments: baseFilaments } }
}

/** One flattened preset (for the settings service). */
export async function flattenOne(vendor: string, type: PresetScope, name: string): Promise<Config> {
  return flattenPreset(type, name, await sources(vendor))
}

/** Process presets Orca offers with the printer. */
export async function listProcesses(vendor: string, machineName: string): Promise<PresetListing[]> {
  const src = await sources(vendor)
  return compatiblePresets([src.vendor, src.library], 'process', flattenPreset('machine', machineName, src), machineName)
}

/** Filament presets Orca offers with the printer (and the chosen process). */
export async function listFilaments(vendor: string, machineName: string, process?: string): Promise<PresetListing[]> {
  const src = await sources(vendor)
  return compatiblePresets([src.vendor, src.library], 'filament', flattenPreset('machine', machineName, src), machineName, process)
}

/** The bed, height and nozzle of a machine preset, for the plate layout. */
export async function machineGeometry(vendor: string, machineName: string): Promise<{ bed: [number, number]; height: number; nozzle: number; modelId: string }> {
  const src = await sources(vendor)
  const m = flattenPreset('machine', machineName, src)
  const pts = (Array.isArray(m.printable_area) ? m.printable_area : String(m.printable_area ?? '').split(',')).map((s) => s.split('x').map(Number))
  const w = Math.max(...pts.map((q) => q[0] || 0)) - Math.min(...pts.map((q) => q[0] || 0))
  const d = Math.max(...pts.map((q) => q[1] || 0)) - Math.min(...pts.map((q) => q[1] || 0))
  const model = src.vendor.models[String(m.printer_model)]
  return { bed: [w || 256, d || 256], height: parseFloat(first(m.printable_height)) || 256, nozzle: parseFloat(first(m.nozzle_diameter)) || 0.4, modelId: model?.model_id ?? '' }
}

/** The printable area of a machine preset as a polygon (bed coordinates, mm) and its build height. */
export async function machineBed(vendor: string, machineName: string): Promise<{ poly: [number, number][]; height: number }> {
  const src = await sources(vendor)
  const m = flattenPreset('machine', machineName, src)
  const raw = (Array.isArray(m.printable_area) ? m.printable_area : String(m.printable_area ?? '').split(',')).map((s) => s.trim().split('x').map(Number))
  const poly = raw.filter((q) => q.length === 2 && isFinite(q[0]) && isFinite(q[1])).map((q) => [q[0], q[1]] as [number, number])
  return { poly, height: parseFloat(first(m.printable_height)) || 256 }
}

/** The default process and filament of a printer. */
export async function printerDefaults(vendor: string, machineName: string): Promise<{ process: string; filament: string }> {
  const src = await sources(vendor)
  const m = flattenPreset('machine', machineName, src)
  return { process: first(m.default_print_profile), filament: first(m.default_filament_profile) }
}
