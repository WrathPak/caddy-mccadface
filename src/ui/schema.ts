/** Schema describing a feature's parameters; the Inspector renders any ParamSchema. */

export type Unit = 'mm' | 'deg' | '%' | ''

interface Base {
  /** key in the values object */
  key: string
  label: string
  /** plain-language explanation: tooltip on the label and a hint line under the field while it is focused */
  help?: string
  /** hide unless predicate over current values is true */
  visibleWhen?: (values: ParamValues) => boolean
}

export interface EnumOption {
  value: string
  label: string
  /** one-line description (shown under the label in 'list' display) */
  desc?: string
  /** icon name resolved by the Inspector (see ui/optionIcons) */
  icon?: string
}

export interface NumberParam extends Base {
  type: 'number'
  unit?: Unit
  min?: number
  max?: number
  step?: number
  default: number
}
export interface EnumParam extends Base {
  type: 'enum'
  options: EnumOption[]
  /** 'segmented' for <=4 short options, 'list' for a visual option list (icon + description), else dropdown */
  display?: 'segmented' | 'select' | 'list'
  /** old stored values that now mean another option (older projects) */
  aliases?: Record<string, string>
  default: string
}
export interface BoolParam extends Base {
  type: 'bool'
  default: boolean
}
export interface Vector3Param extends Base {
  type: 'vector3'
  unit?: Unit
  step?: number
  default: [number, number, number]
}
export interface SelectionRefParam extends Base {
  type: 'selection-ref'
  /** which entity kinds may be picked */
  accepts: ('body' | 'face' | 'edge' | 'sketch' | 'plane' | 'axis' | 'point' | 'vertex' | 'feature' | 'snap' | 'component')[]
  multiple?: boolean
  /** the dialog cannot be confirmed until this (visible) selection has at least one entry */
  required?: boolean
  /** with `required`: the smallest number of entries that satisfies it (default 1) */
  min?: number
  /** viewport / Browser picks flow into this field while it is the active one (click the field to activate it) */
  pick?: boolean
  default: string[]
}
/** Read-only text computed from the current values (e.g. the Measure results). */
export interface InfoParam extends Base {
  type: 'info'
  text: (values: ParamValues) => string
  default: string
}
/** A dropdown that fills several other parameters at once. Its own value remembers the last preset chosen. */
export interface PresetParam extends Base {
  type: 'preset'
  presets: { id: string; label: string; help?: string; values: Record<string, ParamValue> }[]
  default: string
}
export interface GroupParam {
  type: 'group'
  label: string
  /** identifies the group to the feature (see InspectorSession.onActiveGroup) */
  id?: string
  help?: string
  collapsed?: boolean
  children: ParamDef[]
}

export type ParamDef =
  | NumberParam
  | EnumParam
  | BoolParam
  | Vector3Param
  | SelectionRefParam
  | InfoParam
  | PresetParam
  | GroupParam

export type ParamValue = number | string | boolean | [number, number, number] | string[]
export type ParamValues = Record<string, ParamValue>

export interface ParamSchema {
  id: string
  title: string
  params: ParamDef[]
  /** non-blocking advice about the current values, shown above the OK button */
  warnings?: (values: ParamValues) => string[]
}

/** Collect default values from a schema (recursing into groups). */
export function schemaDefaults(schema: ParamSchema): ParamValues {
  const out: ParamValues = {}
  const walk = (defs: ParamDef[]) => {
    for (const d of defs) {
      if (d.type === 'group') walk(d.children)
      else out[d.key] = d.default
    }
  }
  walk(schema.params)
  return out
}

/** Visible selection-ref params, in order. */
export function selectionParams(schema: ParamSchema, values: ParamValues): SelectionRefParam[] {
  const out: SelectionRefParam[] = []
  const walk = (defs: ParamDef[]) => {
    for (const d of defs) {
      if (d.type === 'group') walk(d.children)
      else if (d.type === 'selection-ref' && !(d.visibleWhen && !d.visibleWhen(values))) out.push(d)
    }
  }
  walk(schema.params)
  return out
}

/** Labels of required selections that are still empty (OK stays disabled while this is non-empty). */
export function missingRequired(schema: ParamSchema, values: ParamValues): string[] {
  const full = { ...schemaDefaults(schema), ...values }
  return selectionParams(schema, full)
    .filter((d) => d.required && !(Array.isArray(full[d.key]) && (full[d.key] as string[]).length >= (d.min ?? 1)))
    .map((d) => d.label + ((d.min ?? 1) > 1 ? ` (at least ${d.min})` : ''))
}

/** Demo schema (Extrude-like) so the Inspector is visible. Later agents replace with real ones. */
export const demoExtrudeSchema: ParamSchema = {
  id: 'demo.extrude',
  title: 'Extrude',
  params: [
    { type: 'selection-ref', key: 'profile', label: 'Profile', accepts: ['sketch', 'face'], multiple: true, default: [] },
    {
      type: 'group',
      label: 'Extent',
      children: [
        {
          type: 'enum', key: 'direction', label: 'Direction', display: 'segmented', default: 'one',
          options: [{ value: 'one', label: 'One side' }, { value: 'sym', label: 'Symmetric' }, { value: 'two', label: 'Two sides' }],
        },
        { type: 'number', key: 'distance', label: 'Distance', unit: 'mm', min: 0, step: 0.5, default: 20 },
        { type: 'number', key: 'distance2', label: 'Distance 2', unit: 'mm', min: 0, step: 0.5, default: 10, visibleWhen: (v) => v.direction === 'two' },
        { type: 'number', key: 'taper', label: 'Taper angle', unit: 'deg', min: -89, max: 89, step: 0.5, default: 0 },
      ],
    },
    {
      type: 'enum', key: 'operation', label: 'Operation', display: 'select', default: 'join',
      options: [
        { value: 'join', label: 'Join' }, { value: 'cut', label: 'Cut' },
        { value: 'intersect', label: 'Intersect' }, { value: 'new', label: 'New body' },
      ],
    },
    {
      type: 'group',
      label: 'Advanced',
      collapsed: true,
      children: [
        { type: 'vector3', key: 'offset', label: 'Offset', unit: 'mm', step: 0.1, default: [0, 0, 0] },
        { type: 'bool', key: 'keepProfile', label: 'Keep sketch visible', default: true },
      ],
    },
  ],
}
