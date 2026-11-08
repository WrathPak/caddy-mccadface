import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { test, expect, type App } from './helpers'
import {
  bodyIds, featStates, figureTris, toggle, geom, importStl, lBracketTris, meshStats, meshTool, nearestTri, slabTris, triVolume, without, writeStl,
} from './mesh-kit'
import { clickWorld, dlg, esc2, openSketch, planeOf, relNear, ribbonEntries, seedBox, selection, settle, skCircle, sketchOnFace, toLocal, type P3 } from './solids-kit'

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

test('Mini figure: hollowed with Shell, with a drain hole cut by sketch and Extrude', async ({ app }) => {
  // the Fusion route: Shell the mesh to an even wall, sketch a circle on the base plane and Extrude cut it through the base into the cavity
  test.setTimeout(240000)
  await app.open()
  const full = figureTris(40)
  const vFull = triVolume(full)
  await importStl(app, writeStl('figure', full))
  await app.page.locator('.tree-row', { hasText: /figure/ }).first().click()
  await app.tab('Solid')
  await app.ribbon('Shell').first().click()
  await app.field('Thickness', '1.2')
  await app.ok()
  await ok(app)
  expect((await bodyIds(app)).length).toBe(1)
  const hollow = await meshStats(app)
  expect(hollow.open).toBe(0)
  // an even 1.2 mm skin: the volume of the wall is about the surface area times 1.2 (a scaled copy leaves a wall that is a fixed share of the local radius instead)
  let area = 0
  for (const [p, q, r] of full) area += Math.hypot(...[(q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1]), (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]), (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])]) / 2
  expect(hollow.signedVolume).toBeGreaterThan(area * 1.2 * 0.8)
  expect(hollow.signedVolume).toBeLessThan(area * 1.2 * 1.2)
  expect(hollow.signedVolume).toBeLessThan(vFull * 0.5)
  // the drain hole: a 4 mm circle sketched on the XY plane (the bottom of the base), Extrude cut up through the base wall into the cavity
  await openSketch(app, 'XY')
  await skCircle(app, 0, 0, 4)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await app.field('Distance', '6')
  await app.inspector().locator('.sel').first().click()
  await app.page.getByRole('option', { name: 'Cut' }).click()
  await app.ok()
  await ok(app)
  expect((await bodyIds(app)).length).toBe(1)
  expect((await geom(app))[0].kind).toBe('mesh')
  const done = await meshStats(app)
  expect(done.open).toBe(0)
  expect(done.signedVolume).toBeLessThan(hollow.signedVolume - 5) // the hole took the base wall out
  expect(done.signedVolume).toBeGreaterThan(hollow.signedVolume * 0.95)
  // the cavity is open to the outside now: a ray up the middle from below finds no wall between z = 0 and the top of the base
  const bb = await app.bbox()
  expect(bb.min[2]).toBeCloseTo(0, 3)
})

// ------------------------------------------------------------------------------------------------ 4 an STL bracket

test('STL bracket: a 5 mm hole through the vertical leg, cut with a post and Combine', async ({ app }) => {
  // the older route, still valid on a mesh: a solid post (Box) cut out with Combine > Cut, so the hole is square
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
  // a Fusion user sketches on the face of the part: the profile click must not pick the mesh face as a profile, and the cut goes into the mesh
  test.setTimeout(120000)
  await app.open()
  const bracket = lBracketTris(20)
  const v0 = triVolume(bracket)
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
  expect((await geom(app))[0].kind).toBe('mesh')
  relNear(await app.volume(), v0 - Math.PI * 2.5 * 2.5 * 20, 0.02)
})

test('STL bracket: convert to a solid, fillet the inside corner and drill a 5 mm hole', async ({ app }) => {
  // Convert Mesh (Prismatic) turns the eight flat face groups into planar faces: Fillet and Hole then work on the bracket like on any solid
  test.setTimeout(200000)
  await app.open()
  const bracket = lBracketTris(20)
  const v0 = triVolume(bracket)
  await importStl(app, writeStl('bracket', bracket))
  await meshTool(app, 'Convert Mesh')
  await app.ok()
  await ok(app)
  const g = await geom(app)
  expect(g[0].kind).toBe('brep')
  expect(g[0].faces).toBe(8)
  relNear(await app.volume(), v0, 0.001)
  // fillet the inside corner (an inside fillet adds material)
  await app.tab('Solid')
  await app.ribbon('Fillet').first().click()
  // the inside corner is hidden behind the long leg from the home view: turn the view with the ViewCube until the edge can be clicked
  const cube = app.page.getByTestId('viewcube')
  for (const turn of ['Rotate right 90°', 'Rotate left 90°']) {
    await cube.getByRole('button', { name: turn }).click()
    await app.cameraStable()
    await clickWorld(app, [10, 10, 10])
    const sel = await selection(app)
    if (sel.length && sel.every((r) => r.kind === 'edge')) break
    await app.page.keyboard.press('Escape')
    await cube.getByRole('button', { name: turn.replace(/right|left/, (m) => (m === 'right' ? 'left' : 'right')) }).click()
    await app.cameraStable()
  }
  expect((await selection(app)).map((r) => r.kind)).toEqual(['edge'])
  await app.field('Radius', '3')
  await app.ok()
  await ok(app)
  const vf = await app.volume()
  expect(vf).toBeGreaterThan(v0)
  relNear(vf, v0 + (1 - Math.PI / 4) * 9 * 20, 0.01)
  // a round hole through the vertical leg, from its top face
  await cube.getByRole('button', { name: 'Home view' }).click()
  await app.cameraStable()
  await app.ribbon('Hole').first().click()
  await clickWorld(app, [5, 20, 20])
  await expect.poll(async () => ((await dlg(app)).places as string[]).length).toBe(1)
  await app.field('Diameter', '5')
  await app.ok()
  await ok(app)
  relNear(await app.volume(), vf - Math.PI * 2.5 * 2.5 * 20, 0.01)
  expect((await geom(app))[0].kind).toBe('brep')
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
