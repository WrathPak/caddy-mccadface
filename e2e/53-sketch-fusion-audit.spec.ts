import { test, expect, type App } from './helpers'

/* Sketch tools driven the way a Fusion 360 user works: any pick order, tool first or selection first, dims placed anywhere. */

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
  return { entities: s.model.entities, constraints: s.model.constraints, sel: s.sel, tool: s.tool, draft: s.draft, status: s.status, dof: s.info.dof, ok: s.info.ok, profiles: s.profiles.length }
})
async function click(app: App, x: number, y: number) {
  const p = await app.project(x, y, 0)
  await app.page.mouse.move(p.x, p.y, { steps: 3 })
  await app.page.mouse.click(p.x, p.y)
}
async function drag(app: App, a: [number, number], b: [number, number]) {
  const p = await app.project(a[0], a[1], 0), q = await app.project(b[0], b[1], 0)
  await app.page.mouse.move(p.x, p.y, { steps: 3 })
  await app.page.mouse.down()
  await app.page.mouse.move(q.x, q.y, { steps: 8 })
  await app.page.mouse.up()
}
const tool = (app: App, name: string | RegExp) => app.ribbon(name).first().click()
const menuTool = async (app: App, group: string, item: string) => {
  await app.page.getByRole('button', { name: `${group} options` }).click()
  await app.page.getByRole('menuitem', { name: item }).click()
}
const near = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))
const types = (m: { entities: { type: string }[] }, t: string) => m.entities.filter((e) => e.type === t) as any[] // eslint-disable-line
const pt = (m: { entities: any[] }, id: string) => m.entities.find((e) => e.id === id) // eslint-disable-line
/** A straight line drawn with the Line tool, leaving the tool active with nothing in progress. */
async function line(app: App, a: [number, number], b: [number, number]) {
  await tool(app, 'Line')
  await click(app, a[0], a[1])
  await click(app, b[0], b[1])
  await app.page.keyboard.press('Escape')
}
async function circle(app: App, c: [number, number], r: number) {
  await tool(app, 'Circle')
  await click(app, c[0], c[1])
  await click(app, c[0] + r, c[1])
  await app.page.keyboard.press('Escape')
}
const select = (app: App) => app.page.keyboard.press('q')
const lineLen = (m: any, e: any) => { const a = pt(m, e.p1), b = pt(m, e.p2); return Math.hypot(a.x - b.x, a.y - b.y) } // eslint-disable-line

test('Coincident picks a curve first and a point second, like the other way round', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [40, 0])
  await line(app, [10, 20], [20, 30])
  await page.keyboard.press('Escape')
  await app.ev((c) => c.runCommand('sketch.coincident'))
  await click(app, 30, 0) // the line
  await click(app, 10, 20) // then a loose end
  const m = await sk(app)
  expect(m.constraints.filter((k: any) => k.type === 'pointOnLine')).toHaveLength(1) // eslint-disable-line
  expect(m.status).toBeNull()
  const on = m.constraints.find((k: any) => k.type === 'pointOnLine') // eslint-disable-line
  near(pt(m, on.refs[0]).y, 0) // the loose end was brought onto the line
})

test('Horizontal and Equal apply to everything selected, box-selected points included', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [30, 10])
  await line(app, [0, 20], [30, 35])
  await select(app)
  await click(app, 15, 5)
  await page.keyboard.down('Shift')
  await click(app, 15, 27.5)
  await page.keyboard.up('Shift')
  expect((await sk(app)).sel).toHaveLength(2)
  await app.ev((c) => c.runCommand('sketch.horizontal'))
  let m = await sk(app)
  expect(m.constraints.filter((k: any) => k.type === 'horizontal')).toHaveLength(2) // eslint-disable-line
  for (const l of types(m, 'line')) near(pt(m, l.p1).y - pt(m, l.p2).y, 0)

  // three circles of different sizes, all picked with a window that also catches their centres
  // (a little lower than the top of the view, where the Cancel / Finish bar sits)
  await circle(app, [0, 48], 4)
  await circle(app, [30, 48], 6)
  await circle(app, [60, 48], 9)
  await select(app)
  await drag(app, [-20, 38], [80, 59])
  expect((await sk(app)).sel.length).toBeGreaterThanOrEqual(6)
  await app.ev((c) => c.runCommand('sketch.equal'))
  m = await sk(app)
  const rs = types(m, 'circle').map((e) => e.r)
  near(rs[0], rs[1])
  near(rs[1], rs[2])
})

test('Dimension with a line selected first: the tool starts with it and the click places it', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [30, 10])
  await select(app)
  await click(app, 15, 5)
  await page.keyboard.press('d')
  await click(app, 10, 20) // where the dimension goes
  const input = page.locator('.sk-dim-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(/^31\.6/)
  await input.fill('40')
  await input.press('Enter')
  const m = await sk(app)
  near(lineLen(m, types(m, 'line')[0]), 40)
})

test('Dimension an ellipse: along the long axis gives the major radius, across it the minor one', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Ellipse')
  await click(app, 0, 0)
  await click(app, 40, 0)
  await click(app, 0, 15)
  await tool(app, 'Dimension')
  const input = page.locator('.sk-dim-input')
  await click(app, 0, 15)
  await click(app, 25, 3)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(/^40/)
  await input.fill('50')
  await input.press('Enter')
  let m = await sk(app)
  expect(m.constraints.some((k: any) => k.type === 'majorRadius')).toBe(true) // eslint-disable-line
  await click(app, 0, 15)
  await click(app, -5, 25)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(/^15/)
  await input.fill('10')
  await input.press('Enter')
  m = await sk(app)
  const e = types(m, 'ellipse')[0]
  near(e.r, 10)
  near(Math.hypot(pt(m, e.m).x - pt(m, e.c).x, pt(m, e.m).y - pt(m, e.c).y), 50)
})

test('Dimension a point to the X axis and to the Y axis', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [20, 15], [40, 30])
  await tool(app, 'Dimension')
  const input = page.locator('.sk-dim-input')
  await click(app, 20, 15)
  await click(app, -30, 0) // the X axis
  await click(app, -20, 8)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(/^15/)
  await input.fill('25')
  await input.press('Enter')
  let m = await sk(app)
  expect(m.constraints.some((k: any) => k.type === 'vdist')).toBe(true) // eslint-disable-line
  near(Math.min(...types(m, 'point').map((p) => p.y)), 25)
  // the other way round: the Y axis first, then the point
  const far = types(m, 'point').reduce((a, b) => (b.x > a.x ? b : a))
  await click(app, 0, 45)
  await click(app, far.x, far.y)
  await click(app, 20, 50)
  await expect(input).toBeFocused()
  await input.fill('60')
  await input.press('Enter')
  m = await sk(app)
  expect(m.constraints.some((k: any) => k.type === 'hdist')).toBe(true) // eslint-disable-line
  near(Math.max(...types(m, 'point').map((p) => p.x)), 60)
})

test('Angle between two lines takes the sector the dimension is put in', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [40, 0])
  await line(app, [0, 0], [20, 30])
  await tool(app, 'Dimension')
  const input = page.locator('.sk-dim-input')
  const got: number[] = []
  // inside the sharp angle, in the sector next to it, opposite the sharp one, and in the fourth
  for (const [x, y] of [[20, 10], [-10, 10], [-10, -10], [20, -10]]) {
    await click(app, 30, 0)
    await click(app, 10, 15)
    await click(app, x, y)
    await expect(input).toBeFocused()
    got.push(+(await input.inputValue()))
    await page.keyboard.press('Escape') // a new dimension that is not confirmed is dropped
    await expect(input).toHaveCount(0)
  }
  near(got[0], 56.31, 0.002)
  near(got[1], 123.69, 0.002)
  near(got[2], 56.31, 0.002)
  near(got[3], 123.69, 0.002)
  // put in the wide sector and set to 100: the lines end up 80 apart (100 measured the wide way)
  await click(app, 30, 0)
  await click(app, 10, 15)
  await click(app, -10, 10)
  await input.fill('100')
  await input.press('Enter')
  const m = await sk(app)
  expect(m.ok).toBe(true)
  const [a, b] = types(m, 'line')
  const d1 = [pt(m, a.p2).x - pt(m, a.p1).x, pt(m, a.p2).y - pt(m, a.p1).y], d2 = [pt(m, b.p2).x - pt(m, b.p1).x, pt(m, b.p2).y - pt(m, b.p1).y]
  const ang = Math.abs(Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1])) * 180 / Math.PI
  near(ang, 80, 0.005)
})

test('Dimensioning something already fixed gives a reference dimension in brackets that follows the drawing', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [30, 0])
  await tool(app, 'Dimension')
  const input = page.locator('.sk-dim-input')
  await click(app, 15, 0)
  await click(app, 15, 10)
  await input.fill('30')
  await input.press('Enter')
  // the same length again: nothing to drive, so it is a reference
  await click(app, 15, 0)
  await click(app, 15, 18)
  await expect(page.locator('.sk-status')).toContainText('reference dimension')
  await expect(input).toHaveCount(0)
  let m = await sk(app)
  expect(m.ok).toBe(true)
  expect(m.constraints.filter((k: any) => k.driven)).toHaveLength(1) // eslint-disable-line
  await expect(page.locator('.sk-dim', { hasText: '(30)' })).toBeVisible()
  // it cannot be typed into ...
  await page.locator('.sk-dim', { hasText: '(30)' }).dblclick()
  await expect(input).toHaveCount(0)
  // ... but it follows when the driving dimension changes
  await page.locator('.sk-dim', { hasText: /^30$/ }).dblclick()
  await input.fill('45')
  await input.press('Enter')
  await expect(page.locator('.sk-dim', { hasText: '(45)' })).toBeVisible()
  m = await sk(app)
  near(lineLen(m, types(m, 'line')[0]), 45)
  expect(m.ok).toBe(true)
  expect(m.dof).toBe(0) // the line sits on the origin, horizontal, and has its length: the reference dimension did not change that
})

test('Dragging a box right to left selects what it touches, left to right only what it encloses', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Rectangle')
  await click(app, 0, 0)
  await click(app, 30, 20)
  await app.page.keyboard.press('Escape')
  await select(app)
  await drag(app, [-10, -10], [15, 10]) // left to right: encloses only the corner point
  expect((await sk(app)).sel).toHaveLength(1)
  await drag(app, [15, 10], [-10, -10]) // right to left: the corner and the two sides that cross it
  const m = await sk(app)
  expect(m.sel).toHaveLength(3)
  expect(m.sel.filter((id: string) => types(m, 'line').some((l) => l.id === id))).toHaveLength(2)
})

test('Ctrl+A selects everything in the sketch', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [30, 0])
  await circle(app, [10, 30], 5)
  await select(app)
  await page.keyboard.press('Control+a')
  const m = await sk(app)
  expect(m.sel.length).toBe(m.entities.length)
  await page.keyboard.press('Delete')
  expect((await sk(app)).entities).toHaveLength(0)
})

test('Ctrl+Z while drawing a polyline takes back the last segment and carries on from the one before', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Line')
  for (const [x, y] of [[0, 0], [20, 0], [20, 20], [0, 20]]) await click(app, x, y)
  expect(types(await sk(app), 'line')).toHaveLength(3)
  await page.keyboard.press('Control+z')
  let m = await sk(app)
  expect(types(m, 'line')).toHaveLength(2)
  expect(m.tool).toBe('line')
  near(m.draft.pts[0][0], 20)
  near(m.draft.pts[0][1], 20)
  await click(app, 40, 20)
  m = await sk(app)
  expect(types(m, 'line')).toHaveLength(3)
  expect(m.constraints.filter((k: any) => k.type === 'coincident').length).toBeGreaterThanOrEqual(2) // eslint-disable-line
})

test('Mirror: click the curves inside the tool, Enter, then the mirror line', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [10, 20])
  await line(app, [30, -10], [30, 40])
  await page.keyboard.press('Escape')
  await tool(app, 'Sketch Mirror')
  await click(app, 5, 10)
  expect((await sk(app)).sel).toHaveLength(1)
  await page.keyboard.press('Enter')
  await click(app, 30, 15)
  const m = await sk(app)
  expect(m.constraints.filter((k: any) => k.type === 'mirror')).toHaveLength(2) // eslint-disable-line
  expect(types(m, 'line')).toHaveLength(3)
  expect(m.tool).toBe('select')
  expect(m.ok).toBe(true)
})

test('Circular pattern: click the curves inside the tool, Next, then the centre', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await circle(app, [30, 0], 4)
  await page.keyboard.press('Escape')
  await menuTool(app, 'Rectangular Pattern', 'Circular Pattern')
  await page.getByTestId('sk-opt-count').fill('4')
  await page.getByTestId('sk-opt-count').press('Enter')
  await click(app, 34, 0)
  expect((await sk(app)).sel).toHaveLength(1)
  await page.getByTestId('sk-next').click()
  await click(app, 0, 0)
  const m = await sk(app)
  expect(types(m, 'circle')).toHaveLength(4)
  expect(m.ok).toBe(true)
})

test('Rectangular pattern applies on Enter as well as the Apply button', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Rectangle')
  await click(app, 0, 0)
  await click(app, 10, 10)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await tool(app, 'Rectangular Pattern')
  for (const [x, y] of [[5, 0], [10, 5], [5, 10], [0, 5]]) await click(app, x, y)
  for (const [id, v] of [['count', '2'], ['spacing', '20'], ['angle', '0']]) {
    await page.getByTestId('sk-opt-' + id).fill(v)
    await page.getByTestId('sk-opt-' + id).press('Enter')
  }
  await page.keyboard.press('Enter')
  const m = await sk(app)
  expect(m.profiles).toBe(2)
  expect(m.ok).toBe(true)
})

test('Line tool: drag from the end of a line to draw a tangent arc, then carry on with a line', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [30, 0])
  await drag(app, [30, 0], [50, 15])
  let m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(1)
  expect(m.constraints.some((k: any) => k.type === 'tangentAt')).toBe(true) // eslint-disable-line
  expect(m.tool).toBe('line')
  expect(m.draft).not.toBeNull()
  await click(app, 70, 40)
  m = await sk(app)
  expect(types(m, 'line')).toHaveLength(2)
  expect(m.ok).toBe(true)
  // a plain click on an end still starts an ordinary straight line
  await app.page.keyboard.press('Escape')
  await line(app, [0, 0], [0, -25])
  expect(types(await sk(app), 'line')).toHaveLength(3)
})

test('Construction mode with nothing selected makes ellipses, slots and polygons construction', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await select(app)
  await page.keyboard.press('x')
  await tool(app, 'Ellipse')
  await click(app, 0, 0)
  await click(app, 40, 0)
  await click(app, 0, 15)
  const m = await sk(app)
  expect(types(m, 'ellipse')[0].construction).toBe(true)
  expect(m.profiles).toBe(0)
})
