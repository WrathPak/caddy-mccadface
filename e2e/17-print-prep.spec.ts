import fs from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { test, expect, type App } from './helpers'

async function addBox(app: App, size: [number, number, number], position: [number, number, number]) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size[0], depth: a.size[1], height: a.size[2], position: a.position }), { size, position })
  await app.idle()
}
async function frame(app: App) {
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}
async function selectField(app: App, label: string, option: string) {
  await app.inspector().locator('.field', { has: app.page.locator('.field-label', { hasText: label }) }).locator('button.sel').click()
  await app.page.getByRole('option', { name: option }).click()
}
const states = async (app: App) => {
  const f = await app.features()
  expect(f.map((x) => x.state), JSON.stringify(f.map((x) => x.error))).toEqual(f.map(() => 'ok'))
  return f
}
async function unzipDownload(page: import('@playwright/test').Page, click: () => Promise<void>) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()])
  const bytes = new Uint8Array(fs.readFileSync((await dl.path())!))
  return { name: dl.suggestedFilename(), files: unzipSync(bytes) }
}

test('PRINT tab: ribbon groups and the Print settings dialog', async ({ app, page }) => {
  await app.open()
  await app.tab('Print')
  for (const name of ['Print Settings', 'Bambu Studio', 'OrcaSlicer', 'Export 3MF', 'Paint Body', 'Paint Faces', 'Overhangs', 'Thin Walls', 'Small Features', 'Auto Orient', 'Split Body', 'Hollow']) {
    await expect(app.ribbon(name)).toBeVisible()
  }
  await app.ribbon('Print Settings').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Print settings')
  await app.field('Layer height', '0.16')
  await app.field('Wall loops', '4')
  await selectField(app, 'Printer', 'Bambu Lab A1 mini')
  await app.shot('print-settings')
  await app.ok()
  const f = (await states(app)).filter((x) => x.type === 'printSettings')
  expect(f).toHaveLength(1)
  expect(f[0].params).toMatchObject({ layerHeight: 0.16, wallLoops: 4, printer: 'a1mini' })
  // opening it again edits the same feature
  await app.ribbon('Print Settings').click()
  await expect(app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Layer height' }) }).locator('input').first()).toHaveValue('0.16')
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  expect((await app.features()).filter((x) => x.type === 'printSettings')).toHaveLength(1)
})

test('paint a body and a face: colors show in the viewport and go into the 3MF as filament slots', async ({ app, page }) => {
  await app.open()
  await addBox(app, [30, 30, 12], [0, 0, 0])
  await addBox(app, [20, 20, 20], [60, 0, 0])
  await frame(app)
  await app.tab('Print')
  // whole body: the second box goes to filament 3 (red)
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: 'f2' }]))
  await app.ribbon('Paint Body').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Paint')
  await selectField(app, 'Filament', 'Filament 3')
  await expect(app.page.getByTestId('info-swatch')).toContainText('Red')
  await app.ok()
  // one face: the top of the first box to filament 2 (black)
  const top = await app.ev((c) => {
    const m = c.doc.getState().geometry[0].mesh
    for (let t = 0; t < m.indices.length / 3; t++) if (m.normals[m.indices[t * 3] * 3 + 2] > 0.99) return m.faceIds[t] as number
    return -1
  })
  await app.ev((c, i) => { c.ui.getState().setSelectionFilter('face'); c.ui.getState().setSelection([{ kind: 'face', id: 'f1', index: i }]) }, top)
  await app.ribbon('Paint Faces').click()
  await expect(app.page.locator('.hair-bar')).toBeVisible() // the brush, face and fill tools of the hair selection
  await selectField(app, 'Filament', 'Filament 2')
  await app.ok()
  const feats = await states(app)
  expect(feats.filter((f) => f.type === 'paint').map((f) => f.params.slot)).toEqual(['3', '2'])
  // the overlay meshes carry the filament colors
  const colors = await app.ev((c) => {
    const out: Record<string, number> = {}
    c.three.scene.getObjectByName('print-paint-layer').traverse((o: any) => { if (o.isMesh) out[o.material.color.getHexString()] = (out[o.material.color.getHexString()] ?? 0) + 1 }) // eslint-disable-line
    return out
  })
  expect(colors).toEqual({ '1c1c1e': 1, d63a31: 1 })
  await expect(page.getByTestId('filament-legend')).toContainText('Filament 3: Red')
  await app.ev((c) => c.ui.getState().clearSelection())
  await app.shot('print-painted')

  // export: every visible body is an object, painted ones use their filament
  const { name, files } = await unzipDownload(page, () => app.ribbon('Export 3MF').click())
  expect(name).toBe('Untitled.3mf')
  const ms = strFromU8(files['Metadata/model_settings.config'])
  const objs = [...ms.matchAll(/<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"\/>\s*<metadata key="extruder" value="(\d+)"/g)].map((m) => [m[2], m[3]])
  expect(objs).toEqual([['Box1', '1'], ['Box2', '3']])
  expect(strFromU8(files['3D/Objects/object_1.model']).match(/paint_color="8"/g)!.length).toBeGreaterThan(1)
  const cfg = JSON.parse(strFromU8(files['Metadata/project_settings.config']))
  expect(cfg.filament_colour).toEqual(['#F4F4F1', '#1C1C1E', '#D63A31'])
})

test('send to Bambu Studio / OrcaSlicer: saves through the file picker with a hint; without a picker it downloads with a hint', async ({ app, page }) => {
  await app.open()
  await addBox(app, [30, 30, 12], [0, 0, 0])
  await app.tab('Print')
  // no file picker (the default for these specs): a download and a clear hint
  const { name } = await unzipDownload(page, () => app.ribbon('Bambu Studio').click())
  expect(name).toBe('Untitled.3mf')
  await expect(page.getByText(/File > Open/)).toBeVisible()

  // with a file picker: the file is written where the user chose, and the hint names the slicer
  await page.evaluate(() => {
    const w = window as any // eslint-disable-line
    w.__written = []
    w.showSaveFilePicker = async (o: { suggestedName: string }) => ({
      name: o.suggestedName,
      createWritable: async () => ({ write: async (d: Uint8Array) => { w.__written.push(d.length) }, close: async () => {} }),
    })
  })
  await app.ribbon('Bambu Studio').click()
  await expect(page.getByText(/Saved Untitled.3mf.*Open it in Bambu Studio with File > Open/)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__written[0] as number)).toBeGreaterThan(1000) // eslint-disable-line
  await app.ribbon('OrcaSlicer').click()
  await expect(page.getByText(/Open it in OrcaSlicer with File > Open/)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__written.length as number)).toBe(2) // eslint-disable-line
})

test('overhang, thin wall and small feature maps with legends', async ({ app, page }) => {
  await app.open()
  // a plate on a post (ceiling overhang), a thin fin and a thin pin
  await addBox(app, [10, 10, 20], [0, 0, 0])
  await addBox(app, [60, 60, 4], [0, 0, 20])
  await app.ev((c) => c.doc.getState().addFeature('combine', { target: ['f1'], tools: ['f2'], operation: 'join', keepTools: false }))
  await app.idle()
  await addBox(app, [0.5, 20, 8], [50, 0, 0])
  await addBox(app, [0.3, 0.3, 6], [-50, 0, 0])
  await states(app)
  await frame(app)
  await app.tab('Print')
  const flagged = () => app.ev((c) => c.print.view.getState().result?.flagged ?? -1)

  await app.ribbon('Overhangs').click()
  await expect(page.getByTestId('map-panel')).toContainText('Overhang map')
  await expect(page.getByTestId('map-legend')).toContainText('flat ceiling')
  await expect.poll(flagged).toBeGreaterThan(0)
  await expect(page.getByTestId('map-result')).toContainText('needs support at 45 deg')
  const sev = await app.ev((c) => c.three.scene.getObjectByName('print-analysis').children.length)
  expect(sev).toBeGreaterThan(0)
  await app.shot('print-overhang')
  // a steeper limit than any surface here (nothing leans past 85 degrees except the flat ceiling at 90)
  await page.getByTestId('map-threshold').fill('85')
  await expect.poll(() => app.ev((c) => c.print.view.getState().angle)).toBe(85)
  await expect.poll(flagged).toBeGreaterThan(0)

  await app.ribbon('Thin Walls').click()
  await expect(page.getByTestId('map-panel')).toContainText('Thin walls')
  await expect.poll(flagged).toBeGreaterThan(0)
  await expect(page.getByTestId('map-result')).toContainText('thinner than 0.8 mm')
  await expect(page.getByTestId('map-result')).toContainText('The thinnest is 0.30 mm')
  await app.shot('print-thin-walls')
  await page.getByTestId('map-threshold').fill('0.2')
  await expect(page.getByTestId('map-result')).toContainText('No wall thinner than 0.2 mm')

  await app.ribbon('Small Features').click()
  await expect(page.getByTestId('map-panel')).toContainText('Small features')
  await expect.poll(flagged).toBeGreaterThan(0)
  await expect(page.getByTestId('map-result')).toContainText('small features narrower than 0.4 mm')
  await app.shot('print-small-features')

  // the same button closes the map
  await app.ribbon('Small Features').click()
  await expect(page.getByTestId('map-panel')).toHaveCount(0)
  expect(await app.ev((c) => c.three.scene.getObjectByName('print-analysis').children.length)).toBe(0)
})

test('auto orient turns a T the right way up and applies a Move', async ({ app, page }) => {
  await app.open()
  // a plate hanging over a 20 mm post
  await addBox(app, [10, 10, 20], [0, 0, 0])
  await addBox(app, [60, 60, 4], [0, 0, 20])
  await app.ev((c) => c.doc.getState().addFeature('combine', { target: ['f1'], tools: ['f2'], operation: 'join', keepTools: false }))
  await app.idle()
  // tip it over so the best answer is not the one it has
  await app.ev((c) => c.doc.getState().addFeature('move', { bodyIds: ['f1'], gizmo: 'rotate', translate: [0, 0, 40], rotate: [180, 0, 0], scale: 1 }))
  await app.idle()
  await frame(app)
  await app.tab('Print')
  await app.ribbon('Auto Orient').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Auto orient')
  await expect(app.page.getByTestId('info-report')).toContainText('Option 1')
  const report = await app.page.getByTestId('info-report').innerText()
  expect(report).toMatch(/Now: [\d.]+ mm3 of support/)
  // the preview is on the bodies
  expect(await app.ev((c) => c.doc.getState().features.length)).toBe(4)
  await app.shot('print-auto-orient')
  await app.ok()
  const feats = await states(app)
  const mv = feats[feats.length - 1]
  expect(mv.type).toBe('move')
  expect(mv.name).toBe('Orient for printing')
  const bb = await app.bbox('f1')
  expect(bb.min[2]).toBeCloseTo(0, 2)
  // no overhang is left
  await app.ribbon('Overhangs').click()
  await expect.poll(() => app.ev((c) => c.print.view.getState().result?.kind ?? null)).toBe('overhang')
  await expect(page.getByTestId('map-result')).toContainText('prints without support')
})

test('split a body with a plane and round pins', async ({ app, page }) => {
  await app.open()
  await addBox(app, [40, 30, 20], [0, 0, 0])
  await frame(app)
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: 'f1' }]))
  await app.tab('Print')
  await app.ribbon('Split Body').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Split body')
  await app.field('Offset', '10')
  await selectField(app, 'Connectors', 'Round pins')
  await app.field('Count', '2')
  await app.field('Size', '6')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(2)
  await expect(page.locator('.field-label', { hasText: 'Dovetail angle' })).toHaveCount(0)
  await app.shot('print-split')
  await app.ok()
  const feats = await states(app)
  expect(feats.map((f) => f.type)).toEqual(['box', 'split'])
  const bodies = await app.bodies()
  expect(bodies.map((b) => b.name)).toEqual(['Box1 1', 'Box1 2'])
  const v1 = await app.volume('f1'), v2 = await app.volume('f2.1')
  const pin = Math.PI * 9 * 6, hole = Math.PI * 3.2 * 3.2 * 6.2
  expect(v1).toBeCloseTo(40 * 30 * 10 + 2 * pin, -1)
  expect(v2).toBeCloseTo(40 * 30 * 10 - 2 * hole, -1)
  // dovetails add their angle field
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: 'f2.1' }]))
  await app.ribbon('Split Body').click()
  await selectField(app, 'Connectors', 'Dovetails')
  await expect(page.locator('.field-label', { hasText: 'Dovetail angle' })).toBeVisible()
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
})

test('hollow a body and place a drain hole by clicking its surface', async ({ app, page }) => {
  await app.open()
  await addBox(app, [20, 20, 20], [0, 0, 0])
  await frame(app)
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: 'f1' }]))
  await app.tab('Print')
  await app.ribbon('Hollow').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Hollow')
  await app.field('Wall thickness', '2')
  await app.field('Drain hole diameter', '4')
  await expect(app.page.getByTestId('info-drainInfo')).toContainText('None yet')
  await page.getByTestId('drain-bar').getByRole('button', { name: /Add drain holes/ }).click()
  const p = await app.project(0, 0, 20)
  await page.mouse.click(p.x, p.y)
  await expect(page.getByTestId('drain-count')).toHaveText('1 hole')
  await expect(app.page.getByTestId('info-drainInfo')).toContainText('1 drain hole')
  // leave placing mode: the preview is the hollowed body with the hole in it
  await page.getByTestId('drain-bar').getByRole('button', { name: /Add drain holes/ }).click()
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.shot('print-hollow')
  await app.ok()
  const feats = await states(app)
  const hollow = feats[feats.length - 1]
  expect(hollow.type).toBe('hollow')
  expect((hollow.params.drains as string[]).length).toBe(1)
  const solid = 20 * 20 * 20
  const v = await app.volume('f1')
  expect(v).toBeLessThan(solid - 16 ** 3 + 1) // the cavity is 16 mm cube
  expect(v).toBeGreaterThan(solid - 16 ** 3 - Math.PI * 4 * 2 * 1.1)
  // the cavity is open to the outside through the hole: it is one shell with a hole, so the surface has the hole's wall
  const faces = await app.ev((c) => c.doc.getState().geometry[0].mesh.faceCount as number)
  expect(faces).toBeGreaterThan(12)
})
