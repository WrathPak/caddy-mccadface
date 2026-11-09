/**
 * The Print workspace as a slicer: the printer's bed under the part, the setup sidebar, the object toolbar (rotate and lay flat on
 * the bed), Slice, then the preview with the layer slider, legend and result summary. SHOTS_DIR (optional) gets a copy of each picture.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, SHOTS, type App } from './helpers'

/* eslint-disable @typescript-eslint/no-explicit-any */
const DIR = process.env.WORKSPACE_SHOTS

async function shot(app: App, name: string) {
  await app.shot(name)
  if (DIR) { fs.mkdirSync(DIR, { recursive: true }); fs.copyFileSync(path.join(SHOTS, name + '.png'), path.join(DIR, name + '.png')) }
}

const model = (app: App) => app.ev((c) => {
  const m = c.print.model()
  return { bed: [m.bed.hi[0] - m.bed.lo[0], m.bed.hi[1] - m.bed.lo[1], m.bed.height], parts: m.list.map((p: any) => ({ id: p.id, size: p.size, lo: p.lo, hi: p.hi, status: p.status, r: p.entry.r, x: p.entry.x, y: p.entry.y })) }
}) as Promise<{ bed: number[]; parts: { id: string; size: number[]; lo: number[]; hi: number[]; status: string; r: number[]; x: number; y: number }[] }>

test('Print workspace: bed, rotate a part flat, slice, preview with the layer slider', async ({ app, page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()
  // a tall block and a small cube: the block stands on its end
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 20, depth: 20, height: 60, position: [0, 0, 0] }))
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 25, depth: 25, height: 12, position: [60, 0, 0] }))
  await app.idle()
  await app.tab('Print')

  // the bed is drawn, the sidebar replaces the Browser, parts stand on the bed inside it
  await expect(page.getByTestId('print-sidebar')).toBeVisible()
  await expect(page.getByTestId('print-workspace')).toBeVisible()
  await expect(page.getByTestId('plate-size')).toContainText('256 x 256')
  expect(await app.ev((c) => !!c.three.scene.getObjectByName('print-bed'))).toBe(true)
  await expect.poll(async () => (await model(app)).parts.length).toBe(2)
  let m = await model(app)
  expect(m.bed).toEqual([256, 256, 256])
  for (const p of m.parts) {
    expect(p.status).toBe('ok')
    expect(p.lo[0]).toBeGreaterThanOrEqual(0)
    expect(p.hi[0]).toBeLessThanOrEqual(256)
    expect(p.lo[2]).toBe(0)
  }
  // the CAD model itself is untouched
  expect((await app.features()).filter((f) => f.type !== 'printSettings')).toHaveLength(2)
  await app.cameraStable()
  await shot(app, 'workspace-prepare')

  // the bed fills most of the free window (between the sidebar and the right edge)
  const free = await page.evaluate(() => { const r = document.querySelector('.vp-hole')!.getBoundingClientRect(); return { l: r.left, w: r.right } })
  const cs = [await app.project(0, 0, 0), await app.project(256, 0, 0), await app.project(256, 256, 0), await app.project(0, 256, 0)]
  const span = Math.max(...cs.map((c) => c.x)) - Math.min(...cs.map((c) => c.x))
  expect(span / (free.w - free.l)).toBeGreaterThan(0.6)
  expect(span / (free.w - free.l)).toBeLessThan(0.95)

  // drag a part on the bed with the mouse: it slides in X and Y, one undo step
  const cube = m.parts.find((p) => Math.abs(p.size[2] - 12) < 0.01)!
  const grab = await app.project(cube.x, cube.y, cube.size[2])
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 60, grab.y + 25, { steps: 6 })
  await page.mouse.move(grab.x + 120, grab.y + 40, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => { const p = (await model(app)).parts.find((q) => q.id === cube.id)!; return Math.hypot(p.x - cube.x, p.y - cube.y) }).toBeGreaterThan(5)
  const dragged = (await model(app)).parts.find((p) => p.id === cube.id)!
  expect(Math.hypot(dragged.x - cube.x, dragged.y - cube.y)).toBeGreaterThan(20)
  expect(dragged.lo[2]).toBe(0)
  expect((await app.features()).filter((f) => f.type !== 'printSettings')).toHaveLength(2)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await model(app)).parts.find((p) => p.id === cube.id)!.x).toBeCloseTo(cube.x, 1)
  expect((await model(app)).parts.find((p) => p.id === cube.id)!.y).toBeCloseTo(cube.y, 1)
  await page.keyboard.press('Control+y')
  await expect.poll(async () => (await model(app)).parts.find((p) => p.id === cube.id)!.x).toBeCloseTo(dragged.x, 1)
  await app.ev((c) => c.ui.getState().setSelection([]))

  // select the block and turn it onto its side with the readout field
  const block = m.parts.find((p) => Math.abs(p.size[2] - 60) < 0.01)!
  await app.ev((c, id) => c.ui.getState().setSelection([{ kind: 'body', id }]), block.id)
  await expect(page.getByTestId('part-readout')).toBeVisible()
  await page.getByTestId('tool-rotate').click()
  const rx = page.getByTestId('pose-Rx')
  await rx.fill('90')
  await rx.press('Enter')
  await expect.poll(async () => (await model(app)).parts.find((p) => p.id === block.id)!.size[2]).toBeCloseTo(20, 1)
  m = await model(app)
  const lying = m.parts.find((p) => p.id === block.id)!
  expect(lying.lo[2]).toBe(0)
  expect(lying.size[1]).toBeCloseTo(60, 1)
  await app.cameraStable()
  await shot(app, 'workspace-rotated')

  // undo takes the rotation back, redo brings it again: the placement lives in the document
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await model(app)).parts.find((p) => p.id === block.id)!.size[2]).toBeCloseTo(60, 1)
  await page.keyboard.press('Control+y')
  await expect.poll(async () => (await model(app)).parts.find((p) => p.id === block.id)!.size[2]).toBeCloseTo(20, 1)

  // the quick settings live in the sidebar: a layer height edit lands in the document, a filament can be added and removed again
  const side = page.getByTestId('print-sidebar')
  const lh = side.getByTestId('quick-layer_height').locator('input').first()
  await lh.fill('0.16')
  await lh.press('Enter')
  await expect.poll(async () => (await app.features()).find((f) => f.type === 'printSettings')?.params.layerHeight).toBe(0.16)
  await side.getByTestId('filament-add').click()
  await expect(side.getByTestId('filament-chip-1')).toBeVisible()
  await side.getByTestId('filament-remove').click()
  await expect(side.getByTestId('filament-chip-1')).toHaveCount(0)
  await side.getByTestId('all-settings').click()
  await expect(page.getByTestId('slice-sheet')).toBeVisible()
  await page.getByTestId('slice-close').click()

  // Lay on face: click the end of the block that faces the camera, and that end becomes the bottom (it stands upright again)
  await page.getByTestId('tool-face').click()
  const flat = (await model(app)).parts.find((p) => p.id === block.id)!
  const end = await app.project(flat.x, flat.lo[1], flat.size[2] / 2)
  await page.mouse.click(end.x, end.y)
  await expect.poll(async () => (await model(app)).parts.find((p) => p.id === block.id)!.size[2], { timeout: 15_000 }).toBeCloseTo(60, 1)
  await shot(app, 'workspace-lay-on-face')
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await model(app)).parts.find((p) => p.id === block.id)!.size[2]).toBeCloseTo(20, 1)

  // slice: the result opens in the preview with the layer slider, legend and summary card
  await page.getByTestId('slice-plate').click()
  await page.waitForFunction(() => ['done', 'error'].includes((window as any).__caddy.slicePreview.slice.getState().status), null, { timeout: 200_000 })
  expect(await app.ev((c) => c.slicePreview.slice.getState().message)).toBe('')
  await expect(page.getByTestId('slice-card')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('layer-slider')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('slice-legend')).toBeVisible()
  await expect(page.getByTestId('print-time')).toBeVisible()
  await expect(page.getByTestId('stage-preview')).toHaveAttribute('aria-checked', 'true')
  // the toolpaths sit on the bed under the parts' footprint (the block lies 60 mm long)
  const box = await app.ev((c) => {
    const tp = c.slicePreview.slice.getState().result.toolpaths
    const o = c.slicePreview.origin()
    const min = [Infinity, Infinity], max = [-Infinity, -Infinity]
    for (let i = 0; i < tp.extrusions.count; i++) for (let k = 0; k < 6; k++) { const v = tp.extrusions.positions[i * 6 + k] + o[k % 3]; if (k % 3 < 2) { min[k % 3] = Math.min(min[k % 3], v); max[k % 3] = Math.max(max[k % 3], v) } }
    return { min, max }
  })
  expect(box.min[0]).toBeGreaterThan(0)
  expect(box.max[0]).toBeLessThan(256)
  await app.cameraStable()
  await shot(app, 'workspace-preview')

  // the preview's pieces sit apart at the usual window sizes
  for (const [w, h] of [[1440, 900], [1280, 720], [1024, 768]] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(900)
    // a new window size: Frame All re-frames the bed for it
    await page.keyboard.press('F6')
    await app.cameraStable()
    const holeNow = await page.evaluate(() => { const r = document.querySelector('.vp-hole')!.getBoundingClientRect(); return { l: r.left, w: r.width } })
    const corners = [await app.project(0, 0, 0), await app.project(256, 0, 0), await app.project(256, 256, 0), await app.project(0, 256, 0)]
    const bedSpan = Math.max(...corners.map((c) => c.x)) - Math.min(...corners.map((c) => c.x))
    // the bed stays big in the preview (the Inspector column is given back to the view while Print has no dialog open)
    expect(bedSpan / holeNow.w, `bed width share at ${w}x${h}`).toBeGreaterThan(w === 1440 ? 0.5 : 0.4)
    const boxes = await page.evaluate(() => {
      const names: Record<string, string> = { bar: '.ws-top', legend: '.sp-legend, .sp-legend-btn', slider: '.sp-slider', card: '.sp-card .slice-card', scrub: '.sp-scrub', cube: '.viewcube' }
      return Object.fromEntries(Object.entries(names).map(([k, q]) => { const r = document.querySelector(q)?.getBoundingClientRect(); return [k, r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null] }))
    }) as Record<string, { l: number; t: number; r: number; b: number } | null>
    const keys = Object.keys(boxes)
    for (const k of keys) expect(boxes[k], `${k} at ${w}x${h}`).not.toBeNull()
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const a = boxes[keys[i]]!, b = boxes[keys[j]]!
      const overlap = a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1
      expect(overlap, `${keys[i]} overlaps ${keys[j]} at ${w}x${h}`).toBe(false)
    }
    const track = await page.evaluate(() => document.querySelector('.sp-slider-in')!.getBoundingClientRect().height)
    expect(track, `layer slider track at ${w}x${h}`).toBeGreaterThanOrEqual(200)
    if (w !== 1280) { await shot(app, `workspace-preview-${w}x${h}`) } else { await shot(app, 'workspace-preview-1280x720') }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(500)

  // back to Prepare: the parts are there again
  await page.getByTestId('stage-prepare').click()
  await expect(page.getByTestId('layer-slider')).toHaveCount(0)
  // a short window in Prepare: the top of the build volume stays clear of the ribbon and the bars
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForTimeout(900)
  await page.keyboard.press('F6')
  await app.cameraStable()
  const holeTop = await page.evaluate(() => document.querySelector('.vp-hole')!.getBoundingClientRect().top)
  const tops = [await app.project(0, 0, 256), await app.project(256, 0, 256), await app.project(256, 256, 256), await app.project(0, 256, 256)]
  expect(Math.min(...tops.map((t) => t.y))).toBeGreaterThanOrEqual(holeTop - 1)
  await shot(app, 'workspace-prepare-1024x768')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(500)
  expect(await app.ev((c) => c.three.scene.getObjectByName('bodies').visible)).toBe(true)

  // the phone layout: the setup is a bottom sheet and nothing scrolls sideways
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('print-sheet')).toBeVisible()
  await app.cameraStable()
  await shot(app, 'workspace-phone-prepare')
  await page.getByTestId('print-sheet').getByRole('button', { name: /Show the print setup/ }).click()
  await page.waitForTimeout(600)
  await shot(app, 'workspace-phone-sheet')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.getByTestId('print-sheet').getByRole('button', { name: /Hide the print setup/ }).click()
  await page.getByTestId('stage-preview').click()
  await expect(page.getByTestId('layer-slider')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(500)
  await shot(app, 'workspace-phone-preview')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
})
