import { test, expect } from './helpers'

test('user parameters: define one, use it in an expression, Esc closes the dialog', async ({ app, page }) => {
  await app.open()
  await app.ribbon('Parameters').click()
  const dlg = page.getByRole('dialog', { name: 'Parameters' })
  await expect(dlg).toBeVisible()
  await dlg.getByRole('button', { name: 'Add parameter' }).click()
  const inputs = dlg.locator('.inp input')
  await inputs.nth(0).fill('w')
  await inputs.nth(1).fill('12 mm')
  await expect(dlg).toContainText('12')
  await app.shot('parameters-dialog')
  await dlg.getByRole('button', { name: 'OK' }).click()
  await expect(dlg).toHaveCount(0)

  await app.ev((c) => c.runCommand('solid.box'))
  await app.field('Width', 'w * 2')
  await app.ok()
  const bb = await app.bbox()
  expect(bb.max[0] - bb.min[0]).toBeCloseTo(24, 4)

  await app.ribbon('Parameters').click()
  await expect(dlg).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
})

test('the app never talks to anything but localhost, including fonts and the worker', async ({ app, page }) => {
  const hosts = new Set<string>()
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.protocol.startsWith('http')) hosts.add(u.hostname)
  })
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await page.reload()
  await app.open()
  expect([...hosts]).toEqual(['localhost'])
})
