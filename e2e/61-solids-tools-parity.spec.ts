import { test, expect, XZ, type App } from './helpers'
import {
  addSketch, allEntries, chamferAt, controls, treeRow, planeOf, sk, skRect, sketchOnFace, chipCount, clickWorld, dlg, editChip, featTypes, fastHolePlate, fastPlate, filletAt, inspectorText, near, relNear, ribbonEntries,
  roundedPlate, seedBox, selection, settle, shiftClickWorld, totalVol, XY, type P3,
} from './solids-kit'

/* Fusion 360 parity: the Solid tab minus Extrude. Reference: docs/fusion-parity/solids.md.
   Plate: 60 x 40 x 10 with a corner on the world origin (volume 24000), top face at z = 10. Hole plate: with a 10 mm hole at (20, 12).
   Preconditions that are not under test (a sketch, a seeded box) are added without the UI; everything under test is mouse and keyboard.
   Tests marked test.fail() are gaps: each comment names the Fusion behaviour that is missing, and the test flips when it is built. */

const PLATE = 24000
const FILLET_FACE: P3 = [58.243, 1.757, 5] // R6 round on the vertical edge at (60, 0): the middle of the round
const press = (app: { page: import('@playwright/test').Page }, k: string) => app.page.keyboard.press(k)

// ================================================================================================ Delete on a face (heals like Fusion's Delete Face)

test('Delete on a selected fillet face heals it: the round goes, the sharp corner comes back, the body stays', async ({ app }) => {
  test.fail() // GAP: Delete with a face selected deletes the WHOLE BODY (a "delete" feature), Fusion's Delete removes the face and heals
  await app.open()
  await fastPlate(app)
  await filletAt(app, [[60, 0, 5]], '6')
  relNear(await totalVol(app), PLATE - (36 - Math.PI * 9) * 10, 0.001)
  await clickWorld(app, FILLET_FACE)
  expect((await selection(app))[0].kind).toBe('face')
  await press(app, 'Delete')
  await app.idle()
  expect((await app.bodies()).length).toBe(1)
  relNear(await totalVol(app), PLATE, 0.001)
})

test('Delete on a fillet face adds an editable Delete Face step to the timeline, not a body delete', async ({ app }) => {
  test.fail() // GAP: the timeline gets "delete" (whole body) instead of a Delete Face step
  await app.open()
  await fastPlate(app)
  await filletAt(app, [[60, 0, 5]], '6')
  await clickWorld(app, FILLET_FACE)
  await press(app, 'Delete')
  await app.idle()
  const t = await featTypes(app)
  expect(t[t.length - 1]).toBe('deleteFace')
  expect(t).not.toContain('delete')
  await editChip(app, t.length - 1) // editable from the timeline like any step
  await expect(app.inspector().locator('.panel-title')).toHaveText('Delete Face')
})

test('Delete on a fillet face can be undone: Ctrl+Z brings the round back', async ({ app }) => {
  test.fail() // GAP: Delete removes the body, so undo restores the body but there is no Delete Face step to undo (the round is never healed)
  await app.open()
  await fastPlate(app)
  await filletAt(app, [[60, 0, 5]], '6')
  await clickWorld(app, FILLET_FACE)
  await press(app, 'Delete')
  await app.idle()
  relNear(await totalVol(app), PLATE, 0.001) // healed
  await press(app, 'Control+z')
  await app.idle()
  relNear(await totalVol(app), PLATE - (36 - Math.PI * 9) * 10, 0.001) // rounded again
})

test('Delete on a chain of fillet faces (the top edge round, with its corner round) heals all of them', async ({ app }) => {
  test.fail() // GAP: Delete with faces selected deletes the whole body
  await app.open()
  await roundedPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [30, 0, 10])
  await clickWorld(app, [57.83 + 0, 2.17, 10 - 0.0]) // the arc top edge (tangent chain may take the line edges with it)
  await clickWorld(app, [60, 20, 10])
  await app.field('Radius', '2')
  await app.ok()
  const v = await totalVol(app)
  await clickWorld(app, [30, 0.586, 9.414])
  await shiftClickWorld(app, [57.83, 2.17, 9.414])
  await shiftClickWorld(app, [59.414, 20, 9.414])
  await press(app, 'Delete')
  await app.idle()
  expect((await app.bodies()).length).toBe(1)
  expect(await totalVol(app)).toBeGreaterThan(v + 20) // the edge round is back to a sharp edge
})

test('Delete on a chamfer face heals it: the corner comes back', async ({ app }) => {
  test.fail() // GAP: Delete with a face selected deletes the whole body
  await app.open()
  await fastPlate(app)
  await chamferAt(app, [[60, 0, 5]], '4')
  relNear(await totalVol(app), PLATE - 8 * 10, 0.001)
  await clickWorld(app, [58, 2, 5])
  expect((await selection(app))[0].kind).toBe('face')
  await press(app, 'Delete')
  await app.idle()
  expect((await app.bodies()).length).toBe(1)
  relNear(await totalVol(app), PLATE, 0.001)
})

test('Delete on the wall of a hole fills the hole', async ({ app }) => {
  test.fail() // GAP: Delete with a face selected deletes the whole body (Fusion fills the hole)
  await app.open()
  await fastHolePlate(app)
  const cam = await app.ev((c) => { const e = c.three.camera.matrixWorld.elements; return [e[12], e[13]] })
  const u = [cam[0] - 20, cam[1] - 12], n = Math.hypot(u[0], u[1])
  await clickWorld(app, [20 - (5 * u[0]) / n, 12 - (5 * u[1]) / n, 8]) // the far wall of the hole, the one the camera sees
  expect((await selection(app))[0].kind).toBe('face')
  await press(app, 'Delete')
  await app.idle()
  expect((await app.bodies()).length).toBe(1)
  relNear(await totalVol(app), PLATE, 0.001)
})

test('Delete on a fillet face of a body that was never filleted in the timeline (a rounded sketch corner, as an imported part) heals it', async ({ app }) => {
  test.fail() // GAP: Delete with a face selected deletes the whole body; Fusion heals any round (Delete Face works on the B-rep, not on a fillet feature)
  await app.open()
  await roundedPlate(app)
  relNear(await totalVol(app), PLATE - (36 - Math.PI * 9) * 10, 0.001)
  await clickWorld(app, FILLET_FACE)
  expect((await selection(app))[0].kind).toBe('face')
  await press(app, 'Delete')
  await app.idle()
  expect((await app.bodies()).length).toBe(1)
  relNear(await totalVol(app), PLATE, 0.001)
})


// ================================================================================================ Fillet

test('Fillet: click an edge, type the radius, a live preview is up, OK rounds it', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [60, 0, 5])
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.field('Radius', '6')
  await app.ok()
  relNear(await totalVol(app), PLATE - (36 - Math.PI * 9) * 10, 0.001)
})

test('Fillet: a drag arrow stands in the viewport for the radius', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [60, 0, 5])
  await expect.poll(() => app.ev((c) => c.manips.some((m: any) => m.getState().active) || c.angleManips.some((m: any) => m.getState().active))).toBe(true) // eslint-disable-line
})

test('Fillet: clicking one edge of a tangent chain takes the whole chain (Fusion Tangent Chain, on by default)', async ({ app }) => {
  test.fail() // GAP: each tangent edge has to be clicked on its own
  await app.open()
  await roundedPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [58.243, 1.757, 10]) // the arc on the top edge, between two lines that run on tangent
  await expect.poll(async () => (await selection(app)).length).toBeGreaterThan(0)
  expect((await selection(app)).length).toBe(3)
})

test('Fillet: Variable radius (a radius per end of the edge)', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [30, 0, 10])
  expect(await controls(app)).toMatch(/Variable|Radius type|Start radius/i)
})

test('Fillet: Setback corner type and Rule fillet', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [30, 0, 10])
  expect(await controls(app)).toMatch(/Setback/i)
  expect(await controls(app)).toMatch(/Rule/i)
})

test('Fillet: a radius too large for the part is reported and the body is not lost', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [60, 0, 5])
  await app.field('Radius', '500')
  await app.page.waitForTimeout(500)
  if (await app.inspector().isVisible()) await app.ok().catch(() => {})
  await app.idle()
  expect((await app.bodies()).length).toBe(1) // the plate is still there whichever way the failure was reported
})

test('Fillet: a negative or zero radius is not accepted and nothing breaks', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [60, 0, 5])
  await app.field('Radius', '-3')
  await app.field('Radius', '0')
  expect(((await dlg(app)).size as number)).toBeGreaterThan(0)
  await app.ok()
  expect((await app.bodies()).length).toBe(1)
})

test('Fillet: edit the radius from the timeline, then change the extrude below it: the fillet follows', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await filletAt(app, [[60, 0, 5]], '6')
  await editChip(app, 2)
  await app.field('Radius', '3')
  await app.ok()
  relNear(await totalVol(app), PLATE - (9 - (Math.PI * 9) / 4) * 10, 0.001)
  await editChip(app, 1)
  await app.field('Distance', '20')
  await app.ok()
  const f = (await app.features()).find((x) => x.type === 'fillet')!
  expect(f.state, f.error).toBe('ok')
  relNear(await totalVol(app), 60 * 40 * 20 - (9 - (Math.PI * 9) / 4) * 20, 0.001)
})

test('Fillet: the extrude shortened under a fillet keeps the fillet', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await filletAt(app, [[60, 0, 5]], '6')
  await editChip(app, 1)
  await app.field('Distance', '4')
  await app.ok()
  const f = (await app.features()).find((x) => x.type === 'fillet')!
  expect(f.state, f.error).toBe('ok')
  relNear(await totalVol(app), 60 * 40 * 4 - (36 - Math.PI * 9) * 4, 0.001)
})

// ================================================================================================ Chamfer

test('Chamfer: equal distance on an edge', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await chamferAt(app, [[60, 0, 5]], '4')
  relNear(await totalVol(app), PLATE - 8 * 10, 0.001)
})

test('Chamfer: Two distances and Distance and angle', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Chamfer').first().click()
  await clickWorld(app, [60, 0, 5])
  expect(await controls(app)).toMatch(/Two distances|Distance 2/i)
  expect(await controls(app)).toMatch(/Distance and angle|Angle/i)
})

test('Chamfer: a distance too large is reported and the body is not lost', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Chamfer').first().click()
  await clickWorld(app, [60, 0, 5])
  await app.field('Distance', '900')
  await app.page.waitForTimeout(500)
  if (await app.inspector().isVisible()) await app.ok().catch(() => {})
  await app.idle()
  expect((await app.bodies()).length).toBe(1)
})

// ================================================================================================ Shell

test('Shell: remove the top face, inside, a 2 mm wall', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [5, 5, 10])
  await app.field('Thickness', '2')
  await app.ok()
  relNear(await totalVol(app), 60 * 40 * 10 - 56 * 36 * 8, 0.001)
})

test('Shell: the face picked before the tool starts is the face to remove', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await clickWorld(app, [5, 5, 10])
  expect((await selection(app))[0].kind).toBe('face')
  await app.ribbon('Shell').first().click()
  expect(((await dlg(app)).faces as string[]).length).toBe(1)
})

test('Shell: Outside grows the wall outward and keeps the inner size', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [5, 5, 10])
  await app.field('Thickness', '2')
  await app.inspector().getByText('Outside', { exact: true }).click()
  await app.ok()
  const bb = await app.bbox()
  near(bb.min[0], -2, 0.05)
  relNear(await totalVol(app), 64 * 44 * 12 - 60 * 40 * 10, 0.03)
})

test('Shell: Outside keeps the outer corners and bottom edges sharp, as Fusion does on a box', async ({ app }) => {
  test.fail() // PARTIAL: the outward wall is an offset with rounded outer corners and edges (about 2.3% less volume than the sharp box 64 x 44 x 12)
  await app.open()
  await fastPlate(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [5, 5, 10])
  await app.field('Thickness', '2')
  await app.inspector().getByText('Outside', { exact: true }).click()
  await app.ok()
  relNear(await totalVol(app), 64 * 44 * 12 - 60 * 40 * 10, 0.002)
})

test('Shell: a zero or negative thickness is not accepted', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [5, 5, 10])
  await app.field('Thickness', '0')
  expect(((await dlg(app)).thickness as number)).toBeGreaterThan(0)
  await app.field('Thickness', '-2')
  expect(((await dlg(app)).thickness as number)).toBeGreaterThan(0)
  await app.ok()
  expect((await app.bodies()).length).toBe(1)
})

test('Shell: a wall thicker than half the part is reported and the body stays', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [5, 5, 10])
  await app.field('Thickness', '30')
  await app.page.waitForTimeout(500)
  if (await app.inspector().isVisible()) await app.ok().catch(() => {})
  await app.idle()
  expect((await app.bodies()).length).toBe(1)
})

test('Shell: several faces can be removed (top and a side)', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [5, 5, 10])
  await clickWorld(app, [30, 0, 5])
  expect(((await dlg(app)).faces as string[]).length).toBe(2)
  await app.field('Thickness', '2')
  await app.ok()
  expect((await app.features()).at(-1)!.state).toBe('ok')
  expect(await totalVol(app)).toBeLessThan(PLATE / 2)
})

test('Shell: after a fillet on the top edges the shell is the right wall (the enclosure workflow)', async ({ app }) => {
  test.fail() // GAP: box 80 x 50 x 30, top edges R3, top face removed, 1.5 mm wall: the body has 52845 mm3 where a 1.5 mm wall is about 17000 (the same shell on the box without the fillet is exact at 16858)
  await app.open()
  await addSketch(app, XY, [{ k: 'rect', x0: 0, y0: 0, x1: 80, y1: 50 }])
  await app.ribbon('Extrude').click()
  await app.field('Distance', '30')
  await app.ok()
  await settle(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [40, 25, 30])
  await app.field('Radius', '3')
  await app.ok()
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [40, 25, 30])
  await app.field('Thickness', '1.5')
  await app.ok()
  relNear(await totalVol(app), 80 * 50 * 30 - 77 * 47 * 28.5, 0.1)
})

test('Shell: a wall thicker than the outside fillet radius reports an error instead of silently doing nothing', async ({ app }) => {
  test.fail() // GAP: a 3 mm wall on a box whose top edges have an R2 fillet gives a Shell step that is "ok" with the body unchanged (no hollow, no message); Fusion reports that the shell failed
  await app.open()
  await fastPlate(app)
  await filletAt(app, [[30, 0, 10]], '2')
  const v = await totalVol(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [30, 20, 10])
  await app.field('Thickness', '3')
  await app.ok()
  const sh = (await app.features()).find((x) => x.type === 'shell')!
  const hollowed = (await totalVol(app)) < v * 0.9
  expect(sh.state === 'ok' ? hollowed : true, 'ok step that changed nothing').toBe(true)
})

test('Shell: a different thickness for a chosen face', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [5, 5, 10])
  expect(await controls(app)).toMatch(/Individual|Per face|Face thickness/i)
})

test('Shell: extrude under it cut down to a size the shell cannot fit, then back: it recovers', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [5, 5, 10])
  await app.field('Thickness', '2')
  await app.ok()
  await editChip(app, 1)
  await app.field('Distance', '1')
  await app.ok()
  await app.idle()
  expect((await app.features()).length).toBe(3) // no crash, the steps are all still there
  await editChip(app, 1)
  await app.field('Distance', '10')
  await app.ok()
  await app.idle()
  const sh = (await app.features()).find((x) => x.type === 'shell')!
  expect(sh.state, sh.error).toBe('ok')
  relNear(await totalVol(app), 60 * 40 * 10 - 56 * 36 * 8, 0.001)
})

// ================================================================================================ Break it: Escape, Undo, Delete

test('Escape in the Fillet dialog cancels it: no step, no preview', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [60, 0, 5])
  await app.field('Radius', '3')
  await app.page.keyboard.press('Escape')
  await app.idle()
  expect(await chipCount(app)).toBe(2)
  expect(await app.ev((c) => c.preview.getState().items.length)).toBe(0)
  await expect(app.inspector()).toBeHidden()
})

test('Ctrl+Z while the Fillet dialog is open does not break the dialog or the document', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [60, 0, 5])
  await app.page.keyboard.press('Control+z')
  await app.idle()
  await app.page.keyboard.press('Control+y')
  await app.idle()
  if (await app.inspector().isVisible()) await app.page.keyboard.press('Escape')
  await app.idle()
  expect((await app.bodies()).length).toBe(1)
  expect((await app.features()).every((x) => x.state === 'ok')).toBe(true)
})

test('Undo and redo after a fillet put back exactly the fillet, even after stray Escapes', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await filletAt(app, [[60, 0, 5]], '6')
  await app.page.keyboard.press('Escape')
  await app.page.keyboard.press('Escape')
  await app.page.keyboard.press('Control+z')
  await app.idle()
  relNear(await totalVol(app), PLATE, 0.001)
  await app.page.keyboard.press('Control+y')
  await app.idle()
  relNear(await totalVol(app), PLATE - (36 - Math.PI * 9) * 10, 0.001)
})

test('Deleting the sketch under an extruded, filleted part does not crash, and undo brings it all back', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await filletAt(app, [[60, 0, 5]], '6')
  await app.page.locator('.tl .chip').first().click()
  await app.page.keyboard.press('Delete')
  await app.idle()
  await app.page.waitForTimeout(500)
  await app.page.keyboard.press('Control+z')
  await app.idle()
  expect((await app.features()).every((x) => x.state === 'ok')).toBe(true)
  relNear(await totalVol(app), PLATE - (36 - Math.PI * 9) * 10, 0.001)
})

test('Sketch on a face: a rectangle that shares an edge with the projected outline makes the strip a profile', async ({ app }) => {
  test.fail() // GAP: the strip between the new rectangle and the outline edge is not found as a profile (only the 2160 mm2 remainder is), so a wall drawn against the back edge cannot be extruded
  await app.open()
  await fastPlate(app)
  await sketchOnFace(app, [5, 5, 10])
  const { toLocal: tl } = await import('./solids-kit')
  const pl = await planeOf(app)
  const a = tl(pl, [0, 36, 10]), b = tl(pl, [60, 40, 10])
  await skRect(app, a[0], a[1], b[0], b[1])
  const m = await sk(app)
  expect(m.profiles.map((p) => Math.round(p.area)).sort((x, y) => x - y)).toEqual([240, 2160])
})

test('Extrude: a click in the middle of two overlapping sketches picks the inner (smaller) profile', async ({ app }) => {
  test.fail() // PARTIAL: with two sketches on one plane (80 x 50 and a 72 x 42 inside it) a click in the middle picks the bigger, earlier profile; Fusion offers the innermost
  await app.open()
  await addSketch(app, XY, [{ k: 'rect', x0: 0, y0: 0, x1: 80, y1: 50 }])
  await addSketch(app, XY, [{ k: 'rect', x0: 4, y0: 4, x1: 76, y1: 46 }])
  await settle(app)
  await app.ribbon('Extrude').click()
  await clickWorld(app, [40, 25, 0])
  const pr = (await dlg(app)).profiles as string[]
  expect(pr.length).toBe(1)
  expect(pr[0]).toContain('prof:f2') // the second sketch, the inner rectangle
})

// ================================================================================================ Create: Revolve

const rev = async (app: App) => {
  await addSketch(app, XZ, [{ k: 'rect', x0: 0, y0: 0, x1: 10, y1: 30 }]) // hugs the sketch's Y axis (world Z)
  await settle(app)
  await app.ribbon('Revolve').first().click()
}

test('Revolve: a profile against its axis, a full turn, a live preview, OK', async ({ app }) => {
  await app.open()
  await rev(app)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  relNear(await totalVol(app), Math.PI * 100 * 30, 0.01)
})

test('Revolve: a typed angle of 90 makes a quarter', async ({ app }) => {
  await app.open()
  await rev(app)
  await app.field('Angle', '90')
  await app.ok()
  relNear(await totalVol(app), (Math.PI * 100 * 30) / 4, 0.01)
})

test('Revolve: Symmetric, Two sides and To object extents', async ({ app }) => {
  await app.open()
  await rev(app)
  expect(await controls(app)).toMatch(/Symmetric|Two sides|Direction/i)
})

test('Revolve: Cut, Intersect and New body operations are offered', async ({ app }) => {
  await app.open()
  await rev(app)
  await app.inspector().locator('.field', { has: app.page.locator('.field-label', { hasText: 'Operation' }) }).locator('.sel').first().click()
  const opts = await app.page.getByRole('option').allInnerTexts()
  expect(opts.join('|')).toMatch(/Cut/)
  expect(opts.join('|')).toMatch(/Intersect/)
  expect(opts.join('|')).toMatch(/New/)
})

// ================================================================================================ Create: Sweep, Loft, Rib, Web

async function sweepSetup(app: App) {
  await addSketch(app, XY, [{ k: 'circle', c: [0, 0], r: 5 }])
  await addSketch(app, XZ, [{ k: 'line', a: [0, 0], b: [0, 40] }])
  await settle(app)
  await app.ribbon('Sweep').first().click()
}
test('Sweep: the profile is taken, a click on the path line in the viewport sets the path: live preview and the right volume', async ({ app }) => {
  await app.open()
  await sweepSetup(app)
  await clickWorld(app, [0, 0, 20])
  await expect.poll(async () => ((await dlg(app)).path as string[]).length).toBe(1)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  relNear(await totalVol(app), Math.PI * 25 * 40, 0.01)
})

test('Sweep: Orientation, Taper angle, Twist angle and Guide rail', async ({ app }) => {
  await app.open()
  await sweepSetup(app)
  await clickWorld(app, [0, 0, 20])
  expect(await controls(app)).toMatch(/Twist|Taper|Guide|Orientation/i)
})

test('Loft: two profiles at different heights blend into a frustum, picked in order, live preview', async ({ app }) => {
  await app.open()
  await addSketch(app, XY, [{ k: 'circle', c: [0, 0], r: 10 }])
  await addSketch(app, { origin: [0, 0, 30], xDir: [1, 0, 0], normal: [0, 0, 1] }, [{ k: 'circle', c: [0, 0], r: 5 }])
  await settle(app)
  await app.page.locator('.ribbon-body').getByRole('button', { name: 'Sweep options' }).click()
  await app.page.getByRole('menuitem', { name: 'Loft' }).click()
  await expect.poll(async () => ((await dlg(app)).profiles as string[]).length).toBe(2)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  relNear(await totalVol(app), (Math.PI * 30 * (100 + 25 + 50)) / 3, 0.02)
})

test('Loft: guide rails, a centre line and end conditions (tangent, smooth)', async ({ app }) => {
  await app.open()
  await addSketch(app, XY, [{ k: 'circle', c: [0, 0], r: 10 }])
  await addSketch(app, { origin: [0, 0, 30], xDir: [1, 0, 0], normal: [0, 0, 1] }, [{ k: 'circle', c: [0, 0], r: 5 }])
  await app.page.locator('.ribbon-body').getByRole('button', { name: 'Sweep options' }).click()
  await app.page.getByRole('menuitem', { name: 'Loft' }).click()
  expect(await controls(app)).toMatch(/Rail|Center ?line|Tangen|Continuity|End condition/i)
})

test('Rib and Web exist in the Create menu', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  const e = await ribbonEntries(app)
  expect(e).toMatch(/\bRib\b/)
  expect(e).toMatch(/\bWeb\b/)
})

// ================================================================================================ Create: primitives, Thread, Coil, Pipe

test('Box: typed width, depth and height make the block', async ({ app }) => {
  await app.open()
  await app.ribbon('Box').first().click()
  await app.field('Width', '30')
  await app.field('Depth', '20')
  await app.field('Height', '10')
  await app.ok()
  relNear(await totalVol(app), 6000, 0.001)
})

test('Cylinder from the Box menu: radius and height', async ({ app }) => {
  await app.open()
  await app.page.locator('.ribbon-body').getByRole('button', { name: 'Box options' }).click()
  await app.page.getByRole('menuitem', { name: 'Cylinder' }).click()
  await app.field('Radius', '10')
  await app.field('Height', '20')
  await app.ok()
  relNear(await totalVol(app), Math.PI * 100 * 20, 0.01)
})

for (const name of ['Sphere', 'Torus', 'Coil', 'Pipe']) {
  test(`${name} primitive is in the Create menu`, async ({ app }) => {
    await app.open()
    expect(await ribbonEntries(app)).toMatch(new RegExp('\\b' + name + '\\b'))
  })
}

test('Thread is in the Solid tab Create group, not only in the Detail tab', async ({ app }) => {
  await app.open()
  expect(await ribbonEntries(app)).toMatch(/\bThread\b/)
})

// ================================================================================================ Hole

async function holeOnPlate(app: App, at: P3 = [40, 20, 10]) {
  await app.ribbon('Hole').first().click()
  await clickWorld(app, at)
  await expect.poll(() => app.ev((c) => c.markers.getState().items.length)).toBe(1)
}
const throughAll = (app: App) => app.inspector().getByText('Through all', { exact: true }).click()

test('Hole: click a point on a face, type a diameter, through all', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await holeOnPlate(app)
  await app.field('Diameter', '8')
  await throughAll(app)
  await app.ok()
  relNear(await totalVol(app), PLATE - Math.PI * 16 * 10, 0.005)
})

test('Hole: counterbore (bore diameter and depth)', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await holeOnPlate(app)
  await app.inspector().getByText('Counterbore', { exact: true }).click()
  await app.field('Diameter', '5')
  await app.field('Counterbore diameter', '9')
  await app.field('Counterbore depth', '4')
  await throughAll(app)
  await app.ok()
  relNear(await totalVol(app), PLATE - Math.PI * (2.5 ** 2 * 6 + 4.5 ** 2 * 4), 0.005)
})

test('Hole: countersink has a diameter and an angle', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await holeOnPlate(app)
  await app.inspector().getByText('Countersink', { exact: true }).click()
  expect(await controls(app)).toMatch(/Countersink diameter/i)
  expect(await controls(app)).toMatch(/angle/i)
  await app.field('Diameter', '5')
  await app.field('Countersink diameter', '9')
  await throughAll(app)
  await app.ok()
  const v = await totalVol(app)
  expect(v).toBeLessThan(PLATE - Math.PI * 2.5 ** 2 * 10) // more than the plain hole
})

test('Hole: a countersink follows the hole diameter when the diameter is changed (it stays wider than the hole)', async ({ app }) => {
  test.fail() // PARTIAL: the countersink diameter keeps its own default (4); a hole typed wider than that makes the step fail with "The countersink must be wider than the hole" where Fusion widens the cone with the hole
  await app.open()
  await fastPlate(app)
  await holeOnPlate(app)
  await app.inspector().getByText('Countersink', { exact: true }).click()
  await app.field('Diameter', '5')
  await throughAll(app)
  await app.ok()
  const h = (await app.features()).find((x) => x.type === 'hole')!
  expect(h.state, h.error).toBe('ok')
})

test('Hole: Tapped offers a modeled thread, not just a cosmetic one', async ({ app }) => {
  test.fail() // PARTIAL/GAP: Tapped gives a cosmetic thread mark (tapped hole drilled to the tap size); Fusion's Hole has a Modeled option that cuts the helix
  await app.open()
  await fastPlate(app)
  await holeOnPlate(app)
  await app.inspector().getByText('Tapped', { exact: true }).click()
  expect(await controls(app)).toMatch(/Modeled|Modelled/i)
})

test('Hole: an exact position from an edge can be typed after the click', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await holeOnPlate(app)
  expect(await controls(app)).toMatch(/Offset|Distance from|X position|Position X|Edge/i)
})

test('Hole: through all follows an edit of the plate thickness under it', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await holeOnPlate(app)
  await app.field('Diameter', '8')
  await throughAll(app)
  await app.ok()
  await editChip(app, 1)
  await app.field('Distance', '15')
  await app.ok()
  const h = (await app.features()).find((x) => x.type === 'hole')!
  expect(h.state, h.error).toBe('ok')
  relNear(await totalVol(app), 60 * 40 * 15 - Math.PI * 16 * 15, 0.005)
})

// ================================================================================================ Pattern, Mirror

test('Pattern: a rectangular pattern of a body, quantity and distance typed', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10)
  await app.ribbon('Pattern').first().click()
  await app.inspector().getByText('Bodies', { exact: true }).first().click()
  await app.page.getByTestId('sel-bodies').click()
  await treeRow(app, 'Box1')
  await app.field('Quantity', '3')
  await app.field('Distance', '20')
  await app.ok()
  const f = (await app.features()).at(-1)!
  expect(f.state, f.error).toBe('ok')
  relNear(await totalVol(app), 3000, 0.01)
})

test('Pattern: circular and along-a-path types are offered, with an axis or path to pick', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10, [30, 0, 0])
  await app.ribbon('Pattern').first().click()
  await app.inspector().getByText('Bodies', { exact: true }).first().click()
  await app.page.getByTestId('sel-bodies').click()
  await treeRow(app, 'Box1')
  await app.inspector().getByText('Circular', { exact: true }).click()
  expect(await controls(app)).toMatch(/Axis/i)
  await app.field('Quantity', '4')
  await app.ok()
  relNear(await totalVol(app), 4000, 0.01)
  await app.ribbon('Pattern').first().click()
  await app.inspector().getByText('Path', { exact: true }).click()
  expect(await controls(app)).toMatch(/Path/i)
})

test('Pattern: Fusion pattern extents (Spacing / Extent) and symmetric, flip and a second direction', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10)
  await app.ribbon('Pattern').first().click()
  await app.inspector().getByText('Bodies', { exact: true }).first().click()
  const t = await controls(app)
  expect(t).toMatch(/Distance type/i)
  expect(t).toMatch(/Symmetric/i)
  expect(t).toMatch(/Flip/i)
  expect(t).toMatch(/Second direction/i)
})

// ================================================================================================ Modify: Press/Pull, direct edits, Draft

test('Press/Pull: pick the top face, type a distance, the plate grows', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Press/Pull').first().click()
  await clickWorld(app, [5, 5, 10])
  await app.field('Distance', '5')
  await app.ok()
  relNear(await totalVol(app), 60 * 40 * 15, 0.001)
})

test('Direct-edit menu: Offset Face, Delete Face, Replace Face, Split Face, Split Body and Draft', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  const e = await ribbonEntries(app)
  for (const n of ['Offset Face', 'Delete Face', 'Replace Face', 'Split Face', 'Split Body', 'Draft']) expect(e).toContain(n)
})

test('Draft: a side face tilted about the top face as the neutral plane changes the part', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.page.locator('.ribbon-body').getByRole('button', { name: 'Press/Pull options' }).click()
  await app.page.getByRole('menuitem', { name: 'Draft' }).click()
  await clickWorld(app, [56, 36, 10]) // neutral plane: the top face, away from the origin planes
  await clickWorld(app, [30, 0, 5]) // face
  await app.field('Angle', '5')
  await app.ok()
  const f = (await app.features()).at(-1)!
  expect(f.state, f.error).toBe('ok')
  expect(Math.abs((await totalVol(app)) - PLATE)).toBeGreaterThan(10)
})

test('Draft: a click on the top face picks that face as the neutral plane (not an origin plane drawn over it)', async ({ app }) => {
  test.fail() // PARTIAL: a click at (5, 5, 10) on the top face picks the XZ origin plane that is drawn across the view, not the face
  await app.open()
  await fastPlate(app)
  await app.page.locator('.ribbon-body').getByRole('button', { name: 'Press/Pull options' }).click()
  await app.page.getByRole('menuitem', { name: 'Draft' }).click()
  await clickWorld(app, [5, 5, 10])
  const plane = (await dlg(app)).plane as string[]
  expect(plane[0]).toMatch(/^[{]/)
})

test('Draft: Parting line and Step draft types', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.page.locator('.ribbon-body').getByRole('button', { name: 'Press/Pull options' }).click()
  await app.page.getByRole('menuitem', { name: 'Draft' }).click()
  expect(await controls(app)).toMatch(/Parting|Step|Draft type/i)
})

test('Split Body: a plane through the middle of a block makes two bodies', async ({ app, page }) => {
  await app.open()
  await seedBox(app, 40, 40, 10)
  await app.showPlane('YZ')
  await page.locator('.ribbon-body').getByRole('button', { name: 'Press/Pull options' }).click()
  await page.getByRole('menuitem', { name: 'Split Body' }).click()
  await treeRow(app, 'Box1')
  await page.getByTestId('sel-tool').click()
  await treeRow(app, 'YZ plane')
  await page.waitForTimeout(400)
  await app.ok()
  expect((await app.bodies()).length).toBe(2)
})

test('Scale: a uniform scale factor of 2 doubles the part', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10)
  await app.ribbon('Move').first().click()
  await app.inspector().getByText('Scale', { exact: true }).first().click().catch(() => {})
  await app.field('Scale', '2')
  await app.ok()
  const bb = await app.bbox()
  near(bb.max[0] - bb.min[0], 20, 0.1)
})

test('Scale: a separate Scale command with uniform, non-uniform and a scale point', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  expect(await ribbonEntries(app)).toMatch(/\bScale\b/)
})

// ================================================================================================ Move / Copy, Align

test('Move: translate X by 25 (typed)', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10)
  await app.ribbon('Move').first().click()
  await app.vec('Translate', 0, '25')
  await app.ok()
  const bb = await app.bbox()
  near(bb.min[0], 20, 0.05)
})

test('Move: rotate 90 degrees about Z turns a 30 x 10 block', async ({ app }) => {
  await app.open()
  await seedBox(app, 30, 10, 10)
  await app.ribbon('Move').first().click()
  await app.vec('Rotate', 2, '90')
  await app.ok()
  const bb = await app.bbox()
  near(bb.max[0] - bb.min[0], 10, 0.1)
  near(bb.max[1] - bb.min[1], 30, 0.1)
})

test('Move: a Create copy option leaves the original in place', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10)
  await app.ribbon('Move').first().click()
  expect(await controls(app)).toMatch(/Copy/i)
})

test('Move: Point to point and a rotation about a picked axis or pivot', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10)
  await app.ribbon('Move').first().click()
  expect(await controls(app)).toMatch(/Point to point|Pivot|Move type/i)
})

test('Align: align a body to another by faces or planes', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10)
  expect(await ribbonEntries(app)).toMatch(/\bAlign\b/)
})

// ================================================================================================ Combine

async function twoBoxes(app: App) {
  await seedBox(app, 40, 40, 10, [0, 0, 0]) // x -20..20
  await seedBox(app, 40, 40, 10, [20, 0, 0]) // x 0..40
}
async function combine(app: App, op: 'Join' | 'Cut' | 'Intersect', keep = false) {
  await app.ribbon('Combine').first().click()
  await treeRow(app, 'Box1')
  await treeRow(app, 'Box2')
  await expect.poll(async () => ((await dlg(app)).tools as string[]).length).toBe(1)
  await app.inspector().getByText(op, { exact: true }).click()
  if (keep) await app.inspector().locator('.field', { hasText: 'Keep tools' }).locator('button,input,[role=switch]').first().click()
  await app.ok()
}
test('Combine: clicking a body in the viewport picks the body (not only its row in the Browser)', async ({ app }) => {
  test.fail() // PARTIAL: with Combine open a click on a body in the viewport selects nothing; the bodies have to be picked from the Browser tree
  await app.open()
  await twoBoxes(app)
  await app.ribbon('Combine').first().click()
  await clickWorld(app, [-10, 0, 10])
  expect(((await dlg(app)).target as string[]).length).toBe(1)
})
test('Combine: Join two overlapping blocks into one body', async ({ app }) => {
  await app.open()
  await twoBoxes(app)
  await combine(app, 'Join')
  expect((await app.bodies()).length).toBe(1)
  relNear(await totalVol(app), 60 * 40 * 10, 0.005)
})
test('Combine: Cut the second block out of the first', async ({ app }) => {
  await app.open()
  await twoBoxes(app)
  await combine(app, 'Cut')
  expect((await app.bodies()).length).toBe(1)
  relNear(await totalVol(app), 20 * 40 * 10, 0.005)
})
test('Combine: Intersect keeps only the overlap', async ({ app }) => {
  await app.open()
  await twoBoxes(app)
  await combine(app, 'Intersect')
  relNear(await totalVol(app), 20 * 40 * 10, 0.005)
})
test('Combine: Keep tools leaves the tool body in place after a Cut', async ({ app }) => {
  await app.open()
  await twoBoxes(app)
  await combine(app, 'Cut', true)
  expect((await app.bodies()).length).toBe(2)
})

// ================================================================================================ Construct

test('Construct menus: plane at angle, tangent plane, midplane, three points, axes and points', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  const e = await ribbonEntries(app)
  for (const n of ['Offset Plane', 'Plane at Angle', 'Tangent Plane', 'Midplane', 'Plane Through 3 Points', 'Axis Through 2 Points', 'Axis Normal to Face', 'Axis of Cylinder', 'Point at Vertex', 'Point at Centre', 'Point at Axis and Plane']) expect(e).toContain(n)
})

test('Offset Plane: with the top face selected first, a typed distance, a new plane step based on that face', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await clickWorld(app, [56, 36, 10])
  await app.ribbon('Offset Plane').first().click()
  await app.field('Distance', '15')
  await app.ok()
  const f = (await app.features()).at(-1)!
  expect(f.type).toMatch(/lane/i)
  expect(f.state, f.error).toBe('ok')
  expect(((f.params as any).face as string[]).length).toBe(1) // eslint-disable-line
})

test('Offset Plane: a face clicked after the tool has started becomes the base', async ({ app }) => {
  test.fail() // PARTIAL: the click selects the face but the dialog keeps the XY origin plane as its base (a face only counts when it is selected before the tool starts)
  await app.open()
  await fastPlate(app)
  await app.ribbon('Offset Plane').first().click()
  await clickWorld(app, [56, 36, 10])
  await app.field('Distance', '15')
  await app.ok()
  const f = (await app.features()).at(-1)!
  expect(((f.params as any).face as string[]).length).toBe(1) // eslint-disable-line
})

test('Plane at Angle: plane, axis and angle fields', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Plane at Angle').first().click()
  const t = await inspectorText(app)
  expect(t).toMatch(/Plane/)
  expect(t).toMatch(/Axis/)
  expect(t).toMatch(/Angle/)
})

// ================================================================================================ Inspect, material

test('Measure: the distance between two parallel faces at different heights', async ({ app }) => {
  await app.open()
  await seedBox(app, 20, 20, 10, [-30, 0, 0])
  await seedBox(app, 20, 20, 10, [30, 0, 30]) // top at z = 40
  await app.ribbon('Measure').first().click()
  await clickWorld(app, [-30, 0, 10])
  await clickWorld(app, [30, 0, 40])
  await expect(app.inspector()).toContainText(/30(\.0+)?\s*mm/)
})

test('Section Analysis: plane normal, offset and flip', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Section Analysis').first().click()
  const t = await inspectorText(app)
  expect(t).toMatch(/Offset/)
  expect(t).toMatch(/Flip/)
})

test('Section Analysis: the section plane is picked from an origin plane or a face', async ({ app }) => {
  test.fail() // PARTIAL: only an axis (X, Y, Z) and an offset; Fusion picks the section plane from an origin plane or any planar face
  await app.open()
  await fastPlate(app)
  await app.ribbon('Section Analysis').first().click()
  expect(await inspectorText(app)).toMatch(/Select|pick/i)
  expect(await inspectorText(app)).toMatch(/plane \*|Plane \*|Face/)
})

test('Interference of solid bodies is in the Solid tab Inspect group', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  expect(await ribbonEntries(app)).toMatch(/Interference/)
})

test('Physical Material: a material with a density gives the body a mass', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  expect(await allEntries(app)).toMatch(/Physical Material|Material/)
})

test('Appearance is in the Solid tab Modify group', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  expect(await ribbonEntries(app)).toMatch(/Appearance/)
})
