import { test, expect, type App } from './helpers'

async function startSketch(app: App) {
  const { page } = app
  await app.ribbon('Sketch').first().click()
  if (!(await page.getByText('XY plane').isVisible())) await page.getByText('Planes', { exact: true }).click()
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
