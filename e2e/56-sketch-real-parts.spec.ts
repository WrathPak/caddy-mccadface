import { test, expect, type App } from './helpers'

/* Real 2D sketches a Fusion user makes, built from a blank document through the UI only (clicks, keys, typed values) and
   finished fully constrained (dof 0, "black" in Fusion's colours).  */

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
  return { entities: s.model.entities, constraints: s.model.constraints, sel: s.sel, tool: s.tool, status: s.status, dof: s.info.dof, ok: s.info.ok, fixed: [...(s.info.fixed ?? [])], profiles: s.profiles.map((p: any) => ({ area: p.area, holes: p.holes.length })) } // eslint-disable-line
})
async function click(app: App, x: number, y: number) {
  const p = await app.project(x, y, 0)
  await app.page.mouse.move(p.x, p.y, { steps: 3 })
  await app.page.mouse.click(p.x, p.y)
}
async function hover(app: App, x: number, y: number) {
  const p = await app.project(x, y, 0)
  await app.page.mouse.move(p.x, p.y, { steps: 3 })
}
const tool = (app: App, name: string | RegExp) => app.ribbon(name).first().click()
const menuItem = async (app: App, group: string, item: string) => {
  await app.page.getByRole('button', { name: `${group} options` }).click()
  await app.page.getByRole('menuitem', { name: item }).click()
}
const near = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-3))
const types = (m: { entities: { type: string }[] }, t: string) => m.entities.filter((e) => e.type === t) as any[] // eslint-disable-line
const pt = (m: { entities: any[] }, id: string): [number, number] => { const e = m.entities.find((x) => x.id === id); return id === 'O' ? [0, 0] : [e.x, e.y] } // eslint-disable-line
const consOf = (m: { constraints: any[] }, t: string) => m.constraints.filter((k) => k.type === t) // eslint-disable-line
const esc2 = async (app: App) => { await app.page.keyboard.press('Escape'); await app.page.keyboard.press('Escape') }
/** A dimension: pick things (clicks), click where it goes, type the value. */
async function dim(app: App, picks: [number, number][], place: [number, number], value: string) {
  const { page } = app
  await page.keyboard.press('d')
  for (const p of picks) await click(app, p[0], p[1])
  await click(app, place[0], place[1])
  const input = page.locator('.sk-dim-input')
  await expect(input).toBeFocused()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}
/** Line tool through the given points; Escape ends it. */
async function polyline(app: App, pts: [number, number][]) {
  await tool(app, 'Line')
  for (const p of pts) await click(app, p[0], p[1])
  await esc2(app)
}
/** Every dimension is black and nothing in the sketch can move: dof 0 and every curve in the "fixed" set. */
async function expectFullyConstrained(app: App) {
  const m = await sk(app)
  expect(m.ok).toBe(true)
  expect(m.dof).toBe(0)
  const loose = m.entities.filter((e: any) => e.type !== 'point' && !e.ref && !m.fixed.includes(e.id)) // eslint-disable-line
  expect(loose.map((e: any) => e.id)).toEqual([]) // eslint-disable-line
  await expect(app.page.locator('.sk-bar .info')).toContainText('Fully constrained')
}

test('Mounting plate: centre rectangle, a slot and a four hole bolt circle, fully constrained', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  // 100 x 60 plate about the origin
  await menuItem(app, 'Rectangle', 'Center Rectangle')
  await click(app, 0, 0)
  await hover(app, 30, 20)
  await page.keyboard.type('100')
  await page.keyboard.press('Tab')
  await page.keyboard.type('60')
  await page.keyboard.press('Enter')
  await esc2(app)
  expect((await sk(app)).dof).toBe(0)
  // a 30 long, 10 wide slot starting on the origin and running along X
  await tool(app, 'Centre to Centre Slot')
  await click(app, 0, 0)
  await hover(app, 30, 0.5)
  await page.keyboard.type('30')
  await page.keyboard.press('Tab')
  await page.keyboard.type('0')
  await page.keyboard.press('Enter')
  await hover(app, 15, 8)
  await page.keyboard.type('10')
  await page.keyboard.press('Enter')
  await esc2(app)
  let m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(2)
  expect(m.dof).toBe(0)
  // construction circle, 44 across, for the bolt circle
  await page.keyboard.press('x')
  await tool(app, 'Circle')
  await click(app, 0, 0)
  await hover(app, 22, 0.3)
  await page.keyboard.type('44')
  await page.keyboard.press('Enter')
  await esc2(app)
  await page.keyboard.press('x')
  m = await sk(app)
  expect(types(m, 'circle').filter((c) => c.construction)).toHaveLength(1)
  // one 5 mm hole on it at 45 degrees; the circle holds it on the bolt circle, a distance from the Y axis places it
  const r = 22 / Math.SQRT2
  await tool(app, 'Circle')
  await click(app, r, r)
  await hover(app, r + 2.5, r)
  await page.keyboard.type('5')
  await page.keyboard.press('Enter')
  await esc2(app)
  await dim(app, [[r, r], [0, -45]], [r / 2, 36], String(+r.toFixed(4)))
  m = await sk(app)
  expect(m.dof).toBe(0)
  // the other three: circular pattern about the origin
  await menuItem(app, 'Rectangular Pattern', 'Circular Pattern')
  await page.getByTestId('sk-opt-count').fill('4')
  await page.getByTestId('sk-opt-count').press('Enter')
  await click(app, r + 2.5, r)
  await page.getByTestId('sk-next').click()
  await click(app, 0, 0)
  await esc2(app)
  m = await sk(app)
  const holes = types(m, 'circle').filter((c) => !c.construction)
  expect(holes).toHaveLength(4)
  for (const h of holes) {
    near(h.r, 2.5)
    const [x, y] = pt(m, h.c)
    near(Math.hypot(x, y), 22, 0.005)
  }
  // the plate with its slot and holes: one outline with five holes in it, and the five loose discs
  const plate = m.profiles.reduce((a: any, b: any) => (b.area > a.area ? b : a)) // eslint-disable-line
  near(plate.area, 6000 - (300 + Math.PI * 25), 0.02)
  expect(m.profiles.length).toBeGreaterThanOrEqual(5)
  await expectFullyConstrained(app)
  await app.shot('real-plate')
})

test('Bracket profile: polyline, an angled edge dimensioned by angle, two fillets, fully constrained', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  // A(0,0) B(70,0) C(70,15) D(30,15) E(0,55), closed back to A
  await polyline(app, [[0, 0], [70, 0], [70, 15], [30, 15], [0, 55], [0, 0]])
  let m = await sk(app)
  expect(types(m, 'line')).toHaveLength(5)
  expect(m.profiles).toHaveLength(1)
  await page.keyboard.press('Escape')
  // lengths: base 70, step 15, top of the foot 40
  await dim(app, [[35, 0]], [35, -8], '70')
  await dim(app, [[70, 7]], [78, 7], '15')
  await dim(app, [[50, 15]], [50, 22], '40')
  m = await sk(app)
  // the slanted edge by its angle to the base, put in the sharp sector between them
  await dim(app, [[15, 35], [20, 0]], [25, 6], '55')
  m = await sk(app)
  expect(m.ok).toBe(true)
  expect(m.dof).toBe(0)
  const ys = types(m, 'point').map((p) => p.y)
  near(Math.max(...ys), 15 + 30 * Math.tan((55 * Math.PI) / 180), 0.01)
  // round the two outside corners at the foot and the top
  await tool(app, 'Sketch Fillet')
  await page.getByTestId('sk-opt-radius').fill('5')
  await page.getByTestId('sk-opt-radius').press('Enter')
  await click(app, 70, 0)
  await click(app, 70, 15)
  await esc2(app)
  m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(2)
  expect(m.profiles).toHaveLength(1)
  await expectFullyConstrained(app)
  await app.shot('real-bracket')
})

test('Gasket: a rectangle, two holes and an offset outline, fully constrained', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await menuItem(app, 'Rectangle', 'Center Rectangle')
  await click(app, 0, 0)
  await hover(app, 25, 15)
  await page.keyboard.type('80')
  await page.keyboard.press('Tab')
  await page.keyboard.type('50')
  await page.keyboard.press('Enter')
  await esc2(app)
  // two 12 mm holes on the X axis, 20 either side of the centre
  for (const x of [-20, 20]) {
    await tool(app, 'Circle')
    await click(app, x, 0)
    await hover(app, x + 6, 0.2)
    await page.keyboard.type('12')
    await page.keyboard.press('Enter')
    await esc2(app)
  }
  let m = await sk(app)
  expect(types(m, 'circle')).toHaveLength(2)
  // each hole 20 from the Y axis (the X axis already holds them: they were put on it)
  await dim(app, [[-20, 0], [0, -45]], [-10, 38], '20')
  await dim(app, [[20, 0], [0, -45]], [10, 38], '20')
  m = await sk(app)
  expect(m.dof).toBe(0)
  // the 4 mm gasket edge: offset the outline outwards
  await tool(app, 'Offset')
  await click(app, 0, -25)
  const p = await app.project(0, -30, 0)
  await page.mouse.move(p.x, p.y, { steps: 4 })
  await page.keyboard.type('4')
  await page.keyboard.press('Enter')
  await esc2(app)
  m = await sk(app)
  const xs = types(m, 'point').map((q) => q.x), ys = types(m, 'point').map((q) => q.y)
  near(Math.max(...xs) - Math.min(...xs), 88)
  near(Math.max(...ys) - Math.min(...ys), 58)
  // the rim between the two outlines: 88 x 58 less 80 x 50, and the plate inside it with the two holes cut out
  const areas = m.profiles.map((q: any) => q.area).sort((a: number, b: number) => b - a) // eslint-disable-line
  expect(m.profiles.length).toBeGreaterThanOrEqual(4)
  near(areas.find((a: number) => Math.abs(a - (88 * 58 - 80 * 50)) < 40) ?? 0, 88 * 58 - 80 * 50, 0.02)
  await expectFullyConstrained(app)
  await app.shot('real-gasket')
})

test('Symmetric profile: half drawn from a construction axis, mirrored, fully constrained', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  // a construction line up the Y axis from the origin, 40 long: the line of symmetry
  await page.keyboard.press('x')
  await polyline(app, [[0, 0], [0, 40]])
  await page.keyboard.press('x')
  // construction lines get no automatic Vertical (see 55-sketch-parity): put it on by hand, as in Fusion
  await page.keyboard.press('q')
  await click(app, 0, 20)
  await tool(app, 'Vertical')
  await page.keyboard.press('Escape')
  expect(consOf(await sk(app), 'vertical')).toHaveLength(1)
  await dim(app, [[0, 20]], [-8, 20], '40')
  // half of a T section on the right: foot 30 x 10, web 10 wide, up to the axis end
  await polyline(app, [[0, 0], [30, 0], [30, 10], [10, 10], [10, 40], [0, 40]])
  await page.keyboard.press('Escape')
  await dim(app, [[15, 0]], [15, -8], '30')
  await dim(app, [[30, 5]], [38, 5], '10')
  await dim(app, [[20, 10]], [20, 16], '20')
  let m = await sk(app)
  expect(m.ok).toBe(true)
  // mirror the five solid sides about the construction line
  await tool(app, 'Sketch Mirror')
  for (const [x, y] of [[15, 0], [30, 5], [20, 10], [10, 25], [5, 40]]) await click(app, x, y)
  await page.getByTestId('sk-next').click()
  await click(app, 0, 20)
  m = await sk(app)
  expect(consOf(m, 'mirror').length).toBeGreaterThanOrEqual(2)
  expect(m.profiles).toHaveLength(1)
  near(m.profiles[0].area, 2 * (30 * 10 + 10 * 30), 0.01)
  const xs = types(m, 'point').map((q) => q.x)
  near(Math.min(...xs), -30)
  near(Math.max(...xs), 30)
  await expectFullyConstrained(app)
  await app.shot('real-symmetric')
})

test('Grip: a closed fit point spline outline with a finger hole, fully constrained', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Fit Point Spline')
  const P: [number, number][] = [[-32, -4], [-8, 18], [30, 6], [10, -20]]
  for (const [x, y] of P) await click(app, x, y)
  await click(app, P[0][0], P[0][1]) // back on the first point: closed
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  let m = await sk(app)
  expect(types(m, 'spline')[0].closed).toBe(true)
  expect(m.profiles).toHaveLength(1)
  // a 10 mm finger hole at the centre
  await tool(app, 'Circle')
  await click(app, 0, 0)
  await hover(app, 5, 0.2)
  await page.keyboard.type('10')
  await page.keyboard.press('Enter')
  await esc2(app)
  // every outline point placed from the axes: across from the Y axis, up from the X axis
  for (const [x, y] of P) {
    await dim(app, [[x, y], [0, -50]], [x, y > 0 ? 40 : -40], String(Math.abs(x)))
    await dim(app, [[x, y], [-50, 0]], [x > 0 ? 50 : -50, y], String(Math.abs(y)))
  }
  m = await sk(app)
  expect(m.ok).toBe(true)
  expect(m.profiles.length).toBe(2)
  await expectFullyConstrained(app)
  await app.shot('real-grip')
})

test('Keyhole: two circles and two lines trimmed into one outline, fully constrained', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Circle')
  await click(app, 0, 0)
  await hover(app, 10, 0.2)
  await page.keyboard.type('20')
  await page.keyboard.press('Enter')
  await esc2(app)
  await tool(app, 'Circle')
  await click(app, 0, -30)
  await hover(app, 4, -30.2)
  await page.keyboard.type('8')
  await page.keyboard.press('Enter')
  await esc2(app)
  await dim(app, [[0, -30], [-45, 0]], [-12, -30], '30')
  // the two sides of the slot, running through both circles
  await polyline(app, [[-3, 4], [-3, -38]])
  await polyline(app, [[3, 4], [3, -38]])
  await dim(app, [[-3, 4], [0, 45]], [-3, 15], '3')
  await dim(app, [[3, 4], [0, 45]], [3, 20], '3')
  // trim away what is inside the keyhole and the ends that stick out
  await tool(app, 'Trim')
  for (const [x, y] of [[-3, 0], [3, 0], [-3, -30], [3, -30], [-3, -36], [3, -36], [0, -9.5], [0, -26.1]]) await click(app, x, y)
  await esc2(app)
  const m = await sk(app)
  expect(m.ok).toBe(true)
  expect(m.profiles).toHaveLength(1)
  // ring area of the big circle less the cap the slot opens, plus the slot and the lower round end
  expect(m.profiles[0].area).toBeGreaterThan(Math.PI * 100)
  expect(m.profiles[0].area).toBeLessThan(Math.PI * 100 + 6 * 30 + Math.PI * 16)
  await expectFullyConstrained(app)
  await app.shot('real-keyhole')
})
