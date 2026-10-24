import { test, expect } from './helpers'
import { addBox, addCylinder, frame, selectFace } from './detail-kit'

const kinds = [
  { cmd: /^Fur$/, title: 'Fur', noun: 'strands', side: false },
  { cmd: /^Spikes$/, title: 'Spikes', noun: 'spikes', side: false },
  { cmd: /^Grass$/, title: 'Grass', noun: 'blades', side: false },
  { cmd: /^Scales$/, title: 'Scales', noun: 'scales', side: true },
] as const

for (const k of kinds) {
  test(`${k.title.toLowerCase()}: preview, a preset, OK gives one merged solid`, async ({ app, page }) => {
    await app.open()
    if (k.side) await addCylinder(app, 12, 36)
    else await addBox(app, 40, 40, 10)
    await frame(app)
    const before = await app.volume()
    await selectFace(app, k.side ? 'side' : 'top')
    await app.ribbon(k.cmd).first().click()
    await expect(app.inspector().locator('.panel-title')).toHaveText(k.title)
    await expect.poll(() => app.ev((c) => c.hair.getState().result?.strands.indices.length || 0), { timeout: 60_000 }).toBeGreaterThan(300)
    await expect(page.getByTestId('detail-readout')).toContainText(k.noun)
    // every preset is offered and changes the look
    const presets = app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Presets' }) }).locator('button.sel')
    await presets.click()
    const count = await page.getByRole('option').count()
    expect(count).toBeGreaterThanOrEqual(5)
    await page.getByRole('option').nth(1).click()
    await page.waitForTimeout(1800)
    expect(await app.ev((c) => c.ui.getState().inspectorNotice)).toBeNull()
    await app.ev((c) => c.runCommand('view.frame'))
    await app.cameraStable()
    await app.shot(`detail-${k.title.toLowerCase()}-preview`)
    // plain-language help on the labels
    await expect(app.inspector().locator('.field-label').first()).toHaveAttribute('title', /.{12}/)
    await app.ok()
    const feats = await app.features()
    expect(feats.map((f) => f.state), JSON.stringify(feats.map((f) => f.error))).toEqual(['ok', 'ok'])
    expect(await app.bodies()).toHaveLength(1)
    expect(await app.volume()).toBeGreaterThan(before)
    await app.ev((c) => c.runCommand('view.frame'))
    await app.shot(`detail-${k.title.toLowerCase()}-done`)
  })
}

test('fur: the wall variant works on a side face and the up-facing variant needs no wall', async ({ app, page }) => {
  await app.open()
  await addBox(app, 30, 30, 24)
  await frame(app)
  await selectFace(app, 'sideX')
  await app.ribbon(/^Fur$/).first().click()
  await expect.poll(() => app.ev((c) => c.hair.getState().result?.strands.indices.length || 0), { timeout: 60_000 }).toBeGreaterThan(300)
  await app.inspector().locator('.opt-row', { hasText: 'Side faces, with wall' }).click()
  await expect.poll(() => app.ev((c) => !!c.hair.getState().result?.wall), { timeout: 60_000 }).toBe(true)
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('detail-fur-wall-preview')
  await app.inspector().locator('.opt-row', { hasText: 'Up-facing, no wall' }).click()
  await expect.poll(() => app.ev((c) => c.hair.getState().result && !c.hair.getState().result.wall), { timeout: 60_000 }).toBe(true)
  expect(await app.ev((c) => c.ui.getState().inspectorNotice)).toBeNull()
  await app.ok()
  expect((await app.features())[1].state).toBe('ok')
})
