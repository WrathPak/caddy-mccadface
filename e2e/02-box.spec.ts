import { test, expect } from './helpers'

test('Box: main button runs the tool, caret opens the menu, dropdown item no longer crashes', async ({ app, page }) => {
  await app.open()
  // main part of the split button runs the default tool directly (no menu)
  await app.ribbon('Box').first().click()
  await expect(page.locator('.menu')).toHaveCount(0)
  const insp = app.inspector()
  await expect(insp.locator('.panel-title')).toHaveText('Box')
  // every numeric field is populated (the original crash: undefined values on first render)
  const values = await insp.locator('.inp input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
  expect(values.length).toBeGreaterThanOrEqual(6)
  expect(values.every((v) => v !== '' && v !== 'NaN')).toBe(true)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1) // live preview
  await app.shot('box-dialog')
  await insp.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.inspector-foot')).toHaveCount(0)

  // only the caret opens the dropdown; choosing Box from it is the crash scenario from the bug report
  await page.getByRole('button', { name: 'Box options' }).click()
  await expect(page.locator('.menu')).toBeVisible()
  await expect(page.locator('.menu')).toContainText('Cylinder')
  await app.shot('box-menu')
  await page.getByRole('menuitem', { name: 'Box', exact: true }).click()
  await expect(insp.locator('.panel-title')).toHaveText('Box')
  expect(await insp.locator('.inp input').first().inputValue()).toBe('20')
  await app.ok()
  await expect.poll(() => app.tris()).toBeGreaterThan(0)
  expect((await app.bodies())).toHaveLength(1)
  const bb = await app.bbox()
  expect(bb.min).toEqual([-10, -10, 0])
  expect(bb.max).toEqual([10, 10, 20])
  await expect(page.locator('.status')).toContainText('Tris: 12')
  await app.shot('box-created')
})

test('every split button: main part acts, caret opens a menu', async ({ app, page }) => {
  await app.open()
  const carets = page.getByRole('button', { name: / options$/ })
  const n = await carets.count()
  expect(n).toBeGreaterThanOrEqual(3)
  for (let i = 0; i < n; i++) {
    await carets.nth(i).click()
    await expect(page.locator('.menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.menu')).toHaveCount(0)
  }
})
