/**
 * Print settings: one timeline feature per document that carries the slicing profile (printer, presets, overrides) and the
 * quick values the rest of the app reads. The Slice panel edits it; its fields are not shown in the Inspector.
 */
import { Printer } from '@phosphor-icons/react'
import { resolveParams } from '@/doc/params'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { Feature } from '@/doc/types'
import type { ParamDef, ParamSchema, ParamValue, ParamValues } from '@/ui/schema'
import { DEFAULT_SLOT_COLORS, FILAMENT_COLORS, SLOT_COUNT, colorById } from './palette'
import { emptyProfile, legacyProfile, parseProfile, printerLabel, serializeProfile, type SliceProfile } from './slice/profile'
import { useSlicer } from './slice/store'

/** The printer as the plate layout and the analysis tools see it. `id` is the machine preset name. */
export interface PrinterModel { id: string; label: string; /** bed size in mm (x, y) */ bed: [number, number]; /** machine preset name */ preset: string }

const colorOptions = FILAMENT_COLORS.map((c) => ({ value: c.id, label: c.label }))
const hidden = () => false

const slotParams = (): ParamDef[] =>
  Array.from({ length: SLOT_COUNT }, (_, i): ParamDef => ({
    type: 'enum', key: `slot${i + 1}`, label: `Filament ${i + 1}`, display: 'select', default: DEFAULT_SLOT_COLORS[i], options: colorOptions,
    help: `The color of the filament loaded in slot ${i + 1}. Paint a body or a face with "Filament ${i + 1}" and it prints in this color.`,
    visibleWhen: hidden,
  }))

/** Every field is edited in the Slice panel, so none is shown in the Inspector. The quick fields are cached from the Orca presets. */
export const printSettingsSchema: ParamSchema = {
  id: 'printSettings',
  title: 'Print settings',
  params: ([
    { type: 'text', key: 'slicing', label: 'Slicing profile', default: '', visibleWhen: hidden },
    { type: 'number', key: 'layerHeight', label: 'Layer height', unit: 'mm', min: 0.05, max: 0.6, step: 0.04, default: 0.2, visibleWhen: hidden },
    { type: 'number', key: 'firstLayerHeight', label: 'First layer height', unit: 'mm', min: 0.1, max: 0.6, step: 0.02, default: 0.2, visibleWhen: hidden },
    { type: 'number', key: 'wallLoops', label: 'Wall loops', unit: '', min: 1, max: 12, step: 1, default: 3, visibleWhen: hidden },
    { type: 'number', key: 'topLayers', label: 'Top layers', unit: '', min: 0, max: 30, step: 1, default: 5, visibleWhen: hidden },
    { type: 'number', key: 'bottomLayers', label: 'Bottom layers', unit: '', min: 0, max: 30, step: 1, default: 4, visibleWhen: hidden },
    { type: 'number', key: 'infill', label: 'Infill', unit: '%', min: 0, max: 100, step: 5, default: 15, visibleWhen: hidden },
    { type: 'text', key: 'infillPattern', label: 'Infill pattern', default: 'gyroid', visibleWhen: hidden },
    { type: 'text', key: 'support', label: 'Support', default: 'none', visibleWhen: hidden },
    { type: 'number', key: 'overhang', label: 'Overhang angle', unit: 'deg', min: 5, max: 85, step: 5, default: 45, visibleWhen: hidden },
    { type: 'text', key: 'brim', label: 'Brim', default: 'auto', visibleWhen: hidden },
    { type: 'text', key: 'placement', label: 'Plate layout', default: 'arrange', visibleWhen: hidden },
    { type: 'text', key: 'plate', label: 'Plate placement', default: '', visibleWhen: hidden },
    ...slotParams(),
  ] as ParamDef[]).map((p) => (p.type === 'group' || p.help ? p : { ...p, help: 'Edited in the Slice panel, not here.' })),
}

export interface PrintSettings {
  printer: PrinterModel
  nozzle: number
  layerHeight: number
  firstLayerHeight: number
  wallLoops: number
  topLayers: number
  bottomLayers: number
  infill: number
  infillPattern: string
  support: 'none' | 'normal' | 'tree'
  overhang: number
  brim: 'none' | 'auto' | 'outer'
  placement: 'arrange' | 'keep'
  /** palette ids per filament slot (index 0 = slot 1) */
  slotColors: string[]
  /** the printer, presets and overrides the slicer takes */
  profile: SliceProfile
}

function profileFrom(v: ParamValues, raw: ParamValues): SliceProfile {
  const stored = parseProfile(v.slicing)
  if (stored) return stored
  // a document from before presets: its printer and quick values become the profile
  if ('printer' in raw || 'layerHeight' in raw) {
    return legacyProfile({
      printer: raw.printer as string, nozzle: raw.nozzle as string, layerHeight: v.layerHeight as number, firstLayerHeight: v.firstLayerHeight as number,
      wallLoops: v.wallLoops as number, topLayers: v.topLayers as number, bottomLayers: v.bottomLayers as number, infill: v.infill as number,
      infillPattern: v.infillPattern as string, support: v.support as string, overhang: v.overhang as number, brim: v.brim as string,
    })
  }
  return emptyProfile()
}

export function settingsFromValues(v: ParamValues, raw: ParamValues = {}): PrintSettings {
  const profile = profileFrom(v, raw)
  return {
    printer: { id: profile.machine, label: printerLabel(profile.machine), bed: profile.bed, preset: profile.machine },
    nozzle: profile.nozzle,
    layerHeight: v.layerHeight as number,
    firstLayerHeight: v.firstLayerHeight as number,
    wallLoops: Math.round(v.wallLoops as number),
    topLayers: Math.round(v.topLayers as number),
    bottomLayers: Math.round(v.bottomLayers as number),
    infill: v.infill as number,
    infillPattern: String(v.infillPattern),
    support: (['normal', 'tree'].includes(String(v.support)) ? v.support : 'none') as PrintSettings['support'],
    overhang: v.overhang as number,
    brim: (['none', 'outer'].includes(String(v.brim)) ? v.brim : 'auto') as PrintSettings['brim'],
    placement: v.placement === 'keep' ? 'keep' : 'arrange',
    slotColors: Array.from({ length: SLOT_COUNT }, (_, i) => v[`slot${i + 1}`] as string),
    profile,
  }
}

/** The stored plate placement text of the document's active Print settings (parsed by plate/model). */
export function plateTextOf(features: Feature[], rollback: number): string {
  for (let i = Math.min(rollback, features.length) - 1; i >= 0; i--) {
    const f = features[i]
    if (f.type !== 'printSettings' || f.suppressed) continue
    return typeof f.params.plate === 'string' ? f.params.plate : ''
  }
  return ''
}

export const defaultSettings = (): PrintSettings => settingsFromValues(resolveParams(printSettingsSchema, {}))

/** The document's print settings: the last active Print settings feature, else the defaults. */
export function settingsOf(features: Feature[], rollback: number): PrintSettings {
  for (let i = Math.min(rollback, features.length) - 1; i >= 0; i--) {
    const f = features[i]
    if (f.type !== 'printSettings' || f.suppressed) continue
    try { return settingsFromValues(resolveParams(printSettingsSchema, f.params), f.params) } catch { break }
  }
  return defaultSettings()
}
export const currentSettings = () => settingsOf(useDoc.getState().features, useDoc.getState().rollback)

/** Hex color of a filament slot (1-based). */
export const slotHex = (s: PrintSettings, slot: number) => colorById(s.slotColors[slot - 1] ?? 'white').hex

registerFeature({
  type: 'printSettings',
  label: 'Print settings',
  icon: Printer,
  schema: printSettingsSchema,
  async compute() {
    return {}
  },
  // a double click on the timeline chip opens the Slice panel
  edit() {
    useSlicer.getState().openSheet()
  },
})

/** Ribbon command: open the Slice panel (the printer, presets and every setting). */
export function openPrintSettings() {
  useSlicer.getState().openSheet()
}

/**
 * Change the document's Print settings feature (adding it the first time) in one undo step. `change` gets the raw params and
 * returns the ones to write over them.
 */
export function updatePrintSettings(change: (params: ParamValues, current: PrintSettings) => Record<string, ParamValue>, label = 'Print settings') {
  const d = useDoc.getState()
  const existing = [...d.features].reverse().find((f) => f.type === 'printSettings')
  const cur = settingsOf(d.features, d.features.length)
  if (!existing) {
    const patch = change({}, cur)
    d.addFeature('printSettings', patch, 'Print settings')
    return
  }
  const next = { ...existing.params, ...change(existing.params, cur) }
  if (JSON.stringify(next) === JSON.stringify(existing.params)) return
  d.commit(label, (data) => ({ ...data, features: data.features.map((f) => (f.id === existing.id ? { ...f, params: next } : f)) }))
}

/** Write a slicing profile (and the quick values cached from it) into the document. */
export function writeProfile(profile: SliceProfile, quick: Record<string, ParamValue> = {}, label?: string) {
  updatePrintSettings(() => ({ slicing: serializeProfile(profile), ...quick }), label)
}
