import { test, expect, type App } from './helpers'

async function startSketch(app: App) {
  const { page } = app
  await app.ribbon('Sketch').first().click()
  await app.showPlane('XY')
  await page.getByText('XY plane').click()
  await expect(page.locator('.sk-bar')).toBeVisible()
  await app.ev((c) => c.ui.setState({ snap: false })) // exact positions: no grid
  await app.cameraStable()
}
const sk = (app: App) => app.ev((c) => {
  const s = c.sketch.getState()
  return { entities: s.model.entities, constraints: s.model.constraints, profiles: s.profiles.map((p: any) => ({ area: p.area, holes: p.holes.length })), dof: s.info.dof, ok: s.info.ok } // eslint-disable-line
})
async function click(app: App, x: number, y: number) {
  const p = await app.project(x, y, 0)
  await app.page.mouse.move(p.x, p.y, { steps: 3 })
  await app.page.mouse.click(p.x, p.y)
}
/** Bounds of the points of the sketch: where the typed rectangle really is. */
const bounds = (app: App) => app.ev((c) => {
  const pts = c.sketch.getState().model.entities.filter((e: any) => e.type === 'point') // eslint-disable-line
  const xs = pts.map((p: any) => p.x), ys = pts.map((p: any) => p.y) // eslint-disable-line
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
})
const tool = (app: App, name: string | RegExp) => app.ribbon(name).first().click()
const menuTool = async (app: App, group: string, item: string) => {
  await app.page.getByRole('button', { name: `${group} options` }).click()
  await app.page.getByRole('menuitem', { name: item }).click()
}
const near = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
const types = (m: { entities: { type: string }[] }, t: string) => m.entities.filter((e) => e.type === t)

test('Spline: fit point and control point splines, closing, and tangent handles', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Fit Point Spline')
  await expect(page.getByTestId('sk-toolbar')).toContainText('Fit point spline')
  for (const [x, y] of [[0, 0], [20, 15], [45, 5], [70, 20]]) await click(app, x, y)
  await page.keyboard.press('Enter')
  let m = await sk(app)
  expect(types(m, 'spline').length).toBe(1)
  expect((types(m, 'spline')[0] as any).mode).toBe('fit') // eslint-disable-line
  // select it and give it tangent handles
  await app.ev((c) => c.sketch.setState({ sel: c.sketch.getState().model.entities.filter((e: any) => e.type === 'spline').map((e: any) => e.id), tool: 'select' })) // eslint-disable-line
  await tool(app, 'Tangent Handles')
  m = await sk(app)
  const s = types(m, 'spline')[0] as any // eslint-disable-line
  expect(s.t0 && s.t1).toBeTruthy()
  await app.shot('spline-handles')
  // a control point spline, closed by clicking its first point again: a profile
  await menuTool(app, 'Fit Point Spline', 'Control Point Spline')
  for (const [x, y] of [[0, -30], [30, -30], [30, -60], [0, -60]]) await click(app, x, y)
  await click(app, 0, -30)
  m = await sk(app)
  const closed = types(m, 'spline').find((e: any) => e.mode === 'ctrl') as any // eslint-disable-line
  expect(closed.closed).toBe(true)
  expect(m.profiles.length).toBe(1)
  await app.shot('spline-closed')
})

test('Ellipse: centre, long axis, short radius', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Ellipse')
  await click(app, 0, 0)
  await click(app, 40, 0)
  await click(app, 0, 15)
  const m = await sk(app)
  expect(types(m, 'ellipse').length).toBe(1)
  expect(m.profiles.length).toBe(1)
  near(m.profiles[0].area, Math.PI * 40 * 15, 0.02)
  await app.shot('ellipse')
})

test('Slots and polygon', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Centre to Centre Slot')
  await click(app, -40, 30)
  await click(app, 0, 30)
  await click(app, -20, 38)
  let m = await sk(app)
  expect(types(m, 'arc').length).toBe(2)
  near(m.profiles[0].area, 40 * 16 + Math.PI * 64, 0.03)
  await menuTool(app, 'Centre to Centre Slot', 'Overall Slot')
  await click(app, 20, 30)
  await click(app, 70, 30)
  await click(app, 45, 36)
  m = await sk(app)
  expect(m.profiles.length).toBe(2)
  await menuTool(app, 'Centre to Centre Slot', 'Centre Point Arc Slot')
  await click(app, 0, -20)
  await click(app, 30, -20)
  await click(app, 0, 10 - 20)
  await click(app, 36, -20)
  m = await sk(app)
  expect(m.profiles.length).toBe(3)
  await tool(app, 'Polygon')
  await page.getByTestId('sk-opt-sides').fill('5')
  await page.getByTestId('sk-opt-sides').press('Enter')
  await click(app, 60, -30)
  await click(app, 75, -30)
  m = await sk(app)
  // the pentagon's five sides, on top of the four sides of the two straight slots and the arc slot's none
  expect(m.entities.filter((e: any) => e.type === 'line' && !e.construction).length).toBe(9) // eslint-disable-line
  expect(m.ok).toBe(true)
  expect(m.profiles.length).toBe(4)
  await app.shot('slots-polygon')
})

test('Sketch fillet and chamfer at a corner keep the dimensions', async ({ app, page }) => {
  await app.open()
  await app.sketchRect('XY', 30, 20)
  await app.ev((c) => c.ui.setState({ snap: false }))
  await app.cameraStable()
  const b = await bounds(app)
  const free = (await sk(app)).dof // the typed rectangle is sized but not placed
  await tool(app, 'Sketch Fillet')
  await page.getByTestId('sk-opt-radius').fill('4')
  await page.getByTestId('sk-opt-radius').press('Enter')
  await click(app, b.x1, b.y1)
  let m = await sk(app)
  expect(types(m, 'arc').length).toBe(1)
  near(m.profiles[0].area, 600 - (16 - Math.PI * 4), 0.005)
  expect(m.dof).toBe(free)
  await app.shot('sketch-fillet')
  await menuTool(app, 'Sketch Fillet', 'Sketch Chamfer')
  await page.getByTestId('sk-opt-dist').fill('5')
  await page.getByTestId('sk-opt-dist').press('Enter')
  await click(app, b.x0, b.y0)
  m = await sk(app)
  near(m.profiles[0].area, 600 - (16 - Math.PI * 4) - 12.5, 0.005)
  expect(m.dof).toBe(free)
})

test('Sketch mirror and rectangular pattern stay constrained', async ({ app, page }) => {
  await app.open()
  await app.sketchRect('XY', 20, 10)
  await app.ev((c) => c.ui.setState({ snap: false }))
  await app.cameraStable()
  const b = await bounds(app)
  const rect = () => app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'line' && !e.construction).slice(0, 4).map((e: any) => e.id)) // eslint-disable-line
  // a mirror line to the right of the rectangle, drawn with the line tool
  await tool(app, 'Line')
  await click(app, b.x1 + 20, b.y0 - 10)
  await click(app, b.x1 + 20, b.y1 + 10)
  await page.keyboard.press('Escape')
  const ids = await rect()
  await app.ev((c, sel) => c.sketch.setState({ sel, tool: 'select' }), ids)
  await tool(app, 'Sketch Mirror')
  await click(app, b.x1 + 20, (b.y0 + b.y1) / 2)
  let m = await sk(app)
  expect(m.constraints.filter((k: any) => k.type === 'mirror').length).toBe(4) // eslint-disable-line
  expect(m.profiles.length).toBe(2)
  expect(m.ok).toBe(true)
  await app.shot('sketch-mirror')

  // the same rectangle again as a rectangular pattern, three in a row
  await app.ev((c, sel) => c.sketch.setState({ sel, tool: 'select' }), ids)
  await tool(app, 'Rectangular Pattern')
  await expect(page.getByTestId('sk-toolbar')).toContainText('Rectangular pattern')
  for (const [id, v] of [['count', '3'], ['spacing', '15'], ['angle', '90']]) {
    await page.getByTestId('sk-opt-' + id).fill(v)
    await page.getByTestId('sk-opt-' + id).press('Enter')
  }
  await page.getByTestId('sk-apply').click()
  m = await sk(app)
  expect(m.profiles.length).toBe(4)
  expect(m.ok).toBe(true)
  await app.shot('sketch-pattern')
})

test('Circular pattern about the origin', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Circle')
  await click(app, 30, 0)
  await click(app, 34, 0)
  await page.keyboard.press('Escape')
  await app.ev((c) => c.sketch.setState({ sel: c.sketch.getState().model.entities.filter((e: any) => e.type === 'circle').map((e: any) => e.id), tool: 'select' })) // eslint-disable-line
  await menuTool(app, 'Rectangular Pattern', 'Circular Pattern')
  await page.getByTestId('sk-opt-count').fill('6')
  await page.getByTestId('sk-opt-count').press('Enter')
  await click(app, 0, 0)
  const m = await sk(app)
  expect(types(m, 'circle').length).toBe(6)
  expect(m.constraints.filter((k: any) => k.type === 'rotated').length).toBeGreaterThanOrEqual(5) // eslint-disable-line
  expect(m.profiles.length).toBe(6)
  await app.shot('sketch-circular-pattern')
})

test('Text: outlines become profiles and extrude into a solid', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Text')
  await page.getByTestId('sk-opt-text').fill('OK')
  await page.getByTestId('sk-opt-height').fill('12')
  await page.getByTestId('sk-opt-height').press('Enter')
  await click(app, 0, 0)
  await expect.poll(async () => (await sk(app)).profiles.length).toBe(2)
  const m = await sk(app)
  expect(types(m, 'text').length).toBe(1)
  expect(m.profiles.some((p: any) => p.holes === 1)).toBe(true) // the O has its counter // eslint-disable-line
  await app.shot('sketch-text')
  await app.finishSketch()
  await page.locator('.tree-row', { hasText: 'Sketch1' }).first().click() // all the letters at once
  await app.ribbon('Extrude').click()
  await app.field('Distance', '3')
  await app.ok()
  const feats = await app.features()
  expect(feats.map((f) => f.state)).toEqual(['ok', 'ok'])
  expect(await app.volume()).toBeGreaterThan(30)
  await app.shot('text-extruded')
})

test('Import SVG and DXF into a sketch', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="40mm" viewBox="0 0 60 40"><rect x="5" y="5" width="50" height="30"/><circle cx="30" cy="20" r="8"/></svg>'
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Import SVG').click()])
  await chooser.setFiles({ name: 'plate.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) })
  await expect.poll(async () => (await sk(app)).profiles.length).toBe(2)
  let m = await sk(app)
  near(Math.max(...m.profiles.map((p: any) => p.area)), 50 * 30 - Math.PI * 64, 0.01)
  await app.shot('import-svg')
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '10', '100', '20', '0', '11', '120', '21', '0', '0', 'LINE', '10', '120', '20', '0', '11', '120', '21', '20', '0', 'LINE', '10', '120', '20', '20', '11', '100', '21', '20', '0', 'LINE', '10', '100', '20', '20', '11', '100', '21', '0', '0', 'ENDSEC', '0', 'EOF', ''].join('\n')
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Import SVG').click()])
  await chooser2.setFiles({ name: 'square.dxf', mimeType: 'application/dxf', buffer: Buffer.from(dxf) })
  await expect.poll(async () => (await sk(app)).profiles.length).toBe(3)
  m = await sk(app)
  expect(m.profiles.some((p: any) => Math.abs(p.area - 400) < 1)).toBe(true) // eslint-disable-line
})

test('Dimension on two parallel lines gives the distance between them, not an angle', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  for (const y of [0, 15]) {
    await tool(app, 'Line')
    await click(app, 0, y)
    await click(app, 30, y)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }
  await tool(app, 'Dimension')
  await click(app, 15, 0)
  await click(app, 15, 15)
  await click(app, 40, 7)
  const input = page.locator('.sk-dim-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(/^15(\.0+)?$/)
  await input.fill('22')
  await input.press('Enter')
  const m = await sk(app)
  const dims = m.constraints.filter((k: any) => k.type === 'distance' || k.type === 'angle') // eslint-disable-line
  expect(dims).toHaveLength(1)
  expect(dims[0].type).toBe('distance')
  // the lines stay parallel and move apart to the new gap
  const ys = [...new Set(m.entities.filter((e: any) => e.type === 'point').map((p: any) => Math.round(p.y * 1000) / 1000))].sort((a, b) => a - b) // eslint-disable-line
  near(ys[ys.length - 1] - ys[0], 22)
})

test('Rectangular pattern: click the curves to repeat while the tool is open', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Rectangle')
  await click(app, 0, 0)
  await click(app, 10, 10)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  expect(await app.ev((c) => c.sketch.getState().sel.length)).toBe(0)
  await tool(app, 'Rectangular Pattern')
  for (const [x, y] of [[5, 0], [10, 5], [5, 10], [0, 5]]) await click(app, x, y)
  expect(await app.ev((c) => c.sketch.getState().sel.length)).toBe(4)
  // a second click takes a curve out, a third puts it back
  await click(app, 5, 0)
  expect(await app.ev((c) => c.sketch.getState().sel.length)).toBe(3)
  await click(app, 5, 0)
  for (const [id, v] of [['count', '3'], ['spacing', '20'], ['angle', '0']]) {
    await page.getByTestId('sk-opt-' + id).fill(v)
    await page.getByTestId('sk-opt-' + id).press('Enter')
  }
  await page.getByTestId('sk-apply').click()
  const m = await sk(app)
  expect(m.profiles.length).toBe(3)
  expect(m.ok).toBe(true)
  // Escape leaves the tool and keeps the sketch open with everything in it
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const after = await app.ev((c) => ({ active: c.sketch.getState().active, tool: c.sketch.getState().tool, lines: c.sketch.getState().model.entities.filter((e: any) => e.type === 'line').length })) // eslint-disable-line
  expect(after).toEqual({ active: true, tool: 'select', lines: 12 })
})

test('Double-clicking a sketch in the Browser opens it for editing; F2 and the right-click menu still rename it', async ({ app, page }) => {
  await app.open()
  await app.sketchRect('XY', 30, 20)
  await app.finishSketch()
  const id = await app.ev((c) => c.doc.getState().features.find((f: any) => f.type === 'sketch').id as string) // eslint-disable-line
  const name = await app.ev((c) => c.doc.getState().sketches[0].name as string)
  const row = page.locator('.tree-row', { hasText: name })
  await row.dblclick()
  await expect(page.locator('.sk-bar')).toBeVisible()
  expect(await app.ev((c) => ({ active: c.sketch.getState().active, editing: c.sketch.getState().editing }))).toEqual({ active: true, editing: id })
  expect(await app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'line').length)).toBe(4) // eslint-disable-line
  await page.keyboard.press('Enter')
  await expect(page.locator('.sk-bar')).toHaveCount(0)
  expect(await app.ev((c) => c.doc.getState().features.filter((f: any) => f.type === 'sketch').length)).toBe(1) // eslint-disable-line

  // F2 on the selected row renames it
  await page.locator('.tree-row', { hasText: name }).click()
  await page.keyboard.press('F2')
  await page.locator('.tree-row input.rename').fill('Base outline')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tree-row', { hasText: 'Base outline' })).toBeVisible()

  // the right-click menu has Edit Sketch too
  await page.locator('.tree-row', { hasText: 'Base outline' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Sketch' }).click()
  await expect(page.locator('.sk-bar')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('Dimension between two circles measures centre to centre, and a circle to a line from its centre', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  for (const y of [0, 40]) {
    await tool(app, 'Circle')
    await click(app, 0, y)
    await click(app, 3, y)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }
  await tool(app, 'Line')
  await click(app, 20, -10)
  await click(app, 20, 50)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const input = page.locator('.sk-dim-input')
  // circle edge, then the other circle's edge, then where the dimension goes
  await tool(app, 'Dimension')
  await click(app, -3, 0)
  await click(app, -3, 40)
  await click(app, -15, 20)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(/^40(\.0+)?$/)
  await input.fill('50')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  const centres = () => app.ev((c) => { const s = c.sketch.getState(); return s.model.entities.filter((e: any) => e.type === 'circle').map((e: any) => s.model.entities.find((p: any) => p.id === e.c)).map((p: any) => [p.x, p.y]) }) // eslint-disable-line
  let cs = await centres()
  near(Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]), 50)
  // circle to the line: from the centre, square to the line
  await click(app, cs[0][0] + 3, cs[0][1])
  await click(app, 20, 20)
  await click(app, 10, cs[0][1] - 8)
  await expect(input).toBeFocused()
  await input.fill('25')
  await input.press('Enter')
  cs = await centres()
  const lineX = await app.ev((c) => { const s = c.sketch.getState(); const l = s.model.entities.find((e: any) => e.type === 'line'); return s.model.entities.find((p: any) => p.id === l.p1).x }) // eslint-disable-line
  near(Math.abs(lineX - cs[0][0]), 25)
  expect((await sk(app)).ok).toBe(true)
})

test('Dimension from centre to centre of two circles stacked straight up, placed above them, then a reference dimension when nothing is left to set', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  for (const y of [0, 40]) {
    await tool(app, 'Circle')
    await click(app, 0, y)
    await click(app, 3, y)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }
  // the two centres on one vertical line, like circles placed on the Y axis
  const cIds = await app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'circle').map((e: any) => e.c as string)) // eslint-disable-line
  await app.ev((c, sel) => c.sketch.setState({ sel }), cIds)
  await app.ev((c) => c.runCommand('sketch.vertical'))
  await app.ev((c) => c.sketch.setState({ sel: [] })) // the Dimension tool would start from what is selected
  const input = page.locator('.sk-dim-input')
  await tool(app, 'Dimension')
  await click(app, 0, 0)
  await click(app, 0, 40)
  await click(app, 0, 55) // above both: there is no sideways gap, so this is the gap between them
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(/^40(\.0+)?$/)
  await input.fill('30')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  const ys = await app.ev((c, ids) => ids.map((id: string) => c.sketch.getState().model.entities.find((p: any) => p.id === id)?.y ?? 0), cIds) // eslint-disable-line (a centre on the origin is the origin itself)
  near(Math.abs(ys[1] - ys[0]), 30)
  // the centres can not get any further constrained against each other: the dimension is made as a reference one, in brackets
  const before = (await sk(app)).constraints.length
  await click(app, 0, ys[0])
  await click(app, 0, ys[1])
  await click(app, 8, (ys[0] + ys[1]) / 2)
  await expect(page.locator('.sk-status')).toContainText('reference dimension')
  await expect(input).toHaveCount(0)
  const m = await sk(app)
  expect(m.constraints.length).toBe(before + 1)
  expect(m.constraints.filter((k: any) => k.driven)).toHaveLength(1) // eslint-disable-line
  expect(m.ok).toBe(true)
})
