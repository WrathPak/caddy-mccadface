import { test, expect } from './helpers'

test('initial layout is Fusion-like: thin timeline, slim side panels', async ({ app, page }) => {
  await app.open()
  const sizes = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
    const groups = [...document.querySelectorAll('.dv-groupview')].map((g) => g.getBoundingClientRect())
    return { groups: groups.map((g) => ({ w: Math.round(g.width), h: Math.round(g.height) })), vp: r('.vp').toJSON(), tl: r('.tl').toJSON() }
  })
  const timeline = sizes.groups.find((g) => g.h < 130 && g.w > 600)!
  expect(timeline, 'timeline strip').toBeTruthy()
  expect(timeline.h).toBeGreaterThanOrEqual(60)
  expect(timeline.h).toBeLessThanOrEqual(100)
  const side = sizes.groups.filter((g) => g.w < 400)
  expect(side).toHaveLength(2)
  for (const s of side) {
    expect(s.w).toBeGreaterThanOrEqual(240)
    expect(s.w).toBeLessThanOrEqual(300)
  }
  expect(sizes.vp.height).toBeGreaterThan(550)
  await app.shot('layout-initial')
})

test('ribbon labels are short and never clipped', async ({ app, page }) => {
  await app.open()
  for (const tab of ['Solid', 'Mesh', 'Hair']) {
    await app.tab(tab)
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll('.ribbon-body .rbtn .lbl')]
        .filter((l) => l.scrollWidth > l.clientWidth + 1 || (l.parentElement && l.parentElement.scrollWidth > l.parentElement.clientWidth + 1))
        .map((l) => l.textContent),
    )
    expect(clipped, `clipped labels on ${tab}`).toEqual([])
  }
  await app.tab('Solid')
  await expect(app.ribbon('Import')).toBeVisible()
  await expect(app.ribbon('Export')).toBeVisible()
  await app.ribbon('Import').hover()
  await expect(page.locator('.tip')).toContainText('STL')
  await app.ribbon('Export').hover()
  await expect(page.locator('.tip')).toContainText('STEP')
  await app.shot('ribbon-solid')
})

test('layout persists across reloads and Reset layout restores it', async ({ app, page }) => {
  await app.open()
  const browserW = () => page.evaluate(() => Math.round(document.querySelector('.dv-groupview')!.getBoundingClientRect().width))
  const w0 = await browserW()
  // drag the sash between the Browser and the viewport
  const sash = page.locator('.dv-sash').first()
  const box = (await sash.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 200, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  const w1 = await browserW()
  expect(w1).toBeGreaterThan(w0 + 30)
  await page.reload()
  await app.open()
  expect(await browserW()).toBeGreaterThan(w0 + 30)
  // the saved layout still has all panels and hidden headers for viewport + timeline
  await expect(page.locator('.vp')).toBeVisible()
  await expect(page.locator('.tl')).toBeVisible()
  // Reset layout via the command palette
  await page.keyboard.press('s')
  await page.locator('.cmdk input').fill('reset layout')
  await page.keyboard.press('Enter')
  await expect.poll(browserW).toBeLessThan(w0 + 10)
  await app.shot('layout-reset')
})

test('a crashing panel shows an inline error with Reload panel; the app stays up', async ({ app, page }) => {
  app.allow(/boom/)
  await app.open()
  await app.ev((c) => {
    c.ui.getState().openInspector({
      schema: { id: 'x', title: 'Crashy', params: [{ type: 'number', key: 'a', label: 'A', default: 1, visibleWhen: () => { throw new Error('boom from test') } }] },
      values: { a: 1 }, onOk: () => {}, onCancel: () => c.ui.getState().closeInspector(),
    })
  })
  const err = page.locator('.panel-error')
  await expect(err).toBeVisible()
  await expect(err).toContainText('boom from test')
  // the rest of the app is alive
  await expect(page.locator('.ribbon')).toBeVisible()
  await expect(page.locator('.vp canvas')).toBeVisible()
  await app.shot('panel-error')
  await app.ev((c) => c.ui.getState().closeInspector())
  await err.getByRole('button', { name: 'Reload panel' }).click()
  await expect(err).toBeHidden()
  await expect(page.locator('.panel-title', { hasText: 'Inspector' })).toBeVisible()
})
