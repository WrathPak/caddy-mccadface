import { test, expect, type App } from './helpers'
import type { Page } from '@playwright/test'
import { writeCylinderFixture } from './fixtures'

const okButton = (page: Page) => page.locator('.inspector-foot').getByRole('button', { name: 'OK' })

async function addBox(app: App, position: [number, number, number], size = 20) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size, depth: a.size, height: a.size, position: a.position }), { size, position })
  await app.idle()
}
async function frame(app: App) {
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}
async function importCylinder(app: App, page: Page) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Import').click()])
  await chooser.setFiles(writeCylinderFixture())
  await expect.poll(() => app.bodies().then((b) => b.length)).toBe(1)
  await app.idle()
}
async function states(app: App) {
  const f = await app.features()
  expect(f.map((x) => x.state), JSON.stringify(f.map((x) => x.error))).toEqual(f.map(() => 'ok'))
  return f
}
const sceneHas = (app: App, name: string) => app.ev((c, n) => !!c.three.scene.getObjectByName(n), name)

test('Measure: pick two faces and read the distance', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0])
  await addBox(app, [50, 0, 0])
  await frame(app)
  await app.ribbon('Measure').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Measure')
  await expect(page.getByTestId('info-result')).toContainText('Pick a face')
  for (const x of [0, 50]) {
    const p = await app.project(x, 0, 20)
    await page.mouse.move(p.x - 20, p.y + 4)
    await page.mouse.move(p.x, p.y, { steps: 4 })
    await page.mouse.click(p.x, p.y)
  }
  const result = page.getByTestId('info-result')
  await expect(result).toContainText('Area      400')
  await expect(result).toContainText('Center distance  50')
  await expect(result).toContainText('Plane distance   0 mm')
  await app.shot('measure-dialog')
  // switching the pick type to Edge changes the viewport selection filter
  await app.inspector().getByRole('radio', { name: 'Edge' }).click()
  expect(await app.ev((c) => c.ui.getState().selectionFilter)).toBe('edge')
  await app.inspector().getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.inspector-foot')).toHaveCount(0)
  expect(await app.features()).toHaveLength(2) // measuring never adds a feature
})

test('Section Analysis: clipping plane with a status chip; Cancel removes it', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0])
  await frame(app)
  await app.ribbon('Section Analysis').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Section Analysis')
  expect(await app.ev((c) => c.ui.getState().section)).toMatchObject({ on: true, axis: 'Z', offset: 10 }) // centred on the box
  await app.field('Offset', '14')
  await expect(page.getByTestId('section-chip')).toContainText('Z = 14')
  const clipped = () => app.ev((c) => {
    let n = 0
    c.three.scene.getObjectByName('bodies').traverse((o: any) => { if (o.isMesh && o.material.clippingPlanes?.length === 1) n++ }) // eslint-disable-line
    return n
  })
  expect(await clipped()).toBeGreaterThan(0)
  await app.shot('section-dialog')
  await app.inspector().getByRole('radio', { name: 'X' }).click()
  expect(await app.ev((c) => c.ui.getState().section)).toMatchObject({ axis: 'X', offset: 0 }) // re-centred
  await app.inspector().getByRole('radio', { name: 'Z' }).click()
  await app.inspector().getByRole('checkbox', { name: 'Flip side' }).click()
  expect(await app.ev((c) => c.ui.getState().section.flip)).toBe(true)
  await okButton(page).click()
  await expect(page.getByTestId('section-chip')).toBeVisible() // OK keeps it
  await page.getByTestId('section-chip').click() // the chip removes it
  await expect(page.getByTestId('section-chip')).toHaveCount(0)
  expect(await clipped()).toBe(0)
  await app.ribbon('Section Analysis').click()
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  expect(await app.ev((c) => c.ui.getState().section.on)).toBe(false)
  expect(await app.features()).toHaveLength(1)
})

test('Offset Plane: sketch on a construction plane; planes are hidden until their eye is switched on', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0])
  await frame(app)
  // origin planes start hidden (the axes stay), and the eye in the Browser shows them
  expect(await sceneHas(app, 'planeXY')).toBe(false)
  await page.locator('.tree-row', { hasText: /^Planes$/ }).click()
  const row = page.locator('.tree-row', { hasText: 'XY plane' })
  await expect(row.locator('.eye')).toHaveAttribute('data-off', 'true')
  await row.locator('.eye').click()
  await expect(row.locator('.eye')).toHaveAttribute('data-off', 'false')
  expect(await sceneHas(app, 'planeXY')).toBe(true)
  await app.shot('origin-plane-visible')
  await row.locator('.eye').click()
  expect(await sceneHas(app, 'planeXY')).toBe(false)

  await app.ribbon('Offset Plane').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Offset Plane')
  await app.field('Distance', '30')
  await expect.poll(() => app.ev((c) => c.planes.getState().data.preview?.origin[2])).toBe(30)
  await app.shot('offset-plane-dialog')
  await app.ok()
  const f = await states(app)
  expect(f.map((x) => x.type)).toEqual(['box', 'offsetPlane'])
  await expect(page.locator('.tree-row', { hasText: 'OffsetPlane1' }).or(page.locator('.tree-row', { hasText: 'Offset Plane1' }))).toBeVisible()
  expect(await sceneHas(app, 'cplane-' + f[1].id)).toBe(true)
  // start a sketch on it
  await app.ev((c) => c.runCommand('sketch.create'))
  await app.ev((c, id) => c.ui.getState().setSelection([{ kind: 'plane', id }]), f[1].id)
  await expect.poll(() => app.ev((c) => c.sketch.getState().active)).toBe(true)
  expect(await app.ev((c) => c.sketch.getState().plane.origin)).toEqual([0, 0, 30])
  await app.ev((c) => c.runCommand('sketch.finish'))
})

test('Browser: Isolate hides everything else, Show all restores', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0])
  await addBox(app, [50, 0, 0])
  const ids = await app.ev((c) => c.doc.getState().geometry.map((b: any) => b.id)) // eslint-disable-line
  const hidden = () => app.ev((c) => Object.keys(c.ui.getState().hiddenIds).filter((k: string) => !k.startsWith('plane')).sort())
  await page.locator('.tree-row', { hasText: 'Box1' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Isolate' }).click()
  expect(await hidden()).toEqual([ids[1]])
  await page.locator('.tree-row', { hasText: 'Box1' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Show all' }).click()
  expect(await hidden()).toEqual([])
})

test('Mesh tools: Plane Cut, Refine, Reduce, Smooth, Repair on an imported mesh; Convert on a solid', async ({ app, page }) => {
  await app.open()
  await importCylinder(app, page)
  await app.tab('Mesh')
  const run = async (button: string, setup?: () => Promise<void>) => {
    await app.ribbon(button).first().click()
    await expect(app.inspector().locator('.panel-title')).toHaveText(button)
    await expect(okButton(page)).toBeEnabled() // the single mesh was pre-selected
    await setup?.()
    await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBeGreaterThan(0)
    await app.ok()
    await states(app)
  }
  const v0 = await app.volume()
  const t0 = (await app.bodies())[0].tris

  await run('Refine', () => app.field('Max edge length', '4'))
  const t1 = (await app.bodies())[0].tris
  expect(t1).toBeGreaterThan(t0)
  expect(await app.volume()).toBeCloseTo(v0, -1)

  await run('Smooth', () => app.field('Iterations', '3'))
  expect((await app.bodies())[0].tris).toBe(t1)
  await app.shot('mesh-smooth')

  await run('Reduce', () => app.field('Tolerance', '0.2'))
  const t3 = (await app.bodies())[0].tris
  expect(t3).toBeLessThan(t1)

  await run('Repair')
  expect(await app.bodies()).toHaveLength(1)

  await run('Plane Cut', async () => {
    await app.field('Offset', '15')
    await app.inspector().locator('.sel').first().click()
    await page.getByRole('option', { name: 'Both (split)' }).click()
  })
  const bodies = await app.bodies()
  expect(bodies).toHaveLength(2)
  const [v1, v2] = [await app.volume(bodies[0].id), await app.volume(bodies[1].id)]
  expect(v1).toBeGreaterThan(300)
  expect(v2).toBeGreaterThan(300)
  expect(Math.abs(v1 - v2) / Math.max(v1, v2)).toBeLessThan(0.25)
  await app.shot('mesh-plane-cut')
  expect((await app.features()).map((f) => f.type)).toEqual(['importMesh', 'meshRefine', 'meshSmooth', 'meshReduce', 'meshRepair', 'meshPlaneCut'])

  // Convert to Mesh on a solid
  await app.ev((c) => c.doc.getState().newDocument())
  await addBox(app, [0, 0, 0])
  await app.ribbon('Convert to Mesh').click()
  await expect(okButton(page)).toBeEnabled()
  await app.ok()
  await states(app)
  expect((await app.bodies())[0].kind).toBe('mesh')
  expect(await app.volume()).toBeCloseTo(8000, -1)
})
