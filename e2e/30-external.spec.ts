import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers'
import type { App } from './helpers'

/** A small project file (a box `w` wide, from its own parameter) built in the page and returned as bytes. */
async function bracketBytes(app: App, w: number): Promise<number[]> {
  return app.ev(async (c, w) => {
    c.doc.getState().newDocument()
    c.doc.getState().setUserParams([{ name: 'w', expr: String(w) }])
    c.doc.getState().addFeature('box', { width: 'w', depth: 10, height: 10, position: [0, 0, 0] }, 'Plate')
    await c.regenerate()
    c.doc.setState({ name: 'Bracket' })
    return Array.from(await c.serializeProject(false))
  }, w) as Promise<number[]>
}
const width = (app: App) => app.ev((c) => {
  const b = c.doc.getState().geometry[0]
  const p = b.mesh.positions
  let lo = Infinity, hi = -Infinity
  for (let k = 0; k < p.length; k += 3) { lo = Math.min(lo, p[k]); hi = Math.max(hi, p[k]) }
  return +(hi - lo).toFixed(4)
}) as Promise<number>
const freshDoc = async (app: App) => {
  await app.ev(async (c) => { c.doc.getState().newDocument(); await c.regenerate() })
  await app.idle()
}

test('external: insert a .caddy as a linked component, share it by instance, and take a newer file when told it changed', async ({ app, page }, info) => {
  await app.open()
  const file = info.outputPath('bracket.caddy')
  fs.writeFileSync(file, Buffer.from(await bracketBytes(app, 30)))
  await freshDoc(app)
  await app.ev((c) => c.doc.getState().setUserParams([{ name: 'w', expr: '5' }])) // same name as the file's own parameter: it must not leak in

  await app.tab('Assemble')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Insert Linked', exact: true }).click()])
  await chooser.setFiles(file)
  await expect(page.getByTestId('comp-o1')).toContainText('Bracket')
  await expect.poll(() => app.ev((c) => c.doc.getState().geometry.length)).toBe(1)
  expect(await width(app)).toBe(30) // the file's own w, not the host's
  expect(await app.ev((c) => c.doc.getState().assembly.externals[0])).toMatchObject({ id: 'e1', fileName: 'bracket.caddy', linked: true })
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('linked-component')

  // an instance of the linked component shares its geometry
  await page.getByTestId('comp-o1').click()
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect(page.getByTestId('comp-o2')).toBeVisible()
  expect(await app.ev((c) => c.doc.getState().geometry.length)).toBe(1)
  expect(await app.ev((c) => c.assembly.place.currentInstances().length)).toBe(2)

  // the file changes on disk (here: a stand-in source the page re-reads): a notice appears, nothing changes until it is accepted
  const v2 = await bracketBytes(app, 55)
  await freshDoc(app)
  await app.ev((c) => c.doc.getState().setUserParams([{ name: 'w', expr: '5' }]))
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Insert Linked', exact: true }).click()])
  await chooser2.setFiles(file)
  await expect(page.getByTestId('comp-o1')).toBeVisible()
  await app.ev((c, v2) => {
    ;(window as unknown as { __file: unknown }).__file = { bytes: Uint8Array.from(v2), stamp: 5000 }
    c.assembly.external.setExternalSource('e1', { read: async () => (window as unknown as { __file: { bytes: Uint8Array; stamp: number } }).__file })
  }, v2)
  await expect(page.getByTestId('ext-update-e1')).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('ext-update-e1')).toBeVisible()
  expect(await width(app)).toBe(30)
  await app.shot('linked-component-update')
  await page.getByTestId('ext-update-e1').click()
  await expect.poll(() => width(app)).toBe(55)
  await expect(page.getByTestId('ext-update-e1')).toHaveCount(0)
  // the update is one undo step
  await app.ev((c) => c.doc.getState().undo())
  await expect.poll(() => width(app)).toBe(30)
})

test('external: an embedded copy never changes, and a file that is not a project is refused', async ({ app, page }, info) => {
  await app.open()
  const file = info.outputPath('copy.caddy')
  fs.writeFileSync(file, Buffer.from(await bracketBytes(app, 22)))
  const junk = info.outputPath('junk.caddy')
  fs.writeFileSync(junk, 'not a zip')
  await freshDoc(app)
  await app.tab('Assemble')
  await page.getByRole('button', { name: 'Insert Linked options' }).click()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Insert Embedded Copy' }).click()])
  await chooser.setFiles(file)
  await expect(page.getByTestId('comp-o1')).toBeVisible()
  expect(await width(app)).toBe(22)
  expect(await app.ev((c) => c.doc.getState().assembly.externals[0].linked)).toBe(false)
  expect(await app.ev((c) => c.assembly.external.checkExternals())).toEqual([])
  // the component menu offers no file update for a copy
  await page.getByTestId('comp-o1').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: /Update from file/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Insert Linked', exact: true }).click()])
  await chooser2.setFiles(junk)
  await expect(page.getByText(/Insert failed/)).toBeVisible()
  expect(await app.ev((c) => c.doc.getState().assembly.externals.length)).toBe(1)
})

test('external: opening a document re-reads the linked file through its stored handle and raises the update notice', async ({ app, page }, info) => {
  await app.open()
  const dir = path.dirname(info.outputPath('x'))
  // a real file handle (the browser's private file system), written with v1
  const v1 = await bracketBytes(app, 30)
  const v2 = await bracketBytes(app, 55)
  await freshDoc(app)
  await app.ev(async (c, a) => {
    const root = await navigator.storage.getDirectory()
    const fh = await root.getFileHandle('bracket.caddy', { create: true })
    const w = await fh.createWritable()
    await w.write(Uint8Array.from(a.v1))
    await w.close()
    await c.assembly.external.insertExternal(Uint8Array.from(a.v1), 'bracket.caddy', { linked: true, stamp: (await fh.getFile()).lastModified, handle: fh })
  }, { v1, v2 })
  expect(await width(app)).toBe(30)

  // save the document (a download here), then change the linked file behind its back
  const [dl] = await Promise.all([page.waitForEvent('download'), app.ribbon('Save').click()])
  const hostFile = path.join(dir, dl.suggestedFilename())
  await dl.saveAs(hostFile)
  await app.ev(async (c, bytes) => {
    const root = await navigator.storage.getDirectory()
    const fh = await root.getFileHandle('bracket.caddy')
    const w = await fh.createWritable()
    await w.write(Uint8Array.from(bytes))
    await w.close()
  }, v2)

  await page.reload()
  await app.open()
  expect(await app.ev((c) => c.doc.getState().geometry.length)).toBe(0)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Open...').click()])
  await chooser.setFiles(hostFile)
  await expect.poll(() => app.ev((c) => c.doc.getState().geometry.length)).toBe(1)
  expect(await width(app)).toBe(30) // the document opens as it was saved
  await expect(page.getByTestId('ext-update-e1')).toBeVisible() // and says the file has changed
  await page.getByTestId('ext-update-e1').click()
  await expect.poll(() => width(app)).toBe(55)
})
