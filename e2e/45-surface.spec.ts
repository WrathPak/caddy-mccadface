import fs from 'node:fs'
import { test, expect, addSketch, XY, XZ, type App } from './helpers'

/** What the specs need to know about a body: its kind, whether it is an open surface, how many edges are open, the surface area. */
interface Info { id: string; name: string; kind: string; surface: boolean; free: number | undefined; faces: number; area: number; tris: number }
const infos = (app: App): Promise<Info[]> => app.ev((c) => c.doc.getState().geometry.map((b: any) => { // eslint-disable-line
  const p = b.mesh.positions, ix = b.mesh.indices
  let area = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, bb = ix[t + 1] * 3, cc = ix[t + 2] * 3
    const ux = p[bb] - p[a], uy = p[bb + 1] - p[a + 1], uz = p[bb + 2] - p[a + 2], vx = p[cc] - p[a], vy = p[cc + 1] - p[a + 1], vz = p[cc + 2] - p[a + 2]
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return { id: b.id, name: b.name, kind: b.kind, surface: !!b.surface, free: b.freeEdges, faces: b.mesh.faceCount, area, tris: ix.length / 3 }
}))
const info = async (app: App, id: string) => (await infos(app)).find((b) => b.id === id)!
const near = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(Math.max(Math.abs(b) * rel, 1e-6))

/** The curve refs of the chains of a finished sketch, as the Inspector stores them. */
const chainsOf = (app: App, fid: string): Promise<{ ref: string; closed: boolean; segs: number }[]> => app.ev((c, fid) => c.sketchData.getState().data[fid].chains.map((ch: any) => ({ // eslint-disable-line
  ref: `crv:${fid}:${ch.key}${ch.id ? '@' + ch.id : ''}`, closed: ch.closed, segs: ch.segs.length,
})), fid)
const select = (app: App, refs: { kind: string; id: string; index?: number }[]) => app.ev((c, refs) => c.ui.getState().setSelection(refs), refs)
const title = (app: App) => app.inspector().locator('.panel-title')
const states = async (app: App) => (await app.features()).map((f) => f.state)

/** Edge indices of a body whose two ends are at height z (the outline of a lid). */
const edgesAtHeight = (app: App, id: string, z: number): Promise<number[]> => app.ev((c, a) => {
  const b = c.doc.getState().geometry.find((x: any) => x.id === a.id) // eslint-disable-line
  const e = b.mesh.edges, ids = b.mesh.edgeIds
  const out = new Set<number>()
  for (let s = 0; s < e.length / 6; s++) if (Math.abs(e[s * 6 + 2] - a.z) < 1e-4 && Math.abs(e[s * 6 + 5] - a.z) < 1e-4) out.add(ids[s])
  return [...out]
}, { id, z })
/** Face index of a body whose triangles all lie at height z. */
const faceAtHeight = (app: App, id: string, z: number): Promise<number> => app.ev((c, a) => {
  const b = c.doc.getState().geometry.find((x: any) => x.id === a.id) // eslint-disable-line
  const p = b.mesh.positions, ix = b.mesh.indices
  for (let t = 0; t < ix.length; t += 3) if ([0, 1, 2].every((k) => Math.abs(p[ix[t + k] * 3 + 2] - a.z) < 1e-4)) return b.mesh.faceIds[t / 3]
  return -1
}, { id, z })

async function startSketch(app: App) {
  const { page } = app
  await app.ribbon('Sketch').first().click()
  if (!(await page.getByText('XY plane').isVisible())) await page.getByText('Planes', { exact: true }).click()
  await page.getByText('XY plane').click()
  await expect(page.locator('.sk-bar')).toBeVisible()
  await app.ev((c) => c.ui.setState({ snap: false })) // exact positions: no grid
  await app.cameraStable()
}
async function click(app: App, x: number, y: number, z = 0) {
  const p = await app.project(x, y, z)
  await app.page.mouse.move(p.x, p.y, { steps: 3 })
  await app.page.mouse.click(p.x, p.y)
}

test('surface workspace: sketch curves to surfaces, patch, trim, stitch to a solid, thicken, delete face, save / open, STEP', async ({ app, page }, testInfo) => {
  test.setTimeout(240_000)
  await app.open()
  await app.tab('Surface')
  // the tab is a real workspace now: its groups and the tools in them
  for (const name of ['Extrude', 'Revolve', 'Sweep', 'Loft', 'Patch', 'Offset Surface', 'Trim', 'Extend', 'Stitch', 'Thicken', 'Delete Face']) {
    await expect(app.ribbon(name).first(), name).toBeVisible()
  }
  await app.shot('surface-tab')

  // ---- one sketch with an open spline and an open line, drawn with the sketcher
  await startSketch(app)
  await app.ribbon('Fit Point Spline').first().click()
  for (const [x, y] of [[0, 0], [20, 15], [45, 5], [70, 20]]) await click(app, x, y)
  await page.keyboard.press('Enter')
  await app.ribbon('Line').first().click()
  await click(app, -10, -30)
  await click(app, 70, -30)
  await page.keyboard.press('Escape')
  await app.finishSketch()
  const sk1 = (await app.features())[0].id
  const chains = await chainsOf(app, sk1)
  expect(chains.map((c) => c.closed)).toEqual([false, false])
  const lineChain = chains.find((c) => c.segs === 1)!

  // ---- Extrude: no curve is picked for us (there are two), so click the spline in the viewport
  await app.ribbon('Extrude').first().click()
  await expect(title(app)).toHaveText('Extrude Surface')
  await app.ev((c) => c.runCommand('view.home'))
  await app.cameraStable()
  await click(app, 20, 15)
  await expect(app.inspector().getByTestId('sel-curves')).toContainText('1 selected')
  await app.field('Distance', '12')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBeGreaterThan(0)
  await app.shot('surface-extrude-dialog')
  await app.ok()
  expect((await app.features()).map((f) => [f.type, f.state])).toEqual([['sketch', 'ok'], ['surfaceExtrude', 'ok']])
  const wavy = (await infos(app)).find((b) => b.surface)!
  expect(wavy.kind).toBe('brep')
  expect(wavy.faces).toBeGreaterThanOrEqual(3)
  expect(wavy.free).toBeGreaterThan(0)
  // a surface of the spline times 12: well over the straight line it spans
  expect(wavy.area).toBeGreaterThan(70 * 12)
  const bb = await app.bbox(wavy.id)
  expect(bb.min[2]).toBeCloseTo(0, 3)
  expect(bb.max[2]).toBeCloseTo(12, 3)
  // it lives in the Browser under Surfaces, not Bodies
  await expect(page.getByText('Surfaces', { exact: true })).toBeVisible()
  await expect(page.locator('.tree-row', { hasText: wavy.name })).toBeVisible()
  expect(await app.ev((c) => ({ bodies: c.doc.getState().bodies.length, surfaces: c.doc.getState().surfaces.length }))).toEqual({ bodies: 0, surfaces: 1 })
  await app.shot('surface-wavy')

  // ---- a second extrude from the picked line: two sides, so it crosses the ground plane
  await select(app, [{ kind: 'curve', id: lineChain.ref }])
  await app.ribbon('Extrude').first().click()
  await expect(app.inspector().getByTestId('sel-curves')).toContainText('1 selected')
  await page.getByRole('radio', { name: 'Two sides' }).click()
  await app.field('Distance', '8')
  await app.field('Distance 2', '4')
  await app.ok()
  const wall = await info(app, 'f3')
  expect(wall.surface).toBe(true)
  const wb = await app.bbox('f3')
  expect([wb.min[2], wb.max[2]].map((v) => +v.toFixed(3))).toEqual([-4, 8])
  near(wall.area, 80 * 12)

  // ---- edit the first extrude from the timeline: the surface follows, and so does everything built on it
  await page.locator('.tl .chip').nth(1).dblclick()
  await expect(title(app)).toHaveText('Extrude Surface')
  await expect(app.inspector().getByTestId('sel-curves')).toContainText('1 selected')
  await app.field('Distance', '14')
  await app.ok()
  expect((await app.bbox(wavy.id)).max[2]).toBeCloseTo(14, 3)
  expect(await states(app)).toEqual(['ok', 'ok', 'ok'])
  const wavy14 = await info(app, wavy.id)
  near(wavy14.area, (wavy.area * 14) / 12, 0.01)

  // ---- Patch: a flat boundary drawn as a rectangle sketch
  const sk2 = await addSketch(app, XY, [{ k: 'rect', x0: 10, y0: -45, x1: 50, y1: -15 }])
  const rect = (await chainsOf(app, sk2))[0]
  expect(rect.closed).toBe(true)
  await select(app, [{ kind: 'curve', id: rect.ref }])
  await app.ribbon('Patch').first().click()
  await expect(title(app)).toHaveText('Patch')
  await expect(app.inspector().getByTestId('sel-boundary')).toContainText('1 selected')
  await app.ok()
  const patch = await info(app, 'f5')
  expect(patch.surface).toBe(true)
  near(patch.area, 40 * 30)
  await app.shot('surface-patch')

  // ---- Trim: the line wall cuts the patch in half
  await app.ribbon('Trim').first().click()
  await expect(title(app)).toHaveText('Trim')
  await select(app, [{ kind: 'body', id: 'f5' }]) // the surface to trim ...
  await select(app, [{ kind: 'body', id: 'f3' }]) // ... and what cuts it
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBeGreaterThan(0)
  await app.ok()
  expect((await app.features()).at(-1)!.type).toBe('surfaceTrim')
  const trimmed = await info(app, 'f5')
  expect(trimmed.surface).toBe(true)
  near(trimmed.area, 40 * 15, 0.02)
  await app.shot('surface-trim')

  // ---- Stitch to a solid: a bottom patch, four walls and a top patch make a closed box
  const sk3 = await addSketch(app, XY, [{ k: 'rect', x0: 100, y0: 0, x1: 120, y1: 10 }])
  const box = (await chainsOf(app, sk3))[0]
  await select(app, [{ kind: 'curve', id: box.ref }])
  await app.ribbon('Patch').first().click()
  await app.ok()
  const bottom = (await app.features()).at(-1)!.id
  await select(app, [{ kind: 'curve', id: box.ref }])
  await app.ribbon('Extrude').first().click()
  await app.field('Distance', '8')
  await app.ok()
  const walls = (await app.features()).at(-1)!.id
  near((await info(app, walls)).area, 60 * 8)
  expect((await info(app, walls)).faces).toBe(4)
  // the top is patched from the open top edges of the walls: pick them like a click would
  const top = await edgesAtHeight(app, walls, 8)
  expect(top.length).toBe(4)
  await select(app, top.map((index) => ({ kind: 'edge', id: walls, index })))
  await app.ribbon('Patch').first().click()
  await expect(app.inspector().getByTestId('sel-boundary')).toContainText('4 selected')
  await app.ok()
  const lid = (await app.features()).at(-1)!.id
  expect(await states(app)).not.toContain('error')

  await select(app, [bottom, walls, lid].map((id) => ({ kind: 'body', id })))
  await app.ribbon('Stitch').first().click()
  await expect(title(app)).toHaveText('Stitch')
  await app.ok()
  const stitched = (await app.features()).at(-1)!
  expect(stitched.type).toBe('surfaceStitch')
  expect(stitched.state, stitched.error).toBe('ok')
  const solid = await info(app, bottom)
  expect(solid.surface).toBe(false)
  expect(solid.free).toBeUndefined()
  expect(solid.faces).toBe(6)
  near(await app.volume(bottom), 20 * 10 * 8, 1e-3)
  near(solid.area, 2 * 200 + 2 * 160 + 2 * 80)
  expect(await app.ev((c) => c.doc.getState().bodies.map((b: any) => b.id))).toEqual([bottom]) // eslint-disable-line
  expect((await infos(app)).filter((b) => b.surface).map((b) => b.id).sort()).toEqual(['f2', 'f3', 'f5'])
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.shot('surface-stitched-solid')

  // ---- Thicken the wavy surface into a solid
  await select(app, [{ kind: 'body', id: 'f2' }])
  await app.ribbon('Thicken').first().click()
  await expect(title(app)).toHaveText('Thicken')
  await app.field('Thickness', '2')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBeGreaterThan(0)
  await app.ok()
  const thick = await info(app, 'f2')
  expect((await app.features()).at(-1)!.state).toBe('ok')
  expect(thick.surface).toBe(false)
  near(await app.volume('f2'), wavy14.area * 2, 0.06)
  await app.shot('surface-thickened')
  // undo takes the thickness away again, redo puts it back
  await app.ev((c) => c.runCommand('edit.undo'))
  await app.idle()
  expect((await info(app, 'f2')).surface).toBe(true)
  await app.ev((c) => c.runCommand('edit.redo'))
  await app.idle()
  expect((await info(app, 'f2')).surface).toBe(false)

  // ---- Delete Face: take the lid off the box, it is an open surface again
  const lidFace = await faceAtHeight(app, bottom, 8)
  expect(lidFace).toBeGreaterThanOrEqual(0)
  await select(app, [{ kind: 'face', id: bottom, index: lidFace }])
  await app.ribbon('Delete Face').first().click()
  await expect(title(app)).toHaveText('Delete Face')
  await app.ok()
  const open = await info(app, bottom)
  expect((await app.features()).at(-1)!.state).toBe('ok')
  expect(open.surface).toBe(true)
  expect(open.free).toBe(4)
  expect(open.faces).toBe(5)
  near(open.area, 2 * 200 - 200 + 2 * 160 + 2 * 80)
  await app.shot('surface-delete-face')

  // a click on a surface picks its face, from either side: the floor of the open box, seen through the missing lid
  await app.ev((c) => { c.ui.getState().clearSelection(); c.ui.getState().setSelectionFilter('face'); c.runCommand('view.home'); c.runCommand('view.frame') })
  await click(app, 110, 5, 0)
  await expect.poll(() => app.ev((c) => c.ui.getState().selection.map((r: any) => [r.kind, r.id]))).toEqual([['face', bottom]]) // eslint-disable-line

  // ---- the solid tools say what is wrong: a fillet on the open box
  const edge = (await edgesAtHeight(app, bottom, 8))[0]
  await select(app, [{ kind: 'edge', id: bottom, index: edge }])
  await app.ev((c) => c.runCommand('solid.fillet'))
  await app.field('Radius', '1')
  await app.ok()
  const fillet = (await app.features()).at(-1)!
  expect(fillet.type).toBe('fillet')
  expect(fillet.state).toBe('error')
  expect(fillet.error).toMatch(/open surface/)
  await app.ev((c) => c.doc.getState().removeFeature(c.doc.getState().features.at(-1).id))
  await app.idle()

  // ---- save / open: the surfaces come back as they were
  const before = { feats: await app.features(), bodies: await infos(app) }
  const [dl] = await Promise.all([page.waitForEvent('download'), app.ribbon('Save').click()])
  expect(dl.suggestedFilename()).toMatch(/\.caddy$/)
  const file = testInfo.outputPath('surfaces.caddy')
  await dl.saveAs(file)
  await page.reload()
  await app.open()
  expect(await app.features()).toEqual([])
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Open...').click()])
  await chooser.setFiles(file)
  await expect.poll(() => app.features().then((f) => f.length)).toBe(before.feats.length)
  await app.idle()
  const after = { feats: await app.features(), bodies: await infos(app) }
  expect(after.feats.map((f) => [f.id, f.type, f.name, f.params])).toEqual(before.feats.map((f) => [f.id, f.type, f.name, f.params]))
  expect(after.feats.map((f) => f.state)).toEqual(before.feats.map((f) => f.state))
  expect(after.bodies.map((b) => [b.id, b.surface, b.free, b.faces, b.tris])).toEqual(before.bodies.map((b) => [b.id, b.surface, b.free, b.faces, b.tris]))
  expect(await app.ev((c) => c.doc.getState().surfaces.map((s: any) => s.id))).toEqual(['f3', 'f5', bottom].sort((a, b) => (a < b ? -1 : 1)).filter((x) => after.bodies.find((b) => b.id === x)!.surface)) // eslint-disable-line
  await app.shot('surface-reopened')

  // ---- STEP keeps surfaces and solids; STL and 3MF leave the open surfaces out and say so
  await app.ev((c) => c.runCommand('file.export'))
  await page.getByRole('radio', { name: 'STEP', exact: true }).click()
  const [step] = await Promise.all([page.waitForEvent('download'), page.locator('.inspector-foot').getByRole('button', { name: 'OK' }).click()])
  const stepFile = testInfo.outputPath('surfaces.step')
  await step.saveAs(stepFile)
  const text = fs.readFileSync(stepFile, 'latin1')
  expect((text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length).toBe(1) // the thickened surface
  expect((text.match(/ADVANCED_FACE/g) ?? []).length).toBeGreaterThan(8) // plus the open surfaces' faces
  expect(text).toMatch(/SHELL_BASED_SURFACE_MODEL|OPEN_SHELL/)

  await app.ev((c) => c.runCommand('file.export'))
  await page.getByRole('radio', { name: 'STL', exact: true }).click()
  const note = page.getByText('Open surfaces are not in the file').waitFor({ timeout: 15_000 })
  const [stl] = await Promise.all([page.waitForEvent('download'), page.locator('.inspector-foot').getByRole('button', { name: 'OK' }).click()])
  const stlFile = testInfo.outputPath('surfaces.stl')
  await stl.saveAs(stlFile)
  expect(fs.statSync(stlFile).size).toBeGreaterThan(1000)
  await note
})

test('surface workspace: the remaining tools build through the engine; solid tools refuse surfaces with a clear message', async ({ app }) => {
  test.setTimeout(120_000)
  await app.open()
  await app.tab('Surface')
  // an open L (two lines) and a closed square, on XY
  const sk = await addSketch(app, XY, [{ k: 'line', a: [0, 0], b: [30, 0] }, { k: 'line', a: [30, 0], b: [30, 20] }])
  const [path] = await chainsOf(app, sk)
  expect(path.closed).toBe(false)
  expect(path.segs).toBe(2)
  const add = async (type: string, params: Record<string, unknown>) => {
    const id = await app.ev((c, a) => c.doc.getState().addFeature(a.type, a.params), { type, params })
    await app.idle()
    return id as string
  }
  const ok = async (id: string) => {
    const f = (await app.features()).find((x) => x.id === id)!
    expect(f.state, `${f.type}: ${f.error}`).toBe('ok')
    return f
  }

  // Revolve the L (it lies flat) around the world Z axis: a quarter disc of radius 30 and the ring around it out to the far corner
  const rev = await add('surfaceRevolve', { curves: [path.ref], axis: 'worldZ', angle: 90 })
  await ok(rev)
  const r = await info(app, rev)
  expect(r.surface).toBe(true)
  near(r.area, (Math.PI / 4) * (30 * 30 + 20 * 20 + 30 * 30 - 30 * 30), 0.01)

  // Sweep a vertical line along the L: the walls of a rectangular channel
  const prof = await addSketch(app, { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] }, [{ k: 'line', a: [0, -5], b: [0, 5] }])
  const [profChain] = await chainsOf(app, prof)
  const sweep = await add('surfaceSweep', { profiles: [profChain.ref], path: [path.ref] })
  await ok(sweep)
  near((await info(app, sweep)).area, 10 * 50, 0.02)

  // Loft two parallel lines 15 apart, offset that surface, extend its open edge
  const l1 = (await chainsOf(app, await addSketch(app, XY, [{ k: 'line', a: [100, 40], b: [130, 40] }])))[0]
  const l2 = (await chainsOf(app, await addSketch(app, { origin: [0, 0, 15], xDir: [1, 0, 0], normal: [0, 0, 1] }, [{ k: 'line', a: [100, 40], b: [130, 40] }])))[0]
  const loft = await add('surfaceLoft', { sections: [l1.ref, l2.ref], ruled: false })
  await ok(loft)
  expect((await info(app, loft)).surface).toBe(true)
  near((await info(app, loft)).area, 30 * 15, 0.01)

  const off = await add('surfaceOffset', { faces: [loft], distance: 3 })
  await ok(off)
  near((await info(app, off)).area, 30 * 15, 0.01)

  // Extend (through the dialog) the edge at the bottom of the loft by 5: 30 x 5 more surface
  const bottomEdge = await edgesAtHeight(app, loft, 0)
  expect(bottomEdge.length).toBe(1)
  await select(app, [{ kind: 'edge', id: loft, index: bottomEdge[0] }])
  await app.ribbon('Extend').first().click()
  await expect(title(app)).toHaveText('Extend')
  await app.field('Distance', '5')
  await app.ok()
  expect((await app.features()).at(-1)!.state).toBe('ok')
  near((await info(app, loft)).area, 30 * 20, 0.01)

  // Unstitch a solid box into six surfaces; the solid is gone
  const boxId = await app.ev((c) => c.doc.getState().addFeature('box', { width: 10, depth: 10, height: 10, position: [200, 0, 0] }, 'Box'))
  await app.idle()
  const bodiesBefore = (await infos(app)).length
  const un = await add('surfaceUnstitch', { source: [boxId] })
  await ok(un)
  const after = await infos(app)
  expect(after.length).toBe(bodiesBefore - 1 + 6)
  expect(after.filter((b) => b.id === un || b.id.startsWith(un + '.')).every((b) => b.surface && b.faces === 1)).toBe(true)

  // the solid tools on a surface: a clear message, not an OpenCascade failure
  const join = await add('combine', { target: [loft], tools: [off], operation: 'join', keepTools: false })
  const f = (await app.features()).find((x) => x.id === join)!
  expect(f.state).toBe('error')
  expect(f.error).toMatch(/solid/i)
  expect(f.error).toMatch(/surface/i)
})

test('surface workspace: every tool opens its dialog with a live preview, and Escape leaves nothing behind', async ({ app, page }) => {
  test.setTimeout(180_000)
  await app.open()
  await app.tab('Surface')
  const add = async (type: string, params: Record<string, unknown>) => {
    const id = await app.ev((c, a) => c.doc.getState().addFeature(a.type, a.params), { type, params })
    await app.idle()
    return id as string
  }
  const lineAt = async (z: number, x0 = 0, x1 = 30) => (await chainsOf(app, await addSketch(app, { origin: [0, 0, z], xDir: [1, 0, 0], normal: [0, 0, 1] }, [{ k: 'line', a: [x0, 0], b: [x1, 0] }])))[0]
  const a = await lineAt(0, -10), b = await lineAt(15, -10), c3 = await lineAt(7, -15, 40)
  const rect = (await chainsOf(app, await addSketch(app, XY, [{ k: 'rect', x0: 50, y0: 0, x1: 70, y1: 20 }])))[0]
  const wall = await add('surfaceLoft', { sections: [a.ref, b.ref], ruled: false })
  const wall2 = await add('surfaceExtrude', { curves: [c3.ref], direction: 'two', distance: 10, distance2: 5, axis: 'worldY' })
  const box = await app.ev((c) => c.doc.getState().addFeature('box', { width: 10, depth: 10, height: 10, position: [200, 0, 0] }, 'Box'))
  await app.idle()
  expect(await states(app)).not.toContain('error')
  const featureCount = (await app.features()).length

  const open = async (button: string, sel: { kind: string; id: string; index?: number }[], heading: string) => {
    await select(app, sel)
    await app.ribbon(button).first().click()
    await expect(title(app)).toHaveText(heading)
  }
  const leave = async () => {
    await page.keyboard.press('Escape')
    await expect(page.locator('.inspector-foot')).toBeHidden()
    expect((await app.features()).length).toBe(featureCount)
    await expect.poll(() => app.ev((c) => c.preview.getState().items.length), { timeout: 3000 }).toBe(0)
  }
  const preview = async (note?: RegExp) => {
    try {
      await expect.poll(() => app.ev((c) => c.preview.getState().items.length), { timeout: 15_000 }).toBeGreaterThan(0)
    } catch {
      // the dialog says why there is none
      throw new Error(`no live preview: ${await app.ev((c) => c.ui.getState().inspectorNotice)}`)
    }
    // a warning the tool is meant to give (two surfaces that do not meet) is the only message allowed
    const n = await app.ev((c) => c.ui.getState().inspectorNotice)
    if (note) expect(n).toMatch(note)
    else expect(n).toBeNull()
  }

  const wallEdge = (await edgesAtHeight(app, wall, 0))[0]
  const boxTop = await faceAtHeight(app, box, 10)

  await open('Extrude', [{ kind: 'curve', id: rect.ref }], 'Extrude Surface'); await preview(); await leave()
  await open('Revolve', [{ kind: 'curve', id: rect.ref }], 'Revolve Surface'); await preview(); await leave()
  await open('Sweep', [{ kind: 'curve', id: rect.ref }], 'Sweep Surface')
  await select(app, [{ kind: 'curve', id: c3.ref }]) // the path field is next in line
  await expect(app.inspector().getByTestId('sel-path')).toContainText('1 selected')
  await leave()
  await open('Loft', [{ kind: 'curve', id: a.ref }], 'Loft Surface')
  await select(app, [{ kind: 'curve', id: c3.ref }])
  await expect(app.inspector().getByTestId('sel-sections')).toContainText('2 selected')
  await preview(); await leave()
  await open('Patch', [{ kind: 'curve', id: rect.ref }], 'Patch'); await preview(); await leave()
  await open('Offset Surface', [{ kind: 'body', id: wall }], 'Offset Surface'); await preview(); await leave()
  await open('Trim', [{ kind: 'body', id: wall }], 'Trim')
  await select(app, [{ kind: 'body', id: wall2 }])
  await preview(); await leave()
  // a plane cuts as well: the YZ plane runs through the middle of the wall
  await open('Trim', [{ kind: 'body', id: wall }], 'Trim')
  await select(app, [{ kind: 'plane', id: 'planeYZ' }])
  await expect(app.inspector().getByTestId('sel-tool')).toContainText('1 selected')
  await preview(); await leave()
  await open('Extend', [{ kind: 'edge', id: wall, index: wallEdge }], 'Extend'); await preview(); await leave()
  await open('Stitch', [{ kind: 'body', id: wall }, { kind: 'body', id: wall2 }], 'Stitch'); await preview(/open edges? left/); await leave()
  await open('Thicken', [{ kind: 'body', id: wall }], 'Thicken'); await preview(); await leave()
  await open('Delete Face', [{ kind: 'face', id: box, index: boxTop }], 'Delete Face'); await preview(); await leave()
  // Move works on a surface like on any body
  await open('Move', [{ kind: 'body', id: wall }], 'Move / Transform'); await leave()
  await select(app, [])
  await app.ev((c) => c.runCommand('surface.unstitch'))
  await expect(title(app)).toHaveText('Unstitch')
  await select(app, [{ kind: 'body', id: box }])
  await preview(); await leave()
  expect(await states(app)).not.toContain('error')
})

test('surface workspace: Fit to Surface moves the top of a box onto a surface, with undo, a keep switch and a readable error', async ({ app, page }) => {
  test.setTimeout(150_000)
  await app.open()
  await app.tab('Surface')
  await expect(app.ribbon('Fit to Surface').first()).toBeVisible()
  const add = async (type: string, params: Record<string, unknown>) => {
    const id = await app.ev((c, a) => c.doc.getState().addFeature(a.type, a.params), { type, params })
    await app.idle()
    return id as string
  }
  const box = await app.ev((c) => c.doc.getState().addFeature('box', { width: 10, depth: 10, height: 10, position: [0, 0, 0] }, 'Box'))
  await app.idle()
  near(await app.volume(box), 1000)
  // a wide flat patch, then a copy of it 6 mm up: the surface the top of the box has to follow
  const big = (await chainsOf(app, await addSketch(app, XY, [{ k: 'rect', x0: -20, y0: -20, x1: 20, y1: 20 }])))[0]
  const patch = await add('surfacePatch', { boundary: [big.ref], continuity: 'g0' })
  const lid = await add('surfaceOffset', { faces: [patch], distance: 6 })
  expect((await app.features()).find((f) => f.id === lid)!.state).toBe('ok')

  // pick the top face, open the tool, then pick the surface
  const top = await faceAtHeight(app, box, 10)
  expect(top).toBeGreaterThanOrEqual(0)
  await select(app, [{ kind: 'face', id: box, index: top }])
  await app.ribbon('Fit to Surface').first().click()
  await expect(title(app)).toHaveText('Fit Face to Surface')
  await expect(app.inspector().getByTestId('sel-faces')).toContainText('1 selected')
  await select(app, [{ kind: 'body', id: lid }])
  await expect(app.inspector().getByTestId('sel-target')).toContainText('1 selected')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBeGreaterThan(0)
  expect(await app.ev((c) => c.ui.getState().inspectorNotice)).toBeNull()
  await app.ok()
  const rep = (await app.features()).at(-1)!
  expect(rep.type).toBe('surfaceReplaceFace')
  expect(rep.state, rep.error).toBe('ok')
  near(await app.volume(box), 600)
  expect((await info(app, box)).surface).toBe(false)
  expect((await info(app, box)).faces).toBe(6)
  expect((await info(app, lid)).surface).toBe(true) // kept by default
  await app.shot('surface-replace-face')

  // undo puts the top back, redo moves it again
  await app.ev((c) => c.runCommand('edit.undo'))
  await app.idle()
  near(await app.volume(box), 1000)
  await app.ev((c) => c.runCommand('edit.redo'))
  await app.idle()
  near(await app.volume(box), 600)

  // switching off "keep" uses the surface up
  await app.ev((c, a) => c.doc.getState().updateFeature(a.id, { ...a.params, keep: false }), { id: rep.id, params: rep.params })
  await app.idle()
  expect((await app.features()).find((f) => f.id === rep.id)!.state).toBe('ok')
  expect((await infos(app)).some((b) => b.id === lid)).toBe(false)
  near(await app.volume(box), 600)

  // a surface too small to reach over the face says so in the dialog
  const small = (await chainsOf(app, await addSketch(app, XY, [{ k: 'rect', x0: 30, y0: 30, x1: 33, y1: 33 }])))[0]
  const tiny = await add('surfacePatch', { boundary: [small.ref], continuity: 'g0' })
  const top2 = await faceAtHeight(app, box, 6)
  expect(top2).toBeGreaterThanOrEqual(0)
  await select(app, [{ kind: 'face', id: box, index: top2 }])
  await app.ribbon('Fit to Surface').first().click()
  await select(app, [{ kind: 'body', id: tiny }])
  await expect.poll(() => app.ev((c) => c.ui.getState().inspectorNotice), { timeout: 15_000 }).toMatch(/does not cover the face/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.inspector-foot')).toBeHidden()
  near(await app.volume(box), 600)
})

test('surface workspace: extending two neighbouring edges fills the corner, and a closed surface thickens into a hollow solid', async ({ app }) => {
  test.setTimeout(120_000)
  await app.open()
  await app.tab('Surface')
  const add = async (type: string, params: Record<string, unknown>) => {
    const id = await app.ev((c, a) => c.doc.getState().addFeature(a.type, a.params), { type, params })
    await app.idle()
    return id as string
  }

  // a 20 x 10 patch: pick the edge on x = 20 and the one on y = 10 (they meet at a corner) and extend them by 3
  const sk = await addSketch(app, XY, [
    { k: 'line', a: [0, 0], b: [20, 0] }, { k: 'line', a: [20, 0], b: [20, 10] }, { k: 'line', a: [20, 10], b: [0, 10] }, { k: 'line', a: [0, 10], b: [0, 0] },
  ])
  const [rect] = await chainsOf(app, sk)
  const patch = await add('surfacePatch', { boundary: [rect.ref], continuity: 'g0' })
  const edgeOn = (axis: number, v: number): Promise<number[]> => app.ev((c, a) => {
    const b = c.doc.getState().geometry.find((x: any) => x.id === a.id) // eslint-disable-line
    const e = b.mesh.edges, ids = b.mesh.edgeIds
    const out = new Set<number>()
    for (let s = 0; s < e.length / 6; s++) if (Math.abs(e[s * 6 + a.axis] - a.v) < 1e-4 && Math.abs(e[s * 6 + 3 + a.axis] - a.v) < 1e-4) out.add(ids[s])
    return [...out]
  }, { id: patch, axis, v })
  const [ex] = await edgeOn(0, 20), [ey] = await edgeOn(1, 10)
  await select(app, [{ kind: 'edge', id: patch, index: ex }, { kind: 'edge', id: patch, index: ey }])
  await app.ribbon('Extend').first().click()
  await expect(title(app)).toHaveText('Extend')
  await app.field('Distance', '3')
  await app.ok()
  expect((await app.features()).at(-1)!.state).toBe('ok')
  const ext = await info(app, patch)
  near(ext.area, 200 + 30 + 60 + 9, 0.01) // two strips and the 3 x 3 corner
  expect(ext.faces).toBe(4)
  expect(ext.free).toBe(8) // two far edges, two corner rims, two strip ends, two untouched edges

  // a closed box surface (a box taken apart and stitched back without making a solid) thickens into a hollow solid
  const boxId = await app.ev((c) => c.doc.getState().addFeature('box', { width: 10, depth: 10, height: 10, position: [100, 0, 0] }, 'Box'))
  await app.idle()
  const un = await add('surfaceUnstitch', { source: [boxId] })
  const pieces = (await infos(app)).filter((b) => b.id === un || b.id.startsWith(un + '.')).map((b) => b.id)
  expect(pieces.length).toBe(6)
  await add('surfaceStitch', { surfaces: pieces, tolerance: 0.01, solid: false })
  const closed = await info(app, pieces[0])
  expect(closed.surface).toBe(true)
  expect(closed.free).toBe(0)

  await select(app, [{ kind: 'body', id: pieces[0] }])
  await app.ribbon('Thicken').first().click()
  await expect(title(app)).toHaveText('Thicken')
  await app.field('Thickness', '2')
  await app.ok()
  const last = (await app.features()).at(-1)!
  expect(last.state, last.error).toBe('ok')
  const hollow = await info(app, pieces[0])
  expect(hollow.surface).toBe(false)
  expect(hollow.faces).toBe(12) // outer and inner wall
  const across = await app.ev((c, id) => {
    const b = c.doc.getState().geometry.find((x: any) => x.id === id) // eslint-disable-line
    const p = b.mesh.positions
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]) }
    return hi - lo
  }, pieces[0])
  expect(Math.abs(across - 14) < 0.01 || Math.abs(across - 10) < 0.01).toBe(true) // 2 mm outward makes 14 across, inward keeps the 10
})

test('surface workspace: extending two edges that meet on a cylinder wall and on a sphere window closes the corner, natural and tangent', async ({ app }) => {
  test.setTimeout(150_000)
  await app.open()
  await app.tab('Surface')
  const add = async (type: string, params: Record<string, unknown>) => {
    const id = await app.ev((c, a) => c.doc.getState().addFeature(a.type, a.params), { type, params })
    await app.idle()
    return id as string
  }
  /** Edge indices of a body whose two ends both satisfy `on` (the source of a boolean expression in x, y, z). */
  const edgesWhere = (id: string, on: string): Promise<number[]> => app.ev((c, a) => {
    const f = new Function('x', 'y', 'z', 'return ' + a.on) as (x: number, y: number, z: number) => boolean // eslint-disable-line
    const b = c.doc.getState().geometry.find((x: any) => x.id === a.id) // eslint-disable-line
    const e = b.mesh.edges, ids = b.mesh.edgeIds
    const out = new Set<number>()
    for (let s = 0; s < e.length / 6; s++) if (f(e[s * 6], e[s * 6 + 1], e[s * 6 + 2]) && f(e[s * 6 + 3], e[s * 6 + 4], e[s * 6 + 5])) out.add(ids[s])
    return [...out]
  }, { id, on })
  /** The range of an expression in x, y, z over the vertices of a body. */
  const spread = (id: string, of: string): Promise<[number, number]> => app.ev((c, a) => {
    const f = new Function('x', 'y', 'z', 'return ' + a.of) as (x: number, y: number, z: number) => number // eslint-disable-line
    const p = c.doc.getState().geometry.find((x: any) => x.id === a.id).mesh.positions // eslint-disable-line
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < p.length; i += 3) { const v = f(p[i], p[i + 1], p[i + 2]); lo = Math.min(lo, v); hi = Math.max(hi, v) }
    return [lo, hi]
  }, { id, of })
  const extend = async (id: string, edges: number[], mode: 'Natural' | 'Tangent', distance: string) => {
    await select(app, edges.map((index) => ({ kind: 'edge', id, index })))
    await app.ribbon('Extend').first().click()
    await expect(title(app)).toHaveText('Extend')
    await app.field('Distance', distance)
    await app.inspector().getByRole('radio', { name: mode, exact: true }).click()
    await app.ok()
    const f = (await app.features()).at(-1)!
    expect(f.state, f.error).toBe('ok')
  }
  const undo = async () => { await app.ev((c) => c.doc.getState().undo()); await app.idle() }

  // a quarter of a cylinder wall: radius 5, 10 tall. The top arc and the straight edge on the Y axis meet at a corner
  const line = (await chainsOf(app, await addSketch(app, XZ, [{ k: 'line', a: [5, 0], b: [5, 10] }])))[0]
  const wall = await add('surfaceRevolve', { curves: [line.ref], axis: 'worldZ', angle: 90 })
  const patch = (await info(app, wall)).area
  near(patch, (Math.PI / 2) * 5 * 10, 0.01)
  const pair = [...(await edgesWhere(wall, 'Math.abs(z - 10) < 1e-4')), ...(await edgesWhere(wall, 'Math.abs(x) < 1e-4'))]
  expect(pair.length).toBe(2)

  await extend(wall, pair, 'Natural', '2')
  let w = await info(app, wall)
  near(w.area, patch + (Math.PI / 2) * 5 * 2 + 10 * 2 + 4, 0.01) // the arc strip, the straight strip and the 2 x 2 corner: a cylinder unrolls flat
  expect(w.faces).toBe(4)
  expect(w.free).toBe(8) // the rim only: nothing is open at the corner
  const [lo, hi] = await spread(wall, 'Math.hypot(x, y)')
  expect(lo).toBeGreaterThan(5 - 0.02)
  expect(hi).toBeLessThan(5 + 0.02)
  await undo()
  expect((await info(app, wall)).free).toBe(4)

  await extend(wall, pair, 'Tangent', '2')
  w = await info(app, wall)
  expect(w.faces).toBe(4)
  expect(w.free).toBe(8)
  expect(w.area).toBeGreaterThan(patch + 2 * 15)
  await undo()

  // a lat-long window of a sphere of radius 10: doubly curved, so the corner patch has to follow the sphere
  const arc = (await chainsOf(app, await addSketch(app, XZ, [{ k: 'arc', c: [0, 0], s: [10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6)], e: [10 * Math.cos(Math.PI / 3), 10 * Math.sin(Math.PI / 3)] }])))[0]
  const win = await add('surfaceRevolve', { curves: [arc.ref], axis: 'worldZ', angle: 90 })
  const top = 10 * Math.sin(Math.PI / 3)
  const corner = [...(await edgesWhere(win, `Math.abs(z - ${top}) < 1e-3`)), ...(await edgesWhere(win, 'Math.abs(x) < 1e-4'))]
  expect(corner.length).toBe(2)

  await extend(win, corner, 'Natural', '1.5')
  const s = await info(app, win)
  expect(s.faces).toBe(4)
  expect(s.free).toBe(8)
  const [slo, shi] = await spread(win, 'Math.hypot(x, y, z)')
  expect(slo).toBeGreaterThan(10 - 0.03)
  expect(shi).toBeLessThan(10 + 0.03)
  await undo()

  await extend(win, corner, 'Tangent', '1.5')
  const t = await info(app, win)
  expect(t.faces).toBe(4)
  expect(t.free).toBe(8)
  expect((await spread(win, 'Math.hypot(x, y, z)'))[1]).toBeGreaterThan(10 + 0.01) // straight off the sphere along its tangents
  expect(await states(app)).not.toContain('error')
})
