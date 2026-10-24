import { test, expect, type App } from './helpers'

/** Start a sketch on the XY plane (line tool active, top view). */
async function startSketch(app: App) {
  const { page } = app
  await app.ribbon('Sketch').first().click()
  const planes = page.getByText('Planes', { exact: true })
  if (!(await page.getByText('XY plane').isVisible())) await planes.click()
  await page.getByText('XY plane').click()
  await expect(page.locator('.sk-bar')).toBeVisible()
  await app.cameraStable()
}

const model = (app: App) => app.ev((c) => {
  const m = c.sketch.getState().model
  return { entities: m.entities, constraints: m.constraints.map((k: any) => ({ type: k.type, refs: k.refs })) } // eslint-disable-line
})

/** Click at sketch coordinates (mm). */
async function click(app: App, x: number, y: number) {
  const p = await app.project(x, y, 0)
  await app.page.mouse.move(p.x, p.y, { steps: 3 })
  await app.page.mouse.click(p.x, p.y)
}
async function hover(app: App, x: number, y: number) {
  const p = await app.project(x, y, 0)
  await app.page.mouse.move(p.x, p.y, { steps: 4 })
}

/** A first line from (0, 0) to (40, 10) that the next ones refer to. */
async function firstLine(app: App) {
  await click(app, 0, 0)
  await click(app, 40, 10)
  await app.page.keyboard.press('Escape') // end the polyline, keep the line tool
  await expect.poll(async () => (await model(app)).entities.filter((e: any) => e.type === 'line').length).toBe(1) // eslint-disable-line
}

test('inference: a second line drawn almost parallel gets a parallel constraint', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await firstLine(app)
  await click(app, 0, -20)
  await hover(app, 20, 5) // wakes the first line up as reference
  await hover(app, 40, -10 + 0.7) // a hair off the parallel direction (40, 10)
  await expect(app.page.locator('.sk-hint')).toContainText('Parallel')
  await app.shot('inference-parallel')
  await app.page.mouse.click((await app.project(40, -10 + 0.7, 0)).x, (await app.project(40, -10 + 0.7, 0)).y)
  await app.page.keyboard.press('Escape')
  const m = await model(app)
  expect(m.constraints.some((k: any) => k.type === 'parallel')).toBe(true) // eslint-disable-line
  const lines = m.entities.filter((e: any) => e.type === 'line') // eslint-disable-line
  expect(lines.length).toBe(2)
  const pts = Object.fromEntries(m.entities.filter((e: any) => e.type === 'point').map((p: any) => [p.id, p])) // eslint-disable-line
  const d = (l: any) => [pts[l.p2].x - pts[l.p1].x, pts[l.p2].y - pts[l.p1].y] // eslint-disable-line
  const a = d(lines[0]), b = d(lines[1])
  expect(Math.abs(a[0] * b[1] - a[1] * b[0]) / (Math.hypot(...a) * Math.hypot(...b))).toBeLessThan(1e-6)
})

test('inference: perpendicular to a nearby line', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await firstLine(app)
  await click(app, 10, -20)
  await hover(app, 20, 5)
  await hover(app, 5.3, 0) // direction (-10, 40) from (10, -20) is perpendicular to (40, 10): x falls as y rises
  await expect(app.page.locator('.sk-hint')).toContainText('Perpendicular')
  await app.shot('inference-perpendicular')
  const p = await app.project(5.3, 0, 0)
  await app.page.mouse.click(p.x, p.y)
  await app.page.keyboard.press('Escape')
  const m = await model(app)
  expect(m.constraints.some((k: any) => k.type === 'perpendicular')).toBe(true) // eslint-disable-line
})

test('inference: a line continued along an existing one gets a collinear constraint', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await firstLine(app)
  await click(app, 40, 10) // starts on the end of the first line
  await hover(app, 60, 15.3) // near its extension (slope 1/4)
  await expect(app.page.locator('.sk-hint')).toContainText('Extension')
  await app.shot('inference-extension')
  const p = await app.project(60, 15.3, 0)
  await app.page.mouse.click(p.x, p.y)
  await app.page.keyboard.press('Escape')
  const m = await model(app)
  expect(m.constraints.some((k: any) => k.type === 'parallel')).toBe(true) // eslint-disable-line
  const pts = m.entities.filter((e: any) => e.type === 'point') // eslint-disable-line
  const last = pts[pts.length - 1] as any // eslint-disable-line
  expect(last.y / last.x).toBeCloseTo(0.25, 6)
})

test('inference: a tangent arc leaves the end of a line', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await firstLine(app)
  await app.ev((c) => c.runCommand('sketch.arcT'))
  await click(app, 40, 10)
  await click(app, 70, 30)
  const m = await model(app)
  const arc = m.entities.find((e: any) => e.type === 'arc') // eslint-disable-line
  expect(arc).toBeTruthy()
  expect(m.constraints.some((k: any) => k.type === 'tangentAt')).toBe(true) // eslint-disable-line
  // the arc really is tangent: its centre lies on the perpendicular to the line at (40, 10)
  const pts = Object.fromEntries(m.entities.filter((e: any) => e.type === 'point').map((p: any) => [p.id, p])) // eslint-disable-line
  const c = pts[(arc as any).c] // eslint-disable-line
  expect((c.x - 40) * 40 + (c.y - 10) * 10).toBeCloseTo(0, 4)
  await app.shot('inference-tangent-arc')
})

test('inference: tangent leaving an arc end and tangent to a circle; settings and modifiers', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  // the snap settings popover lists every relation, all on except 15 degree steps
  await page.getByTestId('snap-settings').click()
  await expect(page.getByTestId('snap-popover')).toBeVisible()
  for (const k of ['coincident', 'parallel', 'perpendicular', 'collinear', 'horizontalVertical', 'tangent', 'tracking', 'equal', 'grid']) await expect(page.getByTestId('snap-' + k)).toBeChecked()
  await expect(page.getByTestId('snap-angle15')).not.toBeChecked()
  await app.shot('snap-settings')
  await page.getByTestId('snap-parallel').uncheck()
  expect(await app.ev((c) => c.snapFlags.getState().flags.parallel)).toBe(false)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy-snaps-v1') ?? '{}').parallel)).toBe(false)
  await page.getByTestId('snap-parallel').check()
  await page.keyboard.press('Escape')

  // draw a circle, then a line that ends tangent to it
  await app.ribbon('Circle').first().click()
  await click(app, 80, 0)
  await click(app, 100, 0)
  await app.page.keyboard.press('Escape')
  await app.ribbon('Line').first().click()
  await click(app, 0, 0)
  await hover(app, 80, 19) // wake the circle
  const d = 80, r = 20, a = Math.acos(r / d)
  const t = [80 + r * Math.cos(Math.PI + a), r * Math.sin(Math.PI + a)] // lower tangent point
  await hover(app, t[0] + 0.5, t[1] - 0.4)
  await expect(page.locator('.sk-hint')).toContainText('Tangent')
  await app.shot('inference-tangent-circle')
  const p = await app.project(t[0] + 0.5, t[1] - 0.4, 0)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press('Escape')
  const m = await model(app)
  expect(m.constraints.some((k: any) => k.type === 'tangent')).toBe(true) // eslint-disable-line

  // Ctrl pauses inference: the same hover now follows the cursor freely
  await click(app, 0, 30)
  await page.keyboard.down('Control')
  await hover(app, 30, 30.4)
  await expect(page.locator('.sk-hint')).toHaveCount(0)
  await page.keyboard.up('Control')
  await page.keyboard.press('Escape')
})

test('inference: perpendicular to a circle is radial, and a new circle snaps concentric', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await app.ribbon('Circle').first().click()
  await click(app, 60, 0)
  await click(app, 80, 0)
  await page.keyboard.press('Escape')
  await app.ribbon('Line').first().click()
  await click(app, 0, 10)
  await hover(app, 60, 19) // wake the circle
  await hover(app, 30, 5.4)
  await expect(page.locator('.sk-hint')).toContainText('Perpendicular')
  await app.shot('inference-radial')
  const p = await app.project(30, 5.4, 0)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press('Escape')
  let m = await model(app)
  const circle = m.entities.find((e: any) => e.type === 'circle') as any // eslint-disable-line
  const line = m.entities.find((e: any) => e.type === 'line') as any // eslint-disable-line
  expect(m.constraints.some((k: any) => k.type === 'pointOnLine' && k.refs.includes(circle.c) && k.refs.includes(line.id))).toBe(true) // eslint-disable-line
  const pts = Object.fromEntries(m.entities.filter((e: any) => e.type === 'point').map((q: any) => [q.id, q])) // eslint-disable-line
  const a = pts[line.p1], b = pts[line.p2], c = pts[circle.c]
  expect(Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(1e-6)

  // a circle started on the centre of the first one is concentric with it
  await app.ribbon('Circle').first().click()
  await hover(app, 60.4, 0.3)
  await expect(page.locator('.sk-hint')).toContainText('Concentric')
  await app.shot('inference-concentric')
  const q = await app.project(60.4, 0.3, 0)
  await page.mouse.click(q.x, q.y)
  await click(app, 60, 35)
  await page.keyboard.press('Escape')
  m = await model(app)
  const circles = m.entities.filter((e: any) => e.type === 'circle') as any[] // eslint-disable-line
  expect(circles.length).toBe(2)
  const pp = Object.fromEntries(m.entities.filter((e: any) => e.type === 'point').map((r: any) => [r.id, r])) // eslint-disable-line
  const c1 = pp[circles[0].c], c2 = pp[circles[1].c]
  expect(Math.hypot(c1.x - c2.x, c1.y - c2.y)).toBeLessThan(1e-6)
})
