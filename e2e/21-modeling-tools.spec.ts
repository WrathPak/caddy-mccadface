import { test, expect, type App } from './helpers'

async function addBox(app: App, w = 40, d = 40, h = 10, position = [0, 0, 0]) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.w, depth: a.d, height: a.h, position: a.position }), { w, d, h, position })
  await app.idle()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}
const states = async (app: App) => {
  const f = await app.features()
  expect(f.map((x) => x.state), JSON.stringify(f.map((x) => x.error))).toEqual(f.map(() => 'ok'))
  return f
}
const title = (app: App) => app.inspector().locator('.panel-title')
/** Choose an entry of a long select by typing its start (radix typeahead), like a keyboard user would. */
async function pickSize(app: App, text: string) {
  const trigger = app.inspector().locator('.field', { has: app.page.locator('.field-label', { hasText: 'Size' }) }).locator('.sel')
  await trigger.click()
  await app.page.getByRole('option', { name: new RegExp(text) }).click()
}
const markers = (app: App) => app.ev((c) => c.markers.getState().items.map((m: any) => [m.id, m.state])) // eslint-disable-line

test('Hole: click points on a face, pick a preset, a counterbore and a tapped hole with a cosmetic thread', async ({ app, page }) => {
  await app.open()
  await addBox(app)
  await app.tab('Solid')
  await app.ribbon('Hole').first().click()
  await expect(title(app)).toHaveText('Hole')
  await expect(page.getByTestId('inspector-hint')).toContainText('positions')
  // two clicks on the top face place two holes (the dots are the hole centres)
  for (const [x, y] of [[-10, 0], [10, 5]]) {
    const p = await app.project(x, y, 10)
    await page.mouse.move(p.x, p.y, { steps: 3 })
    await page.mouse.click(p.x, p.y)
  }
  await expect.poll(async () => (await markers(app)).length).toBe(2)
  await expect(page.getByTestId('info-summary')).toContainText('2 holes')
  // the M3 counterbore preset fills the size fields
  await pickSize(app, 'M3 counterbore')
  await expect(app.inspector().locator('.field', { hasText: 'Counterbore diameter' }).locator('input')).toHaveValue('6.5')
  await expect(app.inspector().locator('.field', { hasText: 'Counterbore depth' }).locator('input')).toHaveValue('3.4')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ev((c) => { c.runCommand('view.frame') })
  await app.shot('hole-dialog')
  await app.ok()
  await states(app)
  const v = 40 * 40 * 10 - 2 * (Math.PI * 3.25 ** 2 * 3.4 + Math.PI * 1.7 ** 2 * 6.6)
  expect(Math.abs((await app.volume()) - v) / v).toBeLessThan(0.01)
  await app.shot('hole-done')

  // a tapped hole: the thread is a cosmetic mark until it is modeled
  const p = await app.project(0, -12, 10)
  await app.ribbon('Hole').first().click()
  await page.mouse.click(p.x, p.y)
  await expect.poll(async () => (await markers(app)).length).toBe(1)
  await pickSize(app, 'M5 x 0.8 tapped')
  await app.ok()
  await states(app)
  expect(await app.ev((c) => Object.keys(c.construct.getState().threads).length)).toBe(1)
  await app.shot('hole-tapped')
})

test('Pattern: repeat the hole feature, skip an instance by clicking its marker, then edit the box upstream', async ({ app, page }) => {
  await app.open()
  await addBox(app, 80, 20, 10)
  const top = await app.ev((c) => {
    const b = c.doc.getState().geometry[0]
    return b.mesh.faceNames.findIndex((n: string[]) => n[0].endsWith(':zmax'))
  })
  await app.ev((c, i) => {
    const b = c.doc.getState().geometry[0]
    const sig = { normal: [0, 0, 1], centroid: [0, 0, 10], area: 1600 }
    const ref = { kind: 'face', bodyId: b.id, featureId: b.featureId, index: i, sig, name: b.mesh.faceNames[i][0] }
    c.doc.getState().addFeature('hole', { places: [JSON.stringify({ hole: 1, k: 'a', face: JSON.stringify(ref), u: -30, v: 0 })], dia: 4, depthMode: 'through' })
  }, top)
  await app.idle()
  await app.tab('Solid')
  await page.locator('.tl .chip').nth(1).click() // select the Hole in the timeline
  await app.ribbon('Pattern').first().click()
  await expect(title(app)).toHaveText('Pattern')
  await expect(page.getByTestId('sel-features')).toContainText('1 selected')
  await app.field('Quantity', '4')
  await app.field('Distance', '20')
  await expect.poll(async () => (await markers(app)).length).toBe(4) // the original and three copies
  await app.ev((c) => c.runCommand('view.frame'))
  await app.shot('pattern-dialog')
  // click the marker of the second copy to leave it out
  await expect.poll(async () => (await markers(app)).map((m: any) => m[1]).join()).toBe('fixed,on,on,on') // eslint-disable-line
  const where = await app.ev((c) => c.markers.getState().items.find((m: any) => m.id === '2').pos) // eslint-disable-line
  const p = await app.project(where[0], where[1], where[2])
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await page.mouse.click(p.x, p.y)
  await expect.poll(async () => (await markers(app)).map((m: any) => m[1]).join()).toBe('fixed,on,off,on') // eslint-disable-line
  await expect(page.getByTestId('info-hint')).toContainText('2 copies (1 skipped)')
  await app.shot('pattern-skipped')
  await app.ok()
  await states(app)
  const h = 4 * Math.PI * 4 * 10
  expect(Math.abs((await app.volume()) - (80 * 20 * 10 - 3 * Math.PI * 4 * 10 + 0 * h)) / 16000).toBeLessThan(0.01)

  // widen the box: the hole and its copies follow, the skipped one stays skipped
  await page.locator('.tl .chip').first().dblclick()
  await app.field('Height (Z)', '14')
  await app.ok()
  await states(app)
  expect(Math.abs((await app.volume()) - (80 * 20 * 14 - 3 * Math.PI * 4 * 14)) / 22400).toBeLessThan(0.01)
})

test('Mirror: a body across a plane, joined', async ({ app, page }) => {
  await app.open()
  await addBox(app, 10, 10, 10, [20, 0, 0])
  await app.tab('Solid')
  await page.getByRole('button', { name: 'Pattern options' }).click()
  await page.getByRole('menuitem', { name: 'Mirror' }).click()
  await expect(title(app)).toHaveText('Mirror')
  await page.locator('.tree-row', { hasText: 'Box1' }).first().click()
  await page.getByTestId('sel-plane').click() // a field that takes several bodies stays active until you pick another
  await page.getByText('Planes', { exact: true }).click()
  await page.locator('.tree-row', { hasText: 'YZ plane' }).first().click()
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ev((c) => c.runCommand('view.frame'))
  await app.shot('mirror-dialog')
  await app.ok()
  await states(app)
  expect((await app.bodies()).length).toBe(2)
  const bbs = await Promise.all((await app.bodies()).map((b) => app.bbox(b.id)))
  expect(Math.min(...bbs.map((b) => b.min[0]))).toBeCloseTo(-25, 3)
})

test('Construction geometry: plane at an angle, axis, point; usable as a sketch plane and shown in the Browser', async ({ app, page }) => {
  await app.open()
  await addBox(app)
  await app.tab('Solid')
  await app.ribbon('Axis').first().click()
  await expect(title(app)).toHaveText('Construction Axis')
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  // two coordinate points and the axis through them, set up in the document
  const ids = await app.ev((c) => {
    const d = c.doc.getState()
    const a = d.addFeature('constructPoint', { mode: 'coords', pos: [0, 0, 20] })
    const b = d.addFeature('constructPoint', { mode: 'coords', pos: [10, 0, 20] })
    const ax = d.addFeature('constructAxis', { mode: 'twoPoints', p1: [a], p2: [b] })
    return { a, b, ax }
  })
  await app.idle()
  await page.getByText('Axes', { exact: true }).click()
  await expect(page.locator('.tree-row', { hasText: 'Construction Axis' })).toBeVisible()
  await page.getByText('Points', { exact: true }).click()
  await expect(page.locator('.tree-row', { hasText: 'Construction Point' })).toHaveCount(2)
  // the plane at an angle about that axis
  await app.ribbon('Plane at Angle').first().click()
  await expect(title(app)).toHaveText('Construction Plane')
  await page.getByText('Planes', { exact: true }).click()
  await page.locator('.tree-row', { hasText: 'XY plane' }).first().click()
  await page.locator('.tree-row', { hasText: 'Construction Axis' }).first().click()
  await app.field('Angle', '30')
  await expect.poll(() => app.ev((c) => !!c.planes.getState().data.preview)).toBe(true)
  await app.shot('construct-plane-dialog')
  await app.ok()
  await states(app)
  const pl = await app.ev((c) => Object.values(c.planes.getState().data).pop() as any) // eslint-disable-line
  expect(Math.abs(pl.normal[2])).toBeCloseTo(Math.cos(Math.PI / 6), 5)
  expect(ids.ax).toBeTruthy()
  // the new plane is listed with the other planes and can be sketched on
  await expect(page.locator('.tree-row', { hasText: 'Construction Plane1' })).toBeVisible()
  await app.ribbon('Sketch').first().click()
  await page.locator('.tree-row', { hasText: 'Construction Plane1' }).click()
  await expect(page.locator('.sk-bar')).toBeVisible()
  expect(await app.ev((c) => Math.abs(c.sketch.getState().plane.normal[2]))).toBeCloseTo(Math.cos(Math.PI / 6), 5)
})

test('Press/Pull, Offset Face, Split Body from the ribbon', async ({ app, page }) => {
  await app.open()
  await addBox(app, 20, 20, 10)
  await app.tab('Solid')
  const top = await app.project(0, 0, 10)
  await page.mouse.click(top.x, top.y)
  await expect.poll(() => app.ev((c) => c.ui.getState().selection.map((r: any) => r.kind))).toEqual(['face']) // eslint-disable-line
  await app.ribbon('Press/Pull').first().click()
  await expect(title(app)).toHaveText('Press/Pull')
  await expect(page.getByTestId('manip-value')).toBeVisible()
  await app.field('Distance', '5')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.shot('presspull-dialog')
  await app.ok()
  await states(app)
  expect((await app.bbox()).max[2]).toBeCloseTo(15, 3)

  await page.getByRole('button', { name: 'Press/Pull options' }).click()
  await page.getByRole('menuitem', { name: 'Split Body' }).click()
  await expect(title(app)).toHaveText('Split Body')
  await page.locator('.tree-row', { hasText: 'Box1' }).first().click()
  await page.getByTestId('sel-tool').click()
  await page.getByText('Planes', { exact: true }).click()
  await page.locator('.tree-row', { hasText: 'YZ plane' }).first().click()
  await app.ok()
  await states(app)
  expect((await app.bodies()).length).toBe(2)
  await app.shot('split-body')
})
