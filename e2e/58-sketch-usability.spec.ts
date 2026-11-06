import { test, expect, type App } from './helpers'

/* What the usability pass added to the sketcher, used the way the specs in 55 only touch: Move / Copy, Conic Curve, chamfer by
   distance and angle, the Sketch Palette doing its job, the right-click menu acting, names in the dimension box. */

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
  return { entities: s.model.entities, constraints: s.model.constraints, sel: s.sel, tool: s.tool, status: s.status, show: s.show, profiles: s.profiles.map((p: any) => p.area) } // eslint-disable-line
})
async function click(app: App, x: number, y: number) {
  const p = await app.project(x, y, 0)
  await app.page.mouse.move(p.x, p.y, { steps: 3 })
  await app.page.mouse.click(p.x, p.y)
}
const tool = (app: App, name: string | RegExp) => app.ribbon(name).first().click()
const menuTool = async (app: App, group: string, item: string) => {
  await app.page.getByRole('button', { name: `${group} options` }).click()
  await app.page.getByRole('menuitem', { name: item }).click()
}
const near = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-3))
const types = (m: { entities: { type: string }[] }, t: string) => m.entities.filter((e) => e.type === t) as any[] // eslint-disable-line
const pt = (m: { entities: any[] }, id: string): [number, number] => { const e = m.entities.find((x) => x.id === id); return id === 'O' ? [0, 0] : [e.x, e.y] } // eslint-disable-line
const consOf = (m: { constraints: any[] }, t: string) => m.constraints.filter((k) => k.type === t) // eslint-disable-line
async function line(app: App, a: [number, number], b: [number, number]) {
  await tool(app, 'Line')
  await click(app, a[0], a[1])
  await click(app, b[0], b[1])
  await app.page.keyboard.press('Escape')
}
const select = (app: App) => app.page.keyboard.press('q')

test('Move / Copy: M opens it with the selection, Apply moves, Copy leaves the original and selects the copy', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [10, 10], [30, 10])
  await select(app)
  await click(app, 20, 10)
  await page.keyboard.press('m')
  await expect(page.getByTestId('sk-toolbar')).toContainText('Move / Copy')
  await page.getByTestId('sk-opt-x').fill('15')
  await page.getByTestId('sk-opt-x').press('Enter')
  await page.getByTestId('sk-opt-y').fill('5')
  await page.getByTestId('sk-opt-y').press('Enter')
  await page.getByTestId('sk-apply').click()
  let m = await sk(app)
  expect(types(m, 'line')).toHaveLength(1)
  near(Math.min(...types(m, 'point').map((p) => p.x)), 25)
  near(Math.min(...types(m, 'point').map((p) => p.y)), 15)
  // the same again as a copy, 20 up and turned a quarter
  await page.getByTestId('sk-opt-copy').check()
  await page.getByTestId('sk-opt-x').fill('0')
  await page.getByTestId('sk-opt-x').press('Enter')
  await page.getByTestId('sk-opt-y').fill('20')
  await page.getByTestId('sk-opt-y').press('Enter')
  await page.getByTestId('sk-opt-angle').fill('90')
  await page.getByTestId('sk-opt-angle').press('Enter')
  await page.getByTestId('sk-apply').click()
  m = await sk(app)
  expect(types(m, 'line')).toHaveLength(2)
  const [a, b] = types(m, 'line')
  expect(m.sel).toEqual([b.id])
  const [p, q] = [pt(m, b.p1), pt(m, b.p2)]
  expect(Math.abs(p[0] - q[0])).toBeLessThan(1e-6) // turned upright
  near(Math.abs(p[1] - q[1]), 20)
  expect(pt(m, a.p1)).not.toEqual(p)
})

test('Conic curve: ends, apex, a point on the curve; it closes a profile', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await line(app, [-30, -20], [30, -20])
  await menuTool(app, 'Fit Point Spline', 'Conic Curve')
  for (const [x, y] of [[-30, -20], [30, -20], [0, 20], [0, 0]]) await click(app, x, y)
  const m = await sk(app)
  const c = types(m, 'conic')[0]
  expect(c).toBeTruthy()
  near(c.rho, 0.5)
  // a parabola under a chord of 60 that rises 20: two thirds of the box round it
  expect(m.profiles).toHaveLength(1)
  near(m.profiles[0], (2 / 3) * 60 * 20, 0.01)
})

test('Chamfer by distance and angle cuts a corner and dimensions both', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Rectangle')
  await click(app, 0, 0)
  await click(app, 40, 30)
  await page.keyboard.press('Escape')
  await menuTool(app, 'Sketch Fillet', 'Sketch Chamfer')
  await page.getByTestId('sk-opt-type').selectOption('angle')
  await page.getByTestId('sk-opt-dist').fill('8')
  await page.getByTestId('sk-opt-dist').press('Enter')
  await page.getByTestId('sk-opt-angle').fill('45')
  await page.getByTestId('sk-opt-angle').press('Enter')
  await click(app, 20, 0) // the bottom line first
  await click(app, 40, 15) // then the right one
  const m = await sk(app)
  expect(types(m, 'line')).toHaveLength(5)
  const cut = types(m, 'line').find((l) => { const [p, q] = [pt(m, l.p1), pt(m, l.p2)]; return Math.abs(p[0] - q[0]) > 1 && Math.abs(p[1] - q[1]) > 1 })
  expect(cut).toBeTruthy()
  const [p, q] = [pt(m, cut.p1), pt(m, cut.p2)]
  near(Math.hypot(q[0] - p[0], q[1] - p[1]), 8 * Math.SQRT2, 0.01)
  expect(consOf(m, 'angle')).toHaveLength(1)
  expect(consOf(m, 'distance').some((k) => k.expr === '8')).toBe(true)
})

test('Sketch palette: Show Points, Show Profile and Show Constraints switch what is drawn, Slice cuts the view, Look At squares the view up', async ({ app, page }) => {
  await app.open()
  await app.sketchRect('XY', 30, 20)
  expect(await app.ev((c) => c.sketch.getState().show)).toMatchObject({ profile: true, points: true, dims: true, constraints: true, slice: false })
  for (const [name, key] of [['Show Profile', 'profile'], ['Show Points', 'points'], ['Show Constraints', 'constraints']] as const) {
    await page.getByRole('checkbox', { name }).uncheck()
    expect((await sk(app)).show[key]).toBe(false)
  }
  await expect(page.locator('.sk-glyph')).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Show Constraints' }).check()
  await expect(page.locator('.sk-glyph').first()).toBeVisible()
  // Slice: a plane in front of the sketch cuts the model away
  expect(await app.ev((c) => c.three.gl.clippingPlanes.length)).toBe(0)
  await page.getByRole('checkbox', { name: 'Slice' }).check()
  expect(await app.ev((c) => c.three.gl.clippingPlanes.length)).toBe(1)
  await page.getByRole('checkbox', { name: 'Slice' }).uncheck()
  expect(await app.ev((c) => c.three.gl.clippingPlanes.length)).toBe(0)
  // Look At after orbiting away
  await app.ev((c) => c.bus.emit('viewVec', [1, 1, 1]))
  await app.cameraStable()
  const tilted = await app.ev((c) => { const d = c.three.camera.getWorldDirection(new (c.three.camera.position.constructor as any)()); return d.z }) // eslint-disable-line
  expect(tilted).toBeGreaterThan(-0.9)
  await page.getByRole('button', { name: 'Look At' }).click()
  await app.cameraStable()
  const square = await app.ev((c) => { const d = c.three.camera.getWorldDirection(new (c.three.camera.position.constructor as any)()); return d.z }) // eslint-disable-line
  expect(square).toBeLessThan(-0.99)
})

test('Right-click menu on a curve: it selects the curve, Delete takes it away, Construction toggles it', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 20], [30, 25])
  await line(app, [0, -20], [30, -25])
  await select(app)
  const p = await app.project(15, 22.5, 0)
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  expect((await sk(app)).sel).toHaveLength(1) // the curve under the cursor became the selection
  await page.getByRole('menuitem', { name: 'Construction' }).dispatchEvent('pointerdown', { button: 0 })
  expect(types(await sk(app), 'line').filter((l) => l.construction)).toHaveLength(1)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).dispatchEvent('pointerdown', { button: 0 })
  expect(types(await sk(app), 'line')).toHaveLength(1)
})

test('Dimension box names the dimension and a copied dimension gets a name of its own', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [30, 0])
  await tool(app, 'Dimension')
  await click(app, 15, 0)
  await click(app, 15, 10)
  await expect(page.locator('.sk-dim-name')).toHaveText('d1 =')
  await page.locator('.sk-dim-input').fill('20')
  await page.locator('.sk-dim-input').press('Enter')
  await page.keyboard.press('Escape')
  await select(app)
  await click(app, 10, 0)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  const m = await sk(app)
  expect(types(m, 'line')).toHaveLength(2)
  expect(consOf(m, 'distance').map((k) => k.name).sort()).toEqual(['d1', 'd2'])
})
