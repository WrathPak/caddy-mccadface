import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { test, expect, type App } from './helpers'
import {
  bodyIds, featStates, figureTris, toggle, geom, importStl, lBracketTris, meshStats, meshTool, nearestTri, slabTris, triVolume, without, writeStl,
} from './mesh-kit'
import { clickWorld, esc2, openSketch, planeOf, relNear, ribbonEntries, seedBox, selection, settle, skCircle, sketchOnFace, toLocal, type P3 } from './solids-kit'

/* Real jobs a 3D-printing Fusion user does with the Mesh tab, each starting from an imported STL (generated here, nothing checked in).
   Workarounds are marked WORKAROUND in the comments and collected in docs/fusion-parity/mesh.md. Everything is mouse and keyboard. */

const press = (app: App, k: string) => app.page.keyboard.press(k)
const ok = async (app: App) => expect((await featStates(app)).filter((s) => !/:(ok|warning)/.test(s)), 'every step is ok').toEqual([])
/** Pick the n-th Browser row that matches, then Use selection in the named dialog field. */
async function useNth(app: App, field: string, row: string | RegExp, n = 0) {
  await app.page.locator('.tree-row', { hasText: row }).nth(n).click()
  await app.inspector().locator('.field', { hasText: field }).getByRole('button', { name: 'Use selection' }).click()
}

// ------------------------------------------------------------------------------------------------ 1 a broken scan

test('Scan with holes: three missing patches, Repair closes them, the mesh then cuts and exports', async ({ app }) => {
  test.setTimeout(200000)
  await app.open()
  const full = figureTris(40)
  const vFull = triVolume(full)
  // a scan: three patches on the stem and the head are missing
  const drop = ([[4.5, 0, 15], [-2.3, 4, 26], [-2.3, -4, 40]] as P3[]).map((p) => nearestTri(full, p))
  const file = writeStl('scan', without(full, drop))
  await importStl(app, file)
  const s0 = await meshStats(app)
  expect(s0.open).toBeGreaterThan(0)
  await meshTool(app, 'Repair')
  await app.ok()
  const s1 = await meshStats(app)
  expect(s1.open, 'closed after Repair').toBe(0)
  expect(s1.nonManifold).toBe(0)
  relNear(s1.signedVolume, vFull, 0.02)
  await ok(app)
  // "close it": the mesh is manifold now, so a Plane Cut into two halves works and each half is closed (a print slicer needs that)
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '28')
  await app.inspector().locator('.field', { hasText: 'Keep' }).locator('.sel').click()
  await app.page.getByRole('option', { name: /Both/ }).click()
  await app.ok()
  expect((await bodyIds(app)).length).toBe(2)
  const a = await meshStats(app, 0), b = await meshStats(app, 1)
  expect(a.open + b.open).toBe(0)
  relNear(a.signedVolume + b.signedVolume, vFull, 0.02)
  // export the halves as STL: the file carries every triangle of both
  await app.tab('Solid')
  await app.ribbon('Export').first().click()
  const [dl] = await Promise.all([app.page.waitForEvent('download'), app.ok()])
  const out = path.join(os.tmpdir(), 'caddy-mesh-scan-halves.stl')
  await dl.saveAs(out)
  expect(fs.readFileSync(out).readUInt32LE(80)).toBe(a.tris + b.tris)
})

// ------------------------------------------------------------------------------------------------ 2 a big STL cut in half

test('Big STL: half a million triangles cut in half with Plane Cut, both halves closed', async ({ app }) => {
  test.setTimeout(300000)
  await app.open()
  const t0 = Date.now()
  await importStl(app, writeStl('slab354', slabTris(354, 100, 10)), 1, 120000)
  const tImport = Date.now() - t0
  const tris = (await geom(app))[0].tris
  expect(tris).toBeGreaterThan(490000)
  const v = (await meshStats(app)).signedVolume
  const t1 = Date.now()
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '5')
  await app.inspector().locator('.field', { hasText: 'Keep' }).locator('.sel').click()
  await app.page.getByRole('option', { name: /Both/ }).click()
  await app.ok()
  const tCut = Date.now() - t1
  await ok(app)
  expect((await bodyIds(app)).length).toBe(2)
  const a = await meshStats(app, 0), b = await meshStats(app, 1)
  expect(a.open + b.open).toBe(0)
  relNear(a.signedVolume + b.signedVolume, v, 0.001)
  console.log(`MESH PERF 500k split: import ${tImport} ms, plane cut (split) ${tCut} ms`)
})

// ------------------------------------------------------------------------------------------------ 3 a mini figure, hollow with a drain hole

test('Mini figure: hollowed, with a drain hole in the base', async ({ app }) => {
  // WORKAROUND: Shell does not work on a mesh ("needs a solid body, not a mesh"). The figure is hollowed with a scaled copy (Move > Create copy, Scale 0.85, then Combine > Cut);
  // the wall is 15 percent of the local radius, not a constant thickness (0.7 mm on the 4.5 mm stem, 1.8 mm at the base), and the copy has no connection to the original's later edits
  test.setTimeout(240000)
  await app.open()
  const full = figureTris(40)
  const vFull = triVolume(full)
  await importStl(app, writeStl('figure', full))
  await app.page.locator('.tree-row', { hasText: /figure/ }).first().click()
  await app.tab('Solid')
  await app.ribbon(/^Move$/).first().click()
  await app.field('Scale', '0.85')
  await toggle(app, 'Create copy')
  await app.ok()
  expect((await bodyIds(app)).length, JSON.stringify(await featStates(app))).toBe(2)
  // cut the copy out of the figure
  await app.ribbon('Combine').first().click()
  await useNth(app, 'Target body', /figure/, 0)
  await useNth(app, 'Tool bodies', /figure/, 1)
  await app.inspector().getByRole('radio', { name: 'Cut' }).click()
  await app.ok()
  await ok(app)
  expect((await bodyIds(app)).length).toBe(1)
  const hollow = await meshStats(app)
  // the scaled copy is not entirely inside the figure (the profile changes fast at the collar), so a little less than 38.6 percent of the volume is left to cut away
  expect(hollow.signedVolume).toBeGreaterThan(vFull * (1 - 0.85 ** 3) * 0.98)
  expect(hollow.signedVolume).toBeLessThan(vFull * 0.5)
  expect(hollow.open).toBe(0)
  // the drain hole: a 4 mm square post through the base into the cavity
  await seedBox(app, 4, 4, 8, [-2, -2, -1])
  await app.tab('Solid')
  await app.ribbon('Combine').first().click()
  await useNth(app, 'Target body', /figure/, 0)
  await useNth(app, 'Tool bodies', /Box/, 0)
  await app.inspector().getByRole('radio', { name: 'Cut' }).click()
  await app.ok()
  await ok(app)
  expect((await bodyIds(app)).length).toBe(1)
  const done = await meshStats(app)
  expect(done.open).toBe(0)
  expect(done.signedVolume).toBeLessThan(hollow.signedVolume - 20) // the hole took material out of the base
  expect(done.signedVolume).toBeGreaterThan(hollow.signedVolume * 0.9)
  // a valid manifold: Repair (which runs the kernel's manifold check) accepts it
  await meshTool(app, 'Repair')
  await app.ok()
  await ok(app)
})

// ------------------------------------------------------------------------------------------------ 4 an STL bracket

test('STL bracket: a 5 mm hole through the vertical leg, cut with a solid post and Combine', async ({ app }) => {
  // WORKAROUND: there is no Convert Mesh to B-rep, so the bracket stays a mesh. The Fusion route (sketch a circle on the leg, Extrude cut) fails: the click on the profile also picks the
  // mesh face behind it as a profile and Extrude stops with "Expected a B-rep body" (see the next test). The hole is a 5 mm square post (Box) cut out with Combine > Cut instead, so it is square, not round
  test.setTimeout(200000)
  await app.open()
  const bracket = lBracketTris(20)
  const v0 = triVolume(bracket)
  await importStl(app, writeStl('bracket', bracket))
  relNear((await meshStats(app)).signedVolume, v0, 0.001)
  await seedBox(app, 5, 5, 30, [2.5, 17.5, -5])
  await app.tab('Solid')
  await app.ribbon('Combine').first().click()
  await useNth(app, 'Target body', /bracket/, 0)
  await useNth(app, 'Tool bodies', /Box/, 0)
  await app.inspector().getByRole('radio', { name: 'Cut' }).click()
  await app.ok()
  await ok(app)
  expect((await bodyIds(app)).length).toBe(1)
  expect((await geom(app))[0].kind).toBe('mesh')
  relNear(await app.volume(), v0 - 5 * 5 * 20, 0.01)
})

test('STL bracket: sketch on the mesh face and Extrude cut through it', async ({ app }) => {
  // GAP: the sketch opens on the mesh face, but Extrude then fails with "Expected a B-rep body" (the click on the profile also takes the mesh face as a profile): a Fusion user sketches on the face of the part
  test.fail()
  test.setTimeout(120000)
  await app.open()
  const bracket = lBracketTris(20)
  await importStl(app, writeStl('bracket', bracket))
  await sketchOnFace(app, [5, 20, 20])
  const pl = await planeOf(app)
  const [lx, ly] = toLocal(pl, [5, 20, 20])
  await skCircle(app, lx, ly, 5)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await clickWorld(app, [5, 20, 20])
  await app.field('Distance', '-20')
  await app.inspector().locator('.sel').first().click()
  await app.page.getByRole('option', { name: 'Cut' }).click()
  await app.ok()
  await ok(app)
})

test('STL bracket: fillet the inside corner (needs the mesh as a solid)', async ({ app }) => {
  // GAP: Fillet says "Fillet and Chamfer need a solid body ... not a mesh"; Fusion converts the mesh to a B-rep first (Convert Mesh), which does not exist here
  test.fail()
  test.setTimeout(120000)
  await app.open()
  await importStl(app, writeStl('bracket', lBracketTris(20)))
  await app.tab('Solid')
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, [10, 10, 10])
  await app.field('Radius', '3')
  await app.ok()
  expect((await featStates(app)).pop()).toMatch(/:ok$/)
  expect(await app.volume()).toBeLessThan(12000)
})

test('STL bracket: Convert Mesh to B-rep from the Mesh tab, then fillet', async ({ app }) => {
  // GAP: not in the Mesh tab (the prismatic conversion of an STL bracket to planes and cylinders is the route a Fusion user takes)
  test.fail()
  await app.open()
  await importStl(app, writeStl('bracket', lBracketTris(20)))
  expect(await ribbonEntries(app, 'Mesh')).toMatch(/Convert Mesh|Mesh to B-?rep/i)
})

// ------------------------------------------------------------------------------------------------ 5 text engraved into an STL, then 3MF

test('STL name plate: engrave text into the top face, export 3MF with the engraving in it', async ({ app }) => {
  test.setTimeout(240000)
  await app.open()
  const plate = writeStl('plate', (await import('./mesh-kit')).boxTris(60, 30, 6, [0, 0, 0], 6))
  await importStl(app, plate)
  const v0 = await app.volume()
  await clickWorld(app, [30, 15, 6])
  expect((await selection(app))[0].kind).toBe('face')
  await app.tab('Detail')
  await app.ribbon(/^Text$/).first().click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Text and logos')
  await app.inspector().getByRole('radio', { name: /Engrave/ }).click()
  await app.field('Text height', '8')
  await app.inspector().getByTestId('text-text').fill('CAD')
  await app.page.waitForTimeout(1500)
  await app.ok()
  await ok(app)
  expect((await bodyIds(app)).length).toBe(1)
  const v1 = await app.volume()
  expect(v1).toBeLessThan(v0 - 5) // letters were cut out
  expect(v1).toBeGreaterThan(v0 * 0.9)
  // export the part as 3MF and read the file back: one object, the triangles of the engraved mesh
  const tris = (await geom(app))[0].tris
  await app.tab('Solid')
  await app.ribbon('Export').first().click()
  await app.inspector().getByRole('radio', { name: '3MF' }).click()
  const dlp = app.page.waitForEvent('download', { timeout: 30000 }).catch(async () => { throw new Error('no download; toasts: ' + (await app.page.locator('.toast').allInnerTexts()).join(' | ')) })
  await app.ok()
  const dl = await dlp
  const f = path.join(os.tmpdir(), 'caddy-mesh-plate.3mf')
  await dl.saveAs(f)
  const zip = unzipSync(new Uint8Array(fs.readFileSync(f)))
  const model = Buffer.from(zip['3D/3dmodel.model']).toString('utf8')
  expect((model.match(/<triangle /g) ?? []).length).toBe(tris)
  expect(model).toContain('unit="millimeter"')
})

// ------------------------------------------------------------------------------------------------ 6 mixed

test('Inch STL: the scan was made in inches, Scale 25.4 in the Insert step brings it to millimetres', async ({ app }) => {
  // WORKAROUND: no units choice on Insert; the user edits the Scale number of the Insert step in the timeline afterwards
  await app.open()
  await importStl(app, writeStl('inch', (await import('./mesh-kit')).boxTris(2, 1, 0.5, [0, 0, 0], 1)))
  await app.page.locator('.tl .chip').first().dblclick()
  await app.field('Scale', '25.4')
  await app.ok()
  const bb = await app.bbox()
  expect(bb.max[0]).toBeCloseTo(50.8, 2)
  expect(bb.max[2]).toBeCloseTo(12.7, 2)
  await esc2(app)
  await settle(app)
})
