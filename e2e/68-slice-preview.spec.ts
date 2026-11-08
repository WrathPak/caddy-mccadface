/**
 * The sliced layer preview: slice (through the spike's engine handle until the Slice command lands), preview, layer slider, legend,
 * scrubber, out-of-date pill, Esc. Needs `node scripts/fetch-slicer.mjs` first. Screenshots go to e2e/screenshots.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, SHOTS, type App } from './helpers'

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOTES = process.env.PREVIEW_SHOTS // optional second copy of the screenshots

async function addBox(app: App, size: [number, number, number], position: [number, number, number]) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size[0], depth: a.size[1], height: a.size[2], position: a.position }), { size, position })
  await app.idle()
}

const sp = (app: App) => ({
  slice: (_key?: string, opts?: unknown, patch?: unknown) => app.ev((c, a) => c.slicePreview.devSlice(a.opts, a.patch), { opts, patch }) as Promise<{ ms: number; layers: number; segments: number }>,
  stats: () => app.ev((c) => c.slicePreview.stats()) as Promise<any>,
  expected: () => app.ev((c) => c.slicePreview.expected()) as Promise<any>,
  state: () => app.ev((c) => { const s = c.slicePreview.store.getState(); return { lo: s.lo, hi: s.hi, scrub: s.scrub, mode: s.mode, playing: s.playing, roleOff: s.roleOff } }) as Promise<any>,
})

async function shot(app: App, name: string) {
  await app.shot(name)
  if (NOTES) { fs.mkdirSync(NOTES, { recursive: true }); fs.copyFileSync(path.join(SHOTS, name + '.png'), path.join(NOTES, name + '.png')) }
}

async function ready(app: App) {
  await app.page.waitForFunction(() => !!(window as any).__caddy?.slicePreview?.devSlice)
}

async function previewReady(app: App) {
  await expect.poll(async () => (await sp(app).stats())?.ready, { timeout: 30_000 }).toBe(true)
  await expect(app.page.getByTestId('layer-slider')).toBeVisible()
}

test('slice preview: a 20 mm cube, layer slider, legend, scrubber, pill and Esc', async ({ app, page }) => {
  test.setTimeout(240_000)
  await app.open()
  await addBox(app, [20, 20, 20], [0, 0, 0])
  await ready(app)
  const bodies = await app.bbox()
  const r = await sp(app).slice('a1')
  expect(r.layers).toBe(100)
  console.log('slice', JSON.stringify(r))

  // no preview before it is asked for; the ribbon button turns it on
  expect(await sp(app).stats()).toBeNull()
  await app.tab('Print')
  await app.ribbon('Preview').click()
  await previewReady(app)
  const slider = page.getByTestId('layer-slider')
  await expect(slider).toHaveAttribute('data-count', '100')
  await expect(slider).toHaveAttribute('data-hi', '100')
  await expect(slider).toHaveAttribute('data-lo', '1')

  // the bodies are hidden, the toolpaths sit where they were: the outer wall of the cube is inside the body's footprint and
  // reaches its top (the A1 purge line far at the front is a "Custom" feature and is left out)
  const placed = await app.ev((c) => {
    const tp = c.slicePreview.slice.getState().result.toolpaths
    const o = c.slicePreview.origin()
    const wall = tp.roles.findIndex((r: any) => r.name === 'Outer wall')
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < tp.extrusions.count; i++) {
      if (tp.extrusions.roleIndex[i] !== wall) continue
      for (let k = 0; k < 6; k++) { const v = tp.extrusions.positions[i * 6 + k] + o[k % 3]; if (v < min[k % 3]) min[k % 3] = v; if (v > max[k % 3]) max[k % 3] = v }
    }
    return { min, max, bodiesVisible: c.three.scene.getObjectByName('bodies').visible }
  })
  expect(placed.bodiesVisible).toBe(false)
  for (const k of [0, 1]) {
    expect(placed.min[k] - bodies.min[k]).toBeGreaterThan(0)
    expect(placed.min[k] - bodies.min[k]).toBeLessThan(0.6)
    expect(bodies.max[k] - placed.max[k]).toBeGreaterThan(0)
    expect(bodies.max[k] - placed.max[k]).toBeLessThan(0.6)
  }
  expect(Math.abs(placed.max[2] - bodies.max[2])).toBeLessThan(0.05)

  // the GPU draws exactly what the CPU count says
  let st = await sp(app).stats()
  expect(st.drawn).toBe((await sp(app).expected()).segments)
  expect(st.range).toEqual({ lo: 0, hi: 99, scrub: 1 })
  const all = st.instances
  await shot(app, 'slice-preview-cube-full')

  // keyboard: shift+down moves ten layers, five times: layer 50
  await page.getByTestId('layer-thumb-hi').focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowDown')
  await expect(slider).toHaveAttribute('data-hi', '50')
  st = await sp(app).stats()
  expect(st.range).toEqual({ lo: 0, hi: 49, scrub: 1 })
  expect(st.drawn).toBe((await sp(app).expected()).segments)
  expect(st.instances).toBeLessThan(all)
  await shot(app, 'slice-preview-cube-layer50')

  // a feature switched off in the legend is not drawn
  await page.getByTestId('legend-role-Outer wall').click()
  await expect.poll(async () => (await sp(app).stats()).drawn).toBeLessThan(st.drawn)
  expect((await sp(app).stats()).drawn).toBe((await sp(app).expected()).segments)
  await page.getByTestId('legend-role-Outer wall').click()

  // Esc leaves: the bodies are back and the toolpaths are freed
  const geoms = await app.ev((c) => c.three.gl.info.memory.geometries)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('layer-slider')).toHaveCount(0)
  expect(await sp(app).stats()).toBeNull()
  const after = await app.ev((c) => ({ visible: c.three.scene.getObjectByName('bodies').visible, preview: c.slicePreview.slice.getState().preview, tool: c.ui.getState().activeTool, geoms: c.three.gl.info.memory.geometries }))
  expect(after.visible).toBe(true)
  expect(after.preview).toBe(false)
  expect(after.tool).toBeNull()
  expect(after.geoms).toBeLessThan(geoms)
})

test('slice preview: two colors, filament mode and legend with grams', async ({ app, page }) => {
  test.skip(!process.env.PREVIEW_SHOTS, 'screenshots for the polish pass only')
  test.setTimeout(300_000)
  await app.open()
  await addBox(app, [20, 20, 20], [0, 0, 0])
  await addBox(app, [20, 20, 20], [40, 0, 0])
  await ready(app)
  await app.tab('Print')
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: c.doc.getState().geometry[1].id }]))
  await app.ribbon('Paint Body').click()
  await app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Filament' }) }).locator('button.sel').click()
  await page.getByRole('option', { name: 'Filament 2' }).click()
  await app.ok()
  await sp(app).slice('a1')
  await app.ribbon('Preview').click()
  await previewReady(app)
  await expect(page.getByTestId('legend-filaments')).toBeVisible()
  // the G-code scan places the filament change per segment and reads grams from the footer
  await expect(page.getByTestId('legend-filament-1')).toContainText(/\d+\.\d g/, { timeout: 30_000 })
  await app.ev((c) => c.slicePreview.mode('filament'))
  await shot(app, 'slice-preview-two-color-filament')
  await app.ev((c) => c.slicePreview.mode('feature'))
  await shot(app, 'slice-preview-two-color-feature')
  // switching filament 2 off hides about half of it
  const all = (await sp(app).stats()).instances
  await page.getByTestId('legend-filament-1').click()
  await expect.poll(async () => (await sp(app).stats()).ready).toBe(true)
  await shot(app, 'slice-preview-two-color-f2-off')
  expect(all).toBeGreaterThan(0)
})

test('slice preview: a part with supports', async ({ app, page }) => {
  test.skip(!process.env.PREVIEW_SHOTS, 'screenshots for the polish pass only')
  test.setTimeout(300_000)
  await app.open()
  await addBox(app, [10, 10, 12], [0, 0, 0])
  await addBox(app, [40, 12, 4], [0, 0, 10])
  await app.ev((c) => c.doc.getState().addFeature('combine', { target: ['f1'], tools: ['f2'], operation: 'join', keepTools: false }))
  await app.idle()
  await ready(app)
  const r = await sp(app).slice('a1', { bedOrigin: true }, { enable_support: '1', support_type: 'normal(auto)', support_on_build_plate_only: '0' })
  console.log('support slice', JSON.stringify(r))
  await app.tab('Print')
  await app.ribbon('Preview').click()
  await previewReady(app)
  const rows = await page.locator('[data-testid^="legend-role-"]').allTextContents()
  console.log('support legend', JSON.stringify(rows))
  expect(rows.some((t) => /^Support/.test(t.trim()))).toBe(true)
  await shot(app, 'slice-preview-support')
})
