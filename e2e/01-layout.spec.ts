import { test, expect } from './helpers'

test('initial layout: slim floating side panels, a slim bottom dock, the model owns the rest', async ({ app, page }) => {
  await app.open()
  const sizes = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
    const groups = [...document.querySelectorAll('.dv-groupview')].map((g) => ({ box: g.getBoundingClientRect(), dock: !!g.querySelector('.bottom-dock'), hole: !!g.querySelector('.vp-hole') }))
    return { groups: groups.filter((g) => !g.hole).map((g) => ({ w: Math.round(g.box.width), h: Math.round(g.box.height), dock: g.dock })), vp: r('.vp').toJSON(), win: window.innerWidth }
  })
  const dock = sizes.groups.find((g) => g.dock)!
  expect(dock, 'the bottom dock').toBeTruthy()
  expect(dock.h).toBeGreaterThanOrEqual(44)
  expect(dock.h).toBeLessThanOrEqual(60)
  // nothing selected: the Inspector is not there, the Browser is a slim panel
  const side = sizes.groups.filter((g) => !g.dock && g.w > 0)
  expect(side).toHaveLength(1)
  expect(side[0].w).toBeGreaterThanOrEqual(240)
  expect(side[0].w).toBeLessThanOrEqual(300)
  // a tool opens it again, as a slim sheet of its own
  await app.ev((c) => c.runCommand('solid.box'))
  await expect(app.inspector()).toBeVisible()
  const insp = await app.inspector().evaluate((el) => Math.round(el.closest('.dv-groupview')!.getBoundingClientRect().width))
  expect(insp).toBeGreaterThanOrEqual(240)
  expect(insp).toBeLessThanOrEqual(300)
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
  await expect(page.locator('.inspector-empty')).toHaveCount(1) // (an empty Inspector is not shown at all)
})
