import { test, expect, addSketch, XY, type App } from './helpers'

async function addBox(app: App, size: number, position: [number, number, number] = [0, 0, 0]) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size, depth: a.size, height: a.size, position: a.position }), { size, position })
  await app.idle()
}
const title = (app: App) => app.inspector().locator('.panel-title')
const values = (app: App) => app.ev((c) => c.ui.getState().inspector?.values)
async function select(app: App, refs: { kind: string; id?: string; index?: number }[]) {
  await app.ev((c, r) => c.ui.getState().setSelection(r.map((x: { kind: string; id?: string; index?: number }) => ({ ...x, id: x.id ?? c.doc.getState().geometry[0].id }))), refs)
}
/** B-rep index of the face of the first body whose triangles all point along +Z (the top). */
const topFace = (app: App) => app.ev((c) => {
  const m = c.doc.getState().geometry[0].mesh
  for (let t = 0; t < m.faceIds.length; t++) {
    const i = m.indices[t * 3] * 3
    if (m.normals[i + 2] > 0.99) return m.faceIds[t] as number
  }
  return -1
})
async function states(app: App) {
  const f = await app.features()
  expect(f.map((x) => x.state), JSON.stringify(f.map((x) => x.error))).toEqual(f.map(() => 'ok'))
}

test('Fillet from a selected face takes its edges and a radius that fits the part', async ({ app }) => {
  await app.open()
  await addBox(app, 3)
  await app.tab('Solid')
  await select(app, [{ kind: 'face', index: await topFace(app) }])
  await app.ribbon('Fillet').first().click()
  await expect(title(app)).toHaveText('Fillet')
  await expect.poll(async () => (await values(app)).edges.length).toBe(4)
  expect((await values(app)).size).toBeCloseTo(0.1, 5) // a twentieth of 3 mm, not a fixed 1 mm that would swallow the part
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  await states(app)
  expect(await app.volume()).toBeLessThan(27)
  expect(await app.volume()).toBeGreaterThan(26)
})

test('Chamfer size follows a large part, and a first edge pick keeps an untouched default', async ({ app }) => {
  await app.open()
  await addBox(app, 200)
  await app.tab('Solid')
  await app.ribbon('Chamfer').first().click()
  await expect(title(app)).toHaveText('Chamfer')
  // nothing picked yet: the lone body already sizes the default
  expect((await values(app)).size).toBe(10)
  await select(app, [{ kind: 'edge', index: 0 }])
  await expect.poll(async () => (await values(app)).edges.length).toBe(1)
  expect((await values(app)).size).toBe(10)
  await expect.poll(() => app.ev((c) => c.manip.getState().active)).toBe(true)
})

test('Shell: the wall fits a thin part, and a drag arrow sits on the removed face', async ({ app }) => {
  await app.open()
  await addBox(app, 3)
  await app.tab('Solid')
  await select(app, [{ kind: 'face', index: await topFace(app) }])
  await app.ribbon('Shell').click()
  await expect(title(app)).toHaveText('Shell')
  expect((await values(app)).thickness).toBeCloseTo(0.2, 5) // the old fixed 2 mm needs more than the part has
  await expect.poll(() => app.ev((c) => c.manip.getState().active)).toBe(true)
  const m = await app.ev((c) => { const s = c.manip.getState(); return { o: s.origin, d: s.dir, tip: s.tip } })
  expect(m.o[2]).toBeCloseTo(3, 3)
  expect(m.d[2]).toBeCloseTo(-1, 3) // points into the part
  expect(m.tip).toBeCloseTo(0.2, 5)
  await app.ev((c) => c.manip.getState().onChange?.(0.5))
  await expect.poll(async () => (await values(app)).thickness).toBe(0.5)
  await app.ok()
  await states(app)
  expect(await app.volume()).toBeCloseTo(27 - 2 * 2 * 2.5, 0)
})

test('Revolve picks the sketch axis the profile hugs, joins when there is a body, and takes a selected edge as axis', async ({ app }) => {
  await app.open()
  // a half profile standing on the sketch Y axis
  await addSketch(app, XY, [{ k: 'rect', x0: 0, y0: 2, x1: 5, y1: 12 }])
  await app.tab('Solid')
  await app.ribbon('Revolve').first().click()
  await expect(title(app)).toHaveText('Revolve')
  let v = await values(app)
  expect(v.axis).toBe('sketchY')
  expect(v.operation).toBe('new') // nothing to join to yet
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  await states(app)
  expect(Math.abs((await app.volume()) - Math.PI * 25 * 10) / (Math.PI * 250)).toBeLessThan(0.01)

  // now there is a body: Join is the starting operation, and a selected straight edge is the axis
  await addSketch(app, XY, [{ k: 'rect', x0: 30, y0: 0, x1: 35, y1: 6 }])
  await select(app, [{ kind: 'edge', index: 0 }])
  await app.ribbon('Revolve').first().click()
  v = await values(app)
  expect(v.operation).toBe('join')
  expect(v.axis).toBe('edge')
  expect(v.edge).toHaveLength(1)
  await app.page.keyboard.press('Escape')
})

test('Revolve started without a profile adopts the axis once the profile is picked', async ({ app }) => {
  await app.open()
  await addSketch(app, XY, [{ k: 'rect', x0: 0, y0: 2, x1: 5, y1: 12 }])
  await addSketch(app, XY, [{ k: 'rect', x0: 2, y0: 0, x1: 9, y1: 4 }])
  await app.tab('Solid')
  await app.ribbon('Revolve').first().click()
  await expect(title(app)).toHaveText('Revolve')
  expect((await values(app)).profiles).toHaveLength(0)
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  const p = await app.project(2.5, 7, 0) // inside the first sketch's profile only
  await app.page.mouse.move(p.x - 20, p.y)
  await app.page.mouse.move(p.x, p.y, { steps: 4 })
  await app.page.mouse.click(p.x, p.y)
  await expect.poll(async () => (await values(app))?.axis).toBe('sketchY')
  expect((await values(app)).profiles).toHaveLength(1)
})

test('Offset Plane starts from a selected origin plane and has a drag arrow for the distance', async ({ app }) => {
  await app.open()
  await app.tab('Solid')
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'plane', id: 'planeXZ' }]))
  await app.ribbon('Offset Plane').first().click()
  await expect(title(app)).toHaveText('Offset Plane')
  expect((await values(app)).base).toBe('XZ')
  await expect.poll(() => app.ev((c) => c.manip.getState().active)).toBe(true)
  await app.ev((c) => c.manip.getState().onChange?.(25))
  await expect.poll(async () => (await values(app)).distance).toBe(25)
  await app.ok()
  await states(app)
  const pl = await app.ev((c) => Object.values(c.planes.getState().data)[0] as { origin: number[] })
  expect(Math.abs(pl.origin[1])).toBeCloseTo(25, 3)
})

test('Mirror takes the selected body and plane; a lone body is taken when nothing is selected', async ({ app, page }) => {
  await app.open()
  await addBox(app, 10, [20, 0, 0])
  await app.tab('Solid')
  await page.getByRole('button', { name: 'Pattern options' }).click()
  await page.getByRole('menuitem', { name: 'Mirror' }).click()
  await expect(title(app)).toHaveText('Mirror')
  let v = await values(app)
  expect(v.bodies).toHaveLength(1)
  expect(v.plane ?? []).toHaveLength(0)
  await page.keyboard.press('Escape')

  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: c.doc.getState().geometry[0].id }, { kind: 'plane', id: 'planeYZ' }]))
  await page.getByRole('button', { name: 'Pattern options' }).click()
  await page.getByRole('menuitem', { name: 'Mirror' }).click()
  v = await values(app)
  expect(v.plane).toEqual(['planeYZ'])
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  await states(app)
  expect((await app.bodies()).length).toBe(2)
})

test('Pattern spacing clears the selected body instead of a fixed 20 mm', async ({ app }) => {
  await app.open()
  await addBox(app, 40)
  await app.tab('Solid')
  await select(app, [{ kind: 'body' }])
  await app.ev((c) => c.runCommand('solid.pattern'))
  await expect(title(app)).toHaveText('Pattern')
  const v = await values(app)
  expect(v.source).toBe('bodies')
  expect(v.distance1).toBe(60)
})

test('Shell with a body and no faces hollows it into a closed solid', async ({ app }) => {
  await app.open()
  await addBox(app, 20)
  await app.tab('Solid')
  await select(app, [{ kind: 'body' }])
  await app.ribbon('Shell').click()
  await expect(title(app)).toHaveText('Shell')
  const v = await values(app)
  expect(v.bodies).toHaveLength(1)
  expect(v.faces).toHaveLength(0)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  await states(app)
  expect(await app.volume()).toBeCloseTo(8000 - 16 * 16 * 16, -1) // 2 mm walls, sealed void inside
  expect((await app.bodies()).length).toBe(1)
})

test('Hole starting sizes fit a thin part and stay when typed over', async ({ app }) => {
  await app.open()
  await addBox(app, 3)
  await app.tab('Solid')
  await app.ev((c) => c.runCommand('solid.hole'))
  await expect(title(app)).toHaveText('Hole')
  const v = await values(app)
  expect(v.dia).toBe(0.5) // a third of 3 mm, not a 6 mm hole wider than the part
  expect(v.depth).toBe(1)
  await app.field('Diameter', '1')
  // a click on the top face places a hole; the typed diameter must survive the size fitting that runs on the first click
  const top = await topFace(app)
  await app.ev((c, top) => {
    const s = c.lastPick.getState()
    c.lastPick.setState({ seq: s.seq + 1, point: [1, 1, 3], ref: { kind: 'face', id: c.doc.getState().geometry[0].id, index: top } })
  }, top)
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  const f = (await app.features()).find((x) => x.type === 'hole')!
  expect(f.state, f.error).toBe('ok')
  expect(f.params.dia).toBe(1)
  expect(f.params.depth).toBe(1) // untouched sizes took the fitted value
})

test('Hole starting sizes are the usual ones on an ordinary part', async ({ app }) => {
  await app.open()
  await addBox(app, 40)
  await app.tab('Solid')
  await app.ev((c) => c.runCommand('solid.hole'))
  await expect(title(app)).toHaveText('Hole')
  const v = await values(app)
  expect([v.dia, v.cbDia, v.cbDepth, v.cskDia, v.depth]).toEqual([6, 11, 6, 12, 10])
})
