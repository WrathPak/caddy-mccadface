import { test, expect, type App } from './helpers'
import {
  bodiesBox, circles, clickWorld, dim, dlg, esc2, fastHolePlate, fastPlate, hoverWorld, near, planeOf, projectFace, px, refEnts, sk, skCircle, skClick, skRect,
  sketchOnFace, sketchParam, tool, toLocal, userCircles, XY, type P3,
} from './solids-kit'

/* Fusion 360 parity: sketching on solids and Extrude. Reference: docs/fusion-parity/extrude-solids.md.
   Plate: 60 x 40 x 10, corner at the world origin, top face at z = 10. Hole plate: the same with a 10 mm hole at (20, 12).
   Gaps are written as the correct Fusion behaviour and marked test.fail(), so each flips to passing when it is fixed. */

const TOP: P3 = [5, 5, 10]
const HOLE: P3 = [20, 12, 10]

// ------------------------------------------------------------------------------------------------ sketch on a face

test('Sketch on a face: Sketch, then a click on the top face opens a sketch on it, turned square to the face', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  const pl = await planeOf(app)
  expect(pl.normal).toEqual([0, 0, 1])
  near(pl.origin[2], 10, 0.001)
  const m = await sk(app)
  expect(m.face).toContain('"kind":"face"')
  const dir = await app.ev((c) => { const e = c.three.camera.matrixWorld.elements; return [e[8], e[9], e[10]] })
  expect(dir[2]).toBeGreaterThan(0.99) // looking straight down at the face
})

test.fail('Sketch on a face: the face outer edges are projected into the new sketch at once, fixed', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  const m = await sk(app)
  const lines = refEnts(m).filter((e) => e.type === 'line')
  expect(lines).toHaveLength(4)
})

test.fail('Sketch on a face: the edges of a hole in the face are projected into the new sketch at once', async ({ app }) => {
  await app.open()
  await fastHolePlate(app)
  await sketchOnFace(app, TOP)
  const m = await sk(app)
  expect(refEnts(m).filter((e) => e.type === 'circle' || e.type === 'arc').length).toBeGreaterThan(0)
  expect(m.profiles.length).toBeGreaterThanOrEqual(2) // plate with the hole in it, and the hole itself
})

test.fail('Sketch on a face: the sketch origin is the world origin projected onto the face, so coordinates match the model', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  const pl = await planeOf(app)
  near(pl.origin[0], 0, 0.001)
  near(pl.origin[1], 0, 0.001)
  near(pl.origin[2], 10, 0.001)
})

test.fail('Sketch on a face: projected curves are drawn purple', async ({ app, page }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  await projectFace(app, TOP)
  await page.mouse.move(5, 5)
  await page.waitForTimeout(300)
  // the middle of the right edge of the plate
  const p = await px(app, [60, 20, 10])
  const buf = await page.screenshot({ clip: { x: p.x - 14, y: p.y - 14, width: 28, height: 28 } })
  const purple = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < d.length; i += 4) if (d[i] > 110 && d[i + 2] > 110 && d[i + 1] < d[i] - 40 && d[i + 1] < d[i + 2] - 40) return true
    return false
  }, buf.toString('base64'))
  expect(purple).toBe(true)
})

// ------------------------------------------------------------------------------------------------ Project

test('Project: the Project tool on the face under the sketch puts its edges in as fixed reference curves, and they bound profiles', async ({ app }) => {
  await app.open()
  await fastHolePlate(app)
  await sketchOnFace(app, TOP)
  await projectFace(app, TOP)
  const m = await sk(app)
  expect(refEnts(m).filter((e) => e.type === 'line')).toHaveLength(4)
  // the plate with the hole in it, and the hole as a region of its own
  expect(m.profiles.map((p) => p.holes).sort()).toEqual([0, 1])
  // a line across the plate from edge to edge splits the plate region
  const pl = await planeOf(app)
  const a = toLocal(pl, [10, 0, 10]), b = toLocal(pl, [10, 40, 10])
  await tool(app, 'Line')
  await skClick(app, a[0], a[1])
  await skClick(app, b[0], b[1])
  await esc2(app)
  expect((await sk(app)).profiles.length).toBe(3)
})

test.fail('Project: a projected hole is one circle (it has a diameter and a centre), not two half arcs', async ({ app }) => {
  await app.open()
  await fastHolePlate(app)
  await sketchOnFace(app, TOP)
  await projectFace(app, TOP)
  const m = await sk(app)
  expect(refEnts(m).filter((e) => e.type === 'circle')).toHaveLength(1)
})

test.fail('Project: P starts the Project tool', async ({ app, page }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  await page.mouse.move(700, 500)
  await page.keyboard.press('p')
  expect((await sk(app)).tool).toBe('project')
})

test.fail('Project: a side face of the body, edge on to the sketch, projects as a line', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  await tool(app, 'Project')
  await clickWorld(app, [30, 0, 5]) // the front face
  await expect.poll(async () => refEnts(await sk(app)).length, { timeout: 5000 }).toBeGreaterThan(0)
})

test.fail('Project: a click on a single body edge projects just that edge', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  await tool(app, 'Project')
  await hoverWorld(app, [30, 0.05, 10])
  await clickWorld(app, [30, 0.05, 10]) // right on the front top edge
  await expect.poll(async () => refEnts(await sk(app)).length, { timeout: 5000 }).toBeGreaterThan(0)
  expect(refEnts(await sk(app))).toHaveLength(1)
})

test.fail('Project: Intersect (curves where the sketch plane cuts a body) is in the sketch tools', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  await expect(app.page.getByRole('button', { name: /^Intersect/ }).first()).toBeVisible({ timeout: 3000 })
})

test.fail('Project: Include 3D Geometry is in the sketch tools', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  await expect(app.page.getByRole('button', { name: /Include 3D/ }).first()).toBeVisible({ timeout: 3000 })
})

// ------------------------------------------------------------------------------------------------ snaps, dimensions

test('Projected geometry: a circle centres on a projected hole, a circle snaps to an edge midpoint, a line starts on a projected corner', async ({ app }) => {
  await app.open()
  await fastHolePlate(app)
  await sketchOnFace(app, TOP)
  await projectFace(app, TOP)
  const pl = await planeOf(app)
  const refIds = (m: Awaited<ReturnType<typeof sk>>) => new Set(m.entities.filter((e) => e.ref).map((e) => e.id))
  // 1: a circle clicked on the hole centre shares it
  const h = toLocal(pl, HOLE)
  await skCircle(app, h[0], h[1], 16)
  let m = await sk(app)
  const c1 = circles(m).find((c) => !c.ref)!
  expect(m.constraints.some((k) => k.type === 'coincident' && k.refs.includes(c1.c) && k.refs.some((r: string) => refIds(m).has(r)))).toBe(true)
  // 2: the middle of the top edge
  const mid = toLocal(pl, [30, 40, 10])
  await skCircle(app, mid[0], mid[1], 4)
  m = await sk(app)
  const c2 = circles(m).find((c) => !c.ref && c.id !== c1.id)!
  expect(m.constraints.some((k) => k.type === 'midpoint' && k.refs.includes(c2.c) && k.refs.some((r: string) => refIds(m).has(r)))).toBe(true)
  // 3: a line from the corner
  const k0 = toLocal(pl, [0, 0, 10]), k1 = toLocal(pl, [15, 25, 10])
  await tool(app, 'Line')
  await skClick(app, k0[0], k0[1])
  await skClick(app, k1[0], k1[1])
  await esc2(app)
  m = await sk(app)
  const ln = m.entities.find((e) => e.type === 'line' && !e.ref)!
  expect(m.constraints.some((k) => k.type === 'coincident' && k.refs.includes(ln.p1) && k.refs.some((r: string) => refIds(m).has(r)))).toBe(true)
})

test('Projected geometry: a new circle can be dimensioned to a projected edge, and projected curves stay fixed', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  await projectFace(app, TOP)
  const pl = await planeOf(app)
  const c = toLocal(pl, [45, 20, 10]), edge = toLocal(pl, [0, 28, 10]), put = toLocal(pl, [20, 28, 10])
  await skCircle(app, c[0], c[1], 6)
  const before = await sk(app)
  await dim(app, [c, edge], put, '30')
  const m = await sk(app)
  const d = m.constraints.find((k) => k.type === 'distance')
  expect(d).toBeTruthy()
  expect(m.entities.some((e) => (e.id === d.refs[0] || e.id === d.refs[1]) && e.ref)).toBe(true)
  // the circle sits 30 from the left edge
  const circ = userCircles(m)[0]
  const cp = m.entities.find((e) => e.id === circ.c)
  near(cp.x - toLocal(pl, [0, 0, 10])[0], 30, 0.01)
  // projected corner points did not move
  const pts = (s: typeof m) => s.entities.filter((e) => e.ref && e.type === 'point').map((e) => [e.x, e.y])
  expect(pts(m)).toEqual(pts(before))
})

test.fail('Projected geometry: the diameter of a projected hole can be dimensioned (as a reference dimension)', async ({ app, page }) => {
  await app.open()
  await fastHolePlate(app)
  await sketchOnFace(app, TOP)
  await projectFace(app, TOP)
  const pl = await planeOf(app)
  const t = toLocal(pl, [20, 17, 10]) // top of the hole
  await page.keyboard.press('d')
  await skClick(app, t[0], t[1])
  await skClick(app, t[0] + 12, t[1] + 12)
  const input = page.locator('.sk-dim-input')
  await expect(input).toBeVisible({ timeout: 4000 })
  expect(parseFloat(await input.inputValue())).toBeCloseTo(10, 2) // 10 across, not a radius of 5
})

// ------------------------------------------------------------------------------------------------ attached, associative

test('Editing the extrude: a sketch on its top face follows the new height and the projected edges follow a taper', async ({ app, page }) => {
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  await projectFace(app, TOP)
  await app.finishSketch()
  const sketchId = (await app.features()).filter((f) => f.type === 'sketch')[1].id
  const ext = () => app.ev((c, id) => {
    const d = c.sketchData.getState().data[id]
    const xs = d.entities.filter((e: any) => e.ref && e.type === 'point').map((e: any) => e.x) // eslint-disable-line
    return { z: d.plane.origin[2], ents: d.entities.filter((e: any) => e.ref && e.type === 'line').length, w: Math.max(...xs) - Math.min(...xs) } // eslint-disable-line
  }, sketchId)
  const edit = async (label: string, v: string) => {
    await page.locator('.tl .chip').nth(1).dblclick()
    await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
    await app.field(label, v)
    await app.ok()
  }
  let s = await ext()
  expect(s.ents).toBe(4)
  near(s.w, 60, 0.01)
  await edit('Distance', '16')
  s = await ext()
  near(s.z, 16, 0.001) // still on the face, which moved up
  expect(s.ents).toBe(4)
  await edit('Taper angle', '5')
  s = await ext()
  expect(s.ents).toBe(4)
  expect(s.w).toBeLessThan(59) // the top face is narrower now; the projected edges moved with it
  expect((await app.features()).every((f) => f.state === 'ok')).toBe(true)
})

// ------------------------------------------------------------------------------------------------ profiles

test('Profiles: two regions picked in one Extrude', async ({ app }) => {
  await app.open()
  await app.ev((c, s) => c.doc.getState().addFeature('sketch', { sketch: s }), sketchParam(XY, [
    { k: 'rect', x0: 0, y0: 0, x1: 20, y1: 20 }, { k: 'rect', x0: 40, y0: 0, x1: 60, y1: 20 },
  ]))
  await app.idle()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [10, 10, 0])
  await clickWorld(app, [50, 10, 0])
  await expect.poll(async () => ((await dlg(app)).profiles as string[]).length).toBe(2)
  await app.field('Distance', '5')
  await app.ok()
  const bb = await bodiesBox(app)
  const vol = (await Promise.all(bb.map((b) => app.volume(b.id)))).reduce((a, b) => a + b, 0)
  near(vol, 2 * 400 * 5, 1)
})

test('Profiles: the face of a plate with a hole, picked in the viewport, extrudes with the hole left open', async ({ app }) => {
  await app.open()
  await fastHolePlate(app)
  const v0 = await app.volume()
  await app.ribbon('Extrude').click()
  await clickWorld(app, TOP)
  await expect.poll(async () => ((await dlg(app)).profiles as string[]).length).toBe(1)
  await app.field('Distance', '5')
  await app.ok()
  const bb = await bodiesBox(app)
  near(bb[0].max[2], 15, 0.01)
  near((await app.volume(bb[0].id)) - v0, (2400 - Math.PI * 25) * 5, 8)
})

// ------------------------------------------------------------------------------------------------ extrude: extents, start, operations

/** Open Extrude on the plate with a rectangle sketched on its top face. */
async function faceRectExtrude(app: App) {
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  const pl = await planeOf(app)
  const a = toLocal(pl, [10, 10, 10]), b = toLocal(pl, [25, 25, 10])
  await skRect(app, a[0], a[1], b[0], b[1])
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [17, 17, 10]) // the new rectangle (the plate's own sketch profile is inside the body)
  await expect.poll(async () => ((await dlg(app)).profiles as string[]).length).toBe(1)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1) // the live preview is up before anything is typed
}

test('Extrude: one side, symmetric, two sides, a negative distance, taper and a typed expression, edited from the timeline', async ({ app, page }) => {
  test.setTimeout(150000)
  await app.open()
  await fastPlate(app, 20, 20, 10)
  const edit = async (patch: Record<string, string>, extra?: () => Promise<void>) => {
    await page.locator('.tl .chip').nth(1).dblclick()
    await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
    if (extra) await extra()
    for (const [k, v] of Object.entries(patch)) await app.field(k, v)
    await app.ok()
    return (await bodiesBox(app))[0]
  }
  let b = (await bodiesBox(app))[0]
  near(b.min[2], 0); near(b.max[2], 10)
  b = await edit({}, async () => { await page.getByRole('radio', { name: 'Symmetric' }).click() })
  near(b.min[2], -5); near(b.max[2], 5)
  b = await edit({ 'Distance 2': '4' }, async () => { await page.getByRole('radio', { name: 'Two sides' }).click() })
  near(b.min[2], -4); near(b.max[2], 10)
  b = await edit({ Distance: '-10' }, async () => { await page.getByRole('radio', { name: 'One side' }).click() })
  near(b.min[2], -10); near(b.max[2], 0)
  b = await edit({ Distance: '10', 'Taper angle': '10' })
  near(b.min[2], 0); near(b.max[2], 10)
  expect(await app.volume()).toBeLessThan(4000 - 50)
  b = await edit({ 'Taper angle': '0', Distance: '5 * 3' })
  near(b.max[2], 15)
})

test('Extrude: from a face going up joins, a negative distance into the body switches to Cut by itself, New body is chosen by hand', async ({ app, page }) => {
  test.setTimeout(150000)
  await app.open()
  await faceRectExtrude(app)
  const op = () => app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Operation' }) }).innerText()
  await expect.poll(op).toContain('Join')
  const v0 = await app.volume()
  await app.field('Distance', '-3')
  await expect.poll(op).toContain('Cut')
  await app.ok()
  near(v0 - (await app.volume()), 15 * 15 * 3, 1)
  // New body on the same profile
  await app.ribbon('Extrude').click()
  await clickWorld(app, [17, 17, 10])
  await expect.poll(async () => ((await dlg(app)).profiles as string[]).length).toBe(1)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.field('Distance', '4')
  await app.inspector().locator('.sel').first().click()
  await page.getByRole('option', { name: 'New body', exact: true }).click()
  await app.ok()
  expect((await bodiesBox(app)).length).toBe(2)
})

test('Extrude: with several profiles from a face picked, a negative distance into the body switches to Cut by itself', async ({ app, page }) => {
  test.setTimeout(150000)
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, TOP)
  const pl = await planeOf(app)
  for (const [x0, x1] of [[10, 18], [30, 38]]) {
    const a = toLocal(pl, [x0, 10, 10]), b = toLocal(pl, [x1, 18, 10])
    await skRect(app, a[0], a[1], b[0], b[1])
  }
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [14, 14, 10])
  await clickWorld(app, [34, 14, 10])
  await expect.poll(async () => ((await dlg(app)).profiles as string[]).length).toBe(2)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.field('Distance', '-3')
  const op = () => app.inspector().locator('.field', { has: page.locator('.field-label', { hasText: 'Operation' }) }).innerText()
  await expect.poll(op, { timeout: 8000 }).toContain('Cut')
})

test('Extrude: the live preview shows while the dialog is open and the arrow in the view drags the distance', async ({ app, page }) => {
  await app.open()
  await faceRectExtrude(app)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  const m = await app.ev((c) => { const s = c.manips[0].getState(); return { active: s.active, o: s.origin as P3, d: s.dir as P3, tip: s.tip as number } })
  expect(m.active).toBe(true)
  const at = (t: number): P3 => [m.o[0] + m.d[0] * t, m.o[1] + m.d[1] * t, m.o[2] + m.d[2] * t]
  await app.cameraStable()
  const from = await px(app, at(m.tip)), to = await px(app, at(m.tip + 8))
  // wait for the grab cursor over the arrow, then drag it
  await expect.poll(async () => {
    await page.mouse.move(from.x + 3, from.y + 3, { steps: 2 })
    await page.mouse.move(from.x, from.y, { steps: 2 })
    return page.evaluate(() => [...document.querySelectorAll('canvas')].some((c) => c.style.cursor === 'grab'))
  }, { timeout: 20000 }).toBe(true)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  expect((await dlg(app)).distance as number).toBeGreaterThan(m.tip + 3)
})

test.fail('Extrude: Extent type All / Through All cuts through the whole body without a distance', async ({ app, page }) => {
  await app.open()
  await faceRectExtrude(app)
  await expect(app.inspector().getByText('Extent type', { exact: true })).toBeVisible({ timeout: 4000 })
  await page.getByText('Extent type', { exact: true }).click()
  await page.getByRole('option', { name: /All/ }).click()
  await app.ok()
  near(await app.volume(), 2400 * 10 - 15 * 15 * 10, 1)
})

test.fail('Extrude: Extent type To Object runs the extrude up to a picked face or body', async ({ app, page }) => {
  await app.open()
  await faceRectExtrude(app)
  await expect(app.inspector().getByText('Extent type', { exact: true })).toBeVisible({ timeout: 4000 })
  await page.getByText('Extent type', { exact: true }).click()
  await expect(page.getByRole('option', { name: /To Object/i })).toBeVisible({ timeout: 3000 })
})

test.fail('Extrude: Start can be Offset (the extrude begins a distance away from the profile plane)', async ({ app }) => {
  await app.open()
  await faceRectExtrude(app)
  await expect(app.inspector().getByText('Start', { exact: true })).toBeVisible({ timeout: 4000 })
  await expect(app.inspector().getByText(/Offset/).first()).toBeVisible({ timeout: 3000 })
})

test.fail('Extrude: Start can be From Object (the extrude begins at a picked face)', async ({ app }) => {
  await app.open()
  await faceRectExtrude(app)
  await expect(app.inspector().getByText('Start', { exact: true })).toBeVisible({ timeout: 4000 })
  await expect(app.inspector().getByText(/Object/).first()).toBeVisible({ timeout: 3000 })
})

// ------------------------------------------------------------------------------------------------ Press/Pull and Hole on a face

test('Press/Pull: with the top face selected first, a distance pushes it up', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await clickWorld(app, TOP)
  await expect.poll(() => app.ev((c) => c.ui.getState().selection.length)).toBe(1)
  await app.ribbon('Press/Pull').first().click()
  await expect.poll(async () => ((await dlg(app)).entities as string[]).length).toBe(1)
  await app.field('Distance', '4')
  await app.ok()
  near((await bodiesBox(app))[0].max[2], 14, 0.01)
})

test.fail('Press/Pull: start the tool, then click a face: the face goes into the dialog', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Press/Pull').first().click()
  await clickWorld(app, TOP)
  await expect.poll(() => app.ev((c) => c.ui.getState().selection.length)).toBe(1) // the click does select the face ...
  await expect.poll(async () => ((await dlg(app)).entities as string[]).length, { timeout: 8000 }).toBe(1) // ... but the dialog does not take it
})

test('Hole: a click on the top face of the plate places a hole there and it is drilled through', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  const v0 = await app.volume()
  await app.ribbon('Hole').first().click()
  await clickWorld(app, [40, 25, 10])
  await expect.poll(async () => ((await dlg(app)).places as string[]).length).toBe(1)
  await app.ok()
  expect(v0 - (await app.volume())).toBeGreaterThan(5) // the preset sizes the hole to the part (a small one here)
})

test.fail('Hole: a click right at the rim of an existing hole snaps to its centre (concentric)', async ({ app }) => {
  await app.open()
  await fastHolePlate(app)
  await app.ribbon('Hole').first().click()
  await clickWorld(app, [25.6, 12, 10]) // on the face, 0.6 mm outside the rim of the 10 mm hole
  await expect.poll(async () => ((await dlg(app)).places as string[]).length).toBe(1)
  const place = JSON.parse(((await dlg(app)).places as string[])[0])
  const face = JSON.parse(place.face)
  const w: P3 = [face.sig.centroid[0] + place.u, face.sig.centroid[1] + place.v, 10]
  near(Math.hypot(w[0] - HOLE[0], w[1] - HOLE[1]), 0, 0.01)
})
