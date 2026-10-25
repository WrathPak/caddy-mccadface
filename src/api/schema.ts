/**
 * Plugin-declared parameter schemas. A plugin sends plain data (no functions); this checks it and turns it into the schema
 * the Inspector renders. Anything wrong is reported as a readable error naming the field, so a plugin author can fix it.
 */
import { Circle, Cube, Cylinder, DownloadSimple, Gear, Lightning, Package, PencilSimple, PuzzlePiece, Ruler, Shapes, Star, TextT, UploadSimple, Wrench } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import type { ParamDef, ParamSchema, ParamValue, ParamValues } from '@/ui/schema'

export const ICONS: Record<string, Icon> = {
  puzzle: PuzzlePiece, gear: Gear, cube: Cube, cylinder: Cylinder, sphere: Circle, download: DownloadSimple, upload: UploadSimple, wrench: Wrench,
  ruler: Ruler, pencil: PencilSimple, star: Star, bolt: Lightning, package: Package, shapes: Shapes, text: TextT,
}
export const iconOf = (name: unknown): Icon => (typeof name === 'string' && ICONS[name]) || PuzzlePiece

const fail = (where: string, what: string): never => { throw new Error(`${where}: ${what}`) }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, where: string, what: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim()) fail(where, `${what} must be a text`)
  return (v as string).slice(0, max)
}
const optStr = (v: unknown, where: string, what: string, max = 600): string | undefined => (v === undefined ? undefined : str(v, where, what, max))
const finite = (v: unknown, where: string, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(where, `${what} must be a number`)
  return v as number
}
const optNum = (v: unknown, where: string, what: string) => (v === undefined ? undefined : finite(v, where, what))

type When = { key: string; equals?: ParamValue; in?: ParamValue[] }

function visibility(w: unknown, where: string): ((v: ParamValues) => boolean) | undefined {
  if (w === undefined) return undefined
  if (!isObj(w) || typeof w.key !== 'string') return fail(where, 'visibleWhen needs { key, equals } or { key, in }')
  const when = w as unknown as When
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (when.in !== undefined) {
    if (!Array.isArray(when.in)) return fail(where, 'visibleWhen.in must be a list')
    return (v) => when.in!.some((x) => same(v[when.key], x))
  }
  return (v) => same(v[when.key], when.equals)
}

const ACCEPTS = ['body', 'face', 'edge', 'sketch', 'plane', 'axis', 'point', 'vertex'] as const

function compileParam(d: unknown, path: string, keys: Set<string>, depth: number): ParamDef {
  if (!isObj(d)) return fail(path, 'a parameter must be an object')
  const type = d.type
  if (type === 'group') {
    if (depth > 3) fail(path, 'groups are nested too deeply')
    if (!Array.isArray(d.children)) fail(path, 'a group needs children')
    return {
      type: 'group', label: str(d.label, path, 'label'), help: optStr(d.help, path, 'help'), collapsed: !!d.collapsed,
      children: (d.children as unknown[]).map((c, i) => compileParam(c, `${path}.children[${i}]`, keys, depth + 1)),
    }
  }
  const key = str(d.key, path, 'key', 60)
  if (!/^[A-Za-z_]\w*$/.test(key)) fail(path, `key "${key}" must be a plain name (letters, digits, underscore)`)
  if (keys.has(key)) fail(path, `key "${key}" is used twice`)
  keys.add(key)
  const where = `${path} (${key})`
  const base = { key, label: str(d.label, where, 'label'), help: optStr(d.help, where, 'help'), visibleWhen: visibility(d.visibleWhen, where) }
  switch (type) {
    case 'number': {
      const unit = d.unit ?? ''
      if (unit !== 'mm' && unit !== 'deg' && unit !== '%' && unit !== '') fail(where, 'unit must be mm, deg, % or empty')
      return { ...base, type: 'number', unit: unit as 'mm', min: optNum(d.min, where, 'min'), max: optNum(d.max, where, 'max'), step: optNum(d.step, where, 'step'), default: finite(d.default, where, 'default') }
    }
    case 'enum': {
      if (!Array.isArray(d.options) || !d.options.length) fail(where, 'an enum needs options')
      const options = (d.options as unknown[]).map((o, i) => {
        if (!isObj(o)) return fail(where, `option ${i + 1} must be an object`)
        return { value: str(o.value, where, 'option value'), label: str(o.label, where, 'option label'), desc: optStr(o.desc, where, 'option desc') }
      })
      const def = str(d.default, where, 'default')
      if (!options.some((o) => o.value === def)) fail(where, `default "${def}" is not one of the options`)
      const display = d.display
      if (display !== undefined && display !== 'segmented' && display !== 'select' && display !== 'list') fail(where, 'display must be segmented, select or list')
      return { ...base, type: 'enum', options, display: display as 'select' | undefined, default: def }
    }
    case 'bool':
      return { ...base, type: 'bool', default: !!d.default }
    case 'vector3': {
      const v = d.default
      if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) fail(where, 'default must be three numbers')
      return { ...base, type: 'vector3', unit: (d.unit as 'mm') ?? 'mm', step: optNum(d.step, where, 'step'), default: v as [number, number, number] }
    }
    case 'text':
      return { ...base, type: 'text', multiline: !!d.multiline, placeholder: optStr(d.placeholder, where, 'placeholder'), default: typeof d.default === 'string' ? d.default : '' }
    case 'selection-ref': {
      if (!Array.isArray(d.accepts) || !d.accepts.length || !d.accepts.every((a) => (ACCEPTS as readonly unknown[]).includes(a))) fail(where, `accepts must list some of ${ACCEPTS.join(', ')}`)
      return { ...base, type: 'selection-ref', accepts: d.accepts as never, multiple: !!d.multiple, required: !!d.required, pick: true, default: [] }
    }
    default:
      return fail(where, `unknown parameter type ${JSON.stringify(type)}`)
  }
}

/** The Inspector schema for a plugin feature. `params` is what the plugin passed to features.register. */
export function compileSchema(id: string, title: string, params: unknown): ParamSchema {
  if (!Array.isArray(params)) fail(title, 'params must be a list of parameter definitions')
  const keys = new Set<string>()
  return { id, title, params: (params as unknown[]).map((p, i) => compileParam(p, `${title} params[${i}]`, keys, 0)) }
}

/** Keys of selection fields that only take bodies: their values reach compute() as body ids, not as encoded references. */
export function bodyOnlyKeys(schema: ParamSchema): string[] {
  const out: string[] = []
  const walk = (defs: ParamDef[]) => {
    for (const d of defs) {
      if (d.type === 'group') walk(d.children)
      else if (d.type === 'selection-ref' && d.accepts.length === 1 && d.accepts[0] === 'body') out.push(d.key)
    }
  }
  walk(schema.params)
  return out
}
