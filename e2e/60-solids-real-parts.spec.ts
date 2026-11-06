import { test, expect, type App } from './helpers'
import {
  bodiesBox, clickWorld, dim, dlg, near, planeOf, sk, skCircle, sketchOnFace, toLocal, type P3,
} from './solids-kit'

/* Real parts a Fusion user makes on solids, built from a blank document with the mouse and keyboard only (typed values are keystrokes).
   The Fusion way: a sketch on a face has the face's edges projected in at once (no Project step), and a cut through the whole plate
   uses Extent: All instead of a depth typed past the plate. */

type Box = { min: P3; max: P3 }
const mid = (b: Box): P3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]]

/** Blank document: rectangle on XY (typed width and height), Finish Sketch, Extrude with a typed height. */
async function plate(app: App, w: number, h: number, d: number): Promise<Box> {
  await app.sketchRect('XY', w, h)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await app.field('Distance', String(d))
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
  const b = (await bodiesBox(app))[0]
  near(b.max[2] - b.min[2], d, 0.01)
  return b as Box
}
const dist = (app: App, c: [number, number], onEdge: [number, number], at: [number, number], v: number) => dim(app, [c, onEdge], at, String(v))

/** Sketch on the top face (its edges are projected in already, so they can be dimensioned to). Returns the plane and the plate's local box. */
async function faceSketch(app: App, b: Box) {
  await sketchOnFace(app, mid(b))
  await expect.poll(async () => (await sk(app)).entities.filter((e) => e.ref && e.type === 'line').length).toBe(4)
  const pl = await planeOf(app)
  const lo = toLocal(pl, [b.min[0], b.min[1], b.max[2]]), hi = toLocal(pl, [b.max[0], b.max[1], b.max[2]])
  return { pl, lo, hi }
}
const circlesOf = async (app: App) => (await sk(app)).entities.filter((e) => e.type === 'circle' && !e.ref)

/** Extrude dialog with a typed distance; the caller picks profiles first. */
async function extrudeDialog(app: App, profiles: P3[], distance: string) {
  await app.ribbon('Extrude').click()
  // the first pick makes the dialog turn the view square to the profiles: let it finish before the next click or the pixel is stale
  await clickWorld(app, profiles[0])
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.cameraStable()
  for (const p of profiles.slice(1)) await clickWorld(app, p)
  expect(((await dlg(app)).profiles as string[]).every((r) => r.startsWith('prof:'))).toBe(true)
  await expect.poll(async () => ((await dlg(app)).profiles as string[]).length).toBe(profiles.length)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1) // the live preview is up before the distance is typed
  await app.field('Distance', distance)
}

/** Same, but with Extent: All (a cut through everything, no depth to type). */
async function extrudeAll(app: App, profiles: P3[]) {
  await app.ribbon('Extrude').click()
  await clickWorld(app, profiles[0])
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.cameraStable()
  for (const p of profiles.slice(1)) await clickWorld(app, p)
  await expect.poll(async () => ((await dlg(app)).profiles as string[]).length).toBe(profiles.length)
  await app.inspector().locator('.field', { has: app.page.locator('.field-label', { hasText: 'Extent type' }) }).locator('.sel').first().click()
  await app.page.getByRole('option', { name: /^All$/ }).click()
}


/** Blank document: rectangle 60 x 40 with a 10 mm circle in its middle in one sketch, the plate region extruded 8 (so the plate has a through hole). */
async function holePlate(app: App): Promise<Box> {
  await app.sketchRect('XY', 60, 40)
  const m = await sk(app)
  const xs = m.entities.filter((e) => e.type === 'point').map((e) => e.x), ys = m.entities.filter((e) => e.type === 'point').map((e) => e.y)
  const x0 = Math.min(...xs), y0 = Math.min(...ys)
  await skCircle(app, x0 + 30, y0 + 20, 10)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [x0 + 3, y0 + 3, 0]) // the plate region, which has the hole in it
  await app.field('Distance', '8')
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
  const b = (await bodiesBox(app))[0] as Box
  near(b.max[2], 8, 0.01)
  return b
}

/** The plate with the boss: used by the boss part and the timeline edit. Returns the plate box. */
async function plateWithBoss(app: App): Promise<{ b: Box; sketchId: string }> {
  const b = await plate(app, 80, 50, 10)
  const { pl, lo } = await faceSketch(app, b)
  // the boss in the middle of the 80 x 50 plate: 40 from the left edge, 25 up from the bottom edge (the middle is not the sketch origin any more:
  // the origin is the world origin, the corner of the plate)
  const c: [number, number] = [lo[0] + 40, lo[1] + 25]
  await skCircle(app, c[0], c[1], 20)
  await dist(app, c, [lo[0], lo[1] + 40], [lo[0] + 15, lo[1] + 44], 40)
  await dist(app, c, [lo[0] + 60, lo[1]], [lo[0] + 62, lo[1] + 8], 25)
  const m = await sk(app)
  expect(m.dof).toBe(0)
  await app.finishSketch()
  const bossWorld: P3 = [pl.origin[0] + c[0], pl.origin[1] + c[1], b.max[2]]
  await extrudeDialog(app, [bossWorld], '15')
  await app.ok()
  const sketchId = (await app.features()).filter((f) => f.type === 'sketch')[1].id
  return { b, sketchId }
}

test('Mounting plate: four holes dimensioned to the projected plate edges, cut through the plate', async ({ app, page }) => {
  test.setTimeout(300000)
  await app.open()
  const b = await plate(app, 80, 50, 8)
  const v0 = await app.volume()
  const { pl, lo } = await faceSketch(app, b)
  const spots: [number, number][] = [[10, 10], [70, 10], [10, 40], [70, 40]]
  for (const [x, y] of spots) {
    const c: [number, number] = [lo[0] + x, lo[1] + y]
    await skCircle(app, c[0], c[1], 6)
    // along from the left edge, up from the bottom edge (each dimension to the projected plate edge)
    await dist(app, c, [lo[0], lo[1] + y + 6], [lo[0] + x / 2, lo[1] + y + 8], x)
    await dist(app, c, [lo[0] + x + 5, lo[1]], [lo[0] + x + 8, lo[1] + y / 2], y)
  }
  const m = await sk(app)
  expect(m.entities.filter((e) => e.type === 'circle' && !e.ref)).toHaveLength(4)
  expect(m.dof).toBe(0)
  await app.finishSketch()
  // cut the four holes: a click in each, a negative distance into the plate (Cut is chosen by itself)
  const discs: P3[] = spots.map(([x, y]) => [pl.origin[0] + lo[0] + x, pl.origin[1] + lo[1] + y, b.max[2]] as P3)
  await extrudeAll(app, discs) // Extent: All, as in Fusion: through the whole plate, going into it by itself
  await expect(app.inspector().locator('.field', { hasText: 'Operation' })).toContainText('Cut')
  await app.ok()
  near(v0 - (await app.volume()), 4 * Math.PI * 9 * 8, 3)
  expect((await bodiesBox(app))).toHaveLength(1)
  expect((await app.features()).every((f) => f.state === 'ok')).toBe(true)
})

test('Plate with a boss: a circle dimensioned to the projected edges, extruded up joined to the plate', async ({ app }) => {
  test.setTimeout(240000)
  await app.open()
  const v0 = 0
  const { b } = await plateWithBoss(app)
  void v0
  const bodies = await bodiesBox(app)
  expect(bodies).toHaveLength(1)
  near(bodies[0].max[2], b.max[2] + 15, 0.01)
  near(await app.volume(), 80 * 50 * 10 + Math.PI * 100 * 15, 8)
  expect((await app.features()).map((f) => [f.type, f.state])).toEqual([['sketch', 'ok'], ['extrude', 'ok'], ['sketch', 'ok'], ['extrude', 'ok']])
})

test('Counterbore: a circle on the projected through hole, cut 3 deep', async ({ app, page }) => {
  test.setTimeout(240000)
  await app.open()
  const b = await holePlate(app)
  const v0 = await app.volume()
  await sketchOnFace(app, [b.min[0] + 3, b.min[1] + 3, b.max[2]])
  const pl = await planeOf(app)
  // the hole is in the middle of the plate: its centre in the sketch
  const hole = toLocal(pl, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
  await skCircle(app, hole[0], hole[1], 16)
  const m = await sk(app)
  const mine = m.entities.find((e) => e.type === 'circle' && !e.ref)!
  const ctr = m.entities.find((e) => e.id === mine.c)
  near(ctr.x, hole[0], 0.05)
  near(ctr.y, hole[1], 0.05)
  // concentric: the circle's centre is tied to the hole's centre, not just near it
  expect(m.constraints.some((k) => k.type === 'coincident' && k.refs.includes(mine.c) && m.entities.some((e) => e.ref && k.refs.includes(e.id)))).toBe(true)
  await app.finishSketch()
  // the 16 mm disc: the ring between the hole and the circle is the region to cut. Pick it (a click between hole and circle edge)
  await extrudeDialog(app, [[(b.min[0] + b.max[0]) / 2 + 6.5, (b.min[1] + b.max[1]) / 2, b.max[2]]], '-3')
  await expect(app.inspector().locator('.field', { hasText: 'Operation' })).toContainText('Cut')
  await app.ok()
  near(v0 - (await app.volume()), Math.PI * (64 - 25) * 3, 4)
  void page
})

test('Hole region: the region inside the hole loop of a face extruded up as a new body', async ({ app, page }) => {
  test.setTimeout(240000)
  await app.open()
  const b = await holePlate(app)
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2
  await sketchOnFace(app, [b.min[0] + 3, b.min[1] + 3, b.max[2]])
  await app.finishSketch()
  await extrudeDialog(app, [[cx, cy, b.max[2]]], '5')
  await app.inspector().locator('.sel').first().click()
  await page.getByRole('option', { name: 'New body', exact: true }).click()
  await app.ok()
  const bodies = await bodiesBox(app)
  expect(bodies).toHaveLength(2)
  const disc = bodies.find((x) => x.max[2] > b.max[2] + 1)!
  near(disc.max[2] - disc.min[2], 5, 0.05)
  near(disc.max[0] - disc.min[0], 10, 0.1)
  near((disc.min[0] + disc.max[0]) / 2, cx, 0.1)
  expect((await app.features()).every((f) => f.state === 'ok')).toBe(true)
})

test('Timeline: changing the first extrude height moves the boss sketch and the boss with it', async ({ app, page }) => {
  test.setTimeout(300000)
  await app.open()
  const { b, sketchId } = await plateWithBoss(app)
  const before = await bodiesBox(app)
  near(before[0].max[2], b.max[2] + 15, 0.01)
  await page.locator('.tl .chip').nth(1).dblclick() // Extrude1
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  await app.field('Distance', '16')
  await app.ok()
  const feats = await app.features()
  expect(feats.map((f) => f.state)).toEqual(['ok', 'ok', 'ok', 'ok'])
  const z = await app.ev((c, id) => c.sketchData.getState().data[id].plane.origin[2], sketchId)
  near(z, 16, 0.001) // the boss sketch moved up with the plate's top face
  const after = (await bodiesBox(app))
  expect(after).toHaveLength(1)
  near(after[0].max[2], 31, 0.02)
  // the circle kept its dimensions to the (moved) projected edges: the boss is still in the middle, 40 from the left edge
  const d = await app.ev((c, id) => {
    const s = c.sketchData.getState().data[id]
    const circ = s.entities.find((e: any) => e.type === 'circle' && !e.ref) // eslint-disable-line
    const cp = s.entities.find((e: any) => e.id === circ.c) // eslint-disable-line
    return { x: cp.x + s.plane.origin[0], y: cp.y + s.plane.origin[1], r: circ.r }
  }, sketchId)
  near(d.x - b.min[0], 40, 0.05)
  near(d.y - b.min[1], 25, 0.05)
  near(d.r, 10, 0.001)
})
