import { test, expect, type App } from './helpers'

/** A 30 x 20 sketch rectangle on XY, finished, ready to extrude. */
async function rectSketch(app: App) {
  await app.open()
  await app.sketchRect('XY', 30, 20)
  await app.finishSketch()
}
const inspectorOpen = (app: App) => app.ev((c) => !!c.ui.getState().inspector)
const types = async (app: App) => (await app.features()).map((f) => f.type)

test('Enter accepts the Extrude dialog (focus on the canvas), Escape cancels it', async ({ app, page }) => {
  await rectSketch(app)
  await app.ribbon('Extrude').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  await page.keyboard.press('Escape')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
  expect(await types(app)).toEqual(['sketch'])

  await app.ribbon('Extrude').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  await page.keyboard.press('Enter')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
  await app.idle()
  const feats = await app.features()
  expect(feats.map((f) => [f.type, f.state])).toEqual([['sketch', 'ok'], ['extrude', 'ok']])
  expect(await app.bodies()).toHaveLength(1)
})

test('Enter in a number field commits that field first, then accepts the dialog; Escape there reverts, then cancels', async ({ app, page }) => {
  await rectSketch(app)
  await app.ribbon('Extrude').click()
  const dist = app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: /^Distance$/ }) }).locator('input')
  await dist.click()
  await dist.fill('12 + 3')
  await dist.press('Enter')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
  await app.idle()
  const feats = await app.features()
  expect(feats[1].type).toBe('extrude')
  expect(feats[1].params.distance).toBe('12 + 3') // the expression, evaluated to 15 mm
  const bb = await app.bbox()
  expect(bb.max[2] - bb.min[2]).toBeCloseTo(15, 3)

  // Escape in a field with a pending edit reverts it; a second Escape cancels the dialog
  await app.ev((c) => c.runCommand('solid.extrude'))
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  const d2 = app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: /^Distance$/ }) }).locator('input')
  await d2.click()
  await d2.fill('99')
  await d2.press('Escape')
  await expect(d2).toHaveValue('10')
  expect(await inspectorOpen(app)).toBe(true)
  await d2.focus()
  await d2.press('Escape')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
  expect(await types(app)).toEqual(['sketch', 'extrude'])
})

test('Enter on an invalid dialog shows the validation hint instead of accepting', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.extrude')) // nothing to extrude
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  await expect(page.getByTestId('inspector-hint')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('inspector-hint')).toHaveClass(/nudge/)
  expect(await inspectorOpen(app)).toBe(true)
  expect(await types(app)).toEqual([])
  await page.keyboard.press('Escape')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
})

test('Enter accepts the Box, Fillet and Hair dialogs; Escape cancels them', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await expect(app.inspector().locator('.panel-title')).toHaveText('Box')
  await page.keyboard.press('Escape')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
  expect(await types(app)).toEqual([])
  await app.ev((c) => c.runCommand('solid.box'))
  await page.keyboard.press('Enter')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
  await app.idle()
  expect(await types(app)).toEqual(['box'])

  // Fillet: pick an edge programmatically, then Enter
  const id = await app.ev((c) => c.doc.getState().geometry[0].id as string)
  await app.ev((c, id) => { c.ui.getState().setSelectionFilter('edge'); c.ui.getState().setSelection([{ kind: 'edge', id, index: 0 }]) }, id)
  await app.ev((c) => c.runCommand('solid.fillet'))
  await expect(app.inspector().locator('.panel-title')).toHaveText('Fillet')
  await expect(app.inspector().getByRole('button', { name: 'OK' })).toBeEnabled()
  await page.keyboard.press('Enter')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
  await app.idle()
  expect((await types(app)).slice(-1)).toEqual(['fillet'])

  // Hair on a side face
  const face = await app.ev((c) => {
    const m = c.doc.getState().geometry[0].mesh
    for (let t = 0; t < m.indices.length / 3; t++) { const i = m.indices[t * 3] * 3; if (m.normals[i] > 0.99) return m.faceIds[t] as number }
    return 0
  })
  await app.ev((c, a) => { c.ui.getState().setSelectionFilter('face'); c.ui.getState().setSelection([{ kind: 'face', id: a.id, index: a.face }]) }, { id, face })
  await app.ev((c) => c.runCommand('hair.create'))
  await expect(app.inspector().locator('.panel-title')).toHaveText('Hair')
  await expect.poll(() => app.ev((c) => c.hair.getState().result?.stats?.strands ?? 0), { timeout: 45_000 }).toBeGreaterThan(0)
  await page.keyboard.press('Enter')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
  await app.idle()
  expect((await types(app)).slice(-1)).toEqual(['hair'])
})

test('Enter / Escape belong to the command palette and rename boxes while they are in use', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await expect(app.inspector().locator('.panel-title')).toHaveText('Box')
  // command palette: Enter runs the highlighted command, the Box dialog stays open
  await page.keyboard.press('s')
  await page.locator('.cmdk input').fill('wireframe')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cmdk')).toHaveCount(0)
  expect(await app.ev((c) => c.ui.getState().displayMode)).toBe('wireframe')
  expect(await inspectorOpen(app)).toBe(true)
  // Escape in the palette closes only the palette
  await page.keyboard.press('s')
  await expect(page.locator('.cmdk')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.cmdk')).toHaveCount(0)
  expect(await inspectorOpen(app)).toBe(true)
  // a rename box in the Browser
  await app.ok()
  await app.ev((c) => c.runCommand('solid.box'))
  await expect(app.inspector().locator('.panel-title')).toHaveText('Box')
  const row = page.locator('.tree-row', { hasText: 'Box1' })
  await row.dblclick()
  await page.locator('.tree-row input.rename').fill('Block')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tree-row', { hasText: 'Block' })).toBeVisible()
  expect(await inspectorOpen(app)).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
})

test('the on-canvas distance box accepts with Enter', async ({ app, page }) => {
  await rectSketch(app)
  await app.ribbon('Extrude').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  const label = page.getByTestId('manip-value')
  await expect(label).toBeVisible({ timeout: 20_000 })
  await label.click()
  const box = page.getByTestId('manip-input')
  await expect(box).toBeFocused()
  await box.fill('7.5')
  await box.press('Enter')
  await expect.poll(() => inspectorOpen(app)).toBe(false)
  await app.idle()
  const feats = await app.features()
  expect(feats[1].params.distance).toBe(7.5)
  const bb = await app.bbox()
  expect(bb.max[2] - bb.min[2]).toBeCloseTo(7.5, 3)
})

test('sketcher: Enter / Escape end the polyline, then the tool; Enter with no tool finishes the sketch', async ({ app, page }) => {
  await app.open()
  await app.ribbon('Sketch').first().click()
  const planes = page.getByText('Planes', { exact: true })
  if (!(await page.getByText('XY plane').isVisible())) await planes.click()
  await page.getByText('XY plane').click()
  await expect(page.locator('.sk-bar')).toBeVisible()
  await app.ribbon('Line').first().click()
  const b = (await page.locator('.vp canvas').boundingBox())!
  const at = (dx: number, dy: number) => ({ x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 + dy })
  const click = async (dx: number, dy: number) => { const p = at(dx, dy); await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.click(p.x, p.y) }
  const st = () => app.ev((c) => { const s = c.sketch.getState(); return { draft: !!s.draft, tool: s.tool, active: s.active, lines: s.model.entities.filter((e: any) => e.type === 'line').length } })
  await click(-120, 60)
  await click(-20, -40)
  await click(80, 40)
  expect(await st()).toMatchObject({ draft: true, tool: 'line', lines: 2 })
  // Enter ends the polyline but keeps the Line tool
  await page.keyboard.press('Enter')
  expect(await st()).toMatchObject({ draft: false, tool: 'line', lines: 2 })
  // a second polyline, ended with Escape
  await click(-100, -90)
  await click(100, -90)
  expect(await st()).toMatchObject({ draft: true, lines: 3 })
  await page.keyboard.press('Escape')
  expect(await st()).toMatchObject({ draft: false, tool: 'line', lines: 3 })
  // Enter ends the tool
  await page.keyboard.press('Enter')
  expect(await st()).toMatchObject({ tool: 'select', active: true })
  // Enter with no tool active finishes the sketch
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await st()).active).toBe(false)
  await app.idle()
  expect(await types(app)).toEqual(['sketch'])
})

test('sketch dimension boxes accept with Enter and cancel with Escape', async ({ app, page }) => {
  await app.open()
  await app.sketchRect('XY', 30, 20)
  const dim = await app.ev((c) => c.sketch.getState().model.constraints.find((k: any) => k.value === 30)?.id as string)
  expect(dim).toBeTruthy()
  await app.ev((c, id) => c.sketch.setState({ dimEdit: id, dimNew: false, sel: [id] }), dim)
  const input = page.locator('.sk-dim-input')
  await expect(input).toBeFocused()
  await input.fill('44')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect.poll(() => app.ev((c, id) => c.sketch.getState().model.constraints.find((k: any) => k.id === id).value, dim)).toBeCloseTo(44, 3)
  // Escape leaves the value alone
  await app.ev((c, id) => c.sketch.setState({ dimEdit: id, dimNew: false, sel: [id] }), dim)
  await page.locator('.sk-dim-input').fill('12')
  await page.locator('.sk-dim-input').press('Escape')
  await expect(page.locator('.sk-dim-input')).toHaveCount(0)
  expect(await app.ev((c, id) => c.sketch.getState().model.constraints.find((k: any) => k.id === id).value, dim)).toBeCloseTo(44, 3)
})
