/**
 * Build plate (bed type) logic: which plates a printer model offers, which one is the default, and whether a filament can print on a
 * plate. Pure functions over Orca's data: a vendor model's `default_bed_type` and `not_support_bed_type`, and a filament's per-plate
 * bed temperatures (0 means the filament does not support that plate).
 */
import type { Config } from '@muon3d/slicer-engine-protocol'

export interface PlateDef {
  /** exactly what the engine accepts for `curr_bed_type` */
  id: string
  /** the name Bambu Studio shows */
  label: string
  /** the filament key holding this plate's bed temperature */
  tempKey: string
  /** the name the .gcode.3mf plate metadata uses */
  file: string
  /** other names Orca's profiles use for it */
  aliases: string[]
}

export const PLATES: PlateDef[] = [
  { id: 'Cool Plate', label: 'Cool Plate', tempKey: 'cool_plate_temp', file: 'cool_plate', aliases: ['smooth cool plate'] },
  { id: 'Supertack Plate', label: 'Cool Plate (SuperTack)', tempKey: 'supertack_plate_temp', file: 'supertack_plate', aliases: ['cool plate (supertack)', 'cool plate supertack', 'supertack'] },
  { id: 'Engineering Plate', label: 'Engineering Plate', tempKey: 'eng_plate_temp', file: 'eng_plate', aliases: [] },
  { id: 'High Temp Plate', label: 'Smooth PEI Plate / High Temp Plate', tempKey: 'hot_plate_temp', file: 'hot_plate', aliases: ['smooth pei plate / high temp plate', 'smooth pei plate', 'smooth high temp plate'] },
  { id: 'Textured PEI Plate', label: 'Textured PEI Plate', tempKey: 'textured_plate_temp', file: 'textured_plate', aliases: [] },
  { id: 'Textured Cool Plate', label: 'Textured Cool Plate', tempKey: 'textured_cool_plate_temp', file: 'textured_cool_plate', aliases: [] },
]

export const plateDef = (id: string): PlateDef | undefined => PLATES.find((p) => p.id === id)
export const plateLabel = (id: string) => plateDef(id)?.label ?? id

/** An Orca plate name (any spelling the profiles use) as the engine's id; null when unknown. */
export function plateId(name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return PLATES.find((p) => p.id.toLowerCase() === n || p.label.toLowerCase() === n || p.aliases.includes(n))?.id ?? null
}

/** The fields of a vendor model entry this reads. */
export interface ModelPlateData { default_bed_type?: unknown; not_support_bed_type?: unknown }

export interface ModelPlates {
  /** the plates the printer supports, in display order */
  supported: string[]
  default: string
}

/**
 * The plates a printer model offers. A model that names neither a default nor unsupported plates has no plate data (a Prusa
 * printer has one bed): null, and no plate is chosen or sent.
 */
export function modelPlates(model: ModelPlateData | undefined | null): ModelPlates | null {
  const def = typeof model?.default_bed_type === 'string' ? model.default_bed_type : ''
  const not = typeof model?.not_support_bed_type === 'string' ? model.not_support_bed_type : ''
  if (!def && !not) return null
  const banned = new Set(not.split(';').map(plateId).filter((x): x is string => !!x))
  const supported = PLATES.map((p) => p.id).filter((id) => !banned.has(id))
  const d = plateId(def)
  return { supported, default: d && supported.includes(d) ? d : supported.includes('Textured PEI Plate') ? 'Textured PEI Plate' : supported[0] ?? 'Cool Plate' }
}

/** The plate in effect: the requested one when the printer supports it, else the printer's default. */
export const effectivePlate = (requested: string, mp: ModelPlates): string => (mp.supported.includes(requested) ? requested : mp.default)

/** A filament's bed temperature on a plate; null when its preset says nothing about the plate. */
export function plateTemp(filament: Config, plate: string): number | null {
  const key = plateDef(plate)?.tempKey
  if (!key) return null
  const v = filament[key]
  const t = parseFloat(Array.isArray(v) ? v[0] : v ?? '')
  return Number.isFinite(t) ? t : null
}

/** A filament can print on a plate unless its preset gives that plate a temperature of 0. */
export const filamentSupports = (filament: Config, plate: string) => plateTemp(filament, plate) !== 0

/** Slots (0 based) whose filament cannot print on the plate. */
export const unsupportedSlots = (filaments: Config[], plate: string): number[] =>
  filaments.flatMap((f, i) => (filamentSupports(f, plate) ? [] : [i]))

/** The plate to switch to so every filament prints: the default when it works, else the first supported plate that does. */
export function compatiblePlate(mp: ModelPlates, filaments: Config[]): string | null {
  const ok = (id: string) => unsupportedSlots(filaments, id).length === 0
  if (ok(mp.default)) return mp.default
  return mp.supported.find(ok) ?? null
}

/** "Cool Plate can't print Generic PETG. Pick another plate." for the filaments (by name) the plate cannot take. */
export function plateProblem(plate: string, filaments: Config[], names: string[]): string | null {
  const bad = unsupportedSlots(filaments, plate)
  if (!bad.length) return null
  const list = [...new Set(bad.map((i) => names[i] || `Filament ${i + 1}`))].join(', ')
  return `${plateLabel(plate)} can't print ${list}. Pick another plate.`
}

/** The plate name the .gcode.3mf metadata uses ("textured_plate"). */
export const plateFileName = (id: string) => plateDef(id)?.file ?? 'cool_plate'
