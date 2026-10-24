/** Print settings: one timeline feature per document that carries the slicer settings written into the 3MF. */
import { Printer } from '@phosphor-icons/react'
import { createFeature, editFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { Feature } from '@/doc/types'
import type { ParamDef, ParamSchema, ParamValues } from '@/ui/schema'
import { DEFAULT_SLOT_COLORS, FILAMENT_COLORS, SLOT_COUNT, colorById } from './palette'

export interface PrinterModel { id: string; label: string; /** bed size in mm (x, y) */ bed: [number, number]; /** Bambu machine preset name */ preset: string }

export const PRINTERS: PrinterModel[] = [
  { id: 'a1', label: 'Bambu Lab A1', bed: [256, 256], preset: 'Bambu Lab A1' },
  { id: 'a1mini', label: 'Bambu Lab A1 mini', bed: [180, 180], preset: 'Bambu Lab A1 mini' },
  { id: 'p1s', label: 'Bambu Lab P1S', bed: [256, 256], preset: 'Bambu Lab P1S' },
  { id: 'p1p', label: 'Bambu Lab P1P', bed: [256, 256], preset: 'Bambu Lab P1P' },
  { id: 'x1c', label: 'Bambu Lab X1 Carbon', bed: [256, 256], preset: 'Bambu Lab X1 Carbon' },
  { id: 'h2d', label: 'Bambu Lab H2D', bed: [350, 320], preset: 'Bambu Lab H2D' },
]

export const FILAMENT_TYPES = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC'] as const

const colorOptions = FILAMENT_COLORS.map((c) => ({ value: c.id, label: c.label }))

const slotParams = (): ParamDef[] =>
  Array.from({ length: SLOT_COUNT }, (_, i): ParamDef => ({
    type: 'enum', key: `slot${i + 1}`, label: `Filament ${i + 1}`, display: 'select', default: DEFAULT_SLOT_COLORS[i], options: colorOptions,
    help: `The color of the filament loaded in slot ${i + 1}. Paint a body or a face with "Filament ${i + 1}" and it prints in this color.`,
  }))

export const printSettingsSchema: ParamSchema = {
  id: 'printSettings',
  title: 'Print settings',
  params: [
    {
      type: 'enum', key: 'printer', label: 'Printer', display: 'select', default: 'a1', options: PRINTERS.map((p) => ({ value: p.id, label: p.label })),
      help: 'The printer the file is prepared for. It sets the size of the build plate that parts are arranged on.',
    },
    {
      type: 'enum', key: 'nozzle', label: 'Nozzle', display: 'segmented', default: '0.4', options: ['0.2', '0.4', '0.6', '0.8'].map((v) => ({ value: v, label: v })),
      help: 'Nozzle diameter in mm. The thin wall and small feature checks use it to judge what can be printed.',
    },
    {
      type: 'group',
      label: 'Layers and walls',
      children: [
        { type: 'number', key: 'layerHeight', label: 'Layer height', unit: 'mm', min: 0.05, max: 0.6, step: 0.04, default: 0.2, help: 'Thickness of each printed layer in mm. Thinner layers look smoother and print slower.' },
        { type: 'number', key: 'firstLayerHeight', label: 'First layer height', unit: 'mm', min: 0.1, max: 0.6, step: 0.02, default: 0.2, help: 'Thickness of the very first layer in mm. A little thicker than the rest helps it stick to the plate.' },
        { type: 'number', key: 'wallLoops', label: 'Wall loops', unit: '', min: 1, max: 12, step: 1, default: 3, help: 'How many outlines are printed around each layer. More loops make the part stronger and its walls thicker.' },
        { type: 'number', key: 'topLayers', label: 'Top layers', unit: '', min: 0, max: 30, step: 1, default: 5, help: 'How many solid layers close the top of the part.' },
        { type: 'number', key: 'bottomLayers', label: 'Bottom layers', unit: '', min: 0, max: 30, step: 1, default: 4, help: 'How many solid layers close the bottom of the part.' },
      ],
    },
    {
      type: 'group',
      label: 'Infill and support',
      children: [
        { type: 'number', key: 'infill', label: 'Infill', unit: '%', min: 0, max: 100, step: 5, default: 15, help: 'How full the inside of the part is, in percent. 0 makes it hollow, 100 makes it solid.' },
        {
          type: 'enum', key: 'infillPattern', label: 'Infill pattern', display: 'select', default: 'gyroid',
          options: [{ value: 'gyroid', label: 'Gyroid' }, { value: 'grid', label: 'Grid' }, { value: 'cubic', label: 'Cubic' }, { value: 'honeycomb', label: 'Honeycomb' }, { value: 'line', label: 'Lines' }],
          help: 'The pattern that fills the inside of the part. Gyroid is strong in every direction.',
        },
        {
          type: 'enum', key: 'support', label: 'Support', display: 'segmented', default: 'none', options: [{ value: 'none', label: 'Off' }, { value: 'normal', label: 'Normal' }, { value: 'tree', label: 'Tree' }],
          help: 'Scaffolding under overhangs. Off adds none, Normal builds straight pillars, Tree builds branching ones that are easier to remove.',
        },
        { type: 'number', key: 'overhang', label: 'Overhang angle', unit: 'deg', min: 5, max: 85, step: 5, default: 45, help: 'Steepest overhang that prints without support, measured from vertical. The overhang map and Auto orient use the same angle.' },
        {
          type: 'enum', key: 'brim', label: 'Brim', display: 'segmented', default: 'auto', options: [{ value: 'none', label: 'None' }, { value: 'auto', label: 'Auto' }, { value: 'outer', label: 'Outer' }],
          help: 'A flat ring around the first layer that helps tall or thin parts stay stuck to the plate.',
        },
      ],
    },
    {
      type: 'group',
      label: 'Filament',
      children: [
        {
          type: 'enum', key: 'material', label: 'Material', display: 'select', default: 'PLA', options: FILAMENT_TYPES.map((m) => ({ value: m, label: m })),
          help: 'The kind of filament in every slot.',
        },
        {
          type: 'enum', key: 'placement', label: 'Plate layout', display: 'segmented', default: 'arrange', options: [{ value: 'arrange', label: 'Arrange' }, { value: 'keep', label: 'Keep' }],
          help: 'Arrange lays every body out side by side on the plate. Keep centers them on the plate where they sit relative to each other.',
        },
      ],
    },
    { type: 'group', label: 'Filament colors', collapsed: true, children: slotParams() },
  ],
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
  material: string
  placement: 'arrange' | 'keep'
  /** palette ids per filament slot (index 0 = slot 1) */
  slotColors: string[]
}

export function settingsFromValues(v: ParamValues): PrintSettings {
  const printer = PRINTERS.find((p) => p.id === v.printer) ?? PRINTERS[0]
  return {
    printer,
    nozzle: parseFloat(v.nozzle as string) || 0.4,
    layerHeight: v.layerHeight as number,
    firstLayerHeight: v.firstLayerHeight as number,
    wallLoops: Math.round(v.wallLoops as number),
    topLayers: Math.round(v.topLayers as number),
    bottomLayers: Math.round(v.bottomLayers as number),
    infill: v.infill as number,
    infillPattern: v.infillPattern as string,
    support: v.support as PrintSettings['support'],
    overhang: v.overhang as number,
    brim: v.brim as PrintSettings['brim'],
    material: v.material as string,
    placement: v.placement as PrintSettings['placement'],
    slotColors: Array.from({ length: SLOT_COUNT }, (_, i) => v[`slot${i + 1}`] as string),
  }
}

export const defaultSettings = (): PrintSettings => settingsFromValues(resolveParams(printSettingsSchema, {}))

/** The document's print settings: the last active Print settings feature, else the defaults. */
export function settingsOf(features: Feature[], rollback: number): PrintSettings {
  for (let i = Math.min(rollback, features.length) - 1; i >= 0; i--) {
    const f = features[i]
    if (f.type !== 'printSettings' || f.suppressed) continue
    try { return settingsFromValues(resolveParams(printSettingsSchema, f.params)) } catch { break }
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
})

/** Ribbon command: edit the document's settings, or add them the first time. */
export function openPrintSettings() {
  const d = useDoc.getState()
  const existing = [...d.features].reverse().find((f) => f.type === 'printSettings')
  if (existing) editFeature(existing.id)
  else createFeature('printSettings', {}, 'print.settings')
}
