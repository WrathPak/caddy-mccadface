import { test, expect } from './helpers'
import { addBox, addCylinder, frame, selectFace } from './detail-kit'

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#fff"/>
  <path fill-rule="evenodd" fill="#111" d="M50 4 A46 46 0 1 1 49.9 4 Z M50 18 A32 32 0 1 0 50.1 18 Z"/>
  <polygon fill="#111" points="50,28 56,44 73,44 60,54 65,71 50,61 35,71 40,54 27,44 44,44"/>
</svg>`

const emboss = (app: import('./helpers').App) => app.ev((c) => c.detail.getState().emboss && { w: c.detail.getState().emboss.width, wrapped: c.detail.getState().readout as string })

test('logo: an SVG wraps round a cylinder and is embossed', async ({ app, page }) => {
  await app.open()
  await addCylinder(app, 12, 30)
  await frame(app)
  const before = await app.volume()
  await selectFace(app, 'side')
  await app.ribbon(/^Logo$/).first().click()
  await app.inspector().getByTestId('file-input-logo').setInputFiles({ name: 'badge.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) })
  await expect(app.inspector().getByTestId('file-logo')).toContainText('badge.svg')
  await expect.poll(() => emboss(app), { timeout: 45_000 }).not.toBeNull()
  await app.field('Width', '16')
  await expect.poll(async () => (await emboss(app))?.w ?? 0, { timeout: 45_000 }).toBeCloseTo(16, 0)
  await app.inspector().locator('.seg button', { hasText: 'Wrap round' }).click()
  await expect(page.getByTestId('detail-readout')).toContainText('wrapped around the cylinder', { timeout: 45_000 })
  await app.ev((c) => c.runCommand('view.front'))
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('detail-logo-wrapped-preview')
  await app.ok()
  const feats = await app.features()
  expect(feats.map((f) => [f.type, f.state]), JSON.stringify(feats.map((f) => f.error))).toEqual([['cylinder', 'ok'], ['emboss', 'ok']])
  expect(await app.ev((c) => c.doc.getState().features[1].warning ?? null)).toBeNull()
  expect(await app.bodies()).toHaveLength(1)
  expect(await app.volume()).toBeGreaterThan(before + 10)
  // the logo file is stored in the project
  expect(await app.ev((c) => Object.keys(c.doc.getState().blobs).length)).toBe(1)
  await app.shot('detail-logo-wrapped-done')
})

test('logo: a PNG picture is traced and engraved, dark parts are the shape', async ({ app, page }) => {
  await app.open()
  await addBox(app)
  await frame(app)
  const before = await app.volume()
  await selectFace(app, 'top')
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 160
    const g = c.getContext('2d')!
    g.fillStyle = '#fff'; g.fillRect(0, 0, 160, 160)
    g.fillStyle = '#000'; g.beginPath(); g.arc(80, 80, 70, 0, 7); g.fill()
    g.fillStyle = '#fff'; g.beginPath(); g.arc(80, 80, 40, 0, 7); g.fill()
    return c.toDataURL('image/png').split(',')[1]
  })
  await app.ribbon(/^Logo$/).first().click()
  await app.inspector().getByTestId('file-input-logo').setInputFiles({ name: 'ring.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await app.inspector().locator('.seg button', { hasText: 'Engrave' }).click()
  await app.field('Width', '12')
  await expect.poll(() => app.ev((c) => c.detail.getState().emboss?.mode), { timeout: 45_000 }).toBe('engrave')
  await expect(app.inspector().locator('.field-label', { hasText: 'Threshold' })).toBeVisible()
  await page.waitForTimeout(700)
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('detail-logo-image-preview')
  await app.ok()
  expect((await app.features())[1].state).toBe('ok')
  expect(await app.volume()).toBeLessThan(before - 5)
})

test('texture: knurl preview on a decimated mesh, full detail on OK', async ({ app, page }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  await frame(app)
  const before = await app.volume()
  await selectFace(app, 'top')
  await app.ribbon(/^Texture$/).first().click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Texture')
  await expect.poll(() => app.ev((c) => c.detail.getState().texture?.mesh.indices.length / 3 || 0), { timeout: 60_000 }).toBeGreaterThan(500)
  const previewTris = await app.ev((c) => c.detail.getState().texture.mesh.indices.length / 3)
  // the original body is hidden while the preview stands in for it
  expect(await app.ev((c) => c.preview.getState().hidden.length)).toBe(1)
  await expect(page.getByTestId('detail-readout')).toContainText('Preview')
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('detail-texture-knurl-preview')
  // switch the pattern through the presets
  await app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Presets' }) }).locator('button.sel').click()
  await page.getByRole('option', { name: 'Honeycomb' }).click()
  await expect(app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: /^Pattern$/ }) }).locator('button.sel')).toContainText('Hexagons')
  await page.waitForTimeout(1500)
  await app.shot('detail-texture-hex-preview')
  await app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Presets' }) }).locator('button.sel').click()
  await page.getByRole('option', { name: 'Knurled grip' }).click()
  await expect(app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: /^Pattern$/ }) }).locator('button.sel')).toContainText('Knurl')
  await app.field('Depth', '0.5')
  await page.waitForTimeout(1500)
  expect(await app.ev((c) => c.ui.getState().inspectorNotice)).toBeNull()
  await app.ok()
  const feats = await app.features()
  expect(feats.map((f) => [f.type, f.state]), JSON.stringify(feats.map((f) => f.error))).toEqual([['box', 'ok'], ['texture', 'ok']])
  const bodies = await app.bodies()
  expect(bodies).toHaveLength(1)
  expect(bodies[0].tris).toBeGreaterThan(previewTris)
  expect(await app.volume()).toBeGreaterThan(before)
  expect((await app.bbox()).max[2]).toBeGreaterThan(20.3)
  expect((await app.bbox()).max[2]).toBeLessThanOrEqual(20.51)
  await app.ev((c) => c.runCommand('view.frame'))
  await app.shot('detail-texture-knurl-done')
})

test('texture: a picture as height map, and a wood grain wrapped on a cylinder', async ({ app, page }) => {
  await app.open()
  await addCylinder(app, 10, 30)
  await frame(app)
  await selectFace(app, 'side')
  await app.ribbon(/^Texture$/).first().click()
  await app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Presets' }) }).locator('button.sel').click()
  await page.getByRole('option', { name: 'Carbon weave' }).click()
  await expect.poll(() => app.ev((c) => c.detail.getState().texture?.mesh.indices.length || 0), { timeout: 60_000 }).toBeGreaterThan(500)
  await page.waitForTimeout(800)
  await app.shot('detail-texture-carbon-cylinder')
  // a gradient picture as the pattern
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    const grad = g.createLinearGradient(0, 0, 64, 0)
    grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff')
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64)
    return c.toDataURL('image/png').split(',')[1]
  })
  await app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: /^Pattern$/ }) }).locator('button.sel').click()
  await page.getByRole('option', { name: 'Picture (height map)' }).click()
  await app.inspector().getByTestId('file-input-image').setInputFiles({ name: 'ramp.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await expect(app.inspector().getByTestId('file-image')).toContainText('ramp.png')
  await page.waitForTimeout(2000)
  expect(await app.ev((c) => c.ui.getState().inspectorNotice)).toBeNull()
  await app.shot('detail-texture-picture-cylinder')
  await app.ok()
  expect((await app.features())[1].state).toBe('ok')
  expect(await app.bodies()).toHaveLength(1)
})
