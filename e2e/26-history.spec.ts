import fs from 'node:fs'
import { test, expect, type App } from './helpers'
import type { Page } from '@playwright/test'

/** Save through the ribbon (the download fallback: no File System Access API in these runs) and keep the file. */
async function save(app: App, page: Page, to: string) {
  const [dl] = await Promise.all([page.waitForEvent('download'), app.ribbon('Save').click()])
  await dl.saveAs(to)
}

const rows = (page: Page) => page.getByTestId('history-row')

test('every save keeps a version: list, notes, read-only preview, compare, restore, prune and reopen', async ({ app, page }, info) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.field('Width', '24')
  await app.ok()
  await app.openPanel('History')
  const panel = page.getByTestId('history-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Nothing here yet')

  // version 1: a plain save
  const f1 = info.outputPath('v1.caddy')
  await save(app, page, f1)
  await expect(rows(page)).toHaveCount(1)

  // version 2: a second box, saved with a note from the File menu
  await app.ev((c) => c.runCommand('solid.box'))
  await app.field('Width', '30')
  await app.ok()
  await page.locator('.ribbon-tabs').getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /Save with Note/ }).click()
  await page.getByLabel('Note for this version').fill('added the second box')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()])
  const f2 = info.outputPath('v2.caddy')
  await dl.saveAs(f2)
  await expect(rows(page)).toHaveCount(2)
  await expect(rows(page).first()).toContainText('added the second box')
  await expect(rows(page).first()).toContainText('2 features')
  await expect(rows(page).last()).toContainText('1 feature')
  expect(fs.statSync(f2).size).toBeGreaterThan(fs.statSync(f1).size) // the second file carries both versions
  await app.shot('history-panel')

  // preview version 1: read-only
  await page.getByLabel('Select version 1').check()
  await panel.getByRole('button', { name: 'Preview' }).click()
  await expect(page.getByTestId('preview-banner')).toContainText('Version 1')
  await app.idle()
  expect((await app.features()).map((f) => f.type)).toEqual(['box'])
  expect((await app.bodies()).length).toBe(1)
  await app.ev((c) => c.doc.getState().addFeature('box', {})) // an edit while previewing is refused
  await app.ev((c) => c.runCommand('edit.undo'))
  expect((await app.features()).length).toBe(1)
  await app.shot('history-preview')
  await page.getByRole('button', { name: 'Back to the project' }).click()
  await expect(page.getByTestId('preview-banner')).toHaveCount(0)
  await app.idle()
  expect((await app.features()).length).toBe(2)
  expect(await app.ev((c) => c.doc.getState().readOnly)).toBe(false)
  // the edits made before the preview are still there to undo
  expect(await app.ev((c) => c.doc.getState().undoDepth)).toBeGreaterThan(0)

  // compare the two
  await page.getByLabel('Select version 2').check()
  await panel.getByRole('button', { name: 'Compare' }).click()
  const diff = page.getByTestId('history-diff')
  await expect(diff).toContainText('Box2')
  await expect(diff).toContainText('added')
  await app.shot('history-compare')

  // restore version 1 as an edit; the next save is version 3 with a note saying so
  await page.getByLabel('Select version 2').uncheck()
  await panel.getByRole('button', { name: 'Restore' }).click()
  await app.idle()
  expect((await app.features()).length).toBe(1)
  const f3 = info.outputPath('v3.caddy')
  await save(app, page, f3)
  await expect(rows(page)).toHaveCount(3)
  await expect(rows(page).first()).toContainText('Restored version 1')

  // the history is inside the file: reload, open it, see the same three versions
  await page.reload()
  await app.open()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Open...').click()])
  await chooser.setFiles(f3)
  await expect.poll(() => app.features().then((f) => f.length)).toBe(1)
  await app.openPanel('History')
  await expect(rows(page)).toHaveCount(3)
  await expect(rows(page).nth(1)).toContainText('added the second box')

  // cap: keep 2 versions
  await page.getByLabel('Most versions to keep').fill('2')
  await page.getByRole('button', { name: 'Prune now' }).click()
  await expect(rows(page)).toHaveCount(2)
  await expect(rows(page).last()).toContainText('added the second box') // the oldest one went
  const f4 = info.outputPath('v4.caddy')
  await save(app, page, f4)
  await expect(rows(page)).toHaveCount(2) // the cap holds after the new save too
  expect(fs.statSync(f4).size).toBeGreaterThan(200)
})
