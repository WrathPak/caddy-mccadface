import { test, expect, type App } from './helpers'

/* The sketch tools Fusion 360 has that this app was missing: 3-point rectangle, other circles, centre arc, more constraints,
   Point / Extend / Break / Scale, fillets on arcs, typed values everywhere and Ctrl+Z one point at a time. */

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
  return { entities: s.model.entities, constraints: s.model.constraints, sel: s.sel, tool: s.tool, status: s.status, dof: s.info.dof, ok: s.info.ok, profiles: s.profiles.map((p: any) => p.area) } // eslint-disable-line
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
const menuTool = async (app: App, group: string, item: string) => {
  await app.page.getByRole('button', { name: `${group} options` }).click()
  await app.page.getByRole('menuitem', { name: item }).click()
}
const near = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-4))
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
const cmd = (app: App, id: string) => app.ev((c, i) => c.runCommand(i), id)
const type = (app: App, text: string) => app.page.keyboard.type(text)

test('The Rectangle, Circle, Arc and Trim buttons open the menus Fusion has', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  const menus: [string, string[]][] = [
    ['Rectangle', ['Rectangle', '3-Point Rectangle', 'Center Rectangle']],
    ['Circle', ['Circle', '2-Point Circle', '3-Point Circle', '2-Tangent Circle']],
    ['Arc', ['Arc', 'Centre Point Arc', 'Tangent Arc']],
    ['Trim', ['Trim', 'Extend', 'Break']],
  ]
  for (const [group, items] of menus) {
    await page.getByRole('button', { name: `${group} options` }).click()
    for (const name of items) await expect(page.getByRole('menuitem', { name: new RegExp('^' + name.replace(/[-]/g, '\\$&') + '( \\w)?$') })).toBeVisible()
    await page.keyboard.press('Escape')
  }
})

test('3-point rectangle: two corners of a side, then the width, at any angle; or typed', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await menuTool(app, 'Rectangle', '3-Point Rectangle')
  await click(app, 10, 10)
  await click(app, 50, 40) // a side 50 long, up and to the right
  await click(app, -2, 26) // 20 away from it, to the left
  let m = await sk(app)
  expect(types(m, 'line')).toHaveLength(4)
  expect(consOf(m, 'perpendicular')).toHaveLength(3)
  expect(m.ok).toBe(true)
  near(m.profiles[0], 1000, 0.002)
  expect(m.dof).toBe(5) // where, which way, how long, how wide
  // typed: the first side level, then a width of 15 below it
  await click(app, 60, -40)
  await click(app, 90, -40)
  await hover(app, 75, -50)
  await type(app, '15')
  await page.keyboard.press('Enter')
  m = await sk(app)
  expect(types(m, 'line')).toHaveLength(8)
  const widthDim = consOf(m, 'distance').find((k) => k.expr === '15')
  expect(widthDim).toBeTruthy()
  expect(consOf(m, 'horizontal')).toHaveLength(1)
  near(m.profiles[1], 450, 0.002)
})

test('Circles by 2 points, 3 points (through existing points) and 2 tangent curves', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await menuTool(app, 'Circle', '2-Point Circle')
  await click(app, -30, 50)
  await click(app, -10, 50)
  let m = await sk(app)
  expect(types(m, 'circle')).toHaveLength(1)
  near(types(m, 'circle')[0].r, 10)
  near(pt(m, types(m, 'circle')[0].c)[0], -20)

  // three points that already exist: the circle goes through them and says so
  await tool(app, /^Point$/)
  for (const [x, y] of [[50, 0], [65, 15], [80, 0]]) await click(app, x, y)
  expect(types(await sk(app), 'point')).toHaveLength(4) // the diameter circle's centre and the three
  await menuTool(app, 'Circle', '3-Point Circle')
  for (const [x, y] of [[50, 0], [65, 15], [80, 0]]) await click(app, x, y)
  m = await sk(app)
  expect(types(m, 'circle')).toHaveLength(2)
  near(types(m, 'circle')[1].r, 15)
  expect(consOf(m, 'pointOnCurve')).toHaveLength(3)
  expect(m.ok).toBe(true)

  // touching two lines: the mouse picks the corner and the size
  await line(app, [-60, -10], [0, -10])
  await line(app, [-60, -10], [-60, -45])
  await menuTool(app, 'Circle', '2-Tangent Circle')
  await click(app, -30, -10)
  await click(app, -60, -30)
  await click(app, -50, -20)
  m = await sk(app)
  const c = types(m, 'circle')[2]
  expect(c).toBeTruthy()
  near(c.r, 10, 0.35)
  expect(consOf(m, 'tangent')).toHaveLength(2)
  expect(m.ok).toBe(true)
  const [cx, cy] = pt(m, c.c)
  near(cx, -60 + c.r, 0.02)
  near(cy, -10 - c.r, 0.02)
})

test('Centre point arc: centre, start, end; and a typed sweep past a half turn', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await menuTool(app, 'Arc', 'Centre Point Arc')
  await click(app, -60, -20)
  await click(app, -40, -20)
  await click(app, -60, 0)
  let m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(1)
  near(Math.hypot(...(pt(m, types(m, 'arc')[0].s).map((v, i) => v - [-60, -20][i]) as [number, number])), 20)
  const e = pt(m, types(m, 'arc')[0].e)
  near(e[0], -60, 0.001)
  near(e[1], 0, 0.001)
  // 270 degrees, typed
  await click(app, 60, -20)
  await click(app, 80, -20)
  await hover(app, 60, 5)
  await type(app, '270')
  await page.keyboard.press('Enter')
  m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(2)
  const e2 = pt(m, types(m, 'arc')[1].e)
  near(e2[0], 60, 0.001)
  near(e2[1], -40, 0.001)
  expect(m.ok).toBe(true)
})

test('Concentric and Collinear: pick in the tool, either way round', async ({ app }) => {
  await app.open()
  await startSketch(app)
  for (const [c, r] of [[[-60, 40], 10], [[-30, 45], 5]] as [[number, number], number][]) {
    await tool(app, 'Circle')
    await click(app, c[0], c[1])
    await click(app, c[0] + r, c[1])
    await app.page.keyboard.press('Escape')
  }
  await cmd(app, 'sketch.concentric')
  await click(app, -25, 45) // the small circle's edge
  await click(app, -50, 40) // then the big one's
  let m = await sk(app)
  const [a, b] = types(m, 'circle')
  expect(Math.hypot(pt(m, a.c)[0] - pt(m, b.c)[0], pt(m, a.c)[1] - pt(m, b.c)[1])).toBeLessThan(1e-4)
  expect(m.ok).toBe(true)

  await line(app, [0, 0], [20, 0])
  await line(app, [40, 5], [60, 15])
  await cmd(app, 'sketch.collinear')
  await click(app, 10, 0)
  await click(app, 50, 10)
  m = await sk(app)
  expect(consOf(m, 'parallel')).toHaveLength(1)
  const [l1, l2] = types(m, 'line')
  const d = [pt(m, l1.p2)[0] - pt(m, l1.p1)[0], pt(m, l1.p2)[1] - pt(m, l1.p1)[1]]
  for (const p of [l2.p1, l2.p2]) {
    const q = [pt(m, p)[0] - pt(m, l1.p1)[0], pt(m, p)[1] - pt(m, l1.p1)[1]]
    expect(Math.abs(d[0] * q[1] - d[1] * q[0]) / Math.hypot(d[0], d[1])).toBeLessThan(1e-4)
  }
})

test('Symmetry: two points, then the line they mirror across; the same with a selection', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await line(app, [40, -30], [40, 30])
  await tool(app, /^Point$/)
  await click(app, 20, 10)
  await click(app, 65, 14)
  await cmd(app, 'sketch.symmetric')
  await click(app, 20, 10)
  await click(app, 65, 14)
  await click(app, 40, -20)
  let m = await sk(app)
  expect(consOf(m, 'mirror')).toHaveLength(1)
  const mir = consOf(m, 'mirror')[0]
  const [A, B] = types(m, 'line').map((l) => [pt(m, l.p1), pt(m, l.p2)])[0]
  const [p, q] = [pt(m, mir.refs[0]), pt(m, mir.refs[1])]
  const d = [B[0] - A[0], B[1] - A[1]], mid = [(p[0] + q[0]) / 2 - A[0], (p[1] + q[1]) / 2 - A[1]]
  expect(Math.abs(d[0] * mid[1] - d[1] * mid[0]) / Math.hypot(d[0], d[1])).toBeLessThan(1e-3) // halfway point is on the line
  expect(Math.abs(d[0] * (q[0] - p[0]) + d[1] * (q[1] - p[1])) / Math.hypot(d[0], d[1])).toBeLessThan(1e-3) // and they face each other square across it
  // two circles picked first in the select tool, the line last
  await select(app)
  await app.page.keyboard.press('Escape')
  for (const [c, r] of [[[-70, -30], 6], [[85, -25], 9]] as [[number, number], number][]) {
    await tool(app, 'Circle')
    await click(app, c[0], c[1])
    await click(app, c[0] + r, c[1])
    await app.page.keyboard.press('Escape')
  }
  await select(app)
  const axis = types(await sk(app), 'line')[0]
  const ends = await app.ev((c, id) => { const s = c.sketch.getState().model; const l = s.entities.find((e: any) => e.id === id); return [l.p1, l.p2].map((p: string) => s.entities.find((e: any) => e.id === p)) }, axis.id) // eslint-disable-line
  await click(app, -64, -30)
  await app.page.keyboard.down('Shift')
  await click(app, 94, -25)
  await click(app, ends[0].x * 0.7 + ends[1].x * 0.3, ends[0].y * 0.7 + ends[1].y * 0.3)
  await app.page.keyboard.up('Shift')
  expect((await sk(app)).sel).toHaveLength(3)
  await cmd(app, 'sketch.symmetric')
  m = await sk(app)
  expect(consOf(m, 'mirror')).toHaveLength(2)
  expect(consOf(m, 'equal')).toHaveLength(1)
  expect(m.ok).toBe(true)
})

test('Midpoint puts a point halfway round an arc', async ({ app }) => {
  await app.open()
  await startSketch(app)
  await menuTool(app, 'Arc', 'Centre Point Arc')
  await click(app, -60, -40)
  await click(app, -40, -40)
  await click(app, -60, -20)
  await tool(app, /^Point$/)
  await click(app, -35, -10)
  await cmd(app, 'sketch.midpoint')
  await click(app, -35, -10)
  await click(app, -45.86, -25.86) // on the arc
  let m = await sk(app)
  const mid = consOf(m, 'midpoint')[0]
  expect(mid).toBeTruthy()
  const arc = types(m, 'arc')[0]
  const [p, c, a, b] = [pt(m, mid.refs[0]), pt(m, arc.c), pt(m, arc.s), pt(m, arc.e)]
  const d = (u: [number, number], v: [number, number]) => Math.hypot(u[0] - v[0], u[1] - v[1])
  near(d(p, c), d(a, c), 0.002) // on the arc
  near(d(p, a), d(p, b), 0.002) // and halfway along it
})

test('Smooth joins a spline tangent to the line it meets', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 30], [30, 30])
  await app.ev((c) => c.runCommand('sketch.spline'))
  await click(app, 30, 30) // starts on the line's end
  await click(app, 50, 42)
  await click(app, 75, 34)
  await page.keyboard.press('Enter')
  await select(app)
  await page.keyboard.press('Control+a') // the line and the spline (the points in between are ignored)
  await cmd(app, 'sketch.smooth')
  const m = await sk(app)
  expect(consOf(m, 'splineTangent')).toHaveLength(1)
  expect(m.ok).toBe(true)
})

test('Point, Extend and Break', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [-70, -40], [-50, -40])
  await line(app, [-20, -45], [-20, -25])
  await line(app, [0, -45], [0, -20])
  await tool(app, /^Point$/)
  await click(app, -65, -40) // on the line: the point stays on it
  let m = await sk(app)
  expect(consOf(m, 'pointOnLine')).toHaveLength(1)
  await menuTool(app, 'Trim', 'Extend')
  await click(app, -51, -40)
  m = await sk(app)
  near(pt(m, types(m, 'line')[0].p2)[0], -20, 0.001)
  expect(consOf(m, 'pointOnLine').length).toBe(2)
  expect(m.ok).toBe(true)
  // an end that is joined to another curve is left alone
  await page.keyboard.press('Escape')
  await line(app, [30, -40], [50, -40])
  await line(app, [50, -40], [50, -20])
  await menuTool(app, 'Trim', 'Extend')
  await click(app, 45, -40)
  expect((await sk(app)).status).toContain('not joined')

  await line(app, [-70, 30], [-10, 30])
  await line(app, [-55, 20], [-55, 40])
  await line(app, [-35, 20], [-35, 40])
  const before = types(await sk(app), 'line').length
  await menuTool(app, 'Trim', 'Break')
  await click(app, -65, 30)
  m = await sk(app)
  expect(types(m, 'line').length).toBe(before + 2)
  // no crossing: it breaks where you click
  await line(app, [20, 10], [80, 10])
  const n = types(await sk(app), 'line').length
  await menuTool(app, 'Trim', 'Break')
  await click(app, 50, 10)
  m = await sk(app)
  expect(types(m, 'line').length).toBe(n + 1)
  expect(m.ok).toBe(true)
})

test('Sketch Scale: curves about a base point by a factor, dimensions with them', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await tool(app, 'Rectangle')
  await click(app, 10, 10)
  await click(app, 30, 20)
  await page.keyboard.press('Escape')
  await tool(app, 'Dimension')
  await click(app, 20, 20)
  await click(app, 20, 26)
  const input = page.locator('.sk-dim-input')
  await input.fill('20')
  await input.press('Enter')
  await select(app)
  await page.keyboard.press('Control+a')
  await tool(app, 'Sketch Scale')
  await page.getByTestId('sk-opt-factor').fill('2')
  await page.getByTestId('sk-opt-factor').press('Enter')
  await click(app, 0, 0)
  const m = await sk(app)
  const xs = types(m, 'point').map((p) => p.x), ys = types(m, 'point').map((p) => p.y)
  near(Math.min(...xs), 20)
  near(Math.max(...xs), 60)
  near(Math.min(...ys), 20)
  near(Math.max(...ys), 40)
  near(consOf(m, 'distance').concat(consOf(m, 'hdist'))[0].value, 40)
  expect(m.ok).toBe(true)
  expect(m.tool).toBe('select')
  // curves picked inside the tool: click them, Enter, then the base point
  await tool(app, 'Circle')
  await click(app, -50, -50)
  await click(app, -45, -50)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await tool(app, 'Sketch Scale')
  await click(app, -45, -50)
  await page.keyboard.press('Enter')
  await page.getByTestId('sk-opt-factor').fill('3')
  await page.getByTestId('sk-opt-factor').press('Enter')
  await click(app, -50, -50)
  near(types(await sk(app), 'circle')[0].r, 15)
})

test('Fillet and chamfer a line meeting an arc, and two arcs', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await line(app, [0, 0], [30, 0])
  // an arc about (50, 0) that starts on the line's end and leaves downward
  await menuTool(app, 'Arc', 'Centre Point Arc')
  await click(app, 50, 0)
  await click(app, 30, 0)
  await click(app, 50, -20)
  await tool(app, 'Sketch Fillet')
  await page.getByTestId('sk-opt-radius').fill('4')
  await page.getByTestId('sk-opt-radius').press('Enter')
  await click(app, 30, 0) // the corner itself
  let m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(2)
  expect(consOf(m, 'tangentAt')).toHaveLength(2)
  const fillet = types(m, 'arc').find((a) => Math.abs(Math.hypot(pt(m, a.s)[0] - pt(m, a.c)[0], pt(m, a.s)[1] - pt(m, a.c)[1]) - 4) < 1e-3)
  expect(fillet).toBeTruthy()
  expect(m.ok).toBe(true)

  // two arcs meeting at (0, -100), picked one after the other
  await menuTool(app, 'Arc', 'Centre Point Arc')
  await click(app, -40, -10)
  await click(app, -60, -10)
  await click(app, -40, -30)
  await click(app, -60, -30)
  await click(app, -60, -10)
  await click(app, -80, -30)
  await tool(app, 'Sketch Fillet')
  await click(app, -54.14, -24.14) // on the first arc
  await click(app, -74.14, -15.86) // on the second
  m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(5)
  expect(consOf(m, 'tangentAt')).toHaveLength(4)
  expect(m.ok).toBe(true)

  // chamfer a fresh line-and-arc corner
  await line(app, [0, 30], [30, 30])
  await menuTool(app, 'Arc', 'Centre Point Arc')
  await click(app, 50, 30)
  await click(app, 30, 30)
  await click(app, 50, 10)
  await menuTool(app, 'Sketch Fillet', 'Sketch Chamfer')
  await page.getByTestId('sk-opt-dist').fill('5')
  await page.getByTestId('sk-opt-dist').press('Enter')
  await click(app, 30, 30)
  m = await sk(app)
  expect(types(m, 'line')).toHaveLength(3) // the two lines and the chamfer
  expect(consOf(m, 'distance').length).toBeGreaterThanOrEqual(1)
  expect(m.ok).toBe(true)
})

test('Slots, polygon, ellipse and spline take typed values', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  // slot: length and angle, then the width
  await tool(app, 'Centre to Centre Slot')
  await click(app, -40, 20)
  await hover(app, 10, 25)
  await type(app, '40')
  await page.keyboard.press('Tab')
  await type(app, '0')
  await page.keyboard.press('Enter')
  await hover(app, -20, 32)
  await type(app, '12')
  await page.keyboard.press('Enter')
  let m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(2)
  near(types(m, 'arc')[0].r ?? Math.hypot(pt(m, types(m, 'arc')[0].s)[0] - pt(m, types(m, 'arc')[0].c)[0], pt(m, types(m, 'arc')[0].s)[1] - pt(m, types(m, 'arc')[0].c)[1]), 6)
  expect(consOf(m, 'distance').some((k) => k.expr === '40')).toBe(true)
  expect(consOf(m, 'diameter').some((k) => k.expr === '12')).toBe(true)
  // polygon: the radius
  await tool(app, 'Polygon')
  await click(app, 50, 30)
  await hover(app, 62, 30)
  await type(app, '15')
  await page.keyboard.press('Enter')
  m = await sk(app)
  expect(types(m, 'line').filter((l) => !l.construction)).toHaveLength(6 + 2)
  expect(consOf(m, 'radius').some((k) => k.expr === '15')).toBe(true)
  // ellipse: both radii
  await tool(app, 'Ellipse')
  await click(app, -50, -30)
  await hover(app, -20, -30)
  await type(app, '30')
  await page.keyboard.press('Enter')
  await hover(app, -50, -20)
  await type(app, '10')
  await page.keyboard.press('Enter')
  m = await sk(app)
  const el = types(m, 'ellipse')[0]
  near(el.r, 10)
  near(Math.hypot(pt(m, el.m)[0] - pt(m, el.c)[0], pt(m, el.m)[1] - pt(m, el.c)[1]), 30)
  expect(consOf(m, 'majorRadius')).toHaveLength(1)
  // spline: a point by length and angle, then one by click, Enter to finish
  await cmd(app, 'sketch.spline')
  await click(app, -80, 25)
  await hover(app, -60, 35)
  await type(app, '25')
  await page.keyboard.press('Tab')
  await type(app, '30')
  await page.keyboard.press('Enter')
  await click(app, -20, 40)
  await page.keyboard.press('Enter')
  m = await sk(app)
  const sp = types(m, 'spline')[0]
  expect(sp.pts).toHaveLength(3)
  const [p0, p1] = [pt(m, sp.pts[0]), pt(m, sp.pts[1])]
  near(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 25)
  near(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180 / Math.PI, 30)
  expect(consOf(m, 'distance').some((k) => k.expr === '25')).toBe(true)
  expect(m.ok).toBe(true)
})

test('Ctrl+Z while drawing a spline or a click-by-click tool takes back the last point only', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await cmd(app, 'sketch.spline')
  for (const [x, y] of [[0, 0], [20, 20], [40, 0]]) await click(app, x, y)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Enter')
  let m = await sk(app)
  expect(types(m, 'spline')).toHaveLength(1)
  expect(types(m, 'spline')[0].pts).toHaveLength(2)

  // a slot: back out of the second centre, put it somewhere else
  await tool(app, 'Centre to Centre Slot')
  await click(app, -60, -40)
  await click(app, -20, -40)
  await page.keyboard.press('Control+z') // the second centre goes; the first stays
  await click(app, -20, -10)
  m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(0) // still waiting for the width
  await click(app, -45, -20)
  m = await sk(app)
  expect(types(m, 'arc')).toHaveLength(2)
  const cs = types(m, 'arc').map((a) => pt(m, a.c))
  near(Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]), 50, 0.01)
  // the sketch's own history is untouched by the point that was taken back: one Ctrl+Z now removes the whole slot
  await page.keyboard.press('Control+z')
  expect(types(await sk(app), 'arc')).toHaveLength(0)
})
