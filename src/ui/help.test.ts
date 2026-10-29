import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ParamDef, ParamSchema } from './schema'

function missing(schema: ParamSchema): string[] {
  const out: string[] = []
  const walk = (defs: ParamDef[]) => {
    for (const d of defs) {
      if (d.type === 'group') walk(d.children)
      else if (!d.help || d.help.trim().length < 12) out.push(`${schema.id}.${d.key}`)
    }
  }
  walk(schema.params)
  return out
}

describe('every setting explains itself', () => {
  it('has a help text on every parameter of every feature dialog', async () => {
    // some feature modules touch `window` at import time (file pickers); a bare global is enough in node
    ;(globalThis as unknown as { window: unknown }).window ??= globalThis
    await Promise.all([import('@/features/basic'), import('@/features/solids'), import('@/features/meshTools'), import('@/features/offsetPlane'), import('@/features/extrude'), import('@/features/fillet'), import('@/features/revolve'), import('@/features/hair'), import('@/features/measure'), import('@/features/section'), import('@/features/move'), import('@/features/modeling-tools/register'), import('@/features/surface/register')])
    const { allFeatures } = await import('@/doc/registry')
    const { exportSchema } = await import('@/io/actions')
    const { measureSchema } = await import('@/features/measure')
    const { sectionSchema } = await import('@/features/section')
    const { moveSchema } = await import('@/features/move')
    const { extrudeSchema } = await import('@/features/extrude')
    const { revolveSchema } = await import('@/features/revolve')
    const { offsetPlaneSchema } = await import('@/features/offsetPlane')
    const { boxSchema } = await import('@/features/basic')
    const { cylinderSchema, sweepSchema, loftSchema, combineSchema, shellSchema } = await import('@/features/solids')
    const { hairSchema } = await import('@/features/hair/schema')
    const schemas = [...allFeatures().map((f) => f.schema), exportSchema, measureSchema, sectionSchema, moveSchema, extrudeSchema, revolveSchema, offsetPlaneSchema, boxSchema, cylinderSchema, sweepSchema, loftSchema, combineSchema, shellSchema, hairSchema]
    expect(schemas.length).toBeGreaterThan(14)
    expect(schemas.flatMap(missing)).toEqual([])
  })
})

/** Tools that work on a selection must say what to pick, so the tooltip is enough to get started. */
const NEEDS_SELECTION = [
  'solid.extrude', 'solid.revolve', 'solid.sweep', 'solid.loft', 'solid.fillet', 'solid.chamfer', 'solid.shell', 'solid.move', 'solid.combine',
  'solid.pattern', 'solid.mirror', 'solid.hole', 'solid.pressPull', 'construct.plane', 'inspect.measure', 'mesh.smooth', 'mesh.planeCut',
  'hair.create', 'detail.text', 'detail.texture', 'detail.thread', 'print.paintBody', 'print.split', 'surface.trim', 'surface.stitch', 'surface.thicken',
  'sketch.coincident', 'sketch.parallel', 'sketch.tangent', 'sketch.trim', 'assembly.joint', 'render.assign', 'drawing.view.section',
]

async function loadCommands() {
  ;(globalThis as unknown as { window: unknown }).window ??= globalThis
  await import('@/app/commands')
  await import('@/app/docCommands')
  await import('@/help/commands')
  await import('@/app/Layout') // registers Reset Layout
  return import('@/app/commands')
}

describe('every command explains itself in its tooltip', () => {
  it('has help text on every visible command', async () => {
    const { allCommands } = await loadCommands()
    const { helpFor } = await import('@/help/commandHelp')
    const cmds = allCommands().filter((c) => !c.hidden)
    expect(cmds.length).toBeGreaterThan(150)
    const bad = cmds.filter((c) => (helpFor(c)?.desc.trim().length ?? 0) < 20).map((c) => c.id)
    expect(bad, 'commands without a tooltip text').toEqual([])
  }, 280_000)

  it('says what to select for tools that need a selection', async () => {
    const { getCommand } = await loadCommands()
    const { helpFor } = await import('@/help/commandHelp')
    const bad = NEEDS_SELECTION.filter((id) => { const c = getCommand(id); return !c || !helpFor(c)?.select }).map((id) => id)
    expect(bad).toEqual([])
  }, 280_000)

  it('has no help entry for a command that does not exist, and every ribbon button is a real command', async () => {
    const { getCommand } = await loadCommands()
    const { COMMAND_HELP } = await import('@/help/commandHelp')
    const { RIBBON_TABS } = await import('@/app/ribbon')
    expect(Object.keys(COMMAND_HELP).filter((id) => !getCommand(id))).toEqual([])
    const used = RIBBON_TABS.flatMap((t) => t.groups.flatMap((g) => g.items.flatMap((i) => [i.cmd, ...(i.menu ?? []), ...(i.stack ?? [])]))).filter(Boolean) as string[]
    expect(used.filter((id) => !getCommand(id))).toEqual([])
  }, 280_000)

  it('writes no em dashes anywhere in the help text', async () => {
    const { COMMAND_HELP } = await import('@/help/commandHelp')
    const { GUIDES } = await import('@/help/guides')
    const { TOUR } = await import('@/help/tourSteps')
    const { GETTING_STARTED, ABOUT } = await import('@/help/gettingStarted')
    const all = JSON.stringify([COMMAND_HELP, GUIDES, TOUR, GETTING_STARTED, ABOUT])
    expect(all.includes('—')).toBe(false)
  })
})

describe('workspace guides and the tour', () => {
  it('has a guide for every ribbon workspace, with unique sections and real steps', async () => {
    await loadCommands()
    const { RIBBON_TABS } = await import('@/app/ribbon')
    const { GUIDES, guideById } = await import('@/help/guides')
    for (const t of RIBBON_TABS) expect(guideById(t.id), `guide for the ${t.id} tab`).toBeTruthy()
    for (const g of GUIDES) {
      const ids = g.sections.map((s) => s.id)
      expect(new Set(ids).size, g.id).toBe(ids.length)
      expect(g.sections[0].id, g.id).toBe('flow')
      for (const s of g.sections) expect(s.steps.length, `${g.id}.${s.id}`).toBeGreaterThan(0)
    }
  }, 280_000)

  it('points every feature dialog at a real guide section (the Inspector ?)', async () => {
    ;(globalThis as unknown as { window: unknown }).window ??= globalThis
    await loadCommands()
    const { allFeatures } = await import('@/doc/registry')
    const { FEATURE_GUIDE, guideById } = await import('@/help/guides')
    const { exportSchema } = await import('@/io/actions')
    const ids = [...allFeatures().map((f) => f.schema.id), exportSchema.id, 'measure', 'section', 'move']
    expect(ids.filter((id) => !FEATURE_GUIDE[id])).toEqual([])
    for (const [id, t] of Object.entries(FEATURE_GUIDE)) expect(guideById(t.guide)?.sections.some((s) => s.id === t.section), id).toBe(true)
  }, 280_000)

  it('has a short tour (5 to 7 steps)', async () => {
    const { TOUR } = await import('@/help/tourSteps')
    expect(TOUR.length).toBeGreaterThanOrEqual(5)
    expect(TOUR.length).toBeLessThanOrEqual(7)
  })

  it('lists every command that has a shortcut on the shortcuts page', async () => {
    const { allCommands } = await loadCommands()
    const { shortcutRows } = await import('@/help/HelpDialog')
    const rows = shortcutRows(allCommands()).flatMap((g) => g.rows.map((r) => r.keys))
    for (const c of allCommands().filter((x) => x.shortcut)) expect(rows, c.id).toContain(c.shortcut)
  }, 280_000)
})

describe('no bare title= hints on controls', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []))

  it('uses the Tip component (rich tooltip, long press on touch) instead of title= on buttons, inputs, labels and selects', () => {
    const root = path.resolve(import.meta.dirname, '..')
    const bad: string[] = []
    // an opening tag of an interactive element that carries title=; `=>` inside handlers must not end the tag early
    const re = /<(button|input|label|select|textarea)\b(?:[^>]|=>)*?\stitle=/g
    for (const f of walk(root)) {
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(re)) bad.push(`${path.relative(root, f)}:${src.slice(0, m.index).split('\n').length}`)
    }
    expect(bad, 'use <Tip label desc> from @/ui/Tooltip').toEqual([])
  })
})
