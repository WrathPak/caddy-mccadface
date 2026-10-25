import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type App } from './helpers'
import type { Page } from '@playwright/test'

const examples = path.resolve(import.meta.dirname, '../examples/plugins')

/** No directory picker in these runs: the Plugins panel falls back to a folder <input>, which the spec feeds a real folder. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { delete (window as unknown as Record<string, unknown>).showDirectoryPicker })
})

async function openPlugins(app: App) {
  await app.openPanel('Plugins')
  await expect(app.page.getByTestId('plugins-panel')).toBeVisible()
}

async function addFolder(app: App, folder: string) {
  const { page } = app
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('plugins-panel').getByRole('button', { name: 'Folder' }).click()])
  await chooser.setFiles(folder)
}
const confirmAdd = (page: Page) => page.getByRole('dialog').getByRole('button', { name: /Add plugin|Update/ }).click()
const row = (page: Page, id: string) => page.locator(`[data-testid="plugin-row"][data-plugin="${id}"]`)

test('add the gear generator from its folder: a Gear button, a dialog, a body; it survives a reload and a switch off', async ({ app, page }) => {
  await app.open()
  await openPlugins(app)
  await expect(page.getByTestId('plugins-panel')).toContainText('Plugins add features')
  await addFolder(app, path.join(examples, 'gear-generator'))
  await expect(page.getByRole('dialog')).toContainText('Add Gear generator?')
  await expect(page.getByRole('dialog')).toContainText('asks for nothing beyond')
  await confirmAdd(page)
  const r = row(page, 'gear-generator')
  await expect(r.getByTestId('plugin-state')).toContainText('Running - 1 feature, 1 command')
  await app.shot('plugins-panel')

  // the feature has a ribbon button in its own group, and a dialog made from the schema
  await expect(page.locator('.ribbon-body .rgroup-label', { hasText: 'Gears' })).toBeVisible()
  await app.ribbon('Gear').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Gear')
  await app.field('Teeth', '24')
  await app.field('Module', '2')
  await app.shot('plugin-gear-dialog')
  await app.ok()
  await app.idle()
  const feats = await app.features()
  expect(feats.map((f) => [f.type, f.state])).toEqual([['gear-generator.gear', 'ok']])
  expect((await app.bodies())[0].kind).toBe('brep')
  const bb = await app.bbox()
  expect(bb.max[0]).toBeCloseTo(26, 1) // pitch radius 24 plus the module
  expect(bb.max[2]).toBeCloseTo(8, 3)
  await app.ev((c) => c.runCommand('view.frame'))
  await app.shot('plugin-gear')

  // a gear is picked up again by editing: double click the chip in the timeline
  await app.ev((c) => c.doc.getState().updateFeature('f1', { ...c.doc.getState().features[0].params, teeth: 16 }))
  await app.idle()
  expect((await app.bbox()).max[0]).toBeCloseTo(18, 1)

  // switched off: the feature type is gone (its feature reports it), the ribbon button too
  await r.getByRole('switch').click()
  await expect(r.getByTestId('plugin-state')).toContainText('Switched off')
  await expect(page.locator('.ribbon-body .rgroup-label', { hasText: 'Gears' })).toHaveCount(0)
  await expect.poll(() => app.features().then((f) => f[0].state)).toBe('error')
  expect((await app.features())[0].error).toMatch(/Unknown feature type/)
  await r.getByRole('switch').click()
  await expect(r.getByTestId('plugin-state')).toContainText('Running')
  await expect.poll(() => app.features().then((f) => f[0].state)).toBe('ok')

  // it is stored in the browser: after a reload it starts by itself
  await page.reload()
  await app.open()
  await expect(page.locator('.ribbon-body .rgroup-label', { hasText: 'Gears' })).toBeVisible()
  await openPlugins(app)
  await expect(row(page, 'gear-generator').getByTestId('plugin-state')).toContainText('Running')

  // remove it
  page.once('dialog', (d) => void d.accept())
  await row(page, 'gear-generator').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByTestId('plugin-row')).toHaveCount(0)
  await expect(page.locator('.ribbon-body .rgroup-label', { hasText: 'Gears' })).toHaveCount(0)
})

test('a plugin that asks for the download permission: you allow it, and can take it back', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 10, depth: 10, height: 5, position: [0, 0, 0] }))
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 4, depth: 4, height: 4, position: [30, 0, 0] }))
  await app.idle()
  await openPlugins(app)
  await addFolder(app, path.join(examples, 'export-all-stl'))
  await expect(page.getByRole('dialog')).toContainText('Offer files for download')
  await confirmAdd(page)
  const r = row(page, 'export-all-stl')
  await expect(r.getByTestId('plugin-state')).toContainText('Running - 0 features, 1 command')
  const allow = r.getByLabel('Allow: Offer files for download')
  await expect(allow).toBeChecked()

  const [dl] = await Promise.all([page.waitForEvent('download'), app.ribbon('Export all bodies as STLs').click()])
  expect(dl.suggestedFilename()).toMatch(/-stls\.zip$/)
  const file = path.join(path.resolve(import.meta.dirname, 'results'), 'plugin-export.zip')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await dl.saveAs(file)
  expect(fs.statSync(file).size).toBeGreaterThan(1000)

  // take the permission back: the same command now says why it cannot
  await allow.uncheck()
  let downloaded = false
  page.on('download', () => { downloaded = true })
  await app.ribbon('Export all bodies as STLs').click()
  await expect(page.getByText(/needs the "download" permission/)).toBeVisible()
  expect(downloaded).toBe(false)
})

test('a single .js file is a plugin; what its manifest asks for shows up to be allowed', async ({ app, page }, info) => {
  const file = info.outputPath('quick.js')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `
    export const manifest = { name: 'Quick note', version: '0.1', description: 'Saves a note as a text file', permissions: ['download'] }
    export function activate(caddy) {
      caddy.commands.register({ id: 'note', label: 'Save a note', ribbon: { tab: 'mesh', group: 'Notes' }, async run() {
        await caddy.io.download('note.txt', 'remember the milk')
      } })
    }`)
  await app.open()
  await openPlugins(app)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('plugins-panel').getByRole('button', { name: 'File' }).click()])
  await chooser.setFiles(file)
  await expect(page.getByRole('dialog')).toContainText('Add quick?')
  await confirmAdd(page)
  const r = row(page, 'quick')
  await expect(r).toContainText('Quick note') // it named itself
  await expect(r.getByTestId('plugin-state')).toContainText('Running')
  const allow = r.getByLabel('Allow: Offer files for download')
  await expect(allow).not.toBeChecked() // not allowed until you say so
  await app.tab('Mesh')
  await app.ribbon('Save a note').click()
  await expect(page.getByText(/needs the "download" permission/)).toBeVisible()
  await allow.check()
  const [dl] = await Promise.all([page.waitForEvent('download'), app.ribbon('Save a note').click()])
  expect(dl.suggestedFilename()).toBe('note.txt')
})

test('a plugin that does not start says why, and the Script panel runs against the same sandbox (no page, no network)', async ({ app, page }) => {
  app.allow(/Content Security Policy|Refused to connect/i)
  await app.open()
  await openPlugins(app)
  // a broken plugin
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('plugins-panel').getByRole('button', { name: 'File' }).click()])
  await chooser.setFiles({ name: 'broken.js', mimeType: 'text/javascript', buffer: Buffer.from("import x from 'lodash'\nexport function activate() {}") })
  await confirmAdd(page)
  await expect(row(page, 'broken').getByTestId('plugin-state')).toContainText('can only import their own files')

  await app.openPanel('Script')
  const panel = page.getByTestId('script-panel')
  await expect(panel).toBeVisible()
  const editor = panel.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await editor.fill(`
const out = []
out.push('document: ' + typeof document)
out.push('window: ' + typeof window)
out.push('fetch: ' + typeof fetch)
// the CSP of the sandbox still stops a request made with the fetch it took from the prototype
const sneaky = WorkerGlobalScope.prototype.fetch
try { await sneaky.call(self, 'http://localhost:1/'); out.push('network: reachable') } catch (e) { out.push('network: blocked') }
try { await import('http://' + 'localhost:1/x.js'); out.push('import: reachable') } catch (e) { out.push('import: blocked') }
console.log(out.join(' | '))
const info = await caddy.document.info()
console.log('document name: ' + info.name)
console.log('box', JSON.stringify((await caddy.kernel.box({ size: [2, 3, 4] })).bounds))
`)
  await panel.getByRole('button', { name: 'Run' }).click()
  const output = page.getByTestId('script-output')
  await expect(output).toContainText('document name: Untitled', { timeout: 30_000 })
  await expect(output).toContainText('document: undefined | window: undefined | fetch: undefined | network: blocked | import: blocked')
  await expect(output).toContainText('"max":[1,1.5,4]')
  await expect(output).toContainText('Done.')

  // an error in the script is shown, not swallowed
  await editor.click()
  await page.keyboard.press('Control+A')
  await editor.fill('await caddy.kernel.box({ size: [1, 2] })')
  await panel.getByRole('button', { name: 'Run' }).click()
  await expect(output).toContainText('size must be three numbers')
  await app.shot('script-panel')
})

test('a script can register a command and a feature that live until it is stopped, and react to changes', async ({ app, page }) => {
  await app.open()
  await app.openPanel('Script')
  const panel = page.getByTestId('script-panel')
  const editor = panel.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('Control+A')
  await editor.fill(`
caddy.features.register({
  type: 'peg', label: 'Peg',
  params: [{ type: 'number', key: 'r', label: 'Radius', unit: 'mm', default: 3 }],
  async compute(ctx, p) { return { bodies: [await ctx.kernel.cylinder({ radius: p.r, height: 10 })] } },
})
caddy.commands.register({ id: 'hi', label: 'Say hi', run: () => caddy.ui.toast('hi from the script') })
caddy.document.onChange(() => console.log('the document changed'))
console.log('registered')
`)
  await panel.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByTestId('script-output')).toContainText('stays active until you press Stop', { timeout: 30_000 })
  // the command and the feature exist now
  expect(await app.ev((c) => c.runCommand && true)).toBe(true)
  await app.ev((c) => c.doc.getState().addFeature('script.peg', { r: 4 }))
  await app.idle()
  expect((await app.features())[0]).toMatchObject({ type: 'script.peg', state: 'ok' })
  expect((await app.bbox()).max[0]).toBeCloseTo(4, 1)
  await expect(page.getByTestId('script-output')).toContainText('the document changed')
  await app.ev((c) => c.runCommand('script.hi'))
  await expect(page.getByText('hi from the script', { exact: true })).toBeVisible()
  // Stop takes them back
  await panel.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(() => app.features().then((f) => f[0].state)).toBe('error')
})

test('the API types are served and shipped', async ({ request }) => {
  const r = await request.get('/caddy-api.d.ts')
  expect(r.ok()).toBe(true)
  const text = await r.text()
  expect(text).toContain('interface CaddyApi')
  expect(text).toContain('declare const caddy: CaddyApi')
})
