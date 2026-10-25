import { test, expect, type App } from './helpers'
import type { Page } from '@playwright/test'

/**
 * The project folder is a real folder handle: the browser's origin private file system stands in for a folder the user picked
 * (showDirectoryPicker hands out a sub folder of it), so the File System Access calls are the real ones.
 */
const FOLDER = 'projects-e2e'

async function useFolder(page: Page) {
  await page.addInitScript((name) => {
    ;(window as unknown as Record<string, unknown>).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory()
      return root.getDirectoryHandle(name, { create: true })
    }
  }, FOLDER)
}

/** Empty the folder, then write `.caddy` files made by the app itself (so they carry a real thumbnail). */
async function seed(app: App, files: { path: string; width: number }[]) {
  await app.page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(name, { recursive: true }).catch(() => {})
    await root.getDirectoryHandle(name, { create: true })
  }, FOLDER)
  for (const f of files) {
    await app.ev((c) => c.doc.getState().newDocument())
    await app.ev((c, w) => { c.doc.getState().addFeature('box', { width: w, depth: 20, height: 20, position: [0, 0, 0] }) }, f.width)
    await app.idle()
    await app.ev((c) => c.runCommand('view.frame'))
    await app.cameraStable()
    await app.page.evaluate(async ([name, path, bytes]) => {
      const parts = (path as string).split('/')
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name as string)
      for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d, { create: true })
      const h = await dir.getFileHandle(parts[parts.length - 1], { create: true })
      const w = await h.createWritable()
      await w.write(new Uint8Array(bytes as number[]))
      await w.close()
    }, [FOLDER, f.path, Array.from(await app.ev(async (c) => Array.from(await c.serializeProject(true))))] as const)
  }
  await app.ev((c) => c.doc.getState().newDocument())
}

const opfs = (page: Page, sub = '') =>
  page.evaluate(async ([name, sub]) => {
    const root = await navigator.storage.getDirectory()
    let d = await root.getDirectoryHandle(name)
    for (const s of sub ? sub.split('/') : []) d = await d.getDirectoryHandle(s)
    const out: string[] = []
    for await (const [n, h] of (d as unknown as { entries(): AsyncIterable<[string, { kind: string }]> }).entries()) out.push(h.kind === 'directory' ? n + '/' : n)
    return out.sort()
  }, [FOLDER, sub])

const rows = (page: Page) => page.getByTestId('project-row')

test('browse a project folder: thumbnails, search, open, save back, rename, duplicate, trash and restore, and it is remembered', async ({ app, page }) => {
  await useFolder(page)
  await app.open()
  await seed(app, [{ path: 'Bracket.caddy', width: 30 }, { path: 'Lid.caddy', width: 12 }, { path: 'Hinges/Hinge small.caddy', width: 8 }])

  await app.openPanel('Projects')
  const panel = page.getByTestId('projects-panel')
  await expect(panel).toContainText('Choose folder')
  await panel.getByRole('button', { name: 'Choose folder' }).click()
  await expect(rows(page)).toHaveCount(3)
  await expect(page.getByTestId('project-folder')).toHaveCount(1)
  // every project made by the app carries a viewport thumbnail, read straight from the zip
  await expect(page.locator('[data-testid="project-thumb"][data-has="yes"]')).toHaveCount(3)
  await app.shot('projects-panel')

  // search
  await page.getByLabel('Search projects').fill('hinge')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('Hinge small')
  await expect(rows(page).first()).toContainText('Hinges')
  await page.getByLabel('Search projects').fill('zzz')
  await expect(rows(page)).toHaveCount(0)
  await expect(panel).toContainText('No project matches')
  await page.getByLabel('Search projects').fill('')
  await expect(rows(page)).toHaveCount(3)

  // double-click opens it (a fresh document: nothing to discard)
  await rows(page).filter({ hasText: 'Bracket' }).dblclick()
  await expect.poll(() => app.features().then((f) => f.length)).toBe(1)
  await app.idle()
  expect((await app.features())[0].params.width).toBe(30)
  await expect(page.getByText('Recent')).toBeVisible()

  // Save writes back into the same file (no download), and adds a version to its history
  const before = await page.evaluate(async (name) => {
    const f = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(name)).getFileHandle('Bracket.caddy')
    return (await f.getFile()).size
  }, FOLDER)
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 5, depth: 5, height: 5, position: [40, 0, 0] }))
  await app.idle()
  let downloaded = false
  page.on('download', () => { downloaded = true })
  await app.ribbon('Save').click()
  await expect.poll(() => page.evaluate(async (name) => {
    const f = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(name)).getFileHandle('Bracket.caddy')
    return (await f.getFile()).size
  }, FOLDER)).toBeGreaterThan(before)
  expect(downloaded).toBe(false)
  expect(await app.ev((c) => c.doc.getState().dirty)).toBe(false)

  // rename from the context menu
  await rows(page).filter({ hasText: 'Lid' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.getByLabel('Project name').fill('Lid v2')
  await page.getByLabel('Project name').press('Enter')
  await expect(rows(page).filter({ hasText: 'Lid v2' })).toHaveCount(1)
  expect(await opfs(page)).toEqual(['Bracket.caddy', 'Hinges/', 'Lid v2.caddy'])

  // duplicate
  await rows(page).filter({ hasText: 'Lid v2' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(rows(page).filter({ hasText: 'Lid v2 copy' })).toHaveCount(1)
  expect(await opfs(page)).toEqual(['Bracket.caddy', 'Hinges/', 'Lid v2 copy.caddy', 'Lid v2.caddy'])

  // delete = move to the .caddy-trash folder, never gone for good
  await rows(page).filter({ hasText: 'Lid v2 copy' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(rows(page).filter({ hasText: 'Lid v2 copy' })).toHaveCount(0)
  await expect(page.getByTestId('trash-row')).toHaveCount(1)
  expect(await opfs(page)).toEqual(['.caddy-trash/', 'Bracket.caddy', 'Hinges/', 'Lid v2.caddy'])
  expect(await opfs(page, '.caddy-trash')).toEqual(['Lid v2 copy.caddy'])
  await page.getByTestId('trash-row').getByRole('button', { name: 'Restore' }).click()
  await expect(rows(page).filter({ hasText: 'Lid v2 copy' })).toHaveCount(1)
  expect(await opfs(page, '.caddy-trash')).toEqual([])

  // new project and new folder
  await panel.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.getByLabel('Project name')).toBeVisible()
  await page.getByLabel('Project name').fill('Fresh')
  await page.getByLabel('Project name').press('Enter')
  await expect(rows(page).filter({ hasText: 'Fresh' })).toHaveCount(1)
  await panel.getByRole('button', { name: 'Folder', exact: true }).click()
  await page.getByLabel('Folder name').fill('Gears')
  await page.getByLabel('Folder name').press('Enter')
  await expect(page.getByTestId('project-folder')).toHaveCount(2)
  expect(await opfs(page)).toContain('Gears/')
  await app.shot('projects-panel-after')

  // the folder is remembered across a reload (the handle lives in IndexedDB)
  await page.reload()
  await app.open()
  await app.openPanel('Projects')
  await expect(rows(page).first()).toBeVisible()
  await expect(rows(page).filter({ hasText: 'Bracket' })).toHaveCount(2) // once under Recent, once in the list
  // opening the saved project shows its history (two versions: the seeded file has none, the save made one)
  await rows(page).filter({ hasText: 'Bracket' }).last().dblclick()
  await expect.poll(() => app.features().then((f) => f.length)).toBe(2)
  await app.openPanel('History')
  await expect(page.getByTestId('history-row')).toHaveCount(1)
})

test('insert a project of the folder into the open one as a linked component or an embedded copy', async ({ app, page }) => {
  await useFolder(page)
  await app.open()
  await seed(app, [{ path: 'Bracket.caddy', width: 30 }])
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 5, depth: 5, height: 5, position: [100, 0, 0] }))
  await app.idle()
  await app.openPanel('Projects')
  await page.getByTestId('projects-panel').getByRole('button', { name: 'Choose folder' }).click()
  await expect(rows(page)).toHaveCount(1)

  await rows(page).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Insert as linked component' }).click()
  await expect.poll(() => app.ev((c) => c.doc.getState().assembly.externals.length)).toBe(1)
  await app.idle()
  const a = await app.ev((c) => c.doc.getState().assembly)
  expect(a.externals[0]).toMatchObject({ fileName: 'Bracket.caddy', linked: true })
  expect(a.components.some((x: { external?: string }) => x.external === a.externals[0].id)).toBe(true)
  expect((await app.bodies()).length).toBe(2) // the box already there and the bracket's own

  await rows(page).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Insert as embedded copy' }).click()
  await expect.poll(() => app.ev((c) => c.doc.getState().assembly.externals.length)).toBe(2)
  await app.idle()
  expect(await app.ev((c) => c.doc.getState().assembly.externals[1].linked)).toBe(false)
  expect((await app.bodies()).length).toBe(3)
  await app.shot('projects-insert-component')
})
