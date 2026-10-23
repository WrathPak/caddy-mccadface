import { test, expect } from './helpers'
import { writeCylinderFixture } from './fixtures'

test('import an STL cylinder -> move it -> extrude-cut into it', async ({ app, page }) => {
  const stl = writeCylinderFixture()
  await app.open()

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Import').click()])
  await chooser.setFiles(stl)
  await expect.poll(() => app.bodies().then((b) => b.length)).toBe(1)
  await app.idle()
  let feats = await app.features()
  expect(feats.map((f) => [f.type, f.state])).toEqual([['importMesh', 'ok']])
  const body = (await app.bodies())[0]
  expect(body.kind).toBe('mesh')
  expect(body.tris).toBeGreaterThan(100)
  const v0 = await app.volume()
  expect(v0).toBeGreaterThan(Math.PI * 64 * 30 * 0.97) // ~ pi r^2 h
  let bb = await app.bbox()
  expect(bb.max[2]).toBeCloseTo(30, 3)
  await app.shot('stl-imported')

  // select the body in the Browser tree and move it up by 5 mm
  await page.locator('.tree-row', { hasText: 'cylinder' }).first().click()
  await app.ribbon('Move').first().click()
  await expect(app.inspector().locator('.panel-title')).toContainText('Move')
  await app.vec('Translate', 2, '5')
  await app.shot('stl-move-dialog')
  await app.ok()
  feats = await app.features()
  expect(feats.map((f) => f.type)).toEqual(['importMesh', 'move'])
  expect(feats.every((f) => f.state === 'ok')).toBe(true)
  bb = await app.bbox()
  expect(bb.min[2]).toBeCloseTo(5, 3)
  expect(bb.max[2]).toBeCloseTo(35, 3)

  // sketch on the XZ plane, centred-ish rectangle across the cylinder, extrude symmetric + cut
  await app.sketchRect('XZ', 30, 12)
  await app.finishSketch()
  await app.ribbon('Extrude').first().click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  await app.field('Distance', '6')
  // operation = Cut
  await app.inspector().locator('.sel').first().click()
  await page.getByRole('option', { name: 'Cut' }).click()
  // direction = symmetric
  await app.inspector().getByRole('radio', { name: 'Symmetric' }).click()
  // target = the cylinder
  await page.locator('.tree-row', { hasText: 'cylinder' }).first().click()
  await app.inspector().locator('.field', { hasText: 'Target bodies' }).getByRole('button', { name: 'Use selection' }).click()
  await app.shot('stl-cut-dialog')
  await app.ok()
  feats = await app.features()
  expect(feats.map((f) => f.type)).toEqual(['importMesh', 'move', 'sketch', 'extrude'])
  expect(feats.map((f) => f.state), JSON.stringify(feats.map((f) => f.error))).toEqual(['ok', 'ok', 'ok', 'ok'])
  const bodies = await app.bodies()
  expect(bodies).toHaveLength(1)
  const v1 = await app.volume()
  expect(v1).toBeLessThan(v0 - 5)
  expect(v1).toBeGreaterThan(v0 * 0.5)
  await app.ev((c) => { c.runCommand('view.home'); })
  await app.shot('stl-cut-done')
})
