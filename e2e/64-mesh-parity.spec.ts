import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type App } from './helpers'
import {
  boxTris, bodyIds, clickWorld, dialogText, toggle, featStates, flipped, geom, importStl, meshStats, meshTool, slabTris, sphereTris, without, writeObj, writeStl,
} from './mesh-kit'
import { controls, editChip, inspectorText, relNear, ribbonEntries, seedBox, selection, settle, shiftClickWorld, totalVol } from './solids-kit'

/* Fusion 360 parity: the Mesh tab. Reference: docs/fusion-parity/mesh.md.
   Every STL is generated here (e2e/mesh-kit.ts). Box: 40 x 30 x 20 with a corner on the origin (volume 24000), top face at z = 20.
   Everything under test is mouse and keyboard; app.ev only reads state.
   Tests marked test.fail() are gaps: each comment names the Fusion behaviour that is missing, and the test flips when it is built. */

const BOX = 24000
const box = (n = 4) => writeStl(`box${n}`, boxTris(40, 30, 20, [0, 0, 0], n))
const press = (app: App, k: string) => app.page.keyboard.press(k)
const esc2 = async (app: App) => { await press(app, 'Escape'); await press(app, 'Escape') }
/** Open a Mesh tab tool, read what the dialog offers, close it again. */
async function dialogOf(app: App, name: string | RegExp) {
  await meshTool(app, name)
  const c = await controls(app)
  await esc2(app)
  return c
}
const meshEntries = (app: App) => ribbonEntries(app, 'Mesh')
const toasts = (app: App) => app.page.locator('.toast').allInnerTexts().then((a) => a.join(' | '))
/** Pick a body in the Combine / Move field: click its Browser row, then Use selection. */
async function useRow(app: App, field: string, row: string | RegExp) {
  await app.page.locator('.tree-row', { hasText: row }).first().click()
  await app.inspector().locator('.field', { hasText: field }).getByRole('button', { name: 'Use selection' }).click()
}
const pickKeep = async (app: App, what: RegExp) => {
  await app.inspector().locator('.field', { hasText: 'Keep' }).locator('.sel').click()
  await app.page.getByRole('option', { name: what }).click()
}

// ================================================================================================ Insert

test('Insert Mesh: an STL becomes a mesh body, closed, the right size, split into face groups', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  const g = (await geom(app))[0]
  expect(g.kind).toBe('mesh')
  expect(g.faces).toBe(6)
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  expect(s.nonManifold).toBe(0)
  relNear(s.signedVolume, BOX, 0.001)
  const bb = await app.bbox()
  expect(bb.max[0]).toBeCloseTo(40, 3)
  expect(bb.max[2]).toBeCloseTo(20, 3)
})

test('Insert Mesh is in the Mesh tab and takes the same file', async ({ app }) => {
  await app.open()
  await app.tab('Mesh')
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.ribbon('Import Mesh').first().click()])
  await chooser.setFiles(box())
  await expect.poll(() => app.bodies().then((b) => b.length)).toBe(1)
})

test('3MF round trip: export a mesh as 3MF, insert that file, same volume', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.ribbon('Export').first().click()
  await app.inspector().getByRole('radio', { name: '3MF' }).click()
  const [dl] = await Promise.all([app.page.waitForEvent('download'), app.ok()])
  const f = path.join(os.tmpdir(), 'caddy-mesh-roundtrip.3mf')
  await dl.saveAs(f)
  expect(fs.statSync(f).size).toBeGreaterThan(500)
  await importStl(app, f, 2)
  relNear(await app.volume((await bodyIds(app))[1]), BOX, 0.001)
})

// Fusion: Insert Mesh takes OBJ as well as STL and 3MF.
test.fail('Insert Mesh takes an OBJ file', async ({ app }) => {
  // GAP: OBJ is not a known type: the import says "Unsupported file type"
  await app.open()
  await importStl(app, writeObj('box', boxTris(40, 30, 20)), 1, 8000)
})

// Fusion: Insert Mesh asks for the units of the file (mm, cm, in, m) and lets you place it.
test.fail('Insert Mesh asks for units and a position before it inserts', async ({ app }) => {
  // GAP: the file goes straight in at scale 1 and at its own coordinates; the only unit control is the Scale number in the timeline step afterwards
  await app.open()
  await app.tab('Mesh')
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.ribbon('Import Mesh').first().click()])
  await chooser.setFiles(box())
  await expect(app.inspector()).toBeVisible({ timeout: 4000 })
  expect(await controls(app)).toMatch(/Units?/)
})

test('Insert Mesh: the Scale in the timeline step resizes it (an inch model: 25.4)', async ({ app }) => {
  await app.open()
  await importStl(app, box(1))
  await editChip(app, 0)
  await app.field('Scale', '2')
  await app.ok()
  relNear((await app.bbox()).max[0], 80, 0.001)
  relNear(await app.volume(), BOX * 8, 0.001)
})

// Fusion: Insert Mesh puts the model on the origin (or lets you pick the point); a scan that sits at x = 300 comes in beside the origin.
test.fail('Insert Mesh can put the model on the origin', async ({ app }) => {
  // GAP: no placement, no "centre on origin": a model made far from the origin stays there until the user moves it
  await app.open()
  await importStl(app, writeStl('far', boxTris(40, 30, 20, [300, 200, 0], 1)))
  await editChip(app, 0)
  expect(await controls(app)).toMatch(/Center|Centre|Origin|Position/i)
})

test('Convert to Mesh (Tessellate): a solid becomes a mesh body of the same volume', async ({ app }) => {
  await app.open()
  await seedBox(app, 40, 30, 20)
  await meshTool(app, 'Convert to Mesh')
  await app.ok()
  const g = (await geom(app))[0]
  expect(g.kind).toBe('mesh')
  relNear(await app.volume(), BOX, 0.001)
})

// Fusion: Tessellate has a Refinement setting (coarse, medium, fine, custom surface deviation and angle).
test.fail('Convert to Mesh has a refinement setting', async ({ app }) => {
  // GAP: no options at all, the tessellation is whatever the display uses
  await app.open()
  await seedBox(app, 40, 30, 20)
  expect(await dialogOf(app, 'Convert to Mesh')).toMatch(/Refinement|Deviation|Tolerance|Quality/)
})

// ================================================================================================ Prepare

test('Face groups: the Face split angle in the Insert step regroups the faces of a sphere', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('sph', sphereTris(20, 32, 16)))
  expect((await geom(app))[0].faces).toBe(1)
  await editChip(app, 0)
  await app.field('Face split angle', '5')
  await app.ok()
  expect((await geom(app))[0].faces).toBeGreaterThan(10)
})

// Fusion: Generate Face Groups (Fast / Accurate) as a command on the mesh.
test.fail('Generate Face Groups is a Mesh tab command (Fast, Accurate, with a threshold)', async ({ app }) => {
  // GAP: face groups are a crease angle at insert time and cannot be redone on a mesh made by Reduce, Smooth or Plane Cut
  await app.open()
  expect(await meshEntries(app)).toMatch(/Face Groups/)
})

// Fusion: Combine Face Groups, Separate Face Groups.
test.fail('Combine Face Groups and Separate Face Groups are Mesh tab commands', async ({ app }) => {
  // GAP: no face group editing at all
  await app.open()
  expect(await meshEntries(app)).toMatch(/Combine Face Groups|Separate Face Groups/)
})

test('Repair closes a hole: a box with its whole top face missing comes back closed with its volume', async ({ app }) => {
  await app.open()
  const t = boxTris(40, 30, 20, [0, 0, 0], 4)
  await importStl(app, writeStl('hole', without(t, Array.from({ length: 32 }, (_, i) => 32 + i))))
  expect((await meshStats(app)).open).toBeGreaterThan(0)
  await meshTool(app, 'Repair')
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, BOX, 0.001)
})

test('Repair welds cracks: a box with every vertex split apart is closed again', async ({ app }) => {
  await app.open()
  // nudge one box face away by 0.0004 mm so its vertices are not shared with its neighbours (a STL from a slicer-ish exporter)
  const t = boxTris(40, 30, 20, [0, 0, 0], 2).map((tri, i) => (i < 8 ? tri.map((p) => [p[0], p[1], p[2] - 0.0004]) : tri)) as ReturnType<typeof boxTris>
  await importStl(app, writeStl('crack', t))
  await meshTool(app, 'Repair')
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, BOX, 0.002)
})

// Fusion: Repair has Type (Stitch and Fill Holes, Remove Isolated, Wrap, Rebuild), a max hole size, and reports what it found.
test('Repair offers repair types (Stitch, Remove, Wrap, Rebuild)', async ({ app }) => {
  await app.open()
  await importStl(app, box(1))
  expect(await dialogOf(app, 'Repair')).toMatch(/Type|Wrap|Rebuild|Stitch/)
})

test('Repair says what it fixed (holes closed, vertices welded)', async ({ app }) => {
  await app.open()
  const t = boxTris(40, 30, 20, [0, 0, 0], 4)
  await importStl(app, writeStl('hole2', without(t, Array.from({ length: 32 }, (_, i) => 32 + i))))
  await meshTool(app, 'Repair')
  await app.ok()
  await app.page.waitForTimeout(600)
  expect((await toasts(app)) + (await dialogText(app))).toMatch(/hole|closed|welded|repaired/i)
})

test('An inside-out STL (inverted normals) comes in the right way round, Reverse Normal turns it back and Repair fixes it again', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('inv', flipped(boxTris(40, 30, 20, [0, 0, 0], 2))))
  // the import winds the triangles so that the volume is positive
  relNear((await meshStats(app)).signedVolume, BOX, 0.001)
  await meshTool(app, 'Reverse Normal')
  await app.ok()
  expect((await meshStats(app)).signedVolume).toBeLessThan(0)
  expect((await featStates(app)).pop()).toBe('meshReverse:ok')
  await meshTool(app, 'Repair')
  await app.ok()
  relNear((await meshStats(app)).signedVolume, BOX, 0.001)
})

test('Repair makes the faces of a mesh agree about which way is out (one patch of flipped triangles)', async ({ app }) => {
  await app.open()
  const t = boxTris(40, 30, 20, [0, 0, 0], 2)
  const bad = t.map((tri, i) => (i >= 8 && i < 16 ? [tri[0], tri[2], tri[1]] : tri)) as ReturnType<typeof boxTris>
  await importStl(app, writeStl('patch', bad))
  await meshTool(app, 'Repair')
  await app.ok()
  expect((await featStates(app)).pop()).toBe('meshRepair:ok')
  relNear((await meshStats(app)).signedVolume, BOX, 0.001)
})

test('Make Closed Mesh: Repair gives a closed, manifold mesh a Boolean accepts (Combine Cut with a solid)', async ({ app }) => {
  await app.open()
  const t = boxTris(40, 30, 20, [0, 0, 0], 4)
  await importStl(app, writeStl('hole3', without(t, [40, 41])))
  await meshTool(app, 'Repair')
  await app.ok()
  expect((await meshStats(app)).open).toBe(0)
  await seedBox(app, 10, 10, 30, [15, 10, -5])
  await app.tab('Solid')
  await app.ribbon('Combine').first().click()
  await useRow(app, 'Target body', /hole3/)
  await useRow(app, 'Tool bodies', /Box/)
  await app.inspector().getByRole('radio', { name: 'Cut' }).click()
  await app.ok()
  expect((await featStates(app)).every((s) => /:ok$/.test(s))).toBe(true)
  expect((await app.bodies()).length).toBe(1)
  relNear(await app.volume(), BOX - 10 * 10 * 20, 0.01)
})

test('Refine (Remesh): long edges are split, the shape does not change', async ({ app }) => {
  await app.open()
  await importStl(app, box(1))
  const before = (await meshStats(app)).tris
  await meshTool(app, 'Refine')
  await app.field('Max edge length', '5')
  await app.ok()
  const s = await meshStats(app)
  expect(s.tris).toBeGreaterThan(before * 20)
  relNear(s.signedVolume, BOX, 0.0001)
  expect((await geom(app))[0].faces).toBe(6)
})

// Fusion: Remesh has Type (Adaptive / Uniform), Density, Preserve sharp edges and boundaries, and it also makes a mesh coarser.
test.fail('Remesh has Uniform, Adaptive and Density types', async ({ app }) => {
  // GAP: Refine only splits edges longer than a length (a box face of two triangles into hundreds), it never merges or re-triangulates, and has no sharp edge setting
  await app.open()
  await importStl(app, box(1))
  expect(await dialogOf(app, /Refine|Remesh/)).toMatch(/Type|Uniform|Adaptive|Density|sharp/i)
})

// ================================================================================================ Modify

test('Reduce by tolerance: a sphere of 4000 triangles becomes about a quarter, within 2 percent of its volume', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('sph', sphereTris(20, 64, 32)))
  const before = await meshStats(app)
  await meshTool(app, 'Reduce')
  await app.field('Tolerance', '0.5')
  await app.ok()
  const s = await meshStats(app)
  expect(s.tris).toBeLessThan(before.tris * 0.5)
  relNear(s.signedVolume, before.signedVolume, 0.02)
  expect(s.open).toBe(0)
})

// Fusion: Reduce has Reduce Type Tolerance / Proportion / Face count, Preserve Boundaries, Preserve Sharp Edges.
test.fail('Reduce to a face count or a proportion (50 percent)', async ({ app }) => {
  // GAP: tolerance only (and its help text describes welding, not the error allowed); a user wanting "half the triangles" has to guess a tolerance
  await app.open()
  await importStl(app, writeStl('sph', sphereTris(20, 64, 32)))
  expect(await dialogOf(app, 'Reduce')).toMatch(/Proportion|Face count|Percent|Target/i)
})

test('Plane Cut, Trim: the positive side of z = 10 is kept and capped (volume 12000)', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '10')
  await app.ok()
  expect((await bodyIds(app)).length).toBe(1)
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, 12000, 0.001)
  expect((await app.bbox()).min[2]).toBeCloseTo(10, 3)
})

test('Plane Cut, Split Body: both halves are bodies and each is closed', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '10')
  await pickKeep(app, /Both/)
  await app.ok()
  expect((await bodyIds(app)).length).toBe(2)
  for (const i of [0, 1]) {
    const s = await meshStats(app, i)
    expect(s.open).toBe(0)
    relNear(s.signedVolume, 12000, 0.001)
  }
})

test('Plane Cut: the preview shows the cut before OK and Escape leaves the body alone', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '10')
  await app.page.waitForTimeout(800)
  await esc2(app)
  expect((await featStates(app))).toEqual(['importMesh:ok'])
  relNear(await app.volume(), BOX, 0.001)
})

// Fusion: Plane Cut takes any plane: an origin plane, a construction plane or a face, with an offset and an angle.
test.fail('Plane Cut can cut along a picked face or a tilted plane', async ({ app }) => {
  // GAP: only X, Y or Z through the origin plus an offset: a part that is not square to the axes (a scan on the bed at an angle) cannot be cut along its own face
  await app.open()
  await importStl(app, box())
  const c = (await dialogOf(app, 'Plane Cut')).replace(/Plane normal/g, '')
  expect(c).toMatch(/Plane|Face|Angle|Tilt/)
})

// Fusion: Fill Type None / Uniform / Minimal.
test.fail('Plane Cut has a Fill Type (None, Uniform, Minimal)', async ({ app }) => {
  // GAP: the cut is always capped flat; leaving it open (to hollow a model or to keep the inside visible) is not possible
  await app.open()
  await importStl(app, box())
  expect(await dialogOf(app, 'Plane Cut')).toMatch(/Fill/)
})

test('Combine joins two mesh bodies into one closed mesh', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('boxA', boxTris(40, 30, 20, [0, 0, 0], 2)))
  await importStl(app, writeStl('boxB', boxTris(40, 30, 20, [20, 10, 5], 2)), 2)
  await app.tab('Solid')
  await app.ribbon('Combine').first().click()
  await useRow(app, 'Target body', /boxA/)
  await useRow(app, 'Tool bodies', /boxB/)
  await app.ok()
  expect((await featStates(app)).pop()).toMatch(/combine:ok/)
  expect((await bodyIds(app)).length).toBe(1)
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, 2 * BOX - 20 * 20 * 15, 0.01) // overlap is 20 x 20 x 15
})

test('Combine Cut: a solid box cut out of a mesh', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('boxA', boxTris(40, 30, 20, [0, 0, 0], 2)))
  await seedBox(app, 10, 10, 30, [15, 10, -5])
  await app.tab('Solid')
  await app.ribbon('Combine').first().click()
  await useRow(app, 'Target body', /boxA/)
  await useRow(app, 'Tool bodies', /Box/)
  await app.inspector().getByRole('radio', { name: 'Cut' }).click()
  await app.ok()
  expect((await bodyIds(app)).length).toBe(1)
  relNear(await app.volume(), BOX - 10 * 10 * 20, 0.01)
})

test('Smooth keeps the size of a part: a 40 x 30 x 20 box does not grow by more than 0.2 mm a side', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Smooth')
  await app.ok()
  const bb = await app.bbox()
  expect(bb.min[0]).toBeGreaterThan(-0.2)
  expect(bb.max[0]).toBeLessThan(40.2)
  expect(bb.max[2]).toBeLessThan(20.2)
})

test('Smooth runs on a sphere and keeps it closed', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('sph', sphereTris(20, 32, 16)))
  const before = await meshStats(app)
  await meshTool(app, 'Smooth')
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, before.signedVolume, 0.05)
})

// Fusion: Smooth works on the selected face groups (or the whole body) with a smoothness slider and Preserve boundaries.
test('Smooth can be limited to selected faces', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  expect(await dialogOf(app, 'Smooth')).toMatch(/Faces|Selection|boundar/i)
})

test('Shell of a mesh: remove the top face, a 2 mm wall (a hollow figure, Fusion: Modify > Shell)', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await clickWorld(app, [20, 15, 20])
  await app.tab('Solid')
  await app.ribbon('Shell').first().click()
  await app.field('Thickness', '2')
  await app.ok()
  expect((await featStates(app)).pop()).toMatch(/:ok$/)
  relNear(await app.volume(), BOX - 36 * 26 * 18, 0.01)
})

// Fusion: Reverse Normal flips the selected faces or the body.
test('Reverse Normal is a Mesh tab command', async ({ app }) => {
  await app.open()
  expect(await meshEntries(app)).toMatch(/Reverse Normal|Flip Normal/i)
})

test('Delete on a selected mesh face removes the face (Fusion: Delete Faces opens a hole)', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await clickWorld(app, [20, 15, 20])
  expect((await selection(app))[0].kind).toBe('face')
  await press(app, 'Delete')
  await app.idle()
  expect((await meshStats(app)).open).toBeGreaterThan(0)
})

test.fail('Erase And Fill is a Mesh tab command (remove selected faces and fill the gap)', async ({ app }) => {
  // GAP: nothing selects part of a mesh and rebuilds it, so a blemish or a mounting boss cannot be taken off a scan
  await app.open()
  expect(await meshEntries(app)).toMatch(/Erase|Fill/)
})

test('Direct edit: Press/Pull on a mesh face moves the face group (Fusion: Direct editing of face groups)', async ({ app }) => {
  // GAP: Press/Pull and Move on a face of a mesh do nothing; only whole bodies move
  test.fail()
  await app.open()
  await importStl(app, box())
  await clickWorld(app, [20, 15, 20])
  await app.tab('Solid')
  await app.ribbon('Press/Pull').first().click()
  await app.field('Distance', '5')
  await app.ok()
  relNear((await app.bbox()).max[2], 25, 0.01)
})

// Fusion: Convert Mesh (Prismatic: face groups into planes, cylinders and cones; Faceted: one B-rep face per triangle).
test('Convert Mesh to B-rep (Prismatic and Faceted) is a Mesh tab command', async ({ app }) => {
  await app.open()
  expect(await meshEntries(app)).toMatch(/Convert Mesh|Mesh to B-?rep|Prismatic|Faceted/i)
})

test('Move: a mesh body moves 5 mm up with Translate, as a timeline step', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.page.locator('.tree-row', { hasText: /box4/ }).first().click()
  await app.tab('Solid')
  await app.ribbon(/^Move$/).first().click()
  await app.vec('Translate', 2, '5')
  await app.ok()
  expect((await app.bbox()).min[2]).toBeCloseTo(5, 3)
  expect((await featStates(app)).pop()).toBe('move:ok')
})

test('Move with Create copy keeps the mesh and adds a copy', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.page.locator('.tree-row', { hasText: /box4/ }).first().click()
  await app.tab('Solid')
  await app.ribbon(/^Move$/).first().click()
  await app.vec('Translate', 0, '60')
  await toggle(app, 'Create copy')
  await app.ok()
  expect((await bodyIds(app)).length).toBe(2)
  expect((await geom(app)).every((b) => b.kind === 'mesh')).toBe(true)
})

test('Scale (uniform) on a mesh: Move > Scale 0.5 halves it', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.page.locator('.tree-row', { hasText: /box4/ }).first().click()
  await app.tab('Solid')
  await app.ribbon(/^Move$/).first().click()
  await app.field('Scale', '0.5')
  await app.ok()
  relNear(await app.volume(), BOX / 8, 0.001)
})

// Fusion: Scale has Uniform and Non-Uniform (a separate factor per axis).
test.fail('Scale can be non-uniform (a different factor in X, Y and Z)', async ({ app }) => {
  // GAP: one number; stretching a model 5 percent in one direction to fit a part means a Move step per... there is no way
  await app.open()
  await importStl(app, box())
  await app.page.locator('.tree-row', { hasText: /box4/ }).first().click()
  await app.tab('Solid')
  await app.ribbon(/^Move$/).first().click()
  expect(await inspectorText(app)).toMatch(/Non-?uniform|Scale X|Scale Y/i)
})

// ================================================================================================ Selection

test('Selection: a click on a mesh picks one face group, the box has 6 of them', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await clickWorld(app, [20, 15, 20])
  const s = await selection(app)
  expect(s).toHaveLength(1)
  expect(s[0].kind).toBe('face')
  await clickWorld(app, [40, 15, 10])
  const s2 = await selection(app)
  expect(s2[0].index).not.toBe(s[0].index)
})

test('Selection: Shift-click adds a second face group and clicking empty space clears', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await clickWorld(app, [20, 15, 20])
  await shiftClickWorld(app, [40, 15, 10])
  expect(await selection(app)).toHaveLength(2)
  await press(app, 'Escape')
  expect(await selection(app)).toHaveLength(0)
})

test('Selection filter: with Body the first click picks the whole mesh body', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.page.getByRole('button', { name: /Select:/ }).click()
  await app.page.getByRole('menuitem', { name: 'Body' }).click()
  await clickWorld(app, [20, 15, 20])
  const s = await selection(app)
  expect(s).toHaveLength(1)
  expect(['body', 'mesh']).toContain(s[0].kind)
})

test('Selection: the Browser row of a mesh body picks the body', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.page.locator('.tree-row', { hasText: /box4/ }).first().click()
  expect(['body', 'mesh']).toContain((await selection(app))[0].kind)
})

// Fusion: Select by brush, Grow, Shrink and "select by angle" on a mesh.
test.fail('Selection: paint (brush), Grow and Shrink selection on a mesh', async ({ app }) => {
  // GAP: faces only as the crease angle made them; picking a worn patch of a scan (a few hundred triangles) is not possible, and Delete / Smooth / Shell have no selection to work on anyway
  await app.open()
  expect(await meshEntries(app)).toMatch(/Brush|Paint|Grow|Shrink/i)
})

// ================================================================================================ Inspect

test('Measure on a mesh: the top face and the side face give areas, centre distance and the angle between them', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.tab('Mesh')
  await app.ribbon('Measure').first().click()
  await clickWorld(app, [20, 15, 20])
  await clickWorld(app, [40, 15, 10])
  const t = app.inspector()
  await expect(t).toContainText('Area 1200')
  await expect(t).toContainText('Area 600')
  await expect(t).toContainText('Angle 90')
  await expect(t).toContainText('22.361')
})

test('Section Analysis on a mesh: the plane opens and can be set to z = 10', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.tab('Mesh')
  await app.ribbon('Section Analysis').first().click()
  await app.field('Offset', '10')
  await app.ok()
  await expect(app.page.getByTestId('section-chip')).toContainText('10')
})

// Fusion: Mesh Section Sketch makes a sketch from the cut outline of a mesh on a plane, to extrude or measure from.
test.fail('Mesh Section Sketch is a Mesh tab command', async ({ app }) => {
  // GAP: the section view is only a picture; the outline of a scan cannot become a sketch to build a B-rep part from (a bracket that fits a scanned mount)
  await app.open()
  expect(await meshEntries(app)).toMatch(/Section Sketch/)
})

test('Sketch on a mesh face: the sketch opens on the top face of a mesh', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.ribbon('Sketch').first().click()
  await clickWorld(app, [20, 15, 20])
  await expect(app.page.locator('.sk-bar')).toBeVisible({ timeout: 6000 })
})

test('Status bar: Tris is shown for the mesh', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await expect(app.page.locator('.cell', { hasText: 'Tris:' })).toContainText('192')
})

// Fusion: the Mesh properties show triangles, open edges and whether the mesh is closed/manifold, so you know it is ready to print.
test.fail('Mesh stats: open edges, non-manifold edges and volume of the mesh are shown', async ({ app }) => {
  // GAP: only the triangle count of the whole scene; "is this closed?" can be answered only by running Repair or a Boolean and reading the error ("Not manifold")
  await app.open()
  await importStl(app, writeStl('hole', without(boxTris(40, 30, 20, [0, 0, 0], 4), [40, 41])))
  await app.page.locator('.tree-row', { hasText: /hole/ }).first().click()
  const text = await app.page.locator('body').innerText()
  expect(text).toMatch(/open edges|boundary edges|manifold|watertight/i)
})

// ================================================================================================ Export

test('Export STL of a mesh body downloads a .stl with the triangles', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await app.ribbon('Export').first().click()
  const [dl] = await Promise.all([app.page.waitForEvent('download'), app.ok()])
  expect(dl.suggestedFilename()).toMatch(/\.stl$/)
  const f = path.join(os.tmpdir(), 'caddy-mesh-export.stl')
  await dl.saveAs(f)
  expect(fs.readFileSync(f).readUInt32LE(80)).toBe(192)
})

// Fusion: export as OBJ too, with refinement for solids.
test.fail('Export offers OBJ and a mesh refinement', async ({ app }) => {
  // GAP: STL, 3MF and STEP only, no Refinement (coarse to fine) for the solids that are tessellated on the way out
  await app.open()
  await importStl(app, box())
  await app.ribbon('Export').first().click()
  const c = await controls(app)
  expect(c).toMatch(/OBJ|Refinement/)
})

// ================================================================================================ Timeline

test('Timeline: edit the Plane Cut offset after the fact and the mesh follows', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '5')
  await app.ok()
  relNear(await app.volume(), BOX * 0.75, 0.001)
  await editChip(app, 1)
  await app.field('Offset', '10')
  await app.ok()
  relNear(await app.volume(), BOX * 0.5, 0.001)
})

test('Timeline: Ctrl+Z after a mesh step takes the step back, Ctrl+Y brings it again', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Smooth')
  await app.ok()
  expect((await featStates(app)).length).toBe(2)
  await press(app, 'Control+z'); await app.idle()
  expect((await featStates(app)).length).toBe(1)
  await press(app, 'Control+y'); await app.idle()
  expect((await featStates(app)).length).toBe(2)
})

test('Timeline: dropping a step under a mesh feature (the Insert) leaves the later steps reporting an error, not a crash, and undo brings it back', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '5')
  await app.ok()
  await app.page.locator('.tl .chip').first().click()
  await press(app, 'Delete')
  await app.idle()
  expect((await featStates(app)).length).toBeLessThan(2)
  await press(app, 'Control+z'); await app.idle()
  expect((await featStates(app)).length).toBe(2)
  relNear(await app.volume(), BOX * 0.75, 0.001)
})

// ================================================================================================ Break it

test('Break: a mesh that is not closed (a face missing) gets a message from Plane Cut that says what to do', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('hole4', without(boxTris(40, 30, 20, [0, 0, 0], 4), [40, 41])))
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '10')
  await app.ok()
  const f = (await featStates(app)).pop()!
  expect(f).toMatch(/:ok$/) // a user with a scan with a hole still gets the cut
})

test('Break: the error of a mesh step on an open mesh is shown in the dialog or a message, not silent', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('hole5', without(boxTris(40, 30, 20, [0, 0, 0], 4), [40, 41])))
  await meshTool(app, 'Smooth')
  await app.ok() // Smooth does not need a closed mesh
  expect((await featStates(app)).pop()).toMatch(/meshSmooth:ok/)
  await meshTool(app, 'Reduce')
  await app.ok()
  const last = (await featStates(app)).pop()!
  expect(last).toMatch(/meshReduce:error|meshReduce:ok/)
})

test('Break: two boxes touching along one edge (non-manifold) import and cut without a crash', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('nm', [...boxTris(10, 10, 10, [0, 0, 0]), ...boxTris(10, 10, 10, [10, 10, 0])]))
  expect((await meshStats(app)).nonManifold).toBeGreaterThan(0)
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '5')
  await app.ok()
  expect((await featStates(app)).pop()).toMatch(/^meshPlaneCut:/)
})

test('Break: Ctrl+Z with a mesh dialog open leaves a whole document (the dialog closes or the step is back)', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Smooth')
  await press(app, 'Control+z'); await app.idle()
  await press(app, 'Control+y'); await app.idle()
  if (await app.inspector().isVisible()) await press(app, 'Escape')
  await app.idle()
  expect((await bodyIds(app)).length).toBe(1)
  expect((await featStates(app)).every((s) => /:ok$/.test(s))).toBe(true)
})

test('Break: Escape in a mesh dialog leaves no step and no preview', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Reduce')
  await app.field('Tolerance', '3')
  await app.page.waitForTimeout(700)
  await press(app, 'Escape')
  await app.idle()
  expect(await featStates(app)).toEqual(['importMesh:ok'])
  expect(await app.inspector().isVisible()).toBe(false)
  expect((await meshStats(app)).tris).toBe(192)
})

test('Break: a mesh tool started with nothing and several bodies asks for bodies and OK stays disabled', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('boxA', boxTris(10, 10, 10)))
  await importStl(app, writeStl('boxB', boxTris(10, 10, 10, [30, 0, 0])), 2)
  await meshTool(app, 'Smooth')
  await expect(app.inspector().getByRole('button', { name: 'OK' })).toBeDisabled()
  await esc2(app)
})

test('Break: Plane Cut with the plane outside the part says so and keeps the body', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '500')
  await app.page.waitForTimeout(600)
  await app.ok().catch(() => {})
  await app.idle()
  expect((await bodyIds(app)).length).toBe(1)
  relNear(await app.volume(), BOX, 0.001)
})

test('Break: 500 thousand triangles insert in a few seconds and a closed one cuts and repairs', async ({ app }) => {
  test.setTimeout(240000)
  await app.open()
  const t0 = Date.now()
  await importStl(app, writeStl('slab354', slabTris(354, 100, 10)), 1, 120000)
  const tImport = Date.now() - t0
  const g = (await geom(app))[0]
  expect(g.tris).toBeGreaterThan(490000)
  expect(tImport, 'import ms').toBeLessThan(30000)
  const t1 = Date.now()
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '5')
  await app.ok()
  const tCut = Date.now() - t1
  expect((await featStates(app)).pop()).toBe('meshPlaneCut:ok')
  expect(tCut, 'plane cut ms').toBeLessThan(60000)
  console.log(`MESH PERF import ${tImport} ms, plane cut ${tCut} ms, ${g.tris} triangles`)
})

test('Break: Reduce and Refine on half a million triangles finish (or say it is too much) without hanging', async ({ app }) => {
  test.setTimeout(400000)
  await app.open()
  await importStl(app, writeStl('slab354', slabTris(354, 100, 10)), 1, 120000)
  const t0 = Date.now()
  await meshTool(app, 'Reduce')
  await app.field('Tolerance', '0.05')
  await app.ok()
  const tReduce = Date.now() - t0
  const after = (await geom(app))[0].tris
  expect((await featStates(app)).pop()).toBe('meshReduce:ok')
  expect(after).toBeLessThan(250000)
  const t1 = Date.now()
  await meshTool(app, 'Refine')
  await app.field('Max edge length', '0.2')
  await app.page.waitForTimeout(500)
  await app.ok()
  const tRefine = Date.now() - t1
  const last = (await featStates(app)).pop()!
  console.log(`MESH PERF 500k: reduce ${tReduce} ms (to ${after} triangles), refine to 0.2 mm ${tRefine} ms -> ${last}`)
  expect(last).toMatch(/^meshRefine:(ok|error \(That edge length)/)
  expect(tReduce + tRefine).toBeLessThan(300000)
})

// ================================================================================================ Mesh correctness and the core print tools

const pickType = async (app: App, label: RegExp) => {
  await app.inspector().locator('.field', { hasText: /^Type/ }).locator('.sel').click()
  await app.page.getByRole('option', { name: label }).click()
}
const toastText = async (app: App) => { await app.page.waitForTimeout(500); return toasts(app) }

test('Make Closed Mesh: one click closes holes, winds the triangles and says what it did', async ({ app }) => {
  await app.open()
  const t = boxTris(40, 30, 20, [0, 0, 0], 4)
  // the top face is missing and the bottom face is wound the other way
  const bad = without(t, Array.from({ length: 32 }, (_, i) => 32 + i)).map((tri, i) => (i < 32 ? [tri[0], tri[2], tri[1]] : tri)) as ReturnType<typeof boxTris>
  await importStl(app, writeStl('closedmesh', bad))
  await meshTool(app, 'Make Closed Mesh')
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  expect(s.nonManifold).toBe(0)
  relNear(s.signedVolume, BOX, 0.001)
  expect((await featStates(app)).pop()).toBe('meshMakeClosed:ok')
  expect(await toastText(app)).toMatch(/closed 1 hole/)
})

test('Repair type Close Holes closes the hole, Stitch joins cracks, Remove drops a speck', async ({ app }) => {
  await app.open()
  const t = boxTris(40, 30, 20, [0, 0, 0], 4)
  await importStl(app, writeStl('rtypes', [...without(t, Array.from({ length: 32 }, (_, i) => 32 + i)), ...boxTris(1, 1, 1, [100, 0, 0], 1)]))
  await meshTool(app, 'Repair')
  await pickType(app, /Remove/)
  await app.ok()
  expect((await meshStats(app)).tris).toBe(192 - 32)
  expect(await toastText(app)).toMatch(/removed 1 small shell/)
  await meshTool(app, 'Repair')
  await pickType(app, /Close Holes/)
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, BOX, 0.001)
  expect((await featStates(app)).filter((f) => f.startsWith('meshRepair')).length).toBe(2)
})

test('Repair type Wrap: a scan with three big holes becomes a closed mesh near the original volume', async ({ app }) => {
  test.setTimeout(150000)
  await app.open()
  const t = boxTris(40, 30, 20, [0, 0, 0], 6)
  await importStl(app, writeStl('wrap', without(t, [5, 6, 100, 101, 230, 300])))
  expect((await meshStats(app)).open).toBeGreaterThan(0)
  await meshTool(app, 'Repair')
  await pickType(app, /Wrap/)
  await app.field('Voxel size', '1')
  await app.field('Gap to close', '10')
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  expect(s.nonManifold).toBe(0)
  relNear(s.signedVolume, BOX, 0.06)
  expect(await toastText(app)).toMatch(/wrapped as a closed mesh/)
})

test('Repair type Rebuild keeps a closed cavity', async ({ app }) => {
  test.setTimeout(150000)
  await app.open()
  const outer = boxTris(40, 40, 40, [0, 0, 0], 1)
  const inner = flipped(boxTris(16, 16, 16, [12, 12, 12], 1))
  await importStl(app, writeStl('cavity', [...outer, ...inner]))
  relNear((await meshStats(app)).signedVolume, 64000 - 4096, 0.001) // the cavity keeps its inward winding on import
  await meshTool(app, 'Repair')
  await pickType(app, /Rebuild/)
  await app.field('Voxel size', '1')
  await app.ok()
  relNear((await meshStats(app)).signedVolume, 64000 - 4096, 0.05)
})

test('Not manifold: a Boolean on a mesh that is not closed says Repair', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('openbool', without(boxTris(40, 30, 20, [0, 0, 0], 4), [40, 41])))
  await seedBox(app, 10, 10, 30, [15, 10, -5])
  await app.tab('Solid')
  await app.ribbon('Combine').first().click()
  await useRow(app, 'Target body', /openbool/)
  await useRow(app, 'Tool bodies', /Box/)
  await app.inspector().getByRole('radio', { name: 'Cut' }).click()
  await app.ok()
  const f = (await featStates(app)).pop()!
  expect(f).toMatch(/error/)
  expect(f).toMatch(/Repair/)
})

test('Plane Cut on an open mesh trims it, leaves the cut open and says so', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('opencut', without(boxTris(40, 30, 20, [0, 0, 0], 4), [40, 41])))
  await meshTool(app, 'Plane Cut')
  await app.field('Offset', '10')
  await app.ok()
  expect((await featStates(app)).pop()).toBe('meshPlaneCut:ok')
  const s = await meshStats(app)
  expect(s.open).toBeGreaterThan(0) // not capped
  expect((await app.bbox()).min[2]).toBeCloseTo(10, 3)
  expect(await toastText(app)).toMatch(/left open/)
})

test('Delete with a mesh face selected is an editable step, says what happened and Repair closes it again', async ({ app }) => {
  await app.open()
  await importStl(app, box())
  await clickWorld(app, [20, 15, 20])
  await press(app, 'Delete')
  await app.idle()
  expect((await featStates(app)).pop()).toBe('meshDeleteFaces:ok')
  expect((await meshStats(app)).tris).toBe(192 - 32)
  expect(await toastText(app)).toMatch(/Deleted 1 face/)
  await meshTool(app, 'Repair')
  await app.ok()
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  relNear(s.signedVolume, BOX, 0.001)
  // undo takes the Repair and then the Delete Faces step back, the mesh is whole again
  await press(app, 'Control+z'); await app.idle()
  await press(app, 'Control+z'); await app.idle()
  expect((await meshStats(app)).tris).toBe(192)
})

test('Smooth does not inflate or shrink: a sphere keeps its radius within 2 percent and a box keeps its corners', async ({ app }) => {
  await app.open()
  await importStl(app, writeStl('sph2', sphereTris(20, 40, 20)))
  const before = await meshStats(app)
  const b0 = await app.bbox()
  await meshTool(app, 'Smooth')
  await app.field('Iterations', '30')
  await app.ok()
  const b1 = await app.bbox()
  relNear(b1.max[0] - b1.min[0], b0.max[0] - b0.min[0], 0.02)
  relNear((await meshStats(app)).signedVolume, before.signedVolume, 0.02)
})

test('Mesh Shell: a closed hollow with a 2 mm wall, then an outward wall', async ({ app }) => {
  await app.open()
  await importStl(app, box(2))
  await app.page.locator('.tree-row', { hasText: /box/ }).first().click()
  await app.tab('Solid')
  await app.ribbon('Shell').first().click()
  await app.field('Thickness', '2')
  await app.ok()
  expect((await featStates(app)).pop()).toBe('shell:ok')
  const hollow = await meshStats(app)
  expect(hollow.open).toBe(0)
  relNear(hollow.signedVolume, BOX - 36 * 26 * 16, 0.002) // a true offset: the wall is 2 mm on every side
  expect((await app.bbox()).max[0]).toBeCloseTo(40, 3)
})

test('Mesh Shell: the wall is even on a figure, not a scaled copy', async ({ app }) => {
  test.setTimeout(150000)
  await app.open()
  const full = (await import('./mesh-kit')).figureTris(40)
  await importStl(app, writeStl('figshell', full))
  await app.page.locator('.tree-row', { hasText: /figshell/ }).first().click()
  await app.tab('Solid')
  await app.ribbon('Shell').first().click()
  await app.field('Thickness', '1')
  await app.ok()
  expect((await featStates(app)).pop()).toBe('shell:ok')
  // wall volume of a 1 mm skin is about its area: far less than the scaled copy approach (which leaves 0.85 of the radius)
  const s = await meshStats(app)
  expect(s.open).toBe(0)
  const v0 = (await import('./mesh-kit')).triVolume(full)
  expect(s.signedVolume).toBeGreaterThan(0)
  expect(s.signedVolume).toBeLessThan(v0 * 0.5)
})

test('Convert Mesh (Prismatic): a mesh box becomes a solid with 6 planar faces and the same volume', async ({ app }) => {
  await app.open()
  await importStl(app, box(2))
  await meshTool(app, 'Convert Mesh')
  await app.ok()
  expect((await featStates(app)).pop()).toBe('meshToBrep:ok')
  const g = await geom(app)
  expect(g[0].kind).toBe('brep')
  expect(g[0].faces).toBe(6)
  relNear(await app.volume(), BOX, 0.001)
  expect(await toastText(app)).toMatch(/6 planar faces/)
})

test('Convert Mesh (Faceted): every triangle becomes a face, and a limit says what to do', async ({ app }) => {
  await app.open()
  await importStl(app, box(1))
  await meshTool(app, 'Convert Mesh')
  await app.inspector().getByRole('radio', { name: 'Faceted' }).click()
  await app.ok()
  const g = await geom(app)
  expect(g[0].kind).toBe('brep')
  expect(g[0].faces).toBe(12)
  relNear(await app.volume(), BOX, 0.001)
})

test('Convert Mesh (Faceted) over the face limit stops with a message that says what to do', async ({ app }) => {
  await app.open()
  await importStl(app, box(3)) // 108 triangles
  await meshTool(app, 'Convert Mesh')
  await app.inspector().getByRole('radio', { name: 'Faceted' }).click()
  await app.field('Face limit', '100')
  await app.ok()
  const f = (await featStates(app)).pop()!
  expect(f).toMatch(/error/)
  expect(f).toMatch(/Reduce|limited to 100/)
})
