import { test, expect, addSketch, XY, XZ, type App, type Plane3 } from './helpers'

async function addBox(app: App, w = 40, d = 40, h = 10) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.w, depth: a.d, height: a.h, position: [0, 0, 0] }), { w, d, h })
  await app.idle()
}
const home = async (app: App) => {
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}
const title = (app: App) => app.inspector().locator('.panel-title')

/** Select the top face of the box (click it) and open Extrude on it. */
async function extrudeTopFace(app: App) {
  const { page } = app
  await home(app)
  await app.ev((c) => c.ui.getState().setSelectionFilter('face'))
  const top = await app.project(0, 0, 10)
  await page.mouse.move(top.x - 20, top.y + 10)
  await page.mouse.move(top.x, top.y, { steps: 4 })
  await page.mouse.click(top.x, top.y)
  await expect.poll(() => app.ev((c) => c.ui.getState().selection.map((r: any) => r.kind))).toEqual(['face']) // eslint-disable-line
  await app.ribbon('Extrude').click()
  await expect(title(app)).toHaveText('Extrude')
  await expect.poll(() => app.ev((c) => c.manip.getState().active)).toBe(true)
}

const manipTip = async (app: App) => app.ev((c) => { const s = c.manip.getState(); return { o: s.origin, d: s.dir, tip: s.tip } })

test('the arrow can be grabbed from behind a body, and letting go does not pick the face', async ({ app, page }) => {
  await app.open()
  await addBox(app)
  await extrudeTopFace(app)
  await app.field('Distance', '-6')
  await home(app)
  const m = await manipTip(app)
  const at = (t: number) => app.project(m.o[0] + m.d[0] * t, m.o[1] + m.d[1] * t, m.o[2] + m.d[2] * t)
  const tip = await at(m.tip)
  // typing a negative distance on a face is pushing it in: the dialog turned that into Cut (6 mm inwards)
  expect(await app.ev((c) => c.ui.getState().inspector.values.operation)).toBe('cut')
  expect(m.tip).toBeCloseTo(6, 3)
  expect(m.o[2] + m.d[2] * m.tip).toBeCloseTo(4, 3)
  const seq0 = await app.ev((c) => c.lastPick.getState().seq)
  const away = await at(m.tip + 8) // further in
  await page.mouse.move(tip.x + 3, tip.y, { steps: 3 })
  await page.mouse.move(tip.x, tip.y, { steps: 3 })
  // hovering the hidden arrow shows the grab cursor
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.vp canvas')!.style.cursor)).toBe('grab')
  await page.mouse.down()
  await page.mouse.move((tip.x + away.x) / 2, (tip.y + away.y) / 2, { steps: 8 })
  await page.mouse.move(away.x, away.y, { steps: 8 })
  await page.mouse.up()
  const after = await manipTip(app)
  expect(after.tip).toBeGreaterThan(9)
  // no body click went through on release
  expect(await app.ev((c) => c.lastPick.getState().seq)).toBe(seq0)
  // a plain press and release on the hidden arrow (no movement) is not a click on the face behind it either
  const now = await manipTip(app)
  const tip2 = await app.project(m.o[0] + m.d[0] * now.tip, m.o[1] + m.d[1] * now.tip, m.o[2] + m.d[2] * now.tip)
  await page.mouse.move(tip2.x, tip2.y, { steps: 3 })
  await page.mouse.down()
  await page.mouse.up()
  expect(await app.ev((c) => c.lastPick.getState().seq)).toBe(seq0)
  expect(await app.ev((c) => c.ui.getState().selection.length)).toBeGreaterThan(0)
})

// ---------------------------------------------------------------- view turn on start

const viewDir = (app: App) => app.ev((c) => { const e = c.three.camera.matrixWorld.elements; return [e[8], e[9], e[10]] as number[] })
const pose = (app: App) => app.page.evaluate(() => (window as any).__nav.pose() as { target: number[]; dist: number; q: number[] }) // eslint-disable-line
const angleTo = (a: number[], n: number[]) => (Math.acos(Math.min(1, Math.abs(a[0] * n[0] + a[1] * n[1] + a[2] * n[2]))) * 180) / Math.PI

const rect = [{ k: 'rect' as const, x0: -15, y0: -10, x1: 15, y1: 10 }]

test('Extrude turns a straight-on view to an angle, and leaves an angled view alone', async ({ app, page }) => {
  await app.open()
  await addSketch(app, XY, rect)
  // 1. looking straight down at the sketch plane
  await app.ev((c) => { c.runCommand('view.top'); c.runCommand('view.frame') })
  await app.cameraStable()
  expect(angleTo(await viewDir(app), [0, 0, 1])).toBeLessThan(1)
  const before = await pose(app)
  await app.ribbon('Extrude').click()
  await expect(title(app)).toHaveText('Extrude')
  await expect.poll(async () => angleTo(await viewDir(app), [0, 0, 1]), { timeout: 15000 }).toBeGreaterThan(25)
  await app.cameraStable()
  const turned = angleTo(await viewDir(app), [0, 0, 1])
  expect(turned).toBeGreaterThan(25)
  expect(turned).toBeLessThan(55)
  const after = await pose(app)
  // same target and zoom, only the angle changed
  for (let i = 0; i < 3; i++) expect(after.target[i]).toBeCloseTo(before.target[i], 3)
  expect(after.dist).toBeCloseTo(before.dist, 3)
  await app.shot('extrude-view-turned')
  await page.locator('.inspector-foot').getByRole('button', { name: 'Cancel' }).click()

  // 2. already at an angle: the view is not touched
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
  const q0 = (await pose(app)).q
  await app.ribbon('Extrude').click()
  await expect(title(app)).toHaveText('Extrude')
  await expect.poll(() => app.ev((c) => c.manip.getState().active)).toBe(true)
  await app.cameraStable()
  const q1 = (await pose(app)).q
  for (let i = 0; i < 4; i++) expect(q1[i]).toBeCloseTo(q0[i], 5)
})

// ---------------------------------------------------------------- Join / Cut follows the arrow

const TOP: Plane3 = { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] }
const operation = (app: App) => app.ev((c) => c.ui.getState().inspector.values.operation as string)
const distanceOf = (app: App) => app.ev((c) => c.ui.getState().inspector.values.distance as number)

/** Drag the arrow with the real mouse until its tip is at parameter `to` on its axis; returns the biggest jump of the tip (world mm) between mouse moves. */
async function dragArrow(app: App, to: number, steps = 14) {
  const { page } = app
  const m = await manipTip(app)
  const world = (t: number) => [m.o[0] + m.d[0] * t, m.o[1] + m.d[1] * t, m.o[2] + m.d[2] * t]
  const tipNow = (s: { o: number[]; d: number[]; tip: number }) => [s.o[0] + s.d[0] * s.tip, s.o[1] + s.d[1] * s.tip, s.o[2] + s.d[2] * s.tip]
  const a = await app.project(...(world(m.tip) as [number, number, number]))
  const b = await app.project(...(world(to) as [number, number, number]))
  await page.mouse.move(a.x + 4, a.y, { steps: 2 })
  await page.mouse.move(a.x, a.y, { steps: 2 })
  await page.mouse.down()
  let last = tipNow(m), jump = 0
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps)
    const cur = tipNow(await manipTip(app))
    jump = Math.max(jump, Math.hypot(cur[0] - last[0], cur[1] - last[1], cur[2] - last[2]))
    last = cur
  }
  await page.mouse.up()
  return jump
}

test('dragging the arrow into the body switches to Cut, and back out to Join', async ({ app }) => {
  await app.open()
  await addBox(app)
  await addSketch(app, TOP, rect)
  await home(app)
  await app.ribbon('Extrude').click()
  await expect(title(app)).toHaveText('Extrude')
  await expect.poll(() => app.ev((c) => c.manip.getState().active)).toBe(true)
  await app.cameraStable()
  expect(await operation(app)).toBe('join')
  await dragArrow(app, -6)
  await expect.poll(() => operation(app)).toBe('cut')
  expect(await distanceOf(app)).toBeLessThan(-4)
  await app.shot('extrude-auto-cut')
  await dragArrow(app, 7)
  await expect.poll(() => operation(app)).toBe('join')
  expect(await distanceOf(app)).toBeGreaterThan(5)
  // and the result is what the arrow said
  await dragArrow(app, -4)
  await expect.poll(() => operation(app)).toBe('cut')
  await app.ok()
  const f = (await app.features()).find((x) => x.type === 'extrude')!
  expect(f.state).toBe('ok')
  expect(f.params.operation).toBe('cut')
  const bb = await app.bbox()
  expect(bb.max[2]).toBeCloseTo(10, 3)
  expect(await app.tris()).toBeGreaterThan(12)
})

test('pushing a face in switches to Cut without the arrow flipping or jumping', async ({ app, page }) => {
  await app.open()
  await addBox(app)
  await extrudeTopFace(app)
  expect(await operation(app)).toBe('join')
  const jump = await dragArrow(app, -5, 16)
  await expect.poll(() => operation(app)).toBe('cut')
  // a face's Cut measures inwards: positive distance, and the arrow still sits 5 mm inside the top face
  expect(await distanceOf(app)).toBeGreaterThan(3)
  const m = await manipTip(app)
  expect(m.o[2] + m.d[2] * m.tip).toBeCloseTo(5, 0)
  expect(jump).toBeLessThan(3)
  // the arrow points inwards now: back out through the face is negative along it
  await dragArrow(app, -6, 16)
  await expect.poll(() => operation(app)).toBe('join')
  expect(await distanceOf(app)).toBeGreaterThan(3)
  // join again: the arrow points outwards, so in is negative
  await dragArrow(app, -4, 16)
  await expect.poll(() => operation(app)).toBe('cut')
  await app.ok()
  const f = (await app.features()).find((x) => x.type === 'extrude')!
  expect(f.state).toBe('ok')
  const bb = await app.bbox()
  expect(bb.max[2]).toBeCloseTo(6, 1)
  void page
})

test('an operation chosen in the dialog is not overridden by the arrow', async ({ app, page }) => {
  await app.open()
  await addBox(app)
  await addSketch(app, TOP, rect)
  await home(app)
  await app.ribbon('Extrude').click()
  await expect(title(app)).toHaveText('Extrude')
  await expect.poll(() => app.ev((c) => c.manip.getState().active)).toBe(true)
  await app.inspector().locator('.sel').first().click()
  await page.getByRole('option', { name: 'New body', exact: true }).click()
  const sel = app.inspector().locator('.sel').first()
  await expect(sel).toContainText('New body')
  await app.cameraStable()
  await dragArrow(app, -6)
  expect(await distanceOf(app)).toBeLessThan(-4)
  await expect(sel).toContainText('New body')
  await dragArrow(app, 8)
  await expect(sel).toContainText('New body')
  await app.ok()
  const f = (await app.features()).find((x) => x.type === 'extrude')!
  expect(f.params.operation).toBe('new')
})

// ---------------------------------------------------------------- Revolve angle handle

test('Revolve has a rotary handle: drag the knob round the axis, or type the angle', async ({ app, page }) => {
  await app.open()
  // a 10 x 10 profile against the sketch Y axis (world Z): spins about Z, starting out along +X
  await addSketch(app, XZ, [{ k: 'rect', x0: 0, y0: 0, x1: 10, y1: 10 }])
  await home(app)
  await app.ribbon('Revolve').click()
  await expect(title(app)).toHaveText('Revolve')
  await expect.poll(() => app.ev((c) => c.angleManip.getState().active)).toBe(true)
  const st = () => app.ev((c) => { const s = c.angleManip.getState(); return { o: s.origin as number[], a: s.axis as number[], s: s.start as number[], r: s.radius as number, angle: s.angle as number } })
  const g0 = await st()
  expect(g0.angle).toBe(360)
  expect(g0.r).toBeCloseTo(10, 3)
  await app.field('Angle', '90')
  await expect.poll(async () => (await st()).angle).toBe(90)
  // the knob sits on the end of the wedge the preview shows
  const knob = (angle: number) => {
    const rad = (angle * Math.PI) / 180
    const cr = [g0.a[1] * g0.s[2] - g0.a[2] * g0.s[1], g0.a[2] * g0.s[0] - g0.a[0] * g0.s[2], g0.a[0] * g0.s[1] - g0.a[1] * g0.s[0]]
    return [0, 1, 2].map((i) => g0.o[i] + g0.r * (Math.cos(rad) * g0.s[i] + Math.sin(rad) * cr[i])) as [number, number, number]
  }
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  const box = await app.ev((c) => {
    const p = c.preview.getState().items[0].mesh.positions
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]) }
    return { lo, hi }
  })
  const k90 = knob(90)
  for (let i = 0; i < 3; i++) { expect(k90[i]).toBeGreaterThan(box.lo[i] - 0.1); expect(k90[i]).toBeLessThan(box.hi[i] + 0.1) }
  // real mouse drag of the knob from 90 to 180 degrees
  const from = await app.project(...k90)
  const to = await app.project(...knob(180))
  const mid = await app.project(...knob(135))
  await page.mouse.move(from.x + 3, from.y + 3, { steps: 2 })
  await page.mouse.move(from.x, from.y, { steps: 2 })
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.vp canvas')!.style.cursor)).toBe('grab')
  await page.mouse.down()
  await page.mouse.move(mid.x, mid.y, { steps: 8 })
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  const a1 = (await st()).angle
  expect(Math.abs(a1 - 180)).toBeLessThan(4)
  // typing, as with the arrow
  await page.getByTestId('manip-value').click()
  await page.getByTestId('manip-input').fill('45')
  await page.getByTestId('manip-input').press('Enter')
  await expect(app.inspector()).toHaveCount(0)
  await app.idle()
  const f = (await app.features()).find((x) => x.type === 'revolve')!
  expect(f.state).toBe('ok')
  expect(f.params.angle).toBe(45)
})

// ---------------------------------------------------------------- Fillet: a face stands for its edges

test('Fillet with the Edge filter: clicking a face picks all of its edges, again lets them go', async ({ app, page }) => {
  await app.open()
  await addBox(app)
  await home(app)
  await app.ribbon('Fillet').first().click()
  await expect(title(app)).toHaveText('Fillet')
  await expect.poll(() => app.ev((c) => c.ui.getState().selectionFilter)).toBe('edge')
  const bb = await app.bbox()
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2
  const top = await app.project(cx, cy, bb.max[2])
  const edges = () => app.ev((c) => c.ui.getState().selection.filter((r: any) => r.kind === 'edge').length) // eslint-disable-line
  await page.mouse.move(top.x + 10, top.y + 4)
  await page.mouse.move(top.x, top.y, { steps: 4 })
  await page.mouse.click(top.x, top.y)
  await expect.poll(edges).toBe(4)
  expect(await app.ev((c) => c.ui.getState().selection.every((r: any) => r.kind === 'edge'))).toBe(true) // eslint-disable-line
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  // the side face adds its edges to those (the shared top edge stays): 4 + 3
  const side = await app.project(cx, bb.min[1], (bb.min[2] + bb.max[2]) / 2)
  await page.mouse.move(side.x, side.y, { steps: 4 })
  await page.mouse.click(side.x, side.y)
  await expect.poll(edges).toBe(7)
  // the top face again: all its edges are in already, so they go
  await page.mouse.move(top.x, top.y, { steps: 4 })
  await page.mouse.click(top.x, top.y)
  await expect.poll(edges).toBe(3)
  await page.mouse.move(side.x, side.y, { steps: 4 })
  await page.mouse.click(side.x, side.y)
  // only some of its edges were in: it completes them
  await expect.poll(edges).toBe(4)
  await page.mouse.click(side.x, side.y)
  await expect.poll(edges).toBe(0)
  await page.mouse.move(top.x, top.y, { steps: 4 })
  await page.mouse.click(top.x, top.y)
  await expect.poll(edges).toBe(4)
  await app.ok()
  const f = (await app.features()).find((x) => x.type === 'fillet')!
  expect(f.state).toBe('ok')
  expect(await app.tris()).toBeGreaterThan(12)
})
