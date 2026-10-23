/** Schema describing a feature's parameters; the Inspector renders any ParamSchema. */

export type Unit = 'mm' | 'deg' | '%' | ''

interface Base {
  /** key in the values object */
  key: string
  label: string
  /** hide unless predicate over current values is true */
  visibleWhen?: (values: ParamValues) => boolean
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
  options: { value: string; label: string }[]
  /** 'segmented' for <=4 short options, else dropdown */
  display?: 'segmented' | 'select'
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
  accepts: ('body' | 'face' | 'edge' | 'sketch' | 'plane')[]
  multiple?: boolean
  default: string[]
}
export interface GroupParam {
  type: 'group'
  label: string
  collapsed?: boolean
  children: ParamDef[]
}

export type ParamDef =
  | NumberParam
  | EnumParam
  | BoolParam
  | Vector3Param
  | SelectionRefParam
  | GroupParam

export type ParamValue = number | string | boolean | [number, number, number] | string[]
export type ParamValues = Record<string, ParamValue>

export interface ParamSchema {
  id: string
  title: string
  params: ParamDef[]
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
