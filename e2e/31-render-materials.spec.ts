import fs from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { test, expect, type App } from './helpers'

async function addBox(app: App, size: [number, number, number], position: [number, number, number]) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size[0], depth: a.size[1], height: a.size[2], position: a.position }), { size, position })
  await app.idle()
}
async function frame(app: App) {
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}
async function section(app: App, id: string) {
  const d = app.page.getByTestId(`render-sec-${id}`)
  if (!(await d.evaluate((e) => (e as HTMLDetailsElement).open))) await d.locator('summary').click()
}
const appearances = (app: App) => app.features().then((f) => f.filter((x) => x.type === 'appearance'))
const looks = (app: App) => app.ev((c) => c.render.appearance()) as Promise<Record<string, { body: { material: string; color: string } | null; faces: Record<string, { material: string; color: string }> }>>

test('RENDER tab: ribbon, panel and the material library', async ({ app, page }) => {
  await app.open()
  await app.tab('Render')
  for (const name of ['Appearance', 'Focus', 'Depth of Field', 'Render Image', 'Turntable']) await expect(app.ribbon(name)).toBeVisible()
  await expect(page.getByTestId('render-panel')).toBeVisible()
  for (const id of ['pla', 'petg', 'silk', 'metal', 'wood', 'glass', 'rubber', 'carbon']) await expect(page.getByTestId(`mat-${id}`)).toBeVisible()
  // no selection: the click explains itself instead of failing
  await page.getByTestId('mat-metal').click()
  await expect(page.getByText('Select a body or some faces first')).toBeVisible()
  expect(await appearances(app)).toHaveLength(0)
  await app.tab('Solid')
  await expect(page.getByTestId('render-panel')).toHaveCount(0)
})

test('materials per body and per face show in the viewport, survive edits, and are saved in the .caddy', async ({ app, page }, info) => {
  await app.open()
  await addBox(app, [30, 30, 20], [0, 0, 0])
  await addBox(app, [20, 20, 20], [60, 0, 0])
  await frame(app)
  await app.tab('Render')

  // whole body, from the swatch
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: 'f1' }]))
  await page.getByTestId('mat-metal').click()
  await app.idle()
  // one face of the other box, with a color
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'face', id: 'f2', index: 4 }]))
  await page.getByTestId('mat-color').fill('#c0392b')
  await page.getByTestId('mat-wood').click()
  await app.idle()

  const fs1 = await appearances(app)
  expect(fs1).toHaveLength(2)
  expect(fs1.map((f) => f.state)).toEqual(['ok', 'ok'])
  expect(fs1[0].params.material).toBe('metal')
  expect(fs1[1].params.material).toBe('wood')
  expect(fs1[1].params.color).toBe('#c0392b')
  const l1 = await looks(app)
  expect(l1.f1.body?.material).toBe('metal')
  expect(l1.f2.body).toBeNull()
  expect(l1.f2.faces['4']).toEqual({ material: 'wood', color: '#c0392b' })

  // the viewport draws it: the overlay has a mesh per look
  const meshes = await app.ev((c) => {
    const out: { material: string; spec: string }[] = []
    c.three.scene.traverse((o: any) => { if (o.isMesh && o.userData.bodyId && o.material?.userData?.specKey) out.push({ material: o.material.type, spec: o.material.userData.specKey }) }) // eslint-disable-line
    return out
  })
  expect(meshes.map((m) => m.spec).sort()).toEqual(['metal|', 'wood|#c0392b'])
  await app.shot('render-materials')

  // the faces keep their material when the model is edited
  await app.ev((c) => c.doc.getState().updateFeature('f2', { ...c.doc.getState().features.find((f: any) => f.id === 'f2').params, height: 35 })) // eslint-disable-line
  await app.idle()
  expect((await appearances(app)).map((f) => f.state)).toEqual(['ok', 'ok'])
  expect((await looks(app)).f2.faces['4']?.material).toBe('wood')

  // render settings are part of the project too
  await page.getByTestId('env-select').selectOption('sunset')
  await section(app, 'camera')
  await page.getByTestId('focal').fill('85')
  await page.getByTestId('focal').press('Enter')
  await page.getByTestId('dof-check').check()

  const bytes: number[] = await app.ev((c) => c.serializeProject(false).then((b: Uint8Array) => Array.from(b)))
  const files = unzipSync(new Uint8Array(bytes))
  const doc = JSON.parse(strFromU8(files['document.json']))
  const saved = doc.features.filter((f: any) => f.type === 'appearance') // eslint-disable-line
  expect(saved.map((f: any) => f.params.material)).toEqual(['metal', 'wood']) // eslint-disable-line
  expect(saved[1].params.color).toBe('#c0392b')
  const render = JSON.parse(strFromU8(files['render.json']))
  expect(render).toMatchObject({ env: 'sunset', focalMm: 85, dof: true })

  // save, reopen in a fresh page: same assignments and the same render settings
  const [dl] = await Promise.all([page.waitForEvent('download'), app.ev((c) => c.runCommand('file.save'))])
  const file = info.outputPath('materials.caddy')
  await dl.saveAs(file)
  expect(fs.statSync(file).size).toBeGreaterThan(200)
  await page.reload()
  await app.open()
  expect(await appearances(app)).toHaveLength(0)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ev((c) => c.runCommand('file.open'))])
  await chooser.setFiles(file)
  await expect.poll(() => appearances(app).then((f) => f.length)).toBe(2)
  await app.idle()
  const l2 = await looks(app)
  expect(l2.f1.body?.material).toBe('metal')
  expect(l2.f2.faces['4']).toEqual({ material: 'wood', color: '#c0392b' })
  expect(await app.ev((c) => c.render.settings.getState().s)).toMatchObject({ env: 'sunset', focalMm: 85, dof: true })

  // a new document goes back to the default settings
  await app.ev((c) => { window.confirm = () => true; return c.runCommand('file.new') }) // eslint-disable-line
  await expect.poll(() => app.ev((c) => c.render.settings.getState().s.env)).toBe('studio')
})

test('the Appearance dialog edits a material and a lost face is reported', async ({ app, page }) => {
  await app.open()
  await addBox(app, [30, 30, 20], [0, 0, 0])
  await frame(app)
  await app.tab('Render')
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'face', id: 'f1', index: 1 }]))
  await app.ribbon('Appearance').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Appearance')
  await app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Material' }) }).locator('button.sel').click()
  await page.getByRole('option', { name: 'Carbon fiber' }).click()
  await app.shot('render-appearance-dialog')
  await app.ok()
  const f = await appearances(app)
  expect(f).toHaveLength(1)
  expect(f[0].params).toMatchObject({ material: 'carbon' })
  expect(f[0].state).toBe('ok')
  // delete the only body: the feature has nothing to hold on to and says so
  await app.ev((c) => c.doc.getState().removeFeature('f1'))
  await app.idle()
  const after = await appearances(app)
  expect(after[0].state).toBe('error')
  expect(after[0].error).toMatch(/no longer exist/)
})
