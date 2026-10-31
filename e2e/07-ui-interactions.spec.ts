import { strToU8, zipSync } from 'fflate'
import { test, expect } from './helpers'

test('undo / redo walk the timeline', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  expect(await app.features()).toHaveLength(2)
  await page.keyboard.press('Control+z')
  await expect.poll(() => app.features().then((f) => f.length)).toBe(1)
  await page.keyboard.press('Control+z')
  await expect.poll(() => app.features().then((f) => f.length)).toBe(0)
  await page.keyboard.press('Control+y')
  await expect.poll(() => app.features().then((f) => f.length)).toBe(1)
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => app.features().then((f) => f.length)).toBe(2)
  await app.idle()
  expect(await app.bodies()).toHaveLength(2)
  // and through the command palette
  await page.keyboard.press('s')
  await page.locator('.cmdk input').fill('undo')
  await page.keyboard.press('Enter')
  await expect.poll(() => app.features().then((f) => f.length)).toBe(1)
})

test('command palette (S) opens, filters, runs a command and closes with Esc', async ({ app, page }) => {
  await app.open()
  await page.keyboard.press('s')
  await expect(page.locator('.cmdk')).toBeVisible()
  await app.shot('palette')
  await page.locator('.cmdk input').fill('wireframe')
  await expect(page.locator('.cmdk [cmdk-item]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.locator('.cmdk')).toHaveCount(0)
  expect(await app.ev((c) => c.ui.getState().displayMode)).toBe('wireframe')
  await page.keyboard.press('s')
  await page.keyboard.press('Escape')
  await expect(page.locator('.cmdk')).toHaveCount(0)
})

test('marking menu: right-click opens, an item runs, Esc closes', async ({ app, page }) => {
  await app.open()
  const vp = (await page.locator('.vp').boundingBox())!
  const x = vp.x + vp.width / 2
  const y = vp.y + vp.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  await expect(page.locator('.marking .m-center')).toBeVisible()
  await expect(page.locator('.marking .m-item')).toHaveCount(8)
  await app.shot('marking-menu')
  await page.keyboard.press('Escape')
  await expect(page.locator('.marking')).toHaveCount(0)
  // press-drag-release towards the top slot (Extrude): opens the Extrude dialog
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(x, y - 60, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await expect(page.locator('.marking')).toHaveCount(0)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  // click-select on an item
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  await page.locator('.marking .m-item', { hasText: 'Frame' }).click()
  await expect(page.locator('.marking')).toHaveCount(0)
})

test('display modes, projection, AO, grid / origin toggles and the theme switch', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  const bar = page.locator('.vp-toolbar')
  const ids = ['shaded', 'shadedEdges', 'wireframe', 'xray']
  for (let i = 0; i < ids.length; i++) {
    await bar.locator('.vp-bar').first().locator('button').nth(i).click()
    expect(await app.ev((c) => c.ui.getState().displayMode)).toBe(ids[i])
    await page.waitForTimeout(150)
    if (ids[i] === 'wireframe' || ids[i] === 'xray') await app.shot('mode-' + ids[i])
  }
  // orthographic is the default; the button flips to perspective and back
  expect(await app.ev((c) => c.ui.getState().projection)).toBe('orthographic')
  await app.shot('mode-ortho')
  await bar.getByRole('button', { name: /Ortho/ }).click()
  expect(await app.ev((c) => c.ui.getState().projection)).toBe('perspective')
  await page.waitForTimeout(250)
  await app.shot('mode-persp')
  await bar.getByRole('button', { name: /Persp/ }).click()
  await bar.getByRole('button', { name: /AO/ }).click()
  expect(await app.ev((c) => c.ui.getState().ssao)).toBe(false)
  await bar.getByRole('button', { name: /AO/ }).click()
  expect(await app.ev((c) => c.ui.getState().ssao)).toBe(true)
  const sw = bar.locator('.vp-bar').nth(1).locator('button')
  const n = await sw.count()
  for (let i = 3; i < n; i++) await sw.nth(i).click()
  await sw.nth(3).click()
  await sw.nth(4).click()
  await app.ev((c) => c.ui.getState().setDisplayMode('shadedEdges'))
  await app.ev((c) => c.runCommand('view.theme'))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.waitForTimeout(300)
  await app.shot('theme-light')
  await app.ev((c) => c.runCommand('view.theme'))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('ViewCube faces snap the camera; Frame All / Home work', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  const pos = () => app.ev((c) => {
    const e = c.three.camera.matrixWorld.elements
    return [e[12], e[13], e[14]]
  })
  // only faces turned towards the viewer are clickable, so start each from the home view (Top, Front and Right show)
  const cases: [string, number, number][] = [['Top', 2, 1], ['Front', 1, -1], ['Right', 0, 1]]
  for (const [face, axis, sign] of cases) {
    await app.ev((c) => c.runCommand('view.home'))
    await app.cameraStable()
    await page.locator('.vc-face', { hasText: face }).first().click({ force: true })
    await app.cameraStable()
    const p = await pos()
    const dominant = p.map(Math.abs).indexOf(Math.max(...p.map(Math.abs)))
    expect(dominant, `camera for ${face}: ${p}`).toBe(axis)
    expect(Math.sign(p[axis]), `camera for ${face}: ${p}`).toBe(sign)
  }
  // the other three directions come from the view commands
  for (const [id, axis, sign] of [['back', 1, 1], ['left', 0, -1], ['bottom', 2, -1]] as [string, number, number][]) {
    await app.ev((c, id) => c.bus.emit('view', id), id)
    await app.cameraStable()
    const p = await pos()
    expect(Math.sign(p[axis]), `${id}: ${p}`).toBe(sign)
  }
  await app.ev((c) => {
    c.runCommand('view.home')
    c.runCommand('view.top')
    c.runCommand('view.front')
    c.runCommand('view.right')
    c.runCommand('view.frame')
  })
  await app.cameraStable()
})

test('status bar menus, selection filters and the Browser tree', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  const status = page.locator('.status')
  await status.getByRole('button', { name: /Units/ }).click()
  await page.getByRole('menuitem', { name: 'in' }).click()
  expect(await app.ev((c) => c.ui.getState().units)).toBe('in')
  await status.getByRole('button', { name: /Units/ }).click()
  await page.getByRole('menuitem', { name: 'mm' }).click()
  await status.getByRole('button', { name: /Snap/ }).click()
  await status.getByRole('button', { name: /Snap/ }).click()
  for (const f of ['Body', 'Edge', 'Face']) {
    await status.getByRole('button', { name: /Select:/ }).click()
    await page.getByRole('menuitem', { name: f }).click()
  }
  const row = page.locator('.tree-row', { hasText: 'Box1' })
  await row.click()
  await expect(status).toContainText('1 selected')
  await row.locator('.eye').click()
  await row.locator('.eye').click()
  await row.dblclick()
  await page.locator('.tree-row input.rename').fill('Block')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tree-row', { hasText: 'Block' })).toBeVisible()
  await page.locator('.tree-row', { hasText: 'Block' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Delete/ }).click()
  await app.idle()
  expect(await app.bodies()).toHaveLength(0)
})

test('every registered command runs without throwing (empty doc, then with a body)', async ({ app, page }) => {
  test.setTimeout(300_000) // two runs of every command, and the insert commands really insert a file: a few minutes on a 4x throttled CPU
  // the insert commands really run: a stand-in file picker hands them a small in-memory .caddy
  const caddy = Array.from(zipSync({
    'document.json': strToU8(JSON.stringify({ format: 1, name: 'Stub', rollback: 1, userParams: [], bodyNames: {}, configs: [], activeConfig: null, features: [{ id: 'f1', type: 'box', name: 'Box1', suppressed: false, params: { width: 5, depth: 5, height: 5, position: [0, 0, 0] } }] })),
  }))
  await page.addInitScript((bytes) => {
    ;(window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [{
      name: 'stub.caddy',
      getFile: async () => new File([Uint8Array.from(bytes)], 'stub.caddy'),
    }]
  }, caddy)
  page.on('filechooser', (fc) => void fc.setFiles({ name: 'stub.caddy', mimeType: 'application/zip', buffer: Buffer.from(caddy) }))
  await app.open()
  const skip = new Set(['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.import', 'file.export', 'mesh.import', 'app.palette', 'view.resetLayout', 'render.image', 'render.turntable'])
  const all: string[] = await page.evaluate(async () => {
    const mod = await import('/src/app/commands.ts')
    return mod.allCommands().map((c: { id: string }) => c.id)
  })
  expect(all.length).toBeGreaterThan(60)
  // no placeholder commands: nothing is marked as a stub, and every button the ribbon shows is backed by a real command
  const audit = await page.evaluate(async () => {
    const cmds = await import('/src/app/commands.ts')
    const ribbon = await import('/src/app/ribbon.ts')
    const ids = new Set<string>()
    for (const t of ribbon.RIBBON_TABS) for (const g of t.groups) for (const it of g.items) {
      if (it.cmd) ids.add(it.cmd)
      for (const m of it.menu ?? []) ids.add(m)
      for (const m of it.stack ?? []) ids.add(m)
    }
    return { stubs: cmds.allCommands().filter((c: { stub?: boolean }) => c.stub).map((c: { id: string }) => c.id), missing: [...ids].filter((id) => !cmds.getCommand(id)), ribbon: ids.size }
  })
  expect(audit.stubs, 'commands still marked as stubs').toEqual([])
  expect(audit.missing, 'ribbon entries without a command').toEqual([])
  expect(audit.ribbon).toBeGreaterThan(40)
  const runAll = async (tag: string) => {
    for (const id of all) {
      if (skip.has(id)) continue
      await app.ev((c, id) => c.runCommand(id), id)
      await page.waitForTimeout(40)
      await page.keyboard.press('Escape')
      await app.ev((c) => {
        const i = c.ui.getState().inspector
        if (i) i.onCancel()
        if (c.sketch.getState().active) c.runCommand('sketch.finish')
      })
    }
    await app.idle()
    expect(await page.locator('.panel-error').count(), `panel error after ${tag}`).toBe(0)
  }
  await runAll('empty')
  await app.ev((c) => c.doc.getState().newDocument())
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await runAll('body')
  await app.shot('after-all-commands')
})
