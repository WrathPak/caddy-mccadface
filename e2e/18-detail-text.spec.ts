import { test, expect, type App } from './helpers'

/** A default box with its top face selected and the Detail tab open. */
async function boxWithTopSelected(app: App) {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
  const sel = await app.ev((c) => {
    const b = c.doc.getState().geometry[0]
    const m = b.mesh
    for (let t = 0; t < m.indices.length / 3; t++) {
      const i = m.indices[t * 3] * 3
      if (m.normals[i + 2] > 0.99) return { kind: 'face', id: b.id, index: m.faceIds[t] }
    }
    return null
  })
  await app.ev((c, s) => c.ui.getState().setSelection([s]), sel)
  await app.tab('Detail')
}

const preview = (app: App) => app.ev((c) => c.detail.getState().emboss && { w: c.detail.getState().emboss.width, h: c.detail.getState().emboss.height, tris: c.detail.getState().emboss.mesh.indices.length / 3 })
const warning = (app: App) => app.ev((c) => c.doc.getState().features.at(-1).warning ?? null)

test('text: emboss on the top face, preview, change the text and font, OK adds the letters to the body', async ({ app, page }) => {
  await boxWithTopSelected(app)
  const before = await app.volume()
  const top = (await app.bbox()).max[2]
  await app.ribbon(/^Text$/).first().click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Text and logos')
  await expect.poll(() => preview(app), { timeout: 45_000 }).not.toBeNull()
  await app.field('Text height', '4')
  await expect.poll(async () => (await preview(app))?.h ?? 0, { timeout: 45_000 }).toBeLessThan(5)
  const p1 = await preview(app)
  expect(p1.tris).toBeGreaterThan(100)
  await expect(page.getByTestId('detail-readout')).toContainText('mm')
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('detail-text-preview')

  // type new text: the preview follows and gets wider
  const box = app.inspector().getByTestId('text-text')
  await box.fill('Hello Hello Hello')
  await expect.poll(async () => (await preview(app))?.w ?? 0, { timeout: 45_000 }).toBeGreaterThan(p1.w * 2.5)
  await expect(page.getByTestId('detail-readout')).toContainText('off the selected faces')
  // a different font changes the outline
  const wide = (await preview(app)).w
  await app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: /^Font$/ }) }).locator('button.sel').click()
  await page.getByRole('option', { name: 'Bebas Neue' }).click()
  await expect.poll(async () => (await preview(app))?.w ?? 0, { timeout: 45_000 }).toBeLessThan(wide * 0.9)
  await box.fill('CAD')
  await app.field('Depth', '1.2')
  await expect.poll(async () => (await preview(app))?.w ?? 99, { timeout: 45_000 }).toBeLessThan(12)
  await page.waitForTimeout(900)
  expect(await app.ev((c) => c.ui.getState().inspectorNotice)).toBeNull()
  await app.shot('detail-text-tweaked')

  await app.ok()
  const feats = await app.features()
  expect(feats.map((f) => [f.type, f.state]), JSON.stringify(feats.map((f) => f.error))).toEqual([['box', 'ok'], ['emboss', 'ok']])
  expect(feats[1].params.text).toBe('CAD')
  expect(await warning(app)).toBeNull()
  expect(await app.bodies()).toHaveLength(1)
  expect(await app.volume()).toBeGreaterThan(before + 3)
  expect((await app.bbox()).max[2]).toBeCloseTo(top + 1.2, 1)
  await app.ev((c) => c.runCommand('view.frame'))
  await app.shot('detail-text-done')
})

test('text: engrave cuts into the face and the dialog explains its settings', async ({ app, page }) => {
  await boxWithTopSelected(app)
  const before = await app.volume()
  const top = (await app.bbox()).max[2]
  await app.ribbon(/^Text$/).first().click()
  await expect.poll(() => preview(app), { timeout: 45_000 }).not.toBeNull()
  const dlg = app.inspector()
  // every label has a tooltip and the focused field a hint line
  const size = dlg.locator('.field', { has: page.locator('.field-label', { hasText: 'Text height' }) }).first()
  await app.labelTip(size.locator('.field-label'), /capital letter/)
  await size.locator('input').focus()
  await expect(dlg.getByTestId('field-hint')).toContainText('capital letter')
  await size.locator('input').blur()
  await app.field('Text height', '3')
  await dlg.locator('.seg button', { hasText: 'Engrave' }).click()
  await app.field('Depth', '0.8')
  await expect.poll(() => app.ev((c) => c.detail.getState().emboss?.mode)).toBe('engrave')
  await page.waitForTimeout(700)
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('detail-text-engrave-preview')
  await app.ok()
  expect(await app.volume()).toBeLessThan(before - 2)
  expect((await app.bbox()).max[2]).toBeCloseTo(top, 2)
  expect((await app.features())[1].state).toBe('ok')
  expect(await warning(app)).toBeNull()
  await app.ev((c) => c.runCommand('view.frame'))
  await app.shot('detail-text-engraved')
})

test('text: the frame moves the text over the surface, the round handle turns it, and typed values do the same', async ({ app, page }) => {
  await boxWithTopSelected(app)
  await app.ribbon(/^Text$/).first().click()
  await expect.poll(() => preview(app), { timeout: 45_000 }).not.toBeNull()
  await app.field('Text height', '3')
  await app.ev((c) => c.runCommand('view.top'))
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  const p0 = await app.ev((c) => c.detail.getState().emboss.point as number[])
  const top = p0[2]
  // drag the frame to another point of the top face
  const from = await app.project(p0[0], p0[1], top)
  const to = await app.project(p0[0] + 4, p0[1] - 3, top)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await app.ev((c) => c.detail.getState().emboss.point as number[]))[0], { timeout: 30_000 }).toBeGreaterThan(p0[0] + 2.5)
  const p1 = await app.ev((c) => c.detail.getState().emboss.point as number[])
  expect(p1[1]).toBeLessThan(p0[1] - 1.5)
  expect(p1[2]).toBeCloseTo(top, 3)
  expect((await app.ev((c) => c.ui.getState().inspector.values)).placed).toBe(true)
  // typing a rotation turns the preview
  await app.field('Rotation', '90')
  await expect.poll(() => app.ev((c) => c.detail.getState().emboss.rotation)).toBe(90)
  await page.waitForTimeout(600)
  await app.shot('detail-text-moved-turned')
  // the round handle sits beyond the top edge of the (turned) frame: pull it round to the +X side
  const em = await app.ev((c) => ({ p: c.detail.getState().emboss.point as number[], h: c.detail.getState().emboss.height as number }))
  const knob = await app.project(em.p[0] - (em.h / 2 + 0.6), em.p[1], top)
  const aim = await app.project(em.p[0] + 6, em.p[1], top)
  await page.mouse.move(knob.x, knob.y)
  await page.mouse.down()
  await page.mouse.move((knob.x + aim.x) / 2, knob.y + 25, { steps: 6 })
  await page.mouse.move(aim.x, aim.y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => app.ev((c) => c.detail.getState().emboss.rotation), { timeout: 30_000 }).toBeCloseTo(-90, -1)
  await app.ok()
  const feats = await app.features()
  expect(feats[1].state).toBe('ok')
  expect(feats[1].params.placed).toBe(true)
  expect(Math.abs((feats[1].params.rotation as number) + 90)).toBeLessThan(6)
})
