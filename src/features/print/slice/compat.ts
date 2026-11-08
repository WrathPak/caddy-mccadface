/**
 * Which process and filament presets Orca offers with a printer: `compatible_printers`, else `compatible_printers_condition`
 * (Orca's small expression language over the printer's settings), else everything. Written to the rules of docs/PROFILES.md
 * section 5, so the lists match what Orca's own preset picker shows.
 */
import type { Config, PresetScope, VendorBundle } from '@muon3d/slicer-engine-protocol'

type Val = string | number | boolean | string[] | undefined

// the expression language: and / or / not, comparisons, =~ /regex/, name, name[i], numbers, strings
interface Tok { t: 'num' | 'str' | 'id' | 'op' | 're' | 'end'; v: string }

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < src.length && src[j] !== c) j++
      out.push({ t: 'str', v: src.slice(i + 1, j) })
      i = j + 1
      continue
    }
    if (c === '/' && /(=~|!~)$/.test(src.slice(0, i).trimEnd())) {
      let j = i + 1
      while (j < src.length && (src[j] !== '/' || src[j - 1] === '\\')) j++
      out.push({ t: 're', v: src.slice(i + 1, j) })
      i = j + 1
      continue
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i))
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue }
    const id = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i))
    if (id) {
      const w = id[0]
      out.push(w === 'and' || w === 'or' || w === 'not' ? { t: 'op', v: w === 'and' ? '&&' : w === 'or' ? '||' : '!' } : { t: 'id', v: w })
      i += w.length
      continue
    }
    const op = /^(==|!=|<=|>=|=~|!~|&&|\|\||[<>!()[\]])/.exec(src.slice(i))
    if (op) { out.push({ t: 'op', v: op[0] }); i += op[0].length; continue }
    throw new Error(`unexpected "${c}"`)
  }
  out.push({ t: 'end', v: '' })
  return out
}

const toNum = (v: Val): number | null => {
  const s = Array.isArray(v) ? v[0] : v
  if (typeof s === 'number') return s
  if (typeof s === 'string' && s.trim() !== '' && !isNaN(Number(s))) return Number(s)
  return null
}
const toStr = (v: Val) => (Array.isArray(v) ? v[0] ?? '' : v === undefined ? '' : String(v))
const truthy = (v: Val) => (typeof v === 'boolean' ? v : Array.isArray(v) ? v.length > 0 && v[0] !== '0' && v[0] !== '' : typeof v === 'number' ? v !== 0 : !!v && v !== '0')

/** Evaluate a compatibility condition against the printer's variables. An expression that fails to evaluate counts as true. */
export function evalCondition(cond: string, vars: Record<string, Val>): boolean {
  if (!cond.trim()) return true
  try {
    const toks = lex(cond)
    let p = 0
    const peek = () => toks[p]
    const eat = (v?: string) => { const t = toks[p]; if (v !== undefined && t.v !== v) throw new Error(`expected ${v}`); p++; return t }
    const primary = (): Val => {
      const t = peek()
      if (t.t === 'op' && t.v === '(') { eat(); const r = or(); eat(')'); return r }
      if (t.t === 'op' && t.v === '!') { eat(); return !truthy(primary()) }
      if (t.t === 'num') { eat(); return Number(t.v) }
      if (t.t === 'str') { eat(); return t.v }
      if (t.t === 'id') {
        eat()
        if (t.v === 'true') return true
        if (t.v === 'false') return false
        let v = vars[t.v]
        if (peek().v === '[') { eat(); const n = Number(eat().v); eat(']'); v = Array.isArray(v) ? v[n] : n === 0 ? v : undefined }
        return v
      }
      throw new Error('unexpected token')
    }
    const cmp = (): Val => {
      const a = primary()
      const t = peek()
      if (t.t !== 'op' || !['==', '!=', '<', '>', '<=', '>=', '=~', '!~'].includes(t.v)) return a
      eat()
      if (t.v === '=~' || t.v === '!~') {
        const re = eat()
        const hit = new RegExp(re.t === 're' ? re.v : toStr(re.v), 's').test(toStr(a))
        return t.v === '=~' ? hit : !hit
      }
      const b = primary()
      const x = toNum(a), y = toNum(b)
      const [l, r] = x !== null && y !== null ? [x, y] : [toStr(a), toStr(b)]
      switch (t.v) {
        case '==': return l === r
        case '!=': return l !== r
        case '<': return l < r
        case '>': return l > r
        case '<=': return l <= r
        default: return l >= r
      }
    }
    const and = (): Val => { let a = cmp(); while (peek().v === '&&') { eat(); const b = cmp(); a = truthy(a) && truthy(b) } return a }
    const or = (): Val => { let a = and(); while (peek().v === '||') { eat(); const b = and(); a = truthy(a) || truthy(b) } return a }
    const r = or()
    if (peek().t !== 'end') throw new Error('trailing text')
    return truthy(r)
  } catch {
    return true
  }
}

/** The printer's settings as the condition variables. */
export function printerVars(machine: Config, name: string): Record<string, Val> {
  const nozzles = machine.nozzle_diameter
  return { ...(machine as Record<string, Val>), printer_preset: name, num_extruders: Array.isArray(nozzles) ? nozzles.length : 1 }
}

const COMPAT_KEYS = ['compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition'] as const
type CompatKey = (typeof COMPAT_KEYS)[number]

/** The compatibility keys a preset ends up with: the nearest file of its chain that names each one (a child's value replaces its parent's). */
function effective(bundles: VendorBundle[], type: PresetScope, name: string): Partial<Record<CompatKey, string | string[]>> {
  const out: Partial<Record<CompatKey, string | string[]>> = {}
  let cur: string | undefined = name
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const file: Config | undefined = bundles.map((b) => b.presets[type][cur!]).find(Boolean)
    if (!file) break
    for (const k of COMPAT_KEYS) if (!(k in out) && k in file) out[k] = file[k]
    cur = typeof file.inherits === 'string' && file.inherits ? file.inherits : undefined
  }
  return out
}

const names = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? v.split(';').map((s) => s.replace(/^"|"$/g, '')).filter(Boolean) : [])
const alias = (n: string) => n.split('@')[0].trim()

export interface PresetListing { name: string; vendor: string }

/**
 * Selectable presets of `type` that Orca offers with the printer. `bundles` = [the printer's vendor, the library];
 * `process` (filaments only) limits to filaments allowed with that process (`compatible_prints`).
 */
export function compatiblePresets(bundles: VendorBundle[], type: 'process' | 'filament', machine: Config, machineName: string, process?: string): PresetListing[] {
  const vars = printerVars(machine, machineName)
  const out: PresetListing[] = []
  // a library filament is left out where the printer's own vendor has a filament of the same alias that names the printer
  const own = new Set<string>()
  if (type === 'filament') {
    for (const [n, f] of Object.entries(bundles[0].presets.filament)) {
      if (f.instantiation !== 'true') continue
      if (names(effective(bundles, 'filament', n).compatible_printers).includes(machineName)) own.add(alias(n))
    }
  }
  bundles.forEach((b, bi) => {
    for (const [n, f] of Object.entries(b.presets[type])) {
      if (f.instantiation !== 'true') continue
      const e = effective(bundles, type, n)
      const printers = names(e.compatible_printers)
      let ok: boolean
      if (printers.length) ok = printers.includes(machineName)
      else {
        const cond = typeof e.compatible_printers_condition === 'string' ? e.compatible_printers_condition : ''
        ok = evalCondition(cond, vars)
        if (ok && type === 'filament' && bi > 0 && own.has(alias(n))) ok = false
      }
      if (ok && type === 'filament' && process) {
        const prints = names(e.compatible_prints)
        if (prints.length) ok = prints.includes(process)
        else {
          const pc = typeof e.compatible_prints_condition === 'string' ? e.compatible_prints_condition : ''
          if (pc) {
            const pf = bundles.map((x) => x.presets.process[process]).find(Boolean)
            ok = evalCondition(pc, { ...(pf as Record<string, Val> | undefined), print_preset: process })
          }
        }
      }
      if (ok) out.push({ name: n, vendor: b.vendor.id })
    }
  })
  return out
}
