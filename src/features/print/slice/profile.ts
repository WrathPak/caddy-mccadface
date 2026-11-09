/**
 * The slicing profile a document carries: which printer, process and filament presets, the user's sparse overrides on top of
 * them, the per-object overrides, and a few cached values (bed size, nozzle) that code needing them synchronously reads.
 * Everything here is plain data and pure functions; presets are read from the profile set in profiles.ts.
 */
import type { Config, ConfigPatch } from '@muon3d/slicer-engine-protocol'

export type PanelMode = 'simple' | 'advanced' | 'expert'

/** A user preset as it is held in the document: a snapshot, so the file opens on a machine that never saw the preset. */
export interface UserRef { id: string; name: string; keys: ConfigPatch }

export interface SliceProfile {
  v: 1
  /** vendor folder of the printer ("BBL", "Prusa", ...) */
  vendor: string
  /** machine preset: the printer with its nozzle, e.g. "Bambu Lab A1 0.4 nozzle" */
  machine: string
  /** process preset; empty = the printer's default */
  process: string
  /** filament preset per slot; empty = the printer's default */
  filaments: string[]
  user: { machine?: UserRef; process?: UserRef; filaments: (UserRef | null)[] }
  overrides: { machine: ConfigPatch; process: ConfigPatch; filaments: ConfigPatch[] }
  /** build plate (Orca's curr_bed_type, "Textured PEI Plate"); empty = the printer's default */
  bedType: string
  /** per-object overrides by plate object id */
  objects: Record<string, ConfigPatch>
  /** cached from the machine preset for code that needs it without loading presets */
  bed: [number, number]
  height: number
  nozzle: number
}

export const DEFAULT_MACHINE = 'Bambu Lab A1 0.4 nozzle'

export const emptyProfile = (): SliceProfile => ({
  v: 1, vendor: 'BBL', machine: DEFAULT_MACHINE, process: '', filaments: [''], user: { filaments: [] },
  overrides: { machine: {}, process: {}, filaments: [{}] }, bedType: '', objects: {}, bed: [256, 256], height: 256, nozzle: 0.4,
})

/** The printers older documents named by a short id, with their beds. */
export const LEGACY_PRINTERS: Record<string, { model: string; bed: [number, number]; height: number }> = {
  a1: { model: 'Bambu Lab A1', bed: [256, 256], height: 256 },
  a1mini: { model: 'Bambu Lab A1 mini', bed: [180, 180], height: 180 },
  p1s: { model: 'Bambu Lab P1S', bed: [256, 256], height: 256 },
  p1p: { model: 'Bambu Lab P1P', bed: [256, 256], height: 256 },
  x1c: { model: 'Bambu Lab X1 Carbon', bed: [256, 256], height: 256 },
  h2d: { model: 'Bambu Lab H2D', bed: [350, 320], height: 325 },
}

/** An old printer id and nozzle as a machine preset name; null when the id is not an old one. */
export function legacyMachine(id: string, nozzle: string | number = '0.4'): string | null {
  const p = LEGACY_PRINTERS[id]
  return p ? `${p.model} ${String(nozzle)} nozzle` : null
}

/** The long-form machine name drops the " nozzle" suffix for display ("Bambu Lab A1 0.4"). */
export const printerLabel = (machine: string) => machine.replace(/ nozzle$/, '')

const isPatch = (v: unknown): v is ConfigPatch => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'string')
const patchOf = (v: unknown): ConfigPatch => (isPatch(v) ? v : {})

/** The profile stored in a Print settings feature, or null when it holds none (a new or an old document). */
export function parseProfile(raw: unknown): SliceProfile | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const j = JSON.parse(raw) as Partial<SliceProfile>
    if (j.v !== 1 || typeof j.machine !== 'string') return null
    const base = emptyProfile()
    const filaments = Array.isArray(j.filaments) && j.filaments.length ? j.filaments.map(String) : base.filaments
    const ov = (j.overrides ?? {}) as Partial<SliceProfile['overrides']>
    return {
      ...base,
      vendor: typeof j.vendor === 'string' ? j.vendor : base.vendor,
      machine: j.machine,
      process: typeof j.process === 'string' ? j.process : '',
      filaments,
      user: {
        machine: j.user?.machine, process: j.user?.process,
        filaments: Array.isArray(j.user?.filaments) ? j.user.filaments : [],
      },
      overrides: {
        machine: patchOf(ov.machine), process: patchOf(ov.process),
        filaments: filaments.map((_, i) => patchOf(Array.isArray(ov.filaments) ? ov.filaments[i] : undefined)),
      },
      bedType: typeof j.bedType === 'string' ? j.bedType : '',
      objects: Object.fromEntries(Object.entries(j.objects ?? {}).map(([k, v]) => [k, patchOf(v)])),
      bed: Array.isArray(j.bed) && j.bed.length === 2 ? [Number(j.bed[0]) || 256, Number(j.bed[1]) || 256] : base.bed,
      height: Number(j.height) || base.height,
      nozzle: Number(j.nozzle) || base.nozzle,
    }
  } catch {
    return null
  }
}

export const serializeProfile = (p: SliceProfile) => JSON.stringify(p)

/** The fields of the old Print settings dialog, which now are quick settings written to Orca's own keys. */
export interface LegacyFields {
  printer?: string
  nozzle?: string
  layerHeight?: number
  firstLayerHeight?: number
  wallLoops?: number
  topLayers?: number
  bottomLayers?: number
  infill?: number
  infillPattern?: string
  support?: string
  overhang?: number
  brim?: string
}

/** Orca keys for the quick settings; the old brim and support choices map onto Orca's values. */
export function quickPatch(f: LegacyFields): ConfigPatch {
  const out: ConfigPatch = {}
  if (f.layerHeight !== undefined) out.layer_height = String(f.layerHeight)
  if (f.firstLayerHeight !== undefined) out.initial_layer_print_height = String(f.firstLayerHeight)
  if (f.wallLoops !== undefined) out.wall_loops = String(f.wallLoops)
  if (f.topLayers !== undefined) out.top_shell_layers = String(f.topLayers)
  if (f.bottomLayers !== undefined) out.bottom_shell_layers = String(f.bottomLayers)
  if (f.infill !== undefined) out.sparse_infill_density = `${f.infill}%`
  if (f.infillPattern !== undefined) out.sparse_infill_pattern = f.infillPattern
  if (f.overhang !== undefined) out.support_threshold_angle = String(Math.round(90 - f.overhang))
  if (f.support !== undefined) {
    out.enable_support = f.support === 'none' ? '0' : '1'
    if (f.support !== 'none') out.support_type = f.support === 'tree' ? 'tree(auto)' : 'normal(auto)'
  }
  if (f.brim !== undefined) out.brim_type = f.brim === 'none' ? 'no_brim' : f.brim === 'outer' ? 'outer_only' : 'auto_brim'
  return out
}

/** A document from before presets existed: its printer and quick values become the machine and the process overrides. */
export function legacyProfile(f: LegacyFields): SliceProfile {
  const p = emptyProfile()
  const known = f.printer ? LEGACY_PRINTERS[f.printer] : undefined
  if (known) {
    p.machine = legacyMachine(f.printer!, f.nozzle ?? '0.4')!
    p.bed = known.bed
    p.height = known.height
  }
  p.nozzle = parseFloat(f.nozzle ?? '') || 0.4
  p.overrides.process = quickPatch(f)
  return p
}

// ---- patches as configs

/**
 * Apply override text to a flattened config. A vector option's text is its slots separated by commas (one value stands for every
 * slot, as the settings service says); a scalar option takes the text as it is.
 */
export function applyPatch(config: Config, patch: ConfigPatch): Config {
  const out: Config = { ...config }
  for (const [k, text] of Object.entries(patch)) {
    const base = config[k]
    if (Array.isArray(base)) {
      const parts = base.length === 1 ? [text] : text.split(',')
      out[k] = parts.length === 1 && base.length > 1 ? base.map(() => parts[0]) : parts
    } else out[k] = text
  }
  return out
}

/** Keys of `a` whose value differs from `b`'s, as override text (used when saving a user preset against its parent). */
export function textOf(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(',') : v ?? ''
}

/** Writes from the settings service (null removes the override) applied to a patch. */
export function applyWrites(patch: ConfigPatch, writes: Record<string, string | null>): ConfigPatch {
  const out = { ...patch }
  for (const [k, v] of Object.entries(writes)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

/** Number of overrides on a profile, for the "modified" badge. */
export const overrideCount = (p: SliceProfile) =>
  Object.keys(p.overrides.machine).length + Object.keys(p.overrides.process).length + p.overrides.filaments.reduce((n, f) => n + Object.keys(f).length, 0)

/** Keep every per-slot list the length of the slot count. */
export function withSlots(p: SliceProfile, n: number): SliceProfile {
  const count = Math.max(1, n)
  if (p.filaments.length === count && p.overrides.filaments.length === count) return p
  const fill = <T,>(list: T[], make: (i: number) => T) => Array.from({ length: count }, (_, i) => list[i] ?? make(i))
  return {
    ...p,
    filaments: fill(p.filaments, () => p.filaments[0] ?? ''),
    user: { ...p.user, filaments: fill(p.user.filaments, () => null) },
    overrides: { ...p.overrides, filaments: fill(p.overrides.filaments, () => ({})) },
  }
}
