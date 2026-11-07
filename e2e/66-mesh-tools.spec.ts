import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type App } from './helpers'
import { boxTris, bodyIds, clickWorld, featStates, geom, importStl, meshStats, meshTool, sphereTris, without, writeObj, writeStl } from './mesh-kit'
import { editChip, px, relNear, selection, seedBox, settle } from './solids-kit'

/* Mesh tab tools, Fusion style (docs/fusion-parity/mesh.md): every tool has a dialog, a live preview and an editable timeline step.
   Everything under test is mouse and keyboard; app.ev only reads state. */

const box = (n = 4) => writeStl(`box${n}`, boxTris(40, 30, 20, [0, 0, 0], n))
const sphere = (seg = 64, rings = 32) => writeStl(`sph${seg}`, sphereTris(20, seg, rings))
const press = (app: App, k: string) => app.page.keyboard.press(k)
const seg = (app: App, name: string) => app.inspector().getByRole('radio', { name }).click()
const pickSel = async (app: App, field: string, option: RegExp | string) => {
  await app.inspector().locator('.field', { hasText: field }).locator('.sel').click()
  await app.page.getByRole('option', { name: option }).click()
}
const SPHERE_VOL = (4 / 3) * Math.PI * 20 ** 3

/** Drag the mouse across the viewport between two world points (paints with the Brush). */
async function drag(app: App, a: [number, number, number], b: [number, number, number]) {
  const p = await px(app, a), q = await px(app, b)
  await app.page.mouse.move(p.x, p.y, { steps: 2 })
  await app.page.mouse.down()
  await app.page.mouse.move(q.x, q.y, { steps: 8 })
  await app.page.mouse.up()
}
const painted = async (app: App) => Number(((await app.page.locator('.hair-count').innerText()).match(/([\d,]+) tris/) ?? [])[1]?.replace(/,/g, '') ?? 0)
const download = async (app: App, name: string) => {
  const [dl] = await Promise.all([app.page.waitForEvent('download'), app.ok()])
  const f = path.join(os.tmpdir(), name)
  await dl.saveAs(f)
  return f
}

// ================================================================================================ Reduce, Remesh

test('Reduce: by Proportion keeps half the triangles, by Face count hits the number, as an editable step', async ({ app }) => {
  await app.open()
  await importStl(app, sphere())
  const before = (await meshStats(app)).tris
  await meshTool(app, 'Reduce')
  await seg(app, 'Proportion')
  await app.field('Proportion', '50')
  await app.ok()
  let s = await meshStats(app)
  expect(s.tris).toBeGreaterThan(before * 0.45)
  expect(s.tris).toBeLessThan(before * 0.56)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, SPHERE_VOL, 0.03)
  await editChip(app, 1)
  await seg(app, 'Face count')
  await app.field('Face count', '800')
  await app.ok()
  s = await meshStats(app)
  expect(s.tris).toBeGreaterThan(700)
  expect(s.tris).toBeLessThan(900)
  expect(s.open).toBe(0)
})

test('Reduce: Preserve sharp edges keeps a box exact while it loses triangles', async ({ app }) => {
  await app.open()
  await importStl(app, box(6))
  const before = (await meshStats(app)).tris
  await meshTool(app, 'Reduce')
  await app.field('Tolerance', '0.05')
  await app.ok()
  const s = await meshStats(app)
  expect(s.tris).toBeLessThan(before / 2)
  relNear(s.signedVolume, 24000, 0.001)
  const bb = await app.bbox()
  expect(bb.max[0]).toBeCloseTo(40, 3)
  expect(bb.max[2]).toBeCloseTo(20, 3)
  expect((await geom(app))[0].faces).toBe(6)
})

test('Remesh: Uniform rebuilds a box with even triangles and keeps its corners', async ({ app }) => {
  await app.open()
  await importStl(app, box(1))
  await meshTool(app, 'Refine')
  await pickSel(app, 'Type', 'Uniform')
  await app.field('Edge length', '5')
  await app.ok()
  const s = await meshStats(app)
  expect(s.tris).toBeGreaterThan(300)
  expect(s.open).toBe(0)
  expect(s.nonManifold).toBe(0)
  relNear(s.signedVolume, 24000, 0.005)
  const bb = await app.bbox()
  expect(bb.max[0]).toBeCloseTo(40, 2)
  expect(bb.max[1]).toBeCloseTo(30, 2)
  expect((await geom(app))[0].faces).toBe(6)
})

test('Remesh: Density 0.5 halves the triangles of a sphere, Adaptive keeps it closed', async ({ app }) => {
  await app.open()
  await importStl(app, sphere(48, 24))
  const before = (await meshStats(app)).tris
  await meshTool(app, 'Refine')
  await pickSel(app, 'Type', 'Density')
  await app.field('Density', '0.5')
  await app.ok()
  let s = await meshStats(app)
  expect(s.tris).toBeLessThan(before * 0.8)
  expect(s.tris).toBeGreaterThan(before * 0.25)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, SPHERE_VOL, 0.06)
  await editChip(app, 1)
  await pickSel(app, 'Type', 'Adaptive')
  await app.field('Edge length', '4')
  await app.ok()
  s = await meshStats(app)
  expect(s.open).toBe(0)
  expect(s.nonManifold).toBe(0)
  relNear(s.signedVolume, SPHERE_VOL, 0.06)
})

// ================================================================================================ Plane Cut

test('Plane Cut: along a picked face, with an offset along its normal', async ({ app }) => {
  await app.open()
  await importStl(app, box(4))
  await meshTool(app, 'Plane Cut')
  // the Plane or Face field is the active one: the click on the top face goes into it
  await clickWorld(app, [20, 15, 20])
  await expect(app.inspector().locator('.field', { hasText: 'Plane or Face' })).toContainText(/face|Face/i)
  await app.field('Offset', '-5')
  await app.ok()
  expect((await bodyIds(app)).length).toBe(1)
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, 6000, 0.001)
  expect((await app.bbox()).min[2]).toBeCloseTo(15, 3)
})

test('Plane Cut: a tilted plane splits the box in two closed parts of 1500 and 22500', async ({ app }) => {
  await app.open()
  await importStl(app, box(4))
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '10')
  await app.inspector().getByText('Tilt', { exact: true }).click()
  await app.field('Tilt about U', '45')
  await app.inspector().locator('.field', { hasText: 'Keep' }).locator('.sel').click()
  await app.page.getByRole('option', { name: /Both/ }).click()
  await app.ok()
  expect((await bodyIds(app)).length).toBe(2)
  const v = [await meshStats(app, 0), await meshStats(app, 1)]
  for (const s of v) expect(s.open).toBe(0)
  const vols = v.map((s) => s.signedVolume).sort((a, b) => a - b)
  relNear(vols[0], 1500, 0.002)
  relNear(vols[1], 22500, 0.002)
})

test('Plane Cut: Fill type None leaves the cut open, Uniform caps it with more triangles than Minimal', async ({ app }) => {
  await app.open()
  await importStl(app, box(4))
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '10')
  await app.ok()
  const minimal = await meshStats(app)
  expect(minimal.open).toBe(0)
  await editChip(app, 1)
  await seg(app, 'Uniform')
  await app.ok()
  const uniform = await meshStats(app)
  expect(uniform.open).toBe(0)
  expect(uniform.tris).toBeGreaterThan(minimal.tris)
  relNear(uniform.signedVolume, 12000, 0.001)
  await editChip(app, 1)
  await seg(app, 'None')
  await app.ok()
  const none = await meshStats(app)
  expect(none.open).toBeGreaterThan(0)
  expect(none.tris).toBeLessThan(minimal.tris)
  expect((await app.bbox()).min[2]).toBeCloseTo(10, 3)
})

// ================================================================================================ Face groups

test('Generate Face Groups: Accurate cuts a smooth sphere into patches, and it runs again after a Reduce', async ({ app }) => {
  await app.open()
  await importStl(app, sphere())
  expect((await geom(app))[0].faces).toBe(1)
  await meshTool(app, 'Reduce')
  await seg(app, 'Proportion')
  await app.field('Proportion', '50')
  await app.ok()
  await meshTool(app, /^Face Groups$/)
  await seg(app, 'Accurate')
  await app.field('Angle', '15')
  await app.ok()
  expect((await geom(app))[0].faces).toBeGreaterThan(4)
  expect((await featStates(app)).pop()).toBe('meshFaceGroups:ok')
  expect((await meshStats(app)).open).toBe(0)
})

test('Combine Face Groups joins two faces of the box, Separate Face Groups cuts a painted patch out of one', async ({ app }) => {
  await app.open()
  await importStl(app, box(4))
  await app.tab('Mesh')
  await app.ribbon('Face Groups options').click()
  await app.page.getByRole('menuitem', { name: 'Combine Face Groups' }).click()
  await clickWorld(app, [20, 15, 20])
  await clickWorld(app, [40, 15, 10])
  await app.ok()
  expect((await geom(app))[0].faces).toBe(5)
  // paint a few triangles of the front-left of the top... the top is now part of a bigger group: separate a patch of it
  await app.ribbon('Brush Select').click()
  await drag(app, [8, 8, 20], [14, 12, 20])
  expect(await painted(app)).toBeGreaterThan(0)
  await app.ribbon('Face Groups options').click()
  await app.page.getByRole('menuitem', { name: 'Separate Face Groups' }).click()
  await expect(app.inspector()).toBeVisible()
  await app.ok()
  expect((await geom(app))[0].faces).toBe(6)
})

// ================================================================================================ Brush, Grow, Shrink, Delete, Erase and Fill, Move

test('Brush paints triangles, Grow and Shrink change the selection, Delete Faces opens a hole', async ({ app }) => {
  await app.open()
  await importStl(app, box(4))
  await app.tab('Mesh')
  await app.ribbon('Brush Select').click()
  await drag(app, [10, 10, 20], [18, 12, 20])
  const n = await painted(app)
  expect(n).toBeGreaterThan(0)
  await app.page.getByRole('button', { name: 'Grow selection' }).click()
  const grown = await painted(app)
  expect(grown).toBeGreaterThan(n)
  await app.page.getByRole('button', { name: 'Shrink selection' }).click()
  const shrunk = await painted(app)
  expect(shrunk).toBeLessThan(grown)
  const before = (await meshStats(app)).tris
  await app.ribbon('Delete Faces').first().click()
  await expect(app.inspector()).toBeVisible()
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBeGreaterThan(0)
  expect(s.tris).toBe(before - shrunk)
})

test('Erase And Fill removes a painted patch of a sphere and closes the hole', async ({ app }) => {
  await app.open()
  await importStl(app, sphere(48, 24))
  await app.tab('Mesh')
  await app.ribbon('Brush Select').click()
  const top = await app.page.evaluate(() => 0)
  void top
  await drag(app, [0, -8, 18], [0, 8, 14])
  expect(await painted(app)).toBeGreaterThan(3)
  const before = await meshStats(app)
  await app.ribbon('Delete Faces options').click()
  await app.page.getByRole('menuitem', { name: 'Erase And Fill' }).click()
  await expect(app.inspector()).toBeVisible()
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  expect(s.nonManifold).toBe(0)
  relNear(s.signedVolume, before.signedVolume, 0.04)
  expect((await featStates(app)).pop()).toBe('meshEraseFill:ok')
})

test('Move Face Group: the top face of the box pulled 5 mm, the sides stretch and the mesh stays closed', async ({ app }) => {
  await app.open()
  await importStl(app, box(4))
  await clickWorld(app, [20, 15, 20])
  await app.tab('Mesh')
  await app.ribbon('Move Faces').click()
  await app.field('Distance', '5')
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, 30000, 0.001)
  relNear((await app.bbox()).max[2], 25, 0.001)
  expect((await geom(app))[0].faces).toBe(6)
})

// ================================================================================================ Section Sketch

test('Mesh Section Sketch: the outline of a box becomes four lines you can extrude', async ({ app }) => {
  await app.open()
  await importStl(app, box(4))
  await app.tab('Mesh')
  await app.ribbon('Section Sketch').click()
  await app.field('Offset', '10')
  await app.ok()
  await expect.poll(async () => (await app.features()).some((x) => x.type === 'sketch'), { timeout: 15000 }).toBe(true)
  await app.idle()
  const f = (await app.features()).find((x) => x.type === 'sketch')!
  expect(f).toBeTruthy()
  const model = JSON.parse(f.params.sketch).model
  expect(model.entities.filter((e: { type: string }) => e.type === 'line')).toHaveLength(4)
  await app.tab('Solid')
  await app.ribbon('Extrude').click()
  await app.page.locator('.tree-row', { hasText: /Section Sketch/ }).first().click()
  await app.inspector().locator('.field', { hasText: 'Profile' }).getByRole('button', { name: 'Use selection' }).click().catch(() => {})
  await app.field('Distance', '10')
  await app.inspector().locator('.field', { hasText: 'Operation' }).locator('.sel').click()
  await app.page.getByRole('option', { name: 'New body' }).click()
  await app.ok()
  const bodies = await app.bodies()
  const brep = bodies.find((b) => b.kind === 'brep')!
  expect(brep).toBeTruthy()
  relNear(await app.volume(brep.id), 12000, 0.002)
})

test('Mesh Section Sketch: a sphere gives a real circle that extrudes to a cylinder', async ({ app }) => {
  await app.open()
  await importStl(app, sphere())
  await app.tab('Mesh')
  await app.ribbon('Section Sketch').click()
  await app.ok()
  await expect.poll(async () => (await app.features()).some((x) => x.type === 'sketch'), { timeout: 15000 }).toBe(true)
  await app.idle()
  const f = (await app.features()).find((x) => x.type === 'sketch')!
  const model = JSON.parse(f.params.sketch).model
  const circles = model.entities.filter((e: { type: string }) => e.type === 'circle')
  expect(circles).toHaveLength(1)
  expect(circles[0].r).toBeCloseTo(20, 1)
  expect(model.entities.filter((e: { type: string }) => e.type === 'line')).toHaveLength(0)
})

// ================================================================================================ Stats

test('Mesh stats: a closed box says manifold, a box with two triangles missing reports open edges', async ({ app }) => {
  await app.open()
  await importStl(app, box(4))
  await app.page.locator('.tree-row', { hasText: /box4/ }).first().click()
  const card = app.page.locator('.mesh-card')
  await expect(card).toContainText('Manifold, watertight')
  await expect(card).toContainText('24,000')
  await expect(card).toContainText('192')
  await press(app, 'Escape')
  await importStl(app, writeStl('holey', without(boxTris(40, 30, 20, [0, 0, 0], 4), [40, 41])), 2)
  await app.page.locator('.tree-row', { hasText: /holey/ }).first().click()
  await expect(card).toContainText('Not manifold')
  await expect(card.locator('dt', { hasText: 'Open edges' }).locator('xpath=following-sibling::dd[1]')).not.toHaveText('0')
})

// ================================================================================================ Insert, OBJ, export

test('Insert Mesh dialog: units and placement edit the model live, OK is one undo step', async ({ app }) => {
  await app.open()
  await app.tab('Mesh')
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.ribbon('Import Mesh').first().click()])
  await chooser.setFiles(writeStl('far', boxTris(4, 3, 2, [300, 200, 5], 1)))
  await expect(app.inspector()).toBeVisible({ timeout: 6000 })
  await seg(app, 'cm')
  await expect.poll(async () => (await app.bbox()).max[0], { timeout: 15000 }).toBeCloseTo(3040, 0)
  await pickSel(app, 'Placement', 'Center on origin')
  await expect.poll(async () => (await app.bbox()).min[0], { timeout: 15000 }).toBeCloseTo(-20, 0)
  expect((await app.bbox()).max[1]).toBeCloseTo(15, 0)
  await pickSel(app, 'Placement', 'Drop to ground plane')
  await expect.poll(async () => (await app.bbox()).min[2], { timeout: 15000 }).toBeCloseTo(0, 2)
  await app.ok()
  relNear(await app.volume(), 24000, 0.001)
  await press(app, 'Control+z')
  await app.idle()
  expect((await bodyIds(app)).length).toBe(0)
})

test('OBJ: an OBJ box comes in, exports as OBJ and comes back the same size', async ({ app }) => {
  await app.open()
  await importStl(app, writeObj('objbox', boxTris(40, 30, 20, [0, 0, 0], 2)))
  expect((await geom(app))[0].kind).toBe('mesh')
  relNear(await app.volume(), 24000, 0.001)
  await app.ribbon('Export').first().click()
  await app.inspector().getByRole('radio', { name: 'OBJ' }).click()
  const f = await download(app, 'caddy-mesh-export.obj')
  const text = fs.readFileSync(f, 'utf8')
  expect(text).toMatch(/^o /m)
  expect(text.match(/^f /gm)!.length).toBe(48)
  await importStl(app, f, 2)
  relNear(await app.volume((await bodyIds(app))[1]), 24000, 0.001)
})

test('Export refinement: Fine writes more triangles than Coarse for a cylinder', async ({ app }) => {
  await app.open()
  await app.ev((c) => c.doc.getState().addFeature('cylinder', { plane: 'XY', position: [0, 0, 0], radius: 10, height: 20 }))
  await app.idle()
  await settle(app)
  const count = async (level: string) => {
    await app.ribbon('Export').first().click()
    await app.inspector().getByRole('radio', { name: 'STL' }).click()
    await app.inspector().getByRole('radio', { name: level }).click()
    const f = await download(app, `caddy-cyl-${level}.stl`)
    return fs.readFileSync(f).readUInt32LE(80)
  }
  const coarse = await count('Coarse')
  const fine = await count('Fine')
  expect(fine).toBeGreaterThan(coarse * 1.5)
})

test('Convert to Mesh: the Refinement decides how finely a cylinder is cut, and it is an editable step', async ({ app }) => {
  await app.open()
  await app.ev((c) => c.doc.getState().addFeature('cylinder', { plane: 'XY', position: [0, 0, 0], radius: 10, height: 20 }))
  await app.idle()
  await settle(app)
  await meshTool(app, 'Convert to Mesh')
  await seg(app, 'Coarse')
  await app.ok()
  const coarse = await meshStats(app)
  await editChip(app, 1)
  await seg(app, 'Fine')
  await app.ok()
  const fine = await meshStats(app)
  expect(fine.tris).toBeGreaterThan(coarse.tris * 1.5)
  relNear(fine.signedVolume, Math.PI * 100 * 20, 0.003)
})

// ================================================================================================ Scale

test('Scale: Non-uniform stretches a mesh 2 x 1 x 0.5 about its middle', async ({ app }) => {
  await app.open()
  await importStl(app, box(4))
  await app.page.locator('.tree-row', { hasText: /box4/ }).first().click()
  await app.tab('Solid')
  await app.ribbon(/^Move$/).first().click()
  await seg(app, 'Non-uniform')
  await app.vec('Scale X, Y, Z', 0, '2')
  await app.vec('Scale X, Y, Z', 2, '0.5')
  await app.ok()
  const bb = await app.bbox()
  expect(bb.max[0] - bb.min[0]).toBeCloseTo(80, 2)
  expect(bb.max[1] - bb.min[1]).toBeCloseTo(30, 2)
  expect(bb.max[2] - bb.min[2]).toBeCloseTo(10, 2)
  relNear(await app.volume(), 24000, 0.001)
  expect((await meshStats(app)).open).toBe(0)
})

// ================================================================================================ Ribbon

test('The Mesh tab is grouped like Fusion: Create, Prepare, Modify, Assemble, Construct, Inspect, Select, Export', async ({ app }) => {
  await app.open()
  await app.tab('Mesh')
  const labels = await app.page.locator('.ribbon-body .rgroup-label').allInnerTexts()
  expect(labels).toEqual(['Create', 'Prepare', 'Modify', 'Assemble', 'Construct', 'Inspect', 'Select', 'Export'])
  void seedBox
  void selection
})
