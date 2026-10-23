import fs from 'node:fs'
import { test, expect } from './helpers'

test('save (download fallback) -> reload -> open: same features and geometry', async ({ app, page }, info) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.field('Width', '24')
  await app.ok()
  await app.ev((c) => c.doc.getState().renameEntity('features', 'f1', 'My box'))
  await app.sketchRect('XY', 30, 20, { x: 450, y: 450 })
  await app.finishSketch()
  await app.ribbon('Extrude').first().click()
  await app.field('Distance', '7')
  await app.inspector().locator('.sel').first().click()
  await page.getByRole('option', { name: 'New body' }).click()
  await app.ok()
  const before = { feats: await app.features(), bodies: await app.bodies(), vol: await app.volume() }
  expect(before.feats.map((f) => f.state)).toEqual(['ok', 'ok', 'ok'])
  expect(before.bodies).toHaveLength(2)

  // Save: no File System Access API in this run, so the project downloads
  const [dl] = await Promise.all([page.waitForEvent('download'), app.ribbon('Save').click()])
  expect(dl.suggestedFilename()).toMatch(/\.caddy$/)
  const file = info.outputPath('project.caddy')
  await dl.saveAs(file)
  expect(fs.statSync(file).size).toBeGreaterThan(200)
  await expect(page.locator('.toast, [role="status"]').first()).toBeVisible()

  await page.reload()
  await app.open()
  expect(await app.features()).toEqual([])

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Open...').click()])
  await chooser.setFiles(file)
  await expect.poll(() => app.features().then((f) => f.length)).toBe(3)
  await app.idle()
  const after = { feats: await app.features(), bodies: await app.bodies(), vol: await app.volume() }
  expect(after.feats.map((f) => [f.id, f.type, f.name, f.params])).toEqual(before.feats.map((f) => [f.id, f.type, f.name, f.params]))
  expect(after.feats.map((f) => f.state)).toEqual(['ok', 'ok', 'ok'])
  expect(after.bodies.map((b) => [b.id, b.tris])).toEqual(before.bodies.map((b) => [b.id, b.tris]))
  expect(after.vol).toBeCloseTo(before.vol, 3)
  await app.shot('reopened')
})
