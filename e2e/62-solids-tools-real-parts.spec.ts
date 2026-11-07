import { test, expect, XZ, type App } from './helpers'
import {
  addSketch, bodiesBox, clickWorld, dlg, esc2, near, openSketch, planeOf, relNear, selection, settle, shiftClickWorld, skCircle, skClick, skRect, sk, sketchOnFace, tool, totalVol,
  toLocal, type P3,
} from './solids-kit'

/* Real parts a Fusion user makes with the Solid tab tools beyond Extrude, built from a blank document with the mouse and keyboard.
   Workarounds are marked WORKAROUND in the comments and collected in docs/fusion-parity/solids.md. */

/** Rectangle on XY (typed width and height from the sketch tool), Finish Sketch, Extrude a typed distance. */
async function plate(app: App, w: number, h: number, d: number) {
  await app.sketchRect('XY', w, h)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await app.field('Distance', String(d))
  await app.ok()
  await settle(app)
  return (await bodiesBox(app))[0]
}
const ok = async (app: App) => expect((await app.features()).map((f) => `${f.type}: ${f.error ?? f.state}`).filter((s) => !/: (ok|warning)$/.test(s)), 'every step is ok').toEqual([])
/** Select the last step in the timeline, start Pattern, and make sure it repeats that feature (a face left selected makes it start in Faces mode). */
async function patternLastFeature(app: App) {
  await app.page.keyboard.press('Escape')
  await app.page.keyboard.press('Escape')
  await app.page.locator('.tl .chip').last().click()
  await app.ribbon('Pattern').first().click()
  if ((await dlg(app)).source !== 'features') {
    await app.inspector().getByText('Features', { exact: true }).first().click()
    await app.page.locator('.tl .chip').last().click()
  }
  expect(((await dlg(app)).features as string[]).length).toBe(1)
}
const mid = (b: { min: number[]; max: number[] }): P3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]]

// ------------------------------------------------------------------------------------------------ 1 enclosure

test('Enclosure: a box filleted on its top edges, shelled open at the top, with a lid that has a lip', async ({ app }) => {
  test.setTimeout(400000)
  await app.open()
  const b = await plate(app, 80, 50, 30)
  const x0 = b.min[0], y0 = b.min[1]
  // WORKAROUND: Fusion order is fillet the top edges, then shell. Here that gives a wrong body (about three times the wall material, see 61 "Shell: after a fillet on the top edges ...").
  // So: shell first (the top face goes, 2 mm walls), then fillet the outer rim edges (click an edge each).
  await app.ribbon('Shell').first().click()
  await clickWorld(app, mid(b))
  await app.field('Thickness', '2')
  await app.ok()
  await ok(app)
  const vS = await totalVol(app)
  relNear(vS, 80 * 50 * 30 - 76 * 46 * 28, 0.01)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [x0 + 40, y0, b.max[2]])
  await clickWorld(app, [x0 + 80, y0 + 25, b.max[2]])
  await expect.poll(async () => (await selection(app)).length).toBeGreaterThan(0)
  await app.field('Radius', '1')
  await app.ok()
  await ok(app)
  expect(await totalVol(app)).toBeLessThan(vS)
  // lid: an offset plane 5 above the box top. The lip first (a rectangle 4 mm in from the box edge, 2 mm down from the plane, a new body), then the lid (a full rectangle, 3 up, joined to the lip).
  // WORKAROUND: the lip is drawn and extruded first. Two sketches on one plane overlap, and a click in the middle picks the bigger, earlier profile (the lid), so the inner one could not be picked afterwards.
  await app.ribbon('Offset Plane').first().click() // base XY (the default) 35 up: 5 above the box top
  await app.field('Distance', '35')
  await app.ok()
  const planeName = (await app.features()).at(-1)!.name
  const planeRow = app.page.locator('.tree-row', { hasText: planeName }).first()
  const planeSketch = async () => {
    await app.ribbon('Sketch').first().click()
    await planeRow.click()
    await expect(app.page.locator('.sk-bar')).toBeVisible()
    await app.ev((c) => c.ui.setState({ snap: false }))
    await app.cameraStable()
  }
  await planeSketch()
  const pl = await planeOf(app)
  expect(pl.origin[2]).toBeGreaterThan(b.max[2] + 4.9)
  const lo = toLocal(pl, [x0, y0, pl.origin[2]])
  await skRect(app, lo[0] + 4, lo[1] + 4, lo[0] + 76, lo[1] + 46)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [x0 + 40, y0 + 25, pl.origin[2]])
  await app.field('Distance', '-2')
  await app.inspector().locator('.field', { has: app.page.locator('.field-label', { hasText: 'Operation' }) }).locator('.sel').first().click()
  await app.page.getByRole('option', { name: 'New body', exact: true }).click()
  await app.ok()
  expect((await bodiesBox(app)).length).toBe(2)
  await planeSketch()
  await skRect(app, lo[0], lo[1], lo[0] + 80, lo[1] + 50)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [x0 + 2, y0 + 2, pl.origin[2]])
  await app.field('Distance', '3')
  await app.ok()
  await ok(app)
  const bs = await bodiesBox(app)
  expect(bs.length).toBe(2) // the box, and the lid with its lip as one body
  const lid = bs.find((x) => x.max[2] > b.max[2] + 4)!
  near(lid.max[2], 38, 0.1)
  near(lid.min[2], 33, 0.1)
})

// ------------------------------------------------------------------------------------------------ 2 knob

test('Knob: a revolved profile with 12 grooves from one cut and a circular pattern', async ({ app }) => {
  test.fail() // GAP: the single groove cut removes 18 mm3 (a half circle of r 1 over 14 mm, with a "warning" state on the step) but the circular pattern of that cut removes 3834 mm3, about 320 per copy: the copies are much wider than the original
  test.setTimeout(400000)
  await app.open()
  // profile drawn with the Line tool on the XZ plane: a skirt 18 radius 6 tall and a neck 14 radius up to 20
  await openSketch(app, 'XZ')
  await tool(app, 'Line')
  const pts: [number, number][] = [[0, 0], [18, 0], [18, 6], [14, 6], [14, 20], [0, 20], [0, 0]]
  for (const [x, y] of pts) await skClick(app, x, y)
  await app.page.keyboard.press('Escape')
  await app.page.keyboard.press('Escape')
  await expect.poll(() => app.ev((c) => c.sketch.getState().profiles.length)).toBe(1)
  await app.finishSketch()
  await app.ribbon('Revolve').first().click()
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  await settle(app)
  const v0 = await totalVol(app)
  relNear(v0, Math.PI * (18 * 18 * 6 + 14 * 14 * 14), 0.02)
  // a groove: a 2 mm circle on the top face at the neck edge, cut down through the neck
  await sketchOnFace(app, [3, 3, 20])
  const pl = await planeOf(app)
  const c = toLocal(pl, [14, 0, 20])
  await skCircle(app, c[0], c[1], 2)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [14, 0, 20])
  await app.field('Distance', '-14')
  await expect(app.inspector().locator('.field', { hasText: 'Operation' })).toContainText('Cut')
  await app.ok()
  const v1 = await totalVol(app)
  expect(v1).toBeLessThan(v0)
  // pattern the cut round the Z axis: select its step in the timeline first
  await patternLastFeature(app)
  await app.inspector().getByText('Circular', { exact: true }).click()
  await app.field('Quantity', '12')
  await app.ok()
  await ok(app)
  const v12 = await totalVol(app)
  relNear(v0 - v12, 12 * (v0 - v1), 0.08) // twelve grooves
})

// ------------------------------------------------------------------------------------------------ 3 bracket

test('Bracket: base and wall, two counterbored holes, a chamfer, and a rib (no Rib tool: a triangle extruded both ways)', async ({ app }) => {
  test.setTimeout(500000)
  await app.open()
  const b = await plate(app, 60, 40, 5)
  const x0 = b.min[0], y0 = b.min[1]
  // the wall: a rectangle along the back edge of the top face
  await sketchOnFace(app, mid(b))
  const pl = await planeOf(app)
  const lo = toLocal(pl, [x0, y0, b.max[2]])
  await skRect(app, lo[0] + 5, lo[1] + 32, lo[0] + 55, lo[1] + 36)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [x0 + 30, y0 + 34, b.max[2]])
  await app.field('Distance', '30')
  await app.ok()
  await settle(app)
  const vWall = await totalVol(app)
  relNear(vWall, 60 * 40 * 5 + 50 * 4 * 30, 0.01)
  // two counterbored holes in the base
  await app.ribbon('Hole').first().click()
  for (const x of [15, 45]) await clickWorld(app, [x0 + x, y0 + 15, b.max[2]])
  await expect.poll(() => app.ev((c) => c.markers.getState().items.length)).toBe(2)
  await app.inspector().getByText('Counterbore', { exact: true }).click()
  await app.field('Diameter', '5')
  await app.field('Counterbore diameter', '9')
  await app.field('Counterbore depth', '3')
  await app.inspector().getByText('Through all', { exact: true }).click()
  await app.ok()
  const vH = await totalVol(app)
  relNear(vWall - vH, 2 * Math.PI * (2.5 ** 2 * 2 + 4.5 ** 2 * 3), 0.05)
  // WORKAROUND: no Rib tool. A triangle on a plane through the middle (Offset Plane from YZ), extruded symmetric 4 mm, joined
  await app.showPlane('YZ')
  await app.ribbon('Offset Plane').first().click()
  await app.page.locator('.tree-row', { hasText: 'YZ plane' }).first().click()
  await app.field('Distance', '30')
  await app.ok()
  const row = app.page.locator('.tree-row', { hasText: (await app.features()).at(-1)!.name }).first()
  await app.ribbon('Sketch').first().click()
  await row.click()
  await expect(app.page.locator('.sk-bar')).toBeVisible()
  await app.ev((c) => c.ui.setState({ snap: false }))
  await app.cameraStable()
  const rp = await planeOf(app)
  const a = toLocal(rp, [30, y0 + 32, b.max[2]]), bb = toLocal(rp, [30, y0 + 32, b.max[2] + 20]), cc = toLocal(rp, [30, y0 + 16, b.max[2]])
  await tool(app, 'Line')
  for (const p of [a, bb, cc, a]) await skClick(app, p[0], p[1])
  await app.page.keyboard.press('Escape')
  await app.page.keyboard.press('Escape')
  await expect.poll(() => app.ev((c) => c.sketch.getState().profiles.length)).toBeGreaterThan(0)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [30, y0 + 28, b.max[2] + 3])
  await app.field('Distance', '2')
  const sym = app.inspector().getByText('Symmetric', { exact: true })
  if (await sym.count()) await sym.first().click()
  await app.ok()
  const vR = await totalVol(app)
  expect(vR).toBeGreaterThan(vH + 100) // the rib added material
  // chamfer the top edge of the wall
  await app.ribbon('Chamfer').first().click()
  await clickWorld(app, [x0 + 10, y0 + 32, b.max[2] + 30])
  await expect.poll(async () => (await selection(app)).length).toBeGreaterThan(0)
  await app.field('Distance', '2')
  await app.ok()
  await ok(app)
  expect(await totalVol(app)).toBeLessThan(vR)
})

// ------------------------------------------------------------------------------------------------ 4 handle

test('Handle: a circle swept along an arc', async ({ app }) => {
  test.setTimeout(150000)
  await app.open()
  // profile: a 10 mm circle on XY at the origin, drawn with the Circle tool
  await openSketch(app, 'XY')
  await skCircle(app, 0, 0, 10)
  await app.finishSketch()
  // WORKAROUND: the arc path is added without the UI (Arc tool gestures are the Sketch pass's job); it is an upright half circle of radius 20 on XZ that starts at the origin
  await addSketch(app, XZ, [{ k: 'arc', c: [20, 0], s: [40, 0], e: [0, 0] }])
  await settle(app)
  await app.ribbon('Sweep').first().click()
  await clickWorld(app, [20, 0, 20])
  await expect.poll(async () => ((await dlg(app)).path as string[]).length).toBe(1)
  await app.ok()
  await ok(app)
  relNear(await totalVol(app), Math.PI * 25 * Math.PI * 20, 0.03)
})

// ------------------------------------------------------------------------------------------------ 5 flange

test('Flange: a ring, one bolt hole, a circular pattern of six', async ({ app }) => {
  test.setTimeout(400000)
  await app.open()
  await openSketch(app, 'XY')
  await skCircle(app, 0, 0, 100)
  await skCircle(app, 0, 0, 30)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [40, 0, 0]) // the ring between the two circles
  await app.field('Distance', '8')
  await app.ok()
  await settle(app)
  const v0 = await totalVol(app)
  relNear(v0, Math.PI * (2500 - 225) * 8, 0.01)
  await app.ribbon('Hole').first().click()
  await clickWorld(app, [35, 0, 8])
  await expect.poll(() => app.ev((c) => c.markers.getState().items.length)).toBe(1)
  await app.field('Diameter', '6')
  await app.inspector().getByText('Through all', { exact: true }).click()
  await app.ok()
  const v1 = await totalVol(app)
  relNear(v0 - v1, Math.PI * 9 * 8, 0.05)
  await patternLastFeature(app)
  await app.inspector().getByText('Circular', { exact: true }).click()
  await app.field('Quantity', '6')
  await app.ok()
  await ok(app)
  relNear(v0 - (await totalVol(app)), 6 * (v0 - v1), 0.05)
  void shiftClickWorld
})
