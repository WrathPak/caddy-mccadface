import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { schemaDefaults, type ParamDef, type ParamSchema } from '@/ui/schema'

const walk = (defs: ParamDef[], fn: (d: Exclude<ParamDef, { type: 'group' }>) => void) => {
  for (const d of defs) { if (d.type === 'group') walk(d.children, fn); else fn(d) }
}

async function schemas() {
  ;(globalThis as unknown as { window: unknown }).window ??= globalThis
  await import('./register')
  const { allFeatures } = await import('@/doc/registry')
  return allFeatures().filter((f) => ['emboss', 'texture', 'fur', 'scales', 'spikes', 'grass', 'thread'].includes(f.type)).map((f) => f.schema)
}

describe('detail dialogs', () => {
  it('registers every tool, its commands and the ribbon tab', async () => {
    const list = await schemas()
    expect(list.map((s) => s.id).sort()).toEqual(['emboss', 'fur', 'grass', 'scales', 'spikes', 'texture', 'thread'])
    const { getCommand } = await import('@/app/commands')
    for (const id of ['text', 'logo', 'texture', 'fur', 'scales', 'spikes', 'grass', 'thread']) expect(getCommand('detail.' + id), id).toBeTruthy()
    const { RIBBON_TABS } = await import('@/app/ribbon')
    const tab = RIBBON_TABS.find((t) => t.id === 'detail')!
    expect(tab.label).toBe('Detail')
    expect(RIBBON_TABS.some((t) => t.id === 'hair')).toBe(true)
    const cmds = tab.groups.flatMap((g) => g.items.map((i) => i.cmd))
    expect(cmds).toHaveLength(8)
  })

  it('every setting has a plain help text', async () => {
    const missing: string[] = []
    for (const s of await schemas()) walk(s.params, (d) => { if (!d.help || d.help.trim().length < 12) missing.push(`${s.id}.${d.key}`) })
    expect(missing).toEqual([])
  })

  it('presets set the same keys, so switching between them loses nothing, and every key exists', async () => {
    for (const s of await schemas()) {
      const keys = new Set<string>()
      walk(s.params, (d) => keys.add(d.key))
      walk(s.params, (d) => {
        if (d.type !== 'preset') return
        const sets = d.presets.map((p) => Object.keys(p.values).sort().join(','))
        expect(new Set(sets).size, `${s.id} presets`).toBe(1)
        for (const p of d.presets) {
          expect(p.help && p.help.length > 12, `${s.id}.${p.id} help`).toBeTruthy()
          for (const k of Object.keys(p.values)) expect(keys.has(k), `${s.id}.${p.id}.${k}`).toBe(true)
        }
        expect(d.presets.length).toBeGreaterThanOrEqual(5)
      })
    }
  })

  it('defaults are complete and the printing clearance defaults to an FDM value', async () => {
    const list = await schemas() as ParamSchema[]
    for (const s of list) expect(Object.keys(schemaDefaults(s)).length).toBeGreaterThan(5)
    const { threadSchema, DEFAULT_CLEARANCE } = await import('./thread')
    expect(schemaDefaults(threadSchema).clearance).toBe(DEFAULT_CLEARANCE)
    expect(DEFAULT_CLEARANCE).toBe(0.2)
  })

  it('bundled fonts all parse and have letters', async () => {
    const { FONTS } = await import('./fonts')
    const { textShape } = await import('@/kernel/emboss/text')
    for (const f of FONTS) {
      // the ?url import is a file path in node
      const b = fs.readFileSync(f.url)
      const t = textShape(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, 'Abg8', { size: 6, letterSpacing: 0, lineSpacing: 1, align: 'center' })
      expect(t.shape.loops.length, f.label).toBeGreaterThanOrEqual(4)
      expect(t.missing, f.label).toEqual([])
    }
  })

  it('the voice rules hold in everything this feature adds: no em dashes, no mention of tooling', () => {
    const roots = ['src/features/detail', 'src/kernel/generators', 'src/kernel/emboss', 'src/kernel/texture', 'src/kernel/threads.ts', 'src/kernel/threads.test.ts', 'src/kernel/detail-ops.ts', 'e2e/detail-kit.ts']
    const files: string[] = []
    const add = (p: string) => {
      if (fs.statSync(p).isDirectory()) fs.readdirSync(p).forEach((n) => add(path.join(p, n)))
      else if (/\.(ts|tsx|css)$/.test(p)) files.push(p)
    }
    roots.forEach((r) => add(path.resolve(import.meta.dirname, '../../..', r)))
    for (const f of fs.readdirSync(path.resolve(import.meta.dirname, '../../../e2e'))) if (/^(18|19|20|21)-detail/.test(f)) files.push(path.resolve(import.meta.dirname, '../../../e2e', f))
    const bad = files.filter((f) => /—|–|claude|anthropic|co-authored/i.test(fs.readFileSync(f, 'utf8')) && !f.endsWith('detail.test.ts'))
    expect(bad).toEqual([])
  })
})
