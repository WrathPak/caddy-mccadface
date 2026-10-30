import { test, expect, addSketch, XY, XZ, type App } from './helpers'
import { addBox, addCylinder, frame, selectFace } from './detail-kit'

/**
 * Drag handles of the tools: every distance or angle that has a place in the viewport gets an arrow or an arc, the way Extrude does.
 * Each test opens the tool, checks where the handle stands, drags it with real mouse moves and checks the value and the preview.
 */

type V3 = [number, number, number]
const title = (app: App) => app.inspector().locator('.panel-title')
const values = (app: App) => app.ev((c) => c.ui.getState().inspector?.values)
const num = async (app: App, key: string) => (await values(app))[key] as number

/** Add a feature without the dialog, then open it for editing (double click on its chip in the timeline). */
async function openFeature(app: App, type: string, params: Record<string, unknown>, label: string) {
  await app.ev((c, a) => c.doc.getState().addFeature(a.type, a.params), { type, params })
  await app.idle()
  await app.page.locator('.tl .chip').last().dblclick()
  await expect(title(app)).toHaveText(label)
}
/** Change values in the open dialog the way the viewport handles do (the dialog is not reopened). */
const patch = (app: App, p: Record<string, unknown>) => app.ev((c, p) => { const i = c.ui.getState().inspector; i.onChange({ ...i.values, ...p }) }, p)

const slot = (app: App, i = 0) => app.ev((c, i) => {
  const s = c.manips[i].getState()
  return { active: s.active as boolean, o: s.origin as V3, d: s.dir as V3, tip: s.tip as number, factor: s.factor as number }
}, i)
const active = (app: App) => app.ev((c) => c.manips.map((m: any) => m.getState().active as boolean)) // eslint-disable-line
const angle = (app: App, i = 0) => app.ev((c, i) => {
  const s = c.angleManips[i].getState()
  return { active: s.active as boolean, o: s.origin as V3, axis: s.axis as V3, start: s.start as V3, radius: s.radius as number, angle: s.angle as number, scale: s.scale as number }
}, i)

const tipAt = (m: { o: V3; d: V3 }, t: number): V3 => [m.o[0] + m.d[0] * t, m.o[1] + m.d[1] * t, m.o[2] + m.d[2] * t]
const close = (a: number[], b: number[], eps = 0.05) => a.forEach((x, i) => expect(Math.abs(x - b[i]), `${a} vs ${b}`).toBeLessThan(eps))
const parallel = (a: number[], b: number[]) => expect(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))).toBeGreaterThan(0.999)

/** Grab arrow `i` by its tip and pull it `by` mm further along its direction, with real mouse moves. */
async function pull(app: App, i: number, by: number) {
  const { page } = app
  const m = await slot(app, i)
  const from = await app.project(...tipAt(m, m.tip))
  const to = await app.project(...tipAt(m, m.tip + by))
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 3 })
  await page.mouse.move(from.x, from.y, { steps: 3 })
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  await app.idle()
}

const rot = (v: V3, k: V3, deg: number): V3 => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  const kv = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]]
  const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2]
  return [0, 1, 2].map((j) => v[j] * c + kv[j] * s + k[j] * kd * (1 - c)) as V3
}
/** Grab the knob of the angle handle and turn it to `to` degrees (of the arc) along the arc. */
async function turn(app: App, to: number, slotIndex = 0) {
  const { page } = app
  const m = await angle(app, slotIndex)
  const at = (deg: number) => {
    const r = rot(m.start, m.axis, deg)
    return app.project(m.o[0] + r[0] * m.radius, m.o[1] + r[1] * m.radius, m.o[2] + r[2] * m.radius)
  }
  const from = await at(m.angle)
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 3 })
  await page.mouse.move(from.x, from.y, { steps: 3 })
  await page.mouse.down()
  const n = Math.max(2, Math.ceil(Math.abs(to - m.angle) / 12))
  for (let k = 1; k <= n; k++) {
    const p = await at(m.angle + ((to - m.angle) * k) / n)
    await page.mouse.move(p.x, p.y, { steps: 3 })
  }
  await page.mouse.up()
  await app.idle()
}

/** Bounding box of everything the live preview shows. */
const previewBox = (app: App) => app.ev((c) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const it of c.preview.getState().items) {
    const p = it.mesh.positions
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]) }
  }
  return { min: lo, max: hi }
})
const previewReady = (app: App) => expect.poll(() => app.ev((c) => c.preview.getState().items.length), { timeout: 30_000 }).toBeGreaterThan(0)

const home = async (app: App) => { await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') }); await app.cameraStable() }
/** Frame the model, then back off a few notches: the handles of a pattern or a connector can stand well outside the part. */
const wide = async (app: App, ticks = 4) => {
  await home(app)
  const b = (await app.page.locator('.vp canvas').first().boundingBox())!
  await app.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  for (let i = 0; i < ticks; i++) await app.page.mouse.wheel(0, 200)
  await app.cameraStable()
}

/** Edge index of a body that passes through the point. */
const edgeThrough = (app: App, id: string, p: V3): Promise<number> => app.ev((c, a) => {
  const b = c.doc.getState().geometry.find((x: any) => x.id === a.id) // eslint-disable-line
  const e = b.mesh.edges, ids = b.mesh.edgeIds
  for (let s = 0; s < e.length / 6; s++) {
    const A = [e[s * 6], e[s * 6 + 1], e[s * 6 + 2]], B = [e[s * 6 + 3], e[s * 6 + 4], e[s * 6 + 5]]
    const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], ap = [a.p[0] - A[0], a.p[1] - A[1], a.p[2] - A[2]]
    const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
    const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (l2 || 1)))
    if (Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t) < 1e-3) return ids ? ids[s] : s
  }
  return -1
}, { id, p })

/** A face of body `index` whose normal points along `dir` (all triangles of the face). */
const faceFacing = (app: App, dir: V3, index = 0): Promise<number> => app.ev((c, a) => {
  const m = c.doc.getState().geometry[a.index].mesh
  for (let t = 0; t < m.indices.length / 3; t++) {
    const i = m.indices[t * 3] * 3
    if (m.normals[i] * a.dir[0] + m.normals[i + 1] * a.dir[1] + m.normals[i + 2] * a.dir[2] > 0.99) return m.faceIds[t] as number
  }
  return -1
}, { dir, index })

async function states(app: App) {
  const f = await app.features()
  expect(f.map((x) => x.state), JSON.stringify(f.map((x) => x.error))).toEqual(f.map(() => 'ok'))
}

// ---------------------------------------------------------------- primitives

test('Box: an arrow for each size, dragged out to resize it', async ({ app }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await expect(title(app)).toHaveText('Box')
  await patch(app, { width: 30, depth: 20, height: 10 })
  await previewReady(app)
  await home(app)
  await expect.poll(() => active(app)).toEqual([true, true, true, false, false, false])
  const h = await slot(app, 0), w = await slot(app, 1), d = await slot(app, 2)
  // height from the middle of the base straight up, width / depth from the middle of the box out to a face
  close(h.o, [0, 0, 0]); close(h.d, [0, 0, 1]); expect(h.tip).toBeCloseTo(10, 3)
  close(w.o, [0, 0, 5]); close(w.d, [1, 0, 0]); expect(w.tip).toBeCloseTo(15, 3); expect(w.factor).toBe(2)
  close(d.o, [0, 0, 5]); close(d.d, [0, 1, 0]); expect(d.tip).toBeCloseTo(10, 3)
  await pull(app, 0, 6)
  expect(await num(app, 'height')).toBeCloseTo(16, 0)
  await pull(app, 1, 5)
  expect(await num(app, 'width')).toBeCloseTo(40, 0)
  await pull(app, 2, -4)
  expect(await num(app, 'depth')).toBeCloseTo(12, 0)
  await expect.poll(async () => {
    const b = await previewBox(app)
    return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map(Math.round)
  }).toEqual([40, 12, 16])
  await app.ok()
  await states(app)
  const b = await app.bbox()
  expect(Math.round(b.max[0] - b.min[0])).toBe(40)
})

test('Cylinder: height and radius arrows', async ({ app }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.cylinder'))
  await expect(title(app)).toHaveText('Cylinder')
  await patch(app, { radius: 8, height: 20 })
  await previewReady(app)
  await home(app)
  await expect.poll(() => active(app)).toEqual([true, true, false, false, false, false])
  const h = await slot(app, 0), r = await slot(app, 1)
  close(h.o, [0, 0, 0]); close(h.d, [0, 0, 1]); expect(h.tip).toBeCloseTo(20, 3)
  close(r.o, [0, 0, 10]); parallel(r.d, [1, 0, 0]); expect(r.tip).toBeCloseTo(8, 3)
  await pull(app, 1, 4)
  expect(await num(app, 'radius')).toBeCloseTo(12, 0)
  await pull(app, 0, -5)
  expect(await num(app, 'height')).toBeCloseTo(15, 0)
  await expect.poll(async () => {
    const b = await previewBox(app)
    return [Math.round(b.max[0] - b.min[0]), Math.round(b.max[2] - b.min[2])]
  }).toEqual([24, 15])
  await app.ok()
  await states(app)
})

// ---------------------------------------------------------------- surface

async function lineSurface(app: App) {
  const sk = await addSketch(app, XY, [{ k: 'line', a: [-20, 0], b: [20, 0] }])
  const ref = await app.ev((c, fid) => { const ch = c.sketchData.getState().data[fid].chains[0]; return `crv:${fid}:${ch.key}${ch.id ? '@' + ch.id : ''}` }, sk)
  await app.ev((c, ref) => c.doc.getState().addFeature('surfaceExtrude', { curves: [ref], axis: 'normal', direction: 'one', distance: 10, distance2: 5 }), ref)
  await app.idle()
  return ref as string
}

test('Surface Extend: the arrow stands on the picked edge and points away from the surface', async ({ app }) => {
  await app.open()
  await lineSurface(app)
  await home(app)
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  // a sheet 40 wide and 10 high, standing on the line y = 0: the top edge, a side edge and the bottom edge
  const cases: { at: V3; origin: V3; dir: V3 }[] = [
    { at: [0, 0, 10], origin: [0, 0, 10], dir: [0, 0, 1] },
    { at: [20, 0, 5], origin: [20, 0, 5], dir: [1, 0, 0] },
    { at: [-20, 0, 5], origin: [-20, 0, 5], dir: [-1, 0, 0] },
    { at: [0, 0, 0], origin: [0, 0, 0], dir: [0, 0, -1] },
  ]
  for (const k of cases) {
    const edge = await edgeThrough(app, id, k.at)
    expect(edge, `edge through ${k.at}`).toBeGreaterThanOrEqual(0)
    await app.ev((c, a) => c.ui.getState().setSelection([{ kind: 'edge', id: a.id, index: a.edge }]), { id, edge })
    await app.ev((c) => c.runCommand('surface.extend'))
    await expect(title(app)).toHaveText('Extend')
    await expect.poll(async () => (await slot(app)).active).toBe(true)
    await expect.poll(async () => (await slot(app)).o[0]).toBeCloseTo(k.origin[0], 2)
    const m = await slot(app)
    close(m.o, k.origin, 0.1)
    close(m.d, k.dir, 0.01)
    expect(m.tip).toBeCloseTo(5, 3)
    await app.page.keyboard.press('Escape')
    await expect(app.inspector()).toHaveCount(0)
  }
})

test('Surface Extend: dragging the arrow lengthens the surface', async ({ app }) => {
  await app.open()
  await lineSurface(app)
  await home(app)
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  const edge = await edgeThrough(app, id, [0, 0, 10])
  await app.ev((c, a) => c.ui.getState().setSelection([{ kind: 'edge', id: a.id, index: a.edge }]), { id, edge })
  await app.ev((c) => c.runCommand('surface.extend'))
  await expect(title(app)).toHaveText('Extend')
  await previewReady(app)
  await expect.poll(async () => (await previewBox(app)).max[2]).toBeCloseTo(15, 1)
  await pull(app, 0, 8)
  expect(await num(app, 'distance')).toBeCloseTo(13, 0)
  await expect.poll(async () => (await previewBox(app)).max[2]).toBeCloseTo(10 + (await num(app, 'distance')), 1)
  await app.ok()
  await states(app)
  expect((await app.bbox()).max[2]).toBeCloseTo(10 + 13, 0)
})

test('Surface Extrude: two sides get a second arrow for the second distance', async ({ app }) => {
  await app.open()
  const ref = await lineSurface(app)
  await app.ev((c) => c.doc.getState().removeFeature(c.doc.getState().features.at(-1).id))
  await openFeature(app, 'surfaceExtrude', { curves: [ref], axis: 'normal', direction: 'two', distance: 10, distance2: 5 }, 'Extrude Surface')
  await home(app)
  await expect.poll(() => active(app)).toEqual([true, true, false, false, false, false])
  const a = await slot(app, 0), b = await slot(app, 1)
  close(a.d, [0, 0, 1], 0.01); close(b.d, [0, 0, -1], 0.01)
  expect(a.tip).toBeCloseTo(10, 3); expect(b.tip).toBeCloseTo(5, 3)
  await pull(app, 1, 3)
  expect(await num(app, 'distance2')).toBeCloseTo(8, 0)
  expect(await num(app, 'distance')).toBe(10)
  await expect.poll(async () => (await previewBox(app)).min[2]).toBeCloseTo(-8, 0)
  await app.page.keyboard.press('Escape')
})

test('Surface Revolve: an arc round the axis sets the angle', async ({ app }) => {
  await app.open()
  // a line 10 mm out from the Z axis, spun about the sketch Y axis (which is world Z on the XZ plane)
  await addSketch(app, XZ, [{ k: 'line', a: [10, 0], b: [10, 15] }])
  await home(app)
  await app.ev((c) => c.runCommand('surface.revolve'))
  await expect(title(app)).toHaveText('Revolve Surface')
  await expect.poll(async () => (await angle(app)).active).toBe(true)
  const a = await angle(app)
  parallel(a.axis, [0, 0, 1])
  parallel(a.start, [1, 0, 0])
  expect(a.radius).toBeCloseTo(10, 1)
  expect(a.angle).toBe(360)
  expect(Math.abs(a.o[0]) + Math.abs(a.o[1])).toBeLessThan(0.05)
  await previewReady(app)
  await turn(app, 180)
  expect(await num(app, 'angle')).toBeGreaterThan(170)
  expect(await num(app, 'angle')).toBeLessThan(190)
  await expect.poll(async () => { const b = await previewBox(app); return Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) }).toBeLessThan(11)
  expect((await angle(app)).angle).toBeCloseTo(await num(app, 'angle'), 1)
  await app.ok()
  await states(app)
})

// ---------------------------------------------------------------- solid

test('Extrude: the second distance of two sides has its own arrow', async ({ app }) => {
  await app.open()
  const sk = await addSketch(app, XY, [{ k: 'rect', x0: -10, y0: -10, x1: 10, y1: 10 }])
  const ref = await app.ev((c, fid) => { const p = c.sketchData.getState().data[fid].profiles[0]; return `prof:${fid}:${p.key}${p.id ? '@' + p.id : ''}` }, sk)
  await openFeature(app, 'extrude', { profiles: [ref], direction: 'two', distance: 10, distance2: 4, operation: 'new', targets: [] }, 'Extrude')
  await home(app)
  await expect.poll(() => active(app)).toEqual([true, true, false, false, false, false])
  const a = await slot(app, 0), b = await slot(app, 1)
  close(a.d, [0, 0, 1], 0.01); close(b.d, [0, 0, -1], 0.01)
  expect(a.tip).toBeCloseTo(10, 3); expect(b.tip).toBeCloseTo(4, 3)
  await pull(app, 1, 3)
  expect(await num(app, 'distance2')).toBeCloseTo(7, 0)
  expect(await num(app, 'distance')).toBe(10)
  await expect.poll(async () => (await previewBox(app)).min[2]).toBeCloseTo(-7, 0)
  await app.ok()
  await states(app)
})

test('Hole: depth and diameter arrows at the hole', async ({ app, page }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  const top = { origin: [0, 0, 20] as V3, xDir: [1, 0, 0] as V3, normal: [0, 0, 1] as V3 }
  const sk = await addSketch(app, top, [{ k: 'circle', c: [5, 5], r: 3 }])
  await openFeature(app, 'hole', { places: [sk], depthMode: 'depth', depth: 10, dia: 6, holeType: 'simple', tapType: 'simple', flip: false }, 'Hole')
  await home(app)
  await expect.poll(() => active(app)).toEqual([true, true, false, false, false, false])
  const depth = await slot(app, 0), dia = await slot(app, 1)
  // depth runs down into the body from the opening, the diameter arrow across it
  close(depth.d, [0, 0, -1], 0.01); expect(depth.o[0]).toBeCloseTo(5, 1); expect(depth.o[1]).toBeCloseTo(5, 1); expect(depth.o[2]).toBeCloseTo(20, 1)
  expect(depth.tip).toBeCloseTo(10, 3)
  parallel(dia.d, [1, 0, 0]); expect(dia.tip).toBeCloseTo(3, 3); expect(dia.factor).toBe(2)
  // the depth arrow's tip is inside the body: it is grabbed from behind the geometry, and letting go picks nothing
  const seq0 = await app.ev((c) => c.lastPick.getState().seq)
  await pull(app, 0, 4)
  expect(await num(app, 'depth')).toBeCloseTo(14, 0)
  await pull(app, 1, 1.5)
  expect(await num(app, 'dia')).toBeCloseTo(9, 0)
  expect(await app.ev((c) => c.lastPick.getState().seq)).toBe(seq0)
  await previewReady(app)
  await app.ok()
  await states(app)
  // the finished hole is 14 deep: the box lost pi r^2 h
  expect(await app.volume()).toBeCloseTo(40 * 40 * 20 - Math.PI * 4.5 * 4.5 * 14, -1)
  void page
})

test('Hole: a counterbore adds arrows for its depth and diameter, a through hole drops the depth', async ({ app }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  const top = { origin: [0, 0, 20] as V3, xDir: [1, 0, 0] as V3, normal: [0, 0, 1] as V3 }
  const sk = await addSketch(app, top, [{ k: 'circle', c: [0, 0], r: 3 }])
  await openFeature(app, 'hole', { places: [sk], depthMode: 'depth', depth: 12, dia: 5, holeType: 'cbore', cbDia: 10, cbDepth: 4, tapType: 'simple' }, 'Hole')
  await home(app)
  await expect.poll(() => active(app)).toEqual([true, true, true, true, false, false])
  const [depth, cb, dia, cbDia] = await Promise.all([0, 1, 2, 3].map((i) => slot(app, i)))
  expect(depth.tip).toBeCloseTo(12, 3); expect(cb.tip).toBeCloseTo(4, 3); expect(dia.tip).toBeCloseTo(2.5, 3); expect(cbDia.tip).toBeCloseTo(5, 3)
  await pull(app, 1, 2)
  expect(await num(app, 'cbDepth')).toBeCloseTo(6, 0)
  await pull(app, 3, 2)
  expect(await num(app, 'cbDia')).toBeCloseTo(14, 0)
  await patch(app, { depthMode: 'through' })
  await expect.poll(() => active(app)).toEqual([true, true, true, false, false, false])
  await app.page.keyboard.press('Escape')
})

test('Hole: arcs for the countersink angle and the drill point angle', async ({ app }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  const top = { origin: [0, 0, 20] as V3, xDir: [1, 0, 0] as V3, normal: [0, 0, 1] as V3 }
  const sk = await addSketch(app, top, [{ k: 'circle', c: [0, 0], r: 3 }])
  await openFeature(app, 'hole', { places: [sk], depthMode: 'depth', depth: 12, dia: 5, holeType: 'csink', cskDia: 10, cskAngle: 90, tip: 118, tapType: 'simple' }, 'Hole')
  await wide(app, 1)
  await expect.poll(async () => (await angle(app, 0)).active && (await angle(app, 1)).active).toBe(true)
  const csk = await angle(app, 0), tip = await angle(app, 1)
  // the arcs show half the included angle, and stand on the rim of their cone
  expect(csk.scale).toBe(2); expect(csk.angle).toBeCloseTo(45, 3)
  expect(tip.scale).toBe(2); expect(tip.angle).toBeCloseTo(59, 3)
  expect(csk.o[2]).toBeCloseTo(20, 1); expect(Math.hypot(csk.o[0], csk.o[1])).toBeCloseTo(5, 1)
  expect(tip.o[2]).toBeCloseTo(8, 1); expect(Math.hypot(tip.o[0], tip.o[1])).toBeCloseTo(2.5, 1)
  parallel(csk.start, [0, 0, 1])
  // the knob swings in from the rim towards the axis of the hole, down along the cone
  for (const a of [csk, tip]) {
    const k = rot(a.start, a.axis, a.angle)
    expect(k[2]).toBeLessThan(-0.3)
    expect(k[0]).toBeLessThan(-0.3) // the rim is on the +X side of the hole
  }
  await turn(app, 60, 0)
  expect(await num(app, 'cskAngle')).toBeGreaterThan(116)
  expect(await num(app, 'cskAngle')).toBeLessThan(124)
  await expect.poll(async () => (await angle(app, 1)).active).toBe(true)
  await turn(app, 40, 1)
  expect(await num(app, 'tip')).toBeGreaterThan(76)
  expect(await num(app, 'tip')).toBeLessThan(84)
  await previewReady(app)
  await app.ok()
  await states(app)
})

test('Pattern: an arrow per grid direction sets the spacing', async ({ app }) => {
  await app.open()
  await addBox(app, 20, 20, 10)
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  await openFeature(app, 'pattern', { source: 'bodies', bodies: [id], kind: 'rect', axis1: 'X', count1: 3, distance1: 40, type1: 'spacing', second: true, axis2: 'Y', count2: 2, distance2: 40, type2: 'spacing', operation: 'new' }, 'Pattern')
  await wide(app)
  await expect.poll(() => active(app)).toEqual([true, true, false, false, false, false])
  const a = await slot(app, 0), b = await slot(app, 1)
  close(a.d, [1, 0, 0], 0.01); close(b.d, [0, 1, 0], 0.01)
  expect(a.tip).toBeCloseTo(40, 3)
  await pull(app, 0, 10)
  expect(await num(app, 'distance1')).toBeCloseTo(50, 0)
  await pull(app, 1, -15)
  expect(await num(app, 'distance2')).toBeCloseTo(25, 0)
  await previewReady(app)
  await expect.poll(async () => { const p = await previewBox(app); return Math.round(p.max[0] - p.min[0]) }).toBe(20 + 2 * 50)
  await app.ok()
  await states(app)
})

test('Pattern: a circular pattern has an arc for the angle', async ({ app }) => {
  await app.open()
  await addBox(app, 10, 10, 10, [30, 0, 0])
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  await openFeature(app, 'pattern', { source: 'bodies', bodies: [id], kind: 'circ', caxis: 'Z', ccount: 4, cangle: 360, operation: 'new' }, 'Pattern')
  await wide(app)
  await expect.poll(async () => (await angle(app)).active).toBe(true)
  const a = await angle(app)
  parallel(a.axis, [0, 0, 1])
  expect(a.radius).toBeGreaterThan(20)
  expect(a.angle).toBe(360)
  await turn(app, 180)
  expect(await num(app, 'cangle')).toBeGreaterThan(165)
  expect(await num(app, 'cangle')).toBeLessThan(195)
  await previewReady(app)
  await app.ok()
  await states(app)
})

test('Pattern: along a path the arrow sets the spacing', async ({ app }) => {
  await app.open()
  await addBox(app, 10, 10, 10)
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  const sk = await addSketch(app, XY, [{ k: 'line', a: [0, 30], b: [120, 30] }])
  await openFeature(app, 'pattern', { source: 'bodies', bodies: [id], kind: 'path', path: [sk], pcount: 3, ptype: 'spacing', pdistance: 25, operation: 'new' }, 'Pattern')
  await wide(app)
  await expect.poll(async () => (await slot(app, 0)).active).toBe(true)
  const a = await slot(app, 0)
  close(a.d, [1, 0, 0], 0.01)
  expect(a.tip).toBeCloseTo(25, 3)
  await pull(app, 0, 10)
  expect(await num(app, 'pdistance')).toBeCloseTo(35, 0)
  await previewReady(app)
  await app.ok()
  await states(app)
})

test('Draft: an arc about the hinge sets the angle, positive narrows the body along the pull direction', async ({ app }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  await home(app)
  const face = await faceFacing(app, [1, 0, 0])
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  await app.ev((c, a) => c.ui.getState().setSelection([{ kind: 'face', id: a.id, index: a.face }]), { id, face })
  await app.ev((c) => c.runCommand('solid.draft'))
  await expect(title(app)).toHaveText('Draft')
  await patch(app, { plane: ['planeXY'], angle: 3 })
  await expect.poll(async () => (await angle(app)).active).toBe(true)
  const a = await angle(app)
  // the hinge is where the +X wall meets the neutral plane
  parallel(a.axis, [0, 1, 0])
  close(a.start, [0, 0, 1], 0.01)
  expect(a.o[0]).toBeCloseTo(20, 1); expect(a.o[2]).toBeCloseTo(0, 1)
  await turn(app, 12)
  const deg = await num(app, 'angle')
  expect(deg).toBeGreaterThan(10); expect(deg).toBeLessThan(14)
  await expect.poll(async () => { const b = await previewBox(app); return b.max[0] }, { timeout: 30_000 }).toBeCloseTo(20, 1)
  // along +Z (the pull direction) the wall leans in: the top of the +X wall is at 20 - 20 tan(angle)
  const topX = await app.ev((c) => {
    let x = -Infinity
    for (const it of c.preview.getState().items) { const p = it.mesh.positions; for (let i = 0; i < p.length; i += 3) if (p[i + 2] > 19.9) x = Math.max(x, p[i]) }
    return x
  })
  expect(topX).toBeCloseTo(20 - 20 * Math.tan((deg * Math.PI) / 180), 1)
  await app.ok()
  await states(app)
})

// ---------------------------------------------------------------- construct

test('Construction plane: an arrow for the offset, an arc for the angle', async ({ app }) => {
  await app.open()
  await openFeature(app, 'constructPlane', { mode: 'offset', base: ['planeXY'], distance: 10 }, 'Construction Plane')
  await home(app)
  await expect.poll(async () => (await slot(app, 0)).active).toBe(true)
  const m = await slot(app, 0)
  close(m.o, [0, 0, 0]); close(m.d, [0, 0, 1], 0.01); expect(m.tip).toBeCloseTo(10, 3)
  await pull(app, 0, 5)
  expect(await num(app, 'distance')).toBeCloseTo(15, 0)
  await expect.poll(() => app.ev((c) => c.planes.getState().data.preview?.origin[2])).toBeCloseTo(await num(app, 'distance'), 1)
  await patch(app, { mode: 'angle', axis: ['axisX'], angle: 30 })
  await expect.poll(async () => (await angle(app)).active).toBe(true)
  await expect.poll(() => active(app)).toEqual([false, false, false, false, false, false])
  const a = await angle(app)
  parallel(a.axis, [1, 0, 0])
  expect(a.angle).toBe(30)
  await turn(app, 60)
  expect(await num(app, 'angle')).toBeGreaterThan(57); expect(await num(app, 'angle')).toBeLessThan(63)
  // the plane through the X axis turned 60 degrees from XY has the normal (0, -sin, cos) or its mirror
  const n = await app.ev((c) => c.planes.getState().data.preview.normal as V3)
  expect(Math.abs(n[2])).toBeCloseTo(Math.cos((await num(app, 'angle') * Math.PI) / 180), 1)
  await app.ok()
  await states(app)
})

test('Construction plane: tangent to a cylinder has an arc round it', async ({ app }) => {
  await app.open()
  await addCylinder(app, 10, 20)
  await frame(app)
  await selectFace(app, 'side')
  await app.ev((c) => c.runCommand('construct.planeTangent'))
  await expect(title(app)).toHaveText('Construction Plane')
  await expect.poll(async () => (await angle(app)).active).toBe(true)
  const a = await angle(app)
  parallel(a.axis, [0, 0, 1])
  expect(a.radius).toBeCloseTo(10, 1)
  await turn(app, 90)
  expect(await num(app, 'angle')).toBeGreaterThan(80)
  expect(await num(app, 'angle')).toBeLessThan(100)
  await app.ok()
  await states(app)
})

// ---------------------------------------------------------------- print

test('Hollow: the wall thickness and drain hole arrows', async ({ app }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  const drain = JSON.stringify({ p: [0, 10, 20], n: [0, 0, 1] })
  await openFeature(app, 'hollow', { bodies: [id], thickness: 2, diameter: 3, drains: [drain] }, 'Hollow')
  await home(app)
  await expect.poll(() => active(app)).toEqual([true, true, false, false, false, false])
  const t = await slot(app, 0), d = await slot(app, 1)
  expect(t.o[2]).toBeCloseTo(20, 1); close(t.d, [0, 0, -1], 0.01); expect(t.tip).toBeCloseTo(2, 3)
  expect(d.o[1]).toBeCloseTo(10, 1); parallel(d.d, [1, 0, 0]); expect(d.tip).toBeCloseTo(1.5, 3)
  await pull(app, 0, 2)
  expect(await num(app, 'thickness')).toBeCloseTo(4, 0)
  await pull(app, 1, 1)
  expect(await num(app, 'diameter')).toBeCloseTo(5, 0)
  await app.ok()
  await states(app)
  // 4 mm walls all round: 40 x 40 x 20 less the 32 x 32 x 12 void (the hole is a few mm3)
  expect(await app.volume()).toBeGreaterThan(40 * 40 * 20 - 32 * 32 * 12 - 200)
  expect(await app.volume()).toBeLessThan(40 * 40 * 20 - 32 * 32 * 12 + 1)
})

test('Split body: offset arrow on the cut plane, connector arrows on the first connector', async ({ app }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  await openFeature(app, 'split', { bodies: [id], mode: 'plane', plane: 'XY', offset: 5, connector: 'round', count: 1, size: 6, depth: 6, clearance: 0.2, angle: 15 }, 'Split body')
  await home(app)
  await expect.poll(() => active(app), { timeout: 30_000 }).toEqual([true, true, true, false, false, false])
  const o = await slot(app, 0), depth = await slot(app, 1), size = await slot(app, 2)
  close(o.d, [0, 0, 1], 0.01); expect(o.tip).toBeCloseTo(5, 3); expect(o.o[2]).toBeCloseTo(0, 1)
  expect(Math.hypot(o.o[0] - size.o[0], o.o[1] - size.o[1])).toBeGreaterThan(10) // clear of the connector in the middle
  // the connector stands on the cut plane z = 5 and goes down into the other part
  expect(depth.o[2]).toBeCloseTo(5, 1); parallel(depth.d, [0, 0, 1]); expect(depth.tip).toBeCloseTo(6, 3)
  expect(Math.hypot(depth.o[0] - size.o[0], depth.o[1] - size.o[1])).toBeCloseTo(3, 1) // half a size to the other side of the connector
  expect(size.o[2]).toBeCloseTo(5, 1); expect(size.tip).toBeCloseTo(3, 3); expect(size.factor).toBe(2)
  await pull(app, 0, 5)
  expect(await num(app, 'offset')).toBeCloseTo(10, 0)
  // the connector moves up with the plane
  await expect.poll(async () => (await slot(app, 2)).o[2], { timeout: 30_000 }).toBeCloseTo(10, 1)
  await pull(app, 2, 1)
  expect(await num(app, 'size')).toBeCloseTo(8, 0)
  await expect.poll(async () => (await slot(app, 1)).o[0], { timeout: 30_000 }).not.toBeCloseTo(depth.o[0], 1)
  await pull(app, 1, 1)
  expect(await num(app, 'depth')).toBeGreaterThan(6.5)
  await app.ok()
  await states(app)
  expect((await app.bodies()).length).toBe(2)
})

test('Split body: dovetails add an arc for the flare angle', async ({ app }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  await openFeature(app, 'split', { bodies: [id], mode: 'plane', plane: 'XY', offset: 8, connector: 'dovetail', count: 1, size: 6, depth: 6, clearance: 0.2, angle: 15 }, 'Split body')
  await home(app)
  await expect.poll(async () => (await angle(app)).active, { timeout: 30_000 }).toBe(true)
  const a = await angle(app)
  expect(Math.abs(a.axis[2])).toBeLessThan(0.01) // along the dovetail, in the cut plane
  expect(a.angle).toBe(15)
  expect(a.o[2]).toBeCloseTo(8, 1)
  await turn(app, 30)
  expect(await num(app, 'angle')).toBeGreaterThan(27); expect(await num(app, 'angle')).toBeLessThan(33)
  await app.page.keyboard.press('Escape')
})

// ---------------------------------------------------------------- detail

test('Text and logos: the depth arrow stands off the edge of the artwork, clear of the plate that moves it', async ({ app }) => {
  await app.open()
  await addBox(app, 30, 30, 10)
  await frame(app)
  await selectFace(app, 'top')
  await app.ribbon(/^Text$/).first().click()
  await expect(title(app)).toHaveText('Text and logos')
  await expect.poll(async () => (await slot(app)).active, { timeout: 45_000 }).toBe(true)
  const m = await slot(app)
  expect(m.o[2]).toBeCloseTo(10, 1); close(m.d, [0, 0, 1], 0.01)
  const art = await app.ev((c) => c.detail.getState().emboss as { point: V3; width: number } | null)
  expect(Math.hypot(m.o[0] - art!.point[0], m.o[1] - art!.point[1])).toBeGreaterThan(art!.width / 2) // outside the plate
  expect(m.tip).toBeCloseTo(await num(app, 'depth'), 3)
  await pull(app, 0, 1)
  expect(await num(app, 'depth')).toBeCloseTo(2, 0)
  await expect.poll(() => app.ev((c) => c.detail.getState().emboss?.mesh.positions.length), { timeout: 45_000 }).toBeGreaterThan(0)
  // engraving turns the arrow into the part
  await app.inspector().getByRole('radio', { name: /Engrave/ }).click()
  await expect.poll(async () => (await slot(app)).d[2], { timeout: 45_000 }).toBeCloseTo(-1, 2)
  await app.page.keyboard.press('Escape')
})

test('Texture: the depth arrow stands on the selected surface', async ({ app }) => {
  await app.open()
  await addBox(app, 30, 30, 10)
  await frame(app)
  await selectFace(app, 'top')
  await app.ribbon(/^Texture$/).first().click()
  await expect(title(app)).toHaveText('Texture')
  await expect.poll(async () => (await slot(app)).active, { timeout: 60_000 }).toBe(true)
  const m = await slot(app)
  expect(m.o[2]).toBeCloseTo(10, 1); close(m.d, [0, 0, 1], 0.01)
  expect(m.tip).toBeCloseTo(await num(app, 'depth'), 3)
  await pull(app, 0, 0.6)
  expect(await num(app, 'depth')).toBeCloseTo(1.3, 0)
  await app.inspector().getByRole('radio', { name: /Cut in/ }).click()
  await expect.poll(async () => (await slot(app)).d[2], { timeout: 60_000 }).toBeCloseTo(-1, 2)
  await app.page.keyboard.press('Escape')
})

test('Thread: the length arrow runs along the threaded face', async ({ app, page }) => {
  test.setTimeout(240_000)
  await app.open()
  await addCylinder(app, 4, 16)
  await frame(app)
  await selectFace(app, 'side')
  await app.ribbon(/^Thread$/).first().click()
  await expect(title(app)).toHaveText('Thread')
  await expect(page.getByTestId('detail-readout')).toContainText('M8', { timeout: 120_000 })
  await expect.poll(async () => (await slot(app)).active).toBe(true)
  const m = await slot(app)
  // the whole face: the arrow stands at the first end and reaches the other
  parallel(m.d, [0, 0, 1])
  expect(m.tip).toBeCloseTo(16, 2)
  const from = Math.min(m.o[2], m.o[2] + m.d[2] * m.tip)
  expect(from).toBeCloseTo(0, 1)
  await pull(app, 0, -6)
  expect(await num(app, 'length')).toBeCloseTo(10, 0)
  await expect(page.getByTestId('detail-readout')).toContainText('turns', { timeout: 120_000 })
  await app.page.keyboard.press('Escape')
})

for (const [kind, key] of [['fur', 'length'], ['scales', 'height'], ['spikes', 'height'], ['grass', 'height']] as const) {
  test(`${kind}: the ${key} arrow stands on the selected surface`, async ({ app }) => {
    test.setTimeout(120_000)
    await app.open()
    await addBox(app, 30, 30, 10)
    await frame(app)
    await selectFace(app, 'top')
    await app.ev((c, k) => c.runCommand('detail.' + k), kind)
    await expect.poll(async () => (await slot(app)).active, { timeout: 90_000 }).toBe(true)
    const m = await slot(app)
    expect(m.o[2]).toBeCloseTo(10, 1); close(m.d, [0, 0, 1], 0.01)
    const start = await num(app, key)
    expect(m.tip).toBeCloseTo(start, 3)
    await pull(app, 0, 2)
    expect(await num(app, key)).toBeCloseTo(start + 2, 0)
    await expect.poll(async () => (await slot(app)).tip, { timeout: 90_000 }).toBeCloseTo(await num(app, key), 1)
    await app.page.keyboard.press('Escape')
  })
}

test('Hair: the length arrow follows a strand out of the surface', async ({ app }) => {
  test.setTimeout(120_000)
  await app.open()
  await addBox(app, 30, 30, 10)
  await frame(app)
  await selectFace(app, 'top')
  await app.ev((c) => c.runCommand('hair.create'))
  await expect.poll(async () => (await slot(app)).active, { timeout: 90_000 }).toBe(true)
  const m = await slot(app)
  expect(m.o[2]).toBeCloseTo(10, 1)
  expect(m.d[2]).toBeGreaterThan(0.5)
  const start = await num(app, 'length')
  expect(m.tip).toBeCloseTo(start, 3)
  await pull(app, 0, 5)
  expect(await num(app, 'length')).toBeGreaterThan(start + 3)
  await app.page.keyboard.press('Escape')
})

// ---------------------------------------------------------------- mesh and inspection

test('Plane Cut: an arrow on the cutting plane sets the offset', async ({ app }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  const id = await app.ev((c) => c.doc.getState().geometry[0].id)
  await app.ev((c, id) => c.doc.getState().addFeature('meshConvert', { bodies: [id] }), id)
  await app.idle()
  await home(app)
  await app.ev((c) => c.runCommand('mesh.planeCut'))
  await expect(title(app)).toHaveText('Plane Cut')
  await expect.poll(async () => (await slot(app)).active).toBe(true)
  const m = await slot(app)
  close(m.d, [0, 0, 1], 0.01); expect(m.o[2]).toBeCloseTo(0, 3)
  await pull(app, 0, 8)
  expect(await num(app, 'offset')).toBeCloseTo(8, 0)
  await expect.poll(async () => (await previewBox(app)).min[2], { timeout: 30_000 }).toBeCloseTo(await num(app, 'offset'), 1)
  await app.ok()
  await states(app)
})

test('Section Analysis: the arrow moves the section plane', async ({ app }) => {
  await app.open()
  await addBox(app, 40, 40, 20)
  await home(app)
  await app.ev((c) => c.runCommand('inspect.section'))
  await expect.poll(async () => (await slot(app)).active).toBe(true)
  const m = await slot(app)
  close(m.d, [0, 0, 1], 0.01); expect(m.o[2]).toBeCloseTo(0, 3)
  expect(m.tip).toBeCloseTo(10, 1) // the first plane goes through the middle of the model
  await pull(app, 0, 5)
  expect(await app.ev((c) => c.ui.getState().section.offset)).toBeCloseTo(15, 0)
  expect(await num(app, 'offset')).toBeCloseTo(15, 0)
  await app.page.keyboard.press('Escape')
})
