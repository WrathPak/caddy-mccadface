import { test, expect, XZ, type App } from './helpers'
import {
  addSketch, clickWorld, controls, dlg, editChip, fastPlate, featTypes, relNear, seedBox, settle, totalVol, chipCount,
} from './solids-kit'

/* The tools and options added after the Fusion parity pass (docs/fusion-parity/solids.md): Rib, Web, Sphere, Torus, Coil, Pipe, Sweep / Loft / Revolve options,
   Fillet / Chamfer / Shell / Hole / Draft options, Move / Copy, Align, Scale and Physical Material. Each one is driven through the dialog. */

const menu = async (app: App, base: string, item: string) => {
  await app.page.locator('.ribbon-body').getByRole('button', { name: `${base} options` }).click()
  await app.page.getByRole('menuitem', { name: item }).click()
}
const toggle = (app: App, label: string) => app.inspector().locator('.field', { hasText: label }).locator('button,input,[role=switch]').first().click()
const seg = (app: App, text: string) => app.inspector().getByText(text, { exact: true }).click()
const lastFeature = async (app: App) => { const f = await app.features(); return f[f.length - 1] }

// ================================================================================================ primitives

test('Sphere: radius typed, edited from the timeline', async ({ app }) => {
  await app.open()
  await menu(app, 'Box', 'Sphere')
  await app.field('Radius', '10')
  await app.ok()
  relNear(await totalVol(app), (4 / 3) * Math.PI * 1000, 0.01)
  await editChip(app, 0)
  await app.field('Radius', '5')
  await app.ok()
  relNear(await totalVol(app), (4 / 3) * Math.PI * 125, 0.01)
})

test('Torus: ring and tube radius', async ({ app }) => {
  await app.open()
  await menu(app, 'Box', 'Torus')
  await app.field('Ring radius', '20')
  await app.field('Tube radius', '5')
  await app.ok()
  relNear(await totalVol(app), 2 * Math.PI * Math.PI * 20 * 25, 0.01)
})

test('Torus: a tube wider than the ring is refused with a message', async ({ app }) => {
  await app.open()
  await menu(app, 'Box', 'Torus')
  await app.field('Ring radius', '5')
  await app.field('Tube radius', '9')
  await app.ok()
  const f = await lastFeature(app)
  expect(f.state).toBe('error')
  expect(f.error).toMatch(/smaller than the ring radius/)
})

test('Coil: revolutions, height and pitch follow each other, round wire', async ({ app }) => {
  await app.open()
  await menu(app, 'Box', 'Coil')
  await app.field('Diameter', '30')
  await app.field('Revolutions', '5')
  await app.field('Height', '40')
  expect(await app.inspector().innerText()).toMatch(/pitch 8 mm/)
  await app.field('Section size', '4')
  await app.ok()
  relNear(await totalVol(app), Math.PI * 4 * 5 * Math.hypot(2 * Math.PI * 15, 8), 0.04)
  const bb = await app.bbox()
  expect(bb.max[2] - bb.min[2]).toBeGreaterThan(36)
})

test('Coil: revolutions and pitch, a square wire', async ({ app }) => {
  await app.open()
  await menu(app, 'Box', 'Coil')
  await app.inspector().locator('.field', { hasText: 'Size by' }).locator('.sel').first().click()
  await app.page.getByRole('option', { name: 'Revolutions and pitch' }).click()
  await app.field('Revolutions', '3')
  await app.field('Pitch', '10')
  await seg(app, 'Square')
  await app.field('Section size', '4')
  await app.ok()
  const bb = await app.bbox()
  expect(bb.max[2] - bb.min[2]).toBeGreaterThan(30)
  expect(bb.max[2] - bb.min[2]).toBeLessThan(36)
  expect(await totalVol(app)).toBeGreaterThan(16 * 3 * Math.hypot(2 * Math.PI * 15, 10) * 0.9)
})

test('Pipe: follows a picked path, solid and then hollow', async ({ app }) => {
  await app.open()
  await addSketch(app, XZ, [{ k: 'line', a: [0, 0], b: [0, 40] }])
  await settle(app)
  await menu(app, 'Box', 'Pipe')
  await clickWorld(app, [0, 0, 20])
  await expect.poll(async () => ((await dlg(app)).path as string[]).length).toBe(1)
  await app.field('Section size', '10')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  relNear(await totalVol(app), Math.PI * 25 * 40, 0.02)
  await editChip(app, 1)
  await toggle(app, 'Hollow')
  await app.field('Wall thickness', '1')
  await app.ok()
  relNear(await totalVol(app), Math.PI * (25 - 16) * 40, 0.03)
})

// ================================================================================================ rib and web

async function hollowBox(app: App) {
  await seedBox(app, 60, 60, 40)
  await seedBox(app, 56, 56, 40, [0, 0, 2])
  const ids: string[] = await app.ev((c) => c.doc.getState().geometry.map((b: any) => b.id)) // eslint-disable-line
  await app.ev((c, ids) => c.doc.getState().addFeature('combine', { target: [ids[0]], tools: [ids[1]], operation: 'cut' }), ids)
  await app.idle()
}

test('Rib: a line across a hollow box grows down to the floor, thickness 2, editable', async ({ app }) => {
  await app.open()
  await hollowBox(app)
  const before = await totalVol(app)
  await addSketch(app, XZ, [{ k: 'line', a: [-28, 20], b: [28, 20] }])
  await settle(app)
  await app.ribbon('Rib').first().click()
  await expect.poll(async () => ((await dlg(app)).curves as string[]).length).toBe(1)
  await toggle(app, 'Flip direction') // XZ faces -Y, so the default growth is up and out of the open top
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  expect((await featTypes(app)).at(-1)).toBe('rib')
  relNear((await totalVol(app)) - before, 56 * 18 * 2, 0.02)
  // thicker from the timeline
  await editChip(app, (await chipCount(app)) - 1)
  await app.field('Thickness', '4')
  await app.ok()
  relNear((await totalVol(app)) - before, 56 * 18 * 4, 0.02)
})

test('Rib: growing into open air has no face to stop at and says so', async ({ app }) => {
  await app.open()
  await hollowBox(app)
  await addSketch(app, XZ, [{ k: 'line', a: [-28, 20], b: [28, 20] }])
  await settle(app)
  await app.ribbon('Rib').first().click()
  await app.ok()
  const f = await lastFeature(app)
  expect(f.state).toBe('error')
  expect(f.error).toMatch(/does not end on a face/)
})

test('Web: lines of a sketch become walls out of the sketch plane, to the next wall', async ({ app }) => {
  await app.open()
  await hollowBox(app)
  const before = await totalVol(app)
  await addSketch(app, XZ, [{ k: 'line', a: [-28, 20], b: [28, 20] }])
  await settle(app)
  await app.ribbon('Rib').first().click()
  await app.page.keyboard.press('Escape')
  await menu(app, 'Rib', 'Web')
  await expect.poll(async () => ((await dlg(app)).curves as string[]).length).toBe(1)
  await app.ok()
  expect((await featTypes(app)).at(-1)).toBe('web')
  // normal to XZ is Y: the wall runs from the line to the far wall (28 mm), 2 thick
  relNear((await totalVol(app)) - before, 56 * 28 * 2, 0.02)
})

// ================================================================================================ sweep, loft, revolve

async function sweepSetup(app: App) {
  await addSketch(app, { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, [{ k: 'circle', c: [0, 0], r: 5 }])
  await addSketch(app, XZ, [{ k: 'line', a: [0, 0], b: [0, 40] }])
  await settle(app)
  await app.ribbon('Sweep').first().click()
  // the open sketch is taken as the path by itself
  await expect.poll(async () => ((await dlg(app)).path as string[]).length).toBe(1)
}

test('Sweep: a taper angle of 5 turns the cylinder into a cone frustum', async ({ app }) => {
  await app.open()
  await sweepSetup(app)
  await app.field('Taper angle', '5')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  const r2 = 5 - 40 * Math.tan((5 * Math.PI) / 180)
  relNear(await totalVol(app), (Math.PI * 40 * (25 + 5 * r2 + r2 * r2)) / 3, 0.03)
})

test('Sweep: twisting a square keeps its volume, parallel orientation and a too steep taper are handled', async ({ app }) => {
  await app.open()
  await addSketch(app, { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, [{ k: 'rect', x0: -5, y0: -5, x1: 5, y1: 5 }])
  await addSketch(app, XZ, [{ k: 'line', a: [0, 0], b: [0, 40] }])
  await settle(app)
  await app.ribbon('Sweep').first().click()
  await expect.poll(async () => ((await dlg(app)).path as string[]).length).toBe(1)
  await app.field('Twist angle', '90')
  await app.ok()
  relNear(await totalVol(app), 100 * 40, 0.03)
  await editChip(app, 2)
  await app.field('Twist angle', '0')
  await app.field('Taper angle', '40')
  await app.ok()
  const f = await lastFeature(app)
  expect(f.state).toBe('error')
  expect(f.error).toMatch(/taper is too steep/)
})

test('Loft: normal to profile end conditions change the shape, and a center line builds', async ({ app }) => {
  await app.open()
  await addSketch(app, { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, [{ k: 'circle', c: [0, 0], r: 10 }])
  await addSketch(app, { origin: [0, 0, 30], xDir: [1, 0, 0], normal: [0, 0, 1] }, [{ k: 'circle', c: [0, 0], r: 5 }])
  await settle(app)
  await menu(app, 'Sweep', 'Loft')
  await expect.poll(async () => ((await dlg(app)).profiles as string[]).length).toBe(2)
  await app.ok()
  const plain = await totalVol(app)
  await editChip(app, 2)
  expect(await controls(app)).toMatch(/Guide rails/)
  expect(await controls(app)).toMatch(/Center line/)
  await app.inspector().locator('.field', { hasText: 'Start condition' }).locator('.sel').first().click()
  await app.page.getByRole('option', { name: 'Normal to profile' }).click()
  await app.ok()
  expect(Math.abs((await totalVol(app)) - plain)).toBeGreaterThan(5)
  expect((await lastFeature(app)).state).toBe('ok')
})

test('Revolve: symmetric half angles and two sides add up; to object stops at a plane', async ({ app }) => {
  await app.open()
  await addSketch(app, XZ, [{ k: 'rect', x0: 0, y0: 0, x1: 10, y1: 30 }])
  await settle(app)
  await app.ribbon('Revolve').first().click()
  await seg(app, 'Symmetric')
  await app.field('Angle', '180')
  await app.ok()
  const half = (Math.PI * 100 * 30) / 2
  relNear(await totalVol(app), half, 0.01)
  const bb = await app.bbox()
  // half a turn either side of the XZ profile plane: it reaches both -Y and +Y
  expect(bb.min[1]).toBeLessThan(-9)
  expect(bb.max[1]).toBeGreaterThan(9)
  await editChip(app, 1)
  await seg(app, 'Two sides')
  await app.field('Angle', '90')
  await app.field('Second angle', '90')
  await app.ok()
  relNear(await totalVol(app), half, 0.01)
  await editChip(app, 1)
  await seg(app, 'To object')
  expect(await controls(app)).toMatch(/To object/)
})

// ================================================================================================ fillet, chamfer, shell, hole, draft

const TOP_FRONT: [number, number, number] = [30, 0, 10]

test('Fillet: variable radius, chord length and the corner setback / rule options', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, TOP_FRONT)
  await seg(app, 'Variable')
  await app.field('Radius', '1')
  await app.field('End radius', '3')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  relNear(await totalVol(app), 24000 - 60 * (1 - Math.PI / 4) * ((1 + 3 + 9) / 3), 0.0008)
  await editChip(app, 2)
  await seg(app, 'Chord length')
  await app.field('Chord length', String(2 * Math.SQRT2))
  await app.ok()
  relNear(await totalVol(app), 24000 - 60 * (1 - Math.PI / 4) * 4, 0.0008)
  await editChip(app, 2)
  await seg(app, 'G2 (smooth)')
  await app.ok()
  expect((await lastFeature(app)).state).toBe('ok')
})

test('Fillet: the Rule rounds every edge of the face of the picked edge', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Fillet').first().click()
  await clickWorld(app, TOP_FRONT)
  await app.field('Radius', '1')
  await app.inspector().locator('.field', { hasText: 'Rule' }).locator('.sel').first().click()
  await app.page.getByRole('option', { name: 'All edges of their faces' }).click()
  await app.ok()
  // the four top edges (front edge's two faces: top and front) are all rounded: more removed than the one edge
  const v = await totalVol(app)
  expect(24000 - v).toBeGreaterThan(60 * (1 - Math.PI / 4) * 3)
})

test('Chamfer: two distances and distance and angle', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Chamfer').first().click()
  await clickWorld(app, TOP_FRONT)
  await seg(app, 'Two distances')
  await app.field('Distance', '2')
  await app.field('Distance 2', '4')
  await app.ok()
  relNear(await totalVol(app), 24000 - 0.5 * 2 * 4 * 60, 0.001)
  await editChip(app, 2)
  await seg(app, 'Distance and angle')
  await app.field('Distance', '3')
  await app.field('Angle', '45')
  await app.ok()
  relNear(await totalVol(app), 24000 - 0.5 * 3 * 3 * 60, 0.001)
})

test('Shell: a flat face given its own thickness', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Shell').first().click()
  await clickWorld(app, [5, 5, 10])
  await expect.poll(async () => ((await dlg(app)).faces as string[]).length).toBe(1)
  await app.field('Thickness', '2')
  relNear(await totalVol(app), 24000, 1e-9) // nothing applied yet: a preview only
  await toggle(app, 'Individual thickness')
  await app.inspector().locator('.field', { hasText: 'Faces with own thickness' }).click()
  await clickWorld(app, [30, 0, 5])
  await expect.poll(async () => ((await dlg(app)).thickFaces as string[]).length).toBe(1)
  await app.field('Face thickness', '5')
  await app.ok()
  // cavity 56 x (36 - 3) x 8
  relNear(await totalVol(app), 24000 - 56 * 33 * 8, 0.005)
})

test('Hole: positioned from two edges by typed offsets', async ({ app }) => {
  await app.open()
  await fastPlate(app)
  await app.ribbon('Hole').first().click()
  await clickWorld(app, [40, 20, 10])
  await expect.poll(() => app.ev((c) => c.markers.getState().items.length)).toBe(1)
  await app.inspector().locator('.field', { hasText: 'Edge 1' }).click()
  await clickWorld(app, [0, 20, 10])
  await expect.poll(async () => ((await dlg(app)).edgeA as string[]).length).toBe(1)
  await app.field('Offset from edge 1', '12')
  await clickWorld(app, [30, 0, 10])
  await expect.poll(async () => ((await dlg(app)).edgeB as string[]).length).toBe(1)
  await app.field('Offset from edge 2', '15')
  await expect.poll(() => app.ev((c) => Math.round(c.markers.getState().items[0].pos[1] * 10))).toBe(150)
  const pos: number[] = await app.ev((c) => c.markers.getState().items[0].pos)
  expect(Math.abs(pos[0] - 12)).toBeLessThan(0.1)
  expect(Math.abs(pos[1] - 15)).toBeLessThan(0.1)
  await app.ok()
  const f = await lastFeature(app)
  expect(f.state).toBe('ok')
})

// ================================================================================================ move, align, scale, material

test('Move: Create copy leaves the original where it is', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10)
  await app.ribbon('Move').first().click()
  await toggle(app, 'Create copy')
  await app.vec('Translate', 0, '30')
  await app.ok()
  const bodies = await app.bodies()
  expect(bodies.length).toBe(2)
  const boxes = await app.ev((c) => c.doc.getState().geometry.map((b: any) => Math.round((Math.min(...b.mesh.positions.filter((_: number, i: number) => i % 3 === 0)) + Math.max(...b.mesh.positions.filter((_: number, i: number) => i % 3 === 0))) / 2))) // eslint-disable-line
  expect(boxes.sort((a: number, b: number) => a - b)).toEqual([0, 30])
})

test('Move: translate along an axis and rotate about an axis through the origin (by feature values)', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10, [30, 0, 0])
  const id: string = await app.ev((c) => c.doc.getState().geometry[0].id)
  await app.ev((c, id) => c.doc.getState().addFeature('move', { bodyIds: [id], moveType: 'rotate', axisRef: ['axisZ'], axisAngle: 90 }), id)
  await app.idle()
  let bb = await app.bbox()
  expect(Math.abs((bb.min[1] + bb.max[1]) / 2 - 30)).toBeLessThan(0.1)
  expect(Math.abs((bb.min[0] + bb.max[0]) / 2)).toBeLessThan(0.1)
  await app.ev((c, id) => c.doc.getState().addFeature('move', { bodyIds: [id], moveType: 'axis', axisRef: ['axisX'], distance: 25 }), id)
  await app.idle()
  bb = await app.bbox()
  expect(Math.abs((bb.min[0] + bb.max[0]) / 2 - 25)).toBeLessThan(0.1)
  expect((await app.features()).every((f) => f.state === 'ok')).toBe(true)
})

test('Scale: uniform about the middle, non-uniform gives a mesh body', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 20, 30)
  await menu(app, 'Move', 'Scale')
  await app.field('Scale factor', '2')
  await app.ok()
  relNear(await totalVol(app), 48000, 0.001)
  await editChip(app, 1)
  await seg(app, 'Non-uniform')
  await app.vec('Scale factors', 0, '2')
  await app.vec('Scale factors', 1, '1')
  await app.vec('Scale factors', 2, '0.5')
  await app.ok()
  relNear(await totalVol(app), 6000, 0.001)
  const bodies = await app.bodies()
  expect(bodies[0].kind).toBe('mesh')
})

test('Align: a box lands face to face on another', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 10, 10, [0, 0, 0])
  await seedBox(app, 10, 10, 10, [40, 0, 0])
  const ids: string[] = await app.ev((c) => c.doc.getState().geometry.map((b: any) => b.id)) // eslint-disable-line
  // faces by their index in the first body: the +X face of box 1 onto the -X face of box 2 is already touching after a move of 30; start from far away
  await app.ev((c, ids) => c.doc.getState().addFeature('move', { bodyIds: [ids[0]], translate: [-20, 5, 3] }), ids)
  await app.idle()
  await menu(app, 'Move', 'Align')
  // the Bodies field takes box 1, then the From face is clicked on it and the To face on box 2
  await app.page.locator('.tree-row', { hasText: 'Box1' }).first().click()
  await expect.poll(async () => ((await dlg(app)).bodyIds as string[]).length).toBe(1)
  await app.inspector().locator('.field', { hasText: 'From' }).first().click()
  await app.ev((c) => c.ui.getState().setSelectionFilter('face'))
  await clickWorld(app, [-15, 5, 8])
  await app.inspector().locator('.field', { hasText: /^To/ }).first().click()
  await clickWorld(app, [35, 0, 5])
  await expect.poll(async () => ((await dlg(app)).toRef as string[]).length).toBe(1)
  await app.ok()
  expect((await lastFeature(app)).state).toBe('ok')
  expect((await featTypes(app)).at(-1)).toBe('align')
})

test('Physical Material: steel gives Measure a mass and a center of gravity', async ({ app }) => {
  await app.open()
  await seedBox(app, 10, 20, 30)
  await app.ribbon('Physical Material').first().click()
  await expect.poll(async () => ((await dlg(app)).bodyIds as string[]).length).toBe(1)
  await app.inspector().locator('.field', { hasText: 'Material' }).first().locator('.sel').first().click()
  await app.page.getByRole('option', { name: /Aluminium/ }).click()
  await expect.poll(async () => (await dlg(app)).density).toBeCloseTo(2.7, 3)
  await app.ok()
  expect((await featTypes(app)).at(-1)).toBe('material')
  await app.ribbon('Measure').first().click()
  await seg(app, 'Body')
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: c.doc.getState().geometry[0].id }]))
  await expect.poll(() => app.inspector().innerText()).toMatch(/Mass\s+16\.2 g/)
  expect(await app.inspector().innerText()).toMatch(/Aluminium/)
  expect(await app.inspector().innerText()).toMatch(/Center of gravity\s+0, 0, 15 mm/)
})
