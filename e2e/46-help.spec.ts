import { test, expect } from './helpers'
import type { Page } from '@playwright/test'

/** The first-run tour is off for every spec by the fixture; this puts it back for the pages that need it. */
const tourOn = (page: Page) => page.addInitScript(() => { ;(window as unknown as Record<string, unknown>).__e2eNoTour = false })

/** Move the pointer off whatever it is on, in several steps: a tooltip closes on the pointer move after the one that leaves it. */
const away = async (page: Page) => {
  await page.mouse.move(700, 450, { steps: 6 })
  await page.mouse.move(760, 520, { steps: 6 })
}

const openSettings = async (page: Page, section?: string) => {
  await page.getByTestId('settings-gear').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  if (section) await page.getByTestId('settings-dialog-nav-' + section).click()
}
const closeSettings = async (page: Page) => {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
}
const openHelp = async (page: Page, item: string | RegExp) => {
  await page.getByTestId('help-menu').click()
  await page.getByRole('menuitem', { name: item }).click()
  await expect(page.getByTestId('help-dialog')).toBeVisible()
}

test('hovering a ribbon button shows its name, shortcut, what it does and what to select; keyboard focus does too', async ({ app, page }) => {
  await app.open()
  await app.ribbon('Extrude').hover()
  const tip = page.locator('.tip')
  await expect(tip).toContainText('Extrude')
  await expect(tip.locator('.kbd')).toHaveText('E')
  await expect(tip).toContainText('Push a flat sketch shape up into a solid')
  await expect(tip).toContainText('Select')
  await expect(tip).toContainText('closed sketch shape')
  await app.shot('help-tooltip')
  // moving away puts it away again
  await away(page)
  await expect(page.locator('.tip')).toHaveCount(0)
  // keyboard focus shows it as well
  await app.ribbon('Fillet').focus()
  await expect(page.locator('.tip')).toContainText('Round off sharp edges')
  await expect(page.locator('.tip .kbd')).toHaveText('Shift+F')
  // other parts of the screen have them too: status bar, viewport toolbar, Browser eye
  await away(page)
  await page.locator('.status .cell', { hasText: 'Units' }).hover()
  await expect(page.locator('.tip')).toContainText('millimetres or inches')
  await away(page)
  await page.locator('.vp-toolbar').getByRole('button', { name: 'Grid' }).hover()
  await expect(page.locator('.tip')).toContainText('floor')
  // an Inspector field label explains itself, over the viewport side
  await app.ev((c) => c.runCommand('solid.box'))
  await away(page)
  await page.locator('.field-label', { hasText: 'Width' }).hover()
  await expect(page.locator('.tip')).toContainText('Size of the box along the X axis')
})

test('timeline chips and Browser rows have tooltips', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await expect(page.locator('.tl .chip')).toHaveCount(1)
  await page.locator('.tl .chip').first().hover()
  await expect(page.locator('.tip')).toContainText('double-click or press Enter')
  await away(page)
  await page.locator('.tree-row', { hasText: 'Bodies' }).locator('.name').hover()
  await expect(page.locator('.tip')).toContainText('open or close this group')
})

test('Settings: the dialog opens from the gear, sections switch, units change a field in the Inspector', async ({ app, page }) => {
  await app.open()
  await openSettings(page)
  await app.shot('help-settings')
  await expect(page.getByTestId('settings-dialog-nav-general')).toHaveAttribute('data-active', 'true')
  await page.getByTestId('settings-dialog').getByRole('radio', { name: 'Inches' }).click()
  expect(await app.ev((c) => c.ui.getState().units)).toBe('in')
  await expect(page.locator('.status .cell', { hasText: 'Units' })).toContainText('in')
  await closeSettings(page)

  await app.ev((c) => c.runCommand('solid.box'))
  const width = app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Width' }) }).locator('input')
  await expect(width).toHaveValue('0.7874') // 20 mm
  await expect(app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Width' }) }).locator('.unit')).toHaveText('in')
  await app.field('Width', '1')
  await app.ok()
  const box = (await app.features()).find((f) => f.type === 'box')!
  expect(box.params.width).toBeCloseTo(25.4, 6)

  // saved, and still there after a reload
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.settings') ?? '{}').units)).toBe('in')
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  expect(await app.ev((c) => c.ui.getState().units)).toBe('in')
})

test('Settings: theme, grid, grid spacing, display style and AO take effect and are remembered', async ({ app, page }) => {
  await app.open()
  await openSettings(page, 'general')
  const dlg = page.getByTestId('settings-dialog')
  await dlg.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await app.shot('help-settings-light')
  await dlg.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // the autosave interval only shows while autosave is on
  await expect(page.getByTestId('set-autosave-interval')).toBeVisible()
  await dlg.getByRole('checkbox', { name: 'Autosave' }).click()
  await expect(page.getByTestId('set-autosave-interval')).toHaveCount(0)

  await page.getByTestId('settings-dialog-nav-display').click()
  expect(await app.ev((c) => c.ui.getState().showGrid)).toBe(true)
  await dlg.getByRole('checkbox', { name: 'Ground grid' }).click()
  expect(await app.ev((c) => c.ui.getState().showGrid)).toBe(false)
  await dlg.getByRole('checkbox', { name: 'Ambient occlusion' }).click()
  expect(await app.ev((c) => c.ui.getState().ssao)).toBe(false)
  await dlg.getByRole('radio', { name: 'Coarse' }).click()
  await dlg.getByTestId('set-display').locator('button[role=combobox]').click()
  await page.getByRole('option', { name: 'Wireframe' }).click()
  expect(await app.ev((c) => c.ui.getState().displayMode)).toBe('wireframe')
  await closeSettings(page)
  // the toolbar button shows the state set in the dialog
  await expect(page.locator('.vp-toolbar').getByRole('button', { name: 'Grid' })).toHaveAttribute('data-active', 'false')

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.settings') ?? '{}'))
  expect(s).toMatchObject({ showGrid: false, ssao: false, displayMode: 'wireframe', gridDensity: 'coarse', autosave: false })
  expect(await app.ev((c) => [c.ui.getState().showGrid, c.ui.getState().ssao, c.ui.getState().displayMode])).toEqual([false, false, 'wireframe'])
})

test('Settings: zoom direction and orbit speed are saved with the navigation settings; the Help page turns tooltips off', async ({ app, page }) => {
  await app.open()
  await openSettings(page, 'navigation')
  const dlg = page.getByTestId('settings-dialog')
  await dlg.getByRole('radio', { name: 'Reverse' }).click()
  await dlg.getByRole('radio', { name: '2x' }).click()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.nav') ?? '{}'))).toMatchObject({ zoomDirection: 'reverse', orbitSpeed: 2 })
  await page.getByTestId('settings-dialog-nav-help').click()
  await dlg.getByRole('checkbox', { name: 'Show tooltips' }).click()
  await closeSettings(page)
  await app.ribbon('Extrude').hover()
  await page.waitForTimeout(900)
  await expect(page.locator('.tip')).toHaveCount(0)
})

test('Settings: reversing the zoom direction flips what the wheel does', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await app.cameraStable()
  const dist = () => page.evaluate(() => (window as any).__nav.pose().dist as number) // eslint-disable-line
  const b = (await page.locator('.vp canvas').boundingBox())!
  const wheelDown = async () => {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.wheel(0, 240)
    await app.cameraStable()
  }
  const d0 = await dist()
  await wheelDown()
  expect(await dist()).toBeGreaterThan(d0) // normal: scrolling down zooms out
  await openSettings(page, 'navigation')
  await page.getByTestId('settings-dialog').getByRole('radio', { name: 'Reverse' }).click()
  await closeSettings(page)
  const d1 = await dist()
  await wheelDown()
  expect(await dist()).toBeLessThan(d1) // reversed
})

test('Help menu: the shortcuts page lists the registered commands, and follows a new one', async ({ app, page }) => {
  await app.open()
  await openHelp(page, 'Keyboard shortcuts')
  const pane = page.getByTestId('shortcuts-page')
  await expect(pane).toContainText('Extrude')
  const row = (name: string, keys: string) => pane.getByTestId('shortcut-row').filter({ hasText: name }).filter({ hasText: keys })
  await expect(row('Extrude', 'E').first()).toBeVisible()
  await expect(row('Fillet', 'Shift+F')).toBeVisible()
  await expect(row('Save', 'Ctrl+S').first()).toBeVisible()
  // every command with a key is there: compare with the registry
  const reg: { id: string; label: string; shortcut: string }[] = await app.ev((c) => c.allCommands().filter((x: any) => x.shortcut).map((x: any) => ({ id: x.id, label: x.label, shortcut: x.shortcut }))) // eslint-disable-line
  expect(reg.length).toBeGreaterThan(20)
  const texts = await pane.getByTestId('shortcut-row').allInnerTexts()
  for (const c of reg) expect(texts.some((t) => t.includes(c.shortcut)), c.id).toBe(true)
  await pane.getByLabel('Filter shortcuts').fill('fillet')
  await expect(pane.getByTestId('shortcut-row')).toHaveCount(1)
  await app.shot('help-shortcuts')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('help-dialog')).toHaveCount(0)
})

test('Help: Getting started, workspace guides and About, from the ? menu and F1', async ({ app, page }) => {
  await app.open()
  await page.keyboard.press('F1')
  await expect(page.getByTestId('start-page')).toBeVisible()
  await expect(page.getByTestId('start-page')).toContainText('Coming from Fusion 360')
  const dlg = page.getByTestId('help-dialog')
  for (const [nav, text] of [['guide:hair', 'sacrificial wall'], ['guide:surface', 'Stitch'], ['guide:print', 'Auto Orient'], ['guide:solid', 'Fillet'], ['about', 'MIT licensed']] as const) {
    await dlg.getByTestId('help-dialog-nav-' + nav).click()
    await expect(dlg.getByTestId('help-dialog-pane')).toContainText(text)
  }
  await dlg.getByTestId('help-dialog-nav-guide:hair').click()
  await expect(dlg.getByTestId('guide-page')).toContainText('scissors')
  await app.shot('help-guide-hair')
  await page.keyboard.press('Escape')
  // the menu opens the guide of the workspace you are in
  await app.tab('Hair')
  await openHelp(page, /Hair guide/)
  await expect(dlg.getByTestId('guide-page')).toHaveAttribute('data-guide', 'hair')
})

test('the Inspector ? opens the guide at the section for that tool', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.cylinder'))
  await expect(app.inspector().getByTestId('tool-intro')).toContainText('round post')
  await app.inspector().getByTestId('inspector-help').click()
  const dlg = page.getByTestId('help-dialog')
  await expect(dlg.getByTestId('guide-page')).toHaveAttribute('data-guide', 'solid')
  await page.keyboard.press('Escape')
  await app.ev((c) => c.runCommand('edit.escape'))
  await app.tab('Hair')
  await app.ev((c) => c.runCommand('hair.create'))
  await app.inspector().getByTestId('inspector-help').click()
  await expect(dlg.getByTestId('guide-page')).toHaveAttribute('data-guide', 'hair')
  await expect(dlg.locator('[data-section="flow"]')).toHaveAttribute('data-highlight', 'true')
  await app.shot('help-guide-from-inspector')
})

test('an empty document shows a hint in the viewport that goes away with the first geometry', async ({ app, page }) => {
  await app.open()
  const hint = page.getByTestId('empty-hint')
  await expect(hint).toContainText('Start with a sketch, or import an STL')
  await app.shot('help-empty')
  await app.tab('Mesh')
  await expect(hint).toContainText('Import an STL or 3MF')
  await app.tab('Solid')
  await app.ev((c) => c.runCommand('solid.box'))
  await expect(hint).toHaveCount(0) // a tool is open
  await app.ok()
  await expect(hint).toHaveCount(0)
  await app.ev((c) => c.runCommand('file.new'))
  // switching it off in Settings hides it for good
  await openSettings(page, 'help')
  await page.getByTestId('settings-dialog').getByRole('checkbox', { name: 'Show beginner tips' }).click()
  await closeSettings(page)
  await expect(page.getByTestId('empty-hint')).toHaveCount(0)
})

test.describe('the intro tour', () => {
  test('runs by itself on a first visit, steps through every part of the screen and stays dismissed', async ({ app, page }) => {
    await tourOn(page)
    await app.open()
    const card = page.getByTestId('tour-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Step 1 of 7')
    await app.shot('help-tour-1')
    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      ids.push((await card.getAttribute('data-step'))!)
      if (i === 3) await app.shot('help-tour-4')
      if (i < 6) await page.getByTestId('tour-next').click()
    }
    expect(ids).toEqual(['welcome', 'ribbon', 'browser', 'viewport', 'timeline', 'inspector', 'status'])
    await page.getByTestId('tour-back').click()
    await expect(card).toHaveAttribute('data-step', 'inspector')
    await page.getByTestId('tour-next').click()
    await page.getByTestId('tour-next').click() // Done
    await expect(page.getByTestId('tour')).toHaveCount(0)
    await page.reload()
    await page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('tour')).toHaveCount(0)
  })

  test('can be skipped with Escape, and is not shown again', async ({ app, page }) => {
    await tourOn(page)
    await app.open()
    await expect(page.getByTestId('tour-card')).toBeVisible()
    await page.getByTestId('tour-next').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('tour')).toHaveCount(0)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.settings') ?? '{}').tourSeen)).toBe(true)
  })

  test('is off for the specs by default, and can be forced on from the Help menu and from Settings', async ({ app, page }) => {
    await app.open()
    await page.waitForTimeout(1200)
    await expect(page.getByTestId('tour')).toHaveCount(0)
    await page.getByTestId('help-menu').click()
    await page.getByRole('menuitem', { name: 'Take the tour' }).click()
    await expect(page.getByTestId('tour-card')).toHaveAttribute('data-step', 'welcome')
    await page.getByTestId('tour-skip').click()
    await expect(page.getByTestId('tour')).toHaveCount(0)
    // Settings > Help: reset, then it comes back on the next start
    await openSettings(page, 'help')
    await page.getByTestId('reset-tour').click()
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.settings') ?? '{}').tourSeen)).toBe(false)
    await page.getByTestId('replay-tour').click()
    await expect(page.getByTestId('tour-card')).toBeVisible()
    await page.keyboard.press('Escape')
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('Settings fills the screen in one column, a long press shows a tooltip and a tap elsewhere puts it away', async ({ app, page }) => {
    await app.open()
    await app.ev((c) => c.runCommand('app.settings'))
    const dlg = page.getByTestId('settings-dialog')
    await expect(dlg).toBeVisible()
    const box = (await dlg.boundingBox())!
    expect(Math.round(box.width)).toBe(390)
    expect(Math.round(box.height)).toBe(844)
    // one column: the control of a row sits below its text
    const text = (await page.getByTestId('set-units').locator('.set-text').boundingBox())!
    const ctl = (await page.getByTestId('set-units').locator('.set-ctl').boundingBox())!
    expect(ctl.y).toBeGreaterThanOrEqual(text.y + text.height - 1)
    // the page list is a strip across the top
    const nav = (await page.locator('.dlg-nav').boundingBox())!
    expect(nav.width).toBeGreaterThan(300)
    // touch targets
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    if (coarse) {
      for (const sel of ['.dlg-nav-item', '.dlg-close', '.dlg .seg button']) {
        const h = (await page.locator(sel).first().boundingBox())!.height
        expect(h, sel).toBeGreaterThanOrEqual(31)
      }
      expect((await page.locator('.dlg-nav-item').first().boundingBox())!.height).toBeGreaterThanOrEqual(36)
    }
    await page.getByRole('radio', { name: 'Inches' }).tap()
    expect(await app.ev((c) => c.ui.getState().units)).toBe('in')
    await app.shot('help-settings-phone')
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)

    // long press on a tool of the phone layout's strip
    const save = page.getByTestId('m-strip').getByRole('button', { name: 'Extrude' })
    const r = (await save.boundingBox())!
    const pt = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchEnd', p = pt) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y }] })
    await touch('touchStart')
    await expect(page.locator('.tip')).toContainText('Extrude', { timeout: 3000 })
    await touch('touchEnd')
    await page.waitForTimeout(300)
    await expect(page.locator('.tip')).toContainText('Extrude') // stays after the finger lifts
    await app.shot('help-tooltip-phone')
    // a tap elsewhere puts it away
    const other = { x: 195, y: 500 }
    await touch('touchStart', other)
    await touch('touchEnd')
    await expect(page.locator('.tip')).toHaveCount(0)
  })

  test('the tour card fits a phone screen at every step', async ({ app, page }) => {
    await app.open()
    await app.ev((c) => c.runCommand('help.tour'))
    const card = page.getByTestId('tour-card')
    for (let i = 0; i < 7; i++) {
      await expect(card).toContainText(`Step ${i + 1} of 7`)
      await page.waitForTimeout(300)
      const b = (await card.boundingBox())!
      expect(b.x, 'left edge').toBeGreaterThanOrEqual(0)
      expect(b.x + b.width, 'right edge').toBeLessThanOrEqual(390.5)
      expect(b.y, 'top edge').toBeGreaterThanOrEqual(0)
      expect(b.y + b.height, 'bottom edge').toBeLessThanOrEqual(844.5)
      if (i === 3) await app.shot('help-tour-phone')
      if (i < 6) await page.getByTestId('tour-next').tap()
    }
    await page.getByTestId('tour-next').tap()
    await expect(page.getByTestId('tour')).toHaveCount(0)
  })
})
