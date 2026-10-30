import { test, expect, type App } from './helpers'
import { addBox, frame } from './detail-kit'

/**
 * Real parts, modelled the way a person does it: an L bracket from a sketch with real mouse clicks and typed dimensions, then
 * extrude, hole, fillet and split with their defaults, plus the rough spots found while doing that (hair on a rim, shortcuts
 * right after OK, the camera of a new document).
 */

const title = (app: App) => app.inspector().locator('.panel-title')
const values = (app: App) => app.ev((c) => c.ui.getState().inspector?.values)
const notice = (app: App) => app.ev((c) => c.ui.getState().inspectorNotice as string | null)

const sketchModel = (app: App) => app.ev((c) => {
  const m = c.sketch.getState().model
  const pts = Object.fromEntries(m.entities.filter((e: any) => e.type === 'point').map((p: any) => [p.id, [p.x, p.y]])) // eslint-disable-line
  return {
    lines: m.entities.filter((e: any) => e.type === 'line').map((l: any) => [pts[l.p1], pts[l.p2]] as [number[], number[]]), // eslint-disable-line
    constraints: m.constraints.map((k: any) => ({ id: k.id, type: k.type, refs: k.refs, value: k.value })), // eslint-disable-line
    ok: c.sketch.getState().info.ok as boolean,
  }
})

async function startSketch(app: App) {
  const { page } = app
  // one click on Sketch: the planes are there to pick, in the Browser as well as in the viewport
  await app.ribbon('Sketch').first().click()
  await expect(page.getByText('XY plane')).toBeVisible()
  await expect.poll(() => app.ev((c) => c.ui.getState().activeTool)).toBe('sketch.create')
  await page.getByText('XY plane').click()
  await expect(page.locator('.sk-bar')).toBeVisible()
  await app.cameraStable()
}

/** A mouse click at sketch coordinates (mm), a few tenths of a pixel off like a hand. */
async function clickAt(app: App, x: number, y: number, jx = 0, jy = 0) {
  const p = await app.project(x, y, 0)
  await app.page.mouse.move(p.x + jx, p.y + jy, { steps: 4 })
  await app.page.mouse.click(p.x + jx, p.y + jy)
}

/** D, click a line, click where the dimension goes, then type the value straight away and press Enter. */
async function dimension(app: App, pick: [number, number], place: [number, number], text: string) {
  const { page } = app
  await clickAt(app, ...pick)
  await clickAt(app, ...place)
  const input = page.locator('.sk-dim-input')
  await expect(input).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await expect(input).toHaveCount(0)
}

const near = (a: number[], b: number[]) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6)
const previewBox = (app: App) => app.ev((c) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (const it of c.preview.getState().items) {
    const p = it.mesh.positions
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[i + k]); mx[k] = Math.max(mx[k], p[i + k]) }
  }
  return { mn, mx }
})
const states = async (app: App) => {
  const f = await app.features()
  expect(f.map((x) => x.state), JSON.stringify(f.map((x) => x.error))).toEqual(f.map(() => 'ok'))
  return f
}

test('an L bracket: sketch with loose clicks, typed dimensions, extrude, hole, fillet, split', async ({ app, page }) => {
  await app.open()
  await startSketch(app)

  // the L: right, up, left, up, left, then back on the origin; snapping on, every click a pixel or two off
  const L: [number, number][] = [[0, 0], [60, 0], [60, 10], [10, 10], [10, 40], [0, 40], [0, 0]]
  let k = 0
  for (const [x, y] of L) { await clickAt(app, x, y, (k % 3) * 1.3 - 1.3, (k % 2) * 1.7 - 0.8); k++ }
  let m = await sketchModel(app)
  expect(m.lines).toHaveLength(6)
  // round values: the points land on the grid, so the lengths are round too
  for (const [a, b] of m.lines) for (const q of [a, b]) for (const v of q) expect(Math.abs(v - Math.round(v)), String(q)).toBeLessThan(1e-6)
  // the closing edge is perpendicular to the one before it, like every other edge, and nothing is equal by accident
  const ids = await app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'line').map((e: any) => e.id as string)) // eslint-disable-line
  expect(m.constraints.some((c) => c.type === 'perpendicular' && c.refs.includes(ids[5]) && c.refs.includes(ids[4]))).toBe(true)
  expect(m.constraints.some((c) => c.type === 'equal')).toBe(false)
  await app.shot('real-part-L')

  // dimensions: the value box opens by itself with its value selected, so the number is typed and Enter pressed right away
  await page.keyboard.press('Escape')
  await page.keyboard.press('d')
  await dimension(app, [30, 0], [30, -8], '65') // bottom
  await dimension(app, [0, 20], [-8, 20], '45') // left side
  await dimension(app, [65, 6], [73, 6], '12') // foot
  await dimension(app, [5, 45], [5, 53], '11') // leg
  m = await sketchModel(app)
  expect(m.ok).toBe(true)
  const poly = [[0, 0], [65, 0], [65, 12], [11, 12], [11, 45], [0, 45]]
  expect(m.lines).toHaveLength(6)
  m.lines.forEach(([a, b], i) => { near(a, poly[i]); near(b, poly[(i + 1) % 6]) })
  // (so it is still square: every edge is level or upright)
  for (const [a, b] of m.lines) expect(Math.min(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))).toBeLessThan(1e-6)
  expect(await app.ev((c) => c.sketch.getState().info.dof)).toBe(0)
  await app.shot('real-part-dimensions')
  await app.finishSketch()

  // extrude
  await app.ribbon('Extrude').click()
  await expect(title(app)).toHaveText('Extrude')
  await app.field('Distance', '8')
  await app.ok()
  await states(app)
  expect(await app.volume()).toBeCloseTo((65 * 12 + 11 * 33) * 8, 0)
  await frame(app)

  // hole, Through all (the default): the drill in the preview stays inside the material
  await app.tab('Solid')
  await app.ribbon('Hole').first().click()
  const top = await app.project(40, 6, 8)
  await page.mouse.move(top.x, top.y, { steps: 3 })
  await page.mouse.click(top.x, top.y)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  expect((await values(app)).depthMode).toBe('through')
  const drill = await previewBox(app)
  const part = await app.bbox()
  for (let a = 0; a < 3; a++) {
    expect(drill.mn[a]).toBeGreaterThan(part.min[a] - 1e-3)
    expect(drill.mx[a]).toBeLessThan(part.max[a] + 1e-3)
  }
  expect(drill.mx[2] - drill.mn[2]).toBeCloseTo(8, 2) // all the way through, no further
  await app.ok()
  await states(app)
  const vHole = await app.volume()
  expect(vHole).toBeLessThan((65 * 12 + 11 * 33) * 8 - 1)

  // fillet: a radius the edge cannot take says so, with the largest one that works
  await app.ev((c) => c.ui.getState().setSelectionFilter('edge'))
  const edge = await app.project(65, 0, 4)
  await page.mouse.move(edge.x - 20, edge.y + 10)
  await page.mouse.move(edge.x, edge.y, { steps: 6 })
  await page.mouse.click(edge.x, edge.y)
  await expect.poll(() => app.ev((c) => c.ui.getState().selection.map((r: any) => r.kind))).toEqual(['edge']) // eslint-disable-line
  await app.ribbon('Fillet').click()
  await expect(title(app)).toHaveText('Fillet')
  await app.field('Radius', '30')
  const msg = app.page.getByTestId('inspector-notice')
  await expect(msg).toContainText('Fillet of 30 mm is not possible', { timeout: 60_000 })
  await expect(msg).toContainText('largest radius that works')
  const max = Number(/is ([0-9.]+) mm/.exec((await msg.textContent()) ?? '')?.[1])
  expect(max).toBeGreaterThan(1)
  expect(max).toBeLessThan(30)
  // the arrow cannot be dragged past it
  await app.ev((c) => c.manips[0].getState().onChange(500))
  await expect.poll(async () => (await values(app)).size).toBeCloseTo(max, 2)
  await expect(msg).toHaveCount(0, { timeout: 60_000 })
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  await states(app)
  expect(await app.features().then((f) => f.map((x) => x.type))).toEqual(['sketch', 'extrude', 'hole', 'fillet'])

  // split with its defaults: the cut is through the middle of the part, the arrow is there from the start, and OK splits
  await app.tab('Print')
  await app.ribbon('Split Body').click()
  await expect(title(app)).toHaveText('Split body')
  expect((await values(app)).offset).toBeCloseTo(4, 2)
  await expect.poll(() => app.ev((c) => c.manips[0].getState().active as boolean)).toBe(true)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(2)
  expect(await notice(app)).toBeNull()
  await app.shot('real-part-split')
  await app.ok()
  await states(app)
  expect((await app.bodies()).length).toBe(2)
})

test('Split Body: an offset that misses the part keeps its arrow and says why nothing is cut', async ({ app, page }) => {
  await app.open()
  await addBox(app, 40, 30, 20)
  await frame(app)
  await app.tab('Print')
  await app.ribbon('Split Body').click()
  await expect(title(app)).toHaveText('Split body')
  expect((await values(app)).offset).toBeCloseTo(10, 2)
  await expect.poll(() => app.ev((c) => c.manips[0].getState().active as boolean)).toBe(true)
  // another plane puts the default offset in the middle of the part along its normal (a box centred on the origin: 0, where the Z cut had 10)
  await app.inspector().locator('.field', { hasText: 'Plane' }).locator('.sel').first().click()
  await page.getByRole('option', { name: /^YZ/ }).click()
  await expect.poll(async () => (await values(app)).offset).toBeCloseTo(0, 2)
  await expect.poll(() => app.ev((c) => c.manips[0].getState().active as boolean)).toBe(true)
  // an offset past the part: the arrow stays, and the dialog says why nothing is cut
  await app.field('Offset', '60')
  await expect(page.getByTestId('inspector-notice')).toContainText('Move the offset', { timeout: 30_000 })
  expect(await app.ev((c) => c.manips[0].getState().active as boolean)).toBe(true)
  expect(await app.ev((c) => c.preview.getState().items.length)).toBe(0)
  await app.field('Offset', '5')
  await expect(page.getByTestId('inspector-notice')).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(2)
})

test('Shell with a single body and nothing picked: the body is the pick and OK makes a closed hollow', async ({ app }) => {
  await app.open()
  await addBox(app, 30, 30, 30)
  const solid = await app.volume()
  await app.tab('Solid')
  await app.ribbon('Shell').first().click()
  await expect(title(app)).toHaveText('Shell')
  expect((await values(app)).bodies).toEqual(['f1'])
  await expect(app.inspector().getByRole('button', { name: 'OK' })).toBeEnabled()
  await app.ok()
  await states(app)
  expect(await app.volume()).toBeLessThan(solid * 0.9)
})

test('Hair with its default preset works on a flat rim face', async ({ app, page }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  await frame(app)
  const topFace = () => app.ev((c) => {
    const b = c.doc.getState().geometry[0]
    const m = b.mesh
    let best = -1, bz = -Infinity
    for (let t = 0; t < m.indices.length / 3; t++) {
      const i = m.indices[t * 3] * 3
      if (m.normals[i + 2] > 0.99 && m.positions[i + 2] > bz) { bz = m.positions[i + 2]; best = t }
    }
    return { kind: 'face', id: b.id, index: m.faceIds[best] }
  })
  await app.ev((c, s) => c.ui.getState().setSelection([s]), await topFace())
  await app.tab('Solid')
  await app.ribbon('Shell').first().click()
  await expect(title(app)).toHaveText('Shell')
  await app.ok()
  await states(app)
  // the rim of the open box
  await app.ev((c, s) => c.ui.getState().setSelection([s]), await topFace())
  await app.tab('Hair')
  await app.ribbon(/^Hair$/).first().click()
  await expect(title(app)).toHaveText('Hair')
  await expect.poll(() => app.ev((c) => c.hair.getState().result?.stats?.strands ?? 0), { timeout: 60_000 }).toBeGreaterThan(0)
  expect(await app.ev((c) => c.hair.getState().error)).toBeNull()
  await expect(page.getByTestId('inspector-notice')).toHaveCount(0)
  // the comb is still the chosen preset; only Print-aware had to give way on a surface that faces straight up
  expect((await values(app)).preset).toBe('comb')
  expect((await values(app)).printAware).toBe(false)
  await app.shot('real-part-hair-rim')
  await app.ok()
  await states(app)
})

test('shortcuts work right after OK: F6 frames at once', async ({ app, page }) => {
  await app.open()
  await addBox(app, 40, 40, 10)
  await frame(app)
  const dist = () => app.ev((c) => { const p = c.three.camera.position; return Math.hypot(p.x, p.y, p.z) as number })
  const framed = await dist()
  await app.tab('Solid')
  await app.ribbon('Shell').first().click()
  await expect(title(app)).toHaveText('Shell')
  // move the view away from the framed one
  await page.mouse.move(800, 400)
  await page.mouse.wheel(0, 1500)
  await expect.poll(dist).toBeGreaterThan(framed * 1.2)
  await page.locator('.inspector-foot').getByRole('button', { name: 'OK' }).click()
  // no button keeps the focus
  expect(await page.evaluate(() => { const a = document.activeElement; return a === document.body || !a?.closest('.ribbon, [data-inspector-root]') })).toBe(true)
  await page.keyboard.press('F6')
  await app.cameraStable()
  expect(await dist()).toBeCloseTo(framed, 0)

  // the same after Cancel, with a ribbon button holding the focus
  await app.ribbon('Shell').first().click()
  await expect(title(app)).toHaveText('Shell')
  await page.mouse.move(800, 400)
  await page.mouse.wheel(0, -1200)
  await expect.poll(dist).toBeLessThan(framed * 0.9)
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  await page.keyboard.press('F6')
  await app.cameraStable()
  expect(await dist()).toBeCloseTo(framed, 0)
})

test('a new document starts from the home view', async ({ app, page }) => {
  await app.open()
  const pose = () => app.ev((c) => { const p = c.three.camera.position; return [p.x, p.y, p.z] as number[] })
  await app.cameraStable()
  const home = await pose()
  await addBox(app, 40, 40, 10)
  await frame(app)
  // look somewhere else: orbit and zoom
  await page.mouse.move(800, 450)
  await page.mouse.wheel(0, 900)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(900, 380, { steps: 6 })
  await page.mouse.up({ button: 'middle' })
  await app.cameraStable()
  expect(Math.hypot(...(await pose()).map((v, i) => v - home[i]))).toBeGreaterThan(5)
  page.on('dialog', (d) => void d.accept())
  await app.ev((c) => c.runCommand('file.new'))
  await app.cameraStable()
  const after = await pose()
  home.forEach((v, i) => expect(after[i]).toBeCloseTo(v, 1))
  // a box at the origin is in view, not half off the screen
  await addBox(app, 40, 40, 10)
  const b = (await page.locator('.vp canvas').boundingBox())!
  for (const [x, y, z] of [[-20, -20, 0], [20, 20, 10]]) {
    const p = await app.project(x, y, z)
    expect(p.x).toBeGreaterThan(b.x + 20)
    expect(p.x).toBeLessThan(b.x + b.width - 20)
    expect(p.y).toBeGreaterThan(b.y + 20)
    expect(p.y).toBeLessThan(b.y + b.height - 20)
  }
})
