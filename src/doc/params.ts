/** User parameters (name = expression with units, via mathjs) and parameter resolution. */
import { evaluate } from 'mathjs'
import { schemaDefaults, type ParamDef, type ParamSchema, type ParamValues } from '@/ui/schema'
import type { UserParam } from './types'

export interface Scope {
  values: Record<string, unknown>
  errors: Record<string, string>
}

let current: Scope = { values: {}, errors: {} }

export const getScope = () => current
/** Evaluate user parameters in order (later ones may reference earlier ones). */
export function setUserParams(params: UserParam[]): Scope {
  const values: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const p of params) {
    if (!/^[A-Za-z_]\w*$/.test(p.name)) { errors[p.name] = 'Invalid name'; continue }
    try {
      values[p.name] = evaluate(p.expr, { ...values })
    } catch (e) {
      errors[p.name] = e instanceof Error ? e.message : String(e)
    }
  }
  current = { values, errors }
  return current
}

/** Evaluate an expression to a number in `unit` (mm/deg/...), using user parameters. null if invalid. */
export function evalNumber(text: string, unit?: string, scope: Scope = current): number | null {
  const t = text.trim()
  if (!t) return null
  try {
    const r: unknown = evaluate(t, { ...scope.values })
    if (typeof r === 'number') return isFinite(r) ? r : null
    if (r && typeof r === 'object' && 'toNumber' in r) {
      const n = (r as { toNumber: (u?: string) => number }).toNumber(unit && unit !== '%' ? unit : undefined)
      return isFinite(n) ? n : null
    }
  } catch {
    /* invalid */
  }
  return null
}

/** Display string for a parameter's value, e.g. "40 mm". */
export function formatParam(v: unknown): string {
  if (typeof v === 'number') return String(+v.toFixed(4))
  if (v && typeof v === 'object' && 'toString' in v) return String((v as object).toString())
  return String(v)
}

/** Fill defaults and evaluate number expressions. Throws on an invalid expression. */
export function resolveParams(schema: ParamSchema, raw: ParamValues, scope: Scope = current): ParamValues {
  const out: ParamValues = { ...schemaDefaults(schema), ...raw }
  const walk = (defs: ParamDef[]) => {
    for (const d of defs) {
      if (d.type === 'group') walk(d.children)
      else if (d.type === 'number') {
        const v = out[d.key]
        if (typeof v === 'string') {
          const n = evalNumber(v, d.unit, scope)
          if (n === null) throw new Error(`${d.label}: invalid expression "${v}"`)
          out[d.key] = n
        }
      }
    }
  }
  walk(schema.params)
  return out
}
