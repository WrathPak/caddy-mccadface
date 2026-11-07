import { expect, viewBox, type App } from './helpers'

/* Shared helpers for the solids parity specs (59, 60). Everything a user does goes through the mouse and keyboard; `app.ev` only reads state. */

export type P3 = [number, number, number]
export interface Plane { origin: P3; xDir: P3; normal: P3 }

export const planeOf = (app: App): Promise<Plane> => app.ev((c) => c.sketch.getState().plane)
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
/** Sketch-local (x, y) on a plane to world. */
export function toWorld(pl: Plane, x: number, y: number): P3 {
  const yd = cross(pl.normal, pl.xDir)
  return [pl.origin[0] + pl.xDir[0] * x + yd[0] * y, pl.origin[1] + pl.xDir[1] * x + yd[1] * y, pl.origin[2] + pl.xDir[2] * x + yd[2] * y]
}
/** World to sketch-local. */
export function toLocal(pl: Plane, w: P3): [number, number] {
  const yd = cross(pl.normal, pl.xDir)
  const d = [w[0] - pl.origin[0], w[1] - pl.origin[1], w[2] - pl.origin[2]]
  return [d[0] * pl.xDir[0] + d[1] * pl.xDir[1] + d[2] * pl.xDir[2], d[0] * yd[0] + d[1] * yd[1] + d[2] * yd[2]]
}

/** Click a world point. */
/** Client pixel of a world point, for a camera that has already settled (app.project waits for the camera each time, which is slow). */
export function px(app: App, w: P3): Promise<{ x: number; y: number }> {
  return app.page.evaluate(([x, y, z]) => {
    const t = (window as any).__caddy.three // eslint-disable-line
    const cam = t.camera
    cam.updateMatrixWorld()
    const V = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements
    const mul = (m: number[], v: number[]) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3])
    const c = mul(P, mul(V, [x, y, z, 1]))
    const r = document.querySelector('.vp canvas')!.getBoundingClientRect()
    return { x: r.left + ((c[0] / c[3] + 1) / 2) * r.width, y: r.top + ((1 - c[1] / c[3]) / 2) * r.height }
  }, w)
}
export async function clickWorld(app: App, w: P3) {
  const p = await px(app, w)
  await app.page.mouse.move(p.x, p.y, { steps: 2 })
  await app.page.mouse.click(p.x, p.y)
}
export async function hoverWorld(app: App, w: P3) {
  const p = await px(app, w)
  await app.page.mouse.move(p.x, p.y, { steps: 2 })
}
/** Click sketch-local (x, y) in the open sketch. */
export async function skClick(app: App, x: number, y: number) {
  await clickWorld(app, toWorld(await planeOf(app), x, y))
}
export async function skHover(app: App, x: number, y: number) {
  await hoverWorld(app, toWorld(await planeOf(app), x, y))
}

export const sk = (app: App) => app.ev((c) => {
  const s = c.sketch.getState()
  return {
    entities: s.model.entities as any[], constraints: s.model.constraints as any[], projections: s.model.projections as any[] | undefined, // eslint-disable-line
    sel: s.sel, tool: s.tool, dof: s.info.dof, ok: s.info.ok, fixed: [...(s.info.fixed ?? [])] as string[], face: s.face as string | null,
    profiles: s.profiles.map((p: any) => ({ area: p.area, holes: p.holes.length })), // eslint-disable-line
  }
})
export type SkState = Awaited<ReturnType<typeof sk>>
export const circles = (m: SkState) => m.entities.filter((e) => e.type === 'circle')
export const pointOf = (m: SkState, id: string): [number, number] => { const e = m.entities.find((x) => x.id === id); return id === 'O' || !e ? [0, 0] : [e.x, e.y] }
export const userCircles = (m: SkState) => circles(m).filter((c) => !c.ref && !c.projected && !c.construction)

export async function openSketch(app: App, plane: 'XY' | 'XZ' | 'YZ' = 'XY') {
  const { page } = app
  await app.ribbon('Sketch').first().click()
  await app.showPlane(plane)
  await page.getByText(plane + ' plane').click()
  await expect(page.locator('.sk-bar')).toBeVisible()
  await app.ev((c) => c.ui.setState({ snap: false }))
  await app.cameraStable()
}
export const tool = (app: App, name: string | RegExp) => app.ribbon(name).first().click()
export const esc2 = async (app: App) => { await app.page.keyboard.press('Escape'); await app.page.keyboard.press('Escape') }

/** A rectangle in the open sketch from two clicked corners (sketch-local), then Escape. */
export async function skRect(app: App, x0: number, y0: number, x1: number, y1: number) {
  await tool(app, 'Rectangle')
  await skClick(app, x0, y0)
  await skClick(app, x1, y1)
  await app.page.keyboard.press('Escape')
}
/** A circle with the typed diameter, centre clicked at sketch-local (x, y). Leaves the tool. */
export async function skCircle(app: App, x: number, y: number, dia: number) {
  const { page } = app
  await tool(app, 'Circle')
  await skClick(app, x, y)
  await skHover(app, x + dia / 2, y + 0.3)
  await page.keyboard.type(String(dia))
  await page.keyboard.press('Enter')
  await esc2(app)
}
/** Dimension tool: pick things (clicks), click where it goes, type the value. */
export async function dim(app: App, picks: [number, number][], place: [number, number], value: string) {
  const { page } = app
  await page.keyboard.press('d')
  for (const p of picks) await skClick(app, p[0], p[1])
  await skClick(app, place[0], place[1])
  const input = page.locator('.sk-dim-input')
  await expect(input).toBeFocused()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await esc2(app)
}

/** The 2D plate used by most specs: a w x h rectangle on XY with its first corner at (0,0), extruded d up. */
export async function makePlate(app: App, w = 60, h = 40, d = 10) {
  await openSketch(app, 'XY')
  await skRect(app, 0, 0, w, h)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await app.field('Distance', String(d))
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}

/** Create a sketch on a planar body face by clicking it (Sketch button, then the face in the viewport). */
export async function sketchOnFace(app: App, at: P3) {
  await app.ribbon('Sketch').first().click()
  await clickWorld(app, at)
  await expect(app.page.locator('.sk-bar')).toBeVisible()
  await app.ev((c) => c.ui.setState({ snap: false }))
  await app.cameraStable()
}

export const bodiesBox = (app: App) => app.ev((c) => c.doc.getState().geometry.map((b: any) => { // eslint-disable-line
  const p = b.mesh.positions
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]) }
  return { id: b.id, name: b.name, min, max, tris: b.mesh.indices.length / 3 }
}))
export const near = (a: number, b: number, tol = 0.05) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)
export { viewBox }

/** Plate w x h with a dia hole at (cx, cy) as one sketch (outer profile with the hole in it), extruded d. */
export async function makeHolePlate(app: App, w = 60, h = 40, d = 10, hole = { x: 30, y: 20, dia: 10 }) {
  await openSketch(app, 'XY')
  await skRect(app, 0, 0, w, h)
  await skCircle(app, hole.x, hole.y, hole.dia)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await pickProfile(app, 5, 5)
  await app.field('Distance', String(d))
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}
/** In the Extrude dialog: click a profile region of the sketch on the XY plane at (x, y). */
export async function pickProfile(app: App, x: number, y: number, z = 0) {
  await clickWorld(app, [x, y, z])
}

import { addSketch, sketchParam, XY, type Curve } from './helpers'

/** Plate w x h x d: a rectangle sketch (corner at the origin, added without the UI: it is only the starting point) and the Extrude dialog by hand. */
export async function fastPlate(app: App, w = 60, h = 40, d = 10, extra: Curve[] = []) {
  await addSketch(app, XY, [{ k: 'rect', x0: 0, y0: 0, x1: w, y1: h }, ...extra])
  await app.ribbon('Extrude').click()
  if (extra.length) await clickWorld(app, [2, 2, 0])
  await app.field('Distance', String(d))
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}
/** Plate with one through hole, the hole drawn in the same sketch as a circle (the plate is the outer profile with the hole in it). */
export const fastHolePlate = (app: App, w = 60, h = 40, d = 10, hole = { x: 20, y: 12, r: 5 }) =>
  fastPlate(app, w, h, d, [{ k: 'circle', c: [hole.x, hole.y], r: hole.r }])

/** Project the face the sketch sits on with the Project tool (click the face under the sketch). */
export async function projectFace(app: App, at: P3) {
  await tool(app, 'Project')
  await clickWorld(app, at)
  await expect.poll(async () => (await sk(app)).entities.filter((e) => e.ref).length).toBeGreaterThan(0)
  await esc2(app)
}
export const refEnts = (m: SkState) => m.entities.filter((e) => e.ref && e.type !== 'point')
export { sketchParam, XY, addSketch }

/** The Inspector's current dialog values (what the form holds now, including picks made in the viewport). */
export const dlg = (app: App) => app.ev((c) => { const s = c.ui.getState().inspector; return s?.latest ?? s?.values })
export const bodyVolume = (app: App, i = 0) => app.ev((c, i) => c.doc.getState().geometry.length).then(async () => {
  const ids: string[] = await app.ev((c) => c.doc.getState().geometry.map((b: any) => b.id)) // eslint-disable-line
  return app.volume(ids[i])
})

// ------------------------------------------------------------------------------------------------ solids tools (spec 61, 62)

/** Volume of every body added together. */
export const totalVol = async (app: App) => {
  const ids: string[] = await app.ev((c) => c.doc.getState().geometry.map((b: any) => b.id)) // eslint-disable-line
  let v = 0
  for (const id of ids) v += await app.volume(id)
  return v
}
export const relNear = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b) / Math.max(1, Math.abs(b)), `${a} vs ${b}`).toBeLessThanOrEqual(rel)
export const featTypes = async (app: App) => (await app.features()).map((f) => f.type)
export const selection = (app: App) => app.ev((c) => c.ui.getState().selection as { kind: string; id: string; index?: number }[])
export const inspectorText = (app: App) => app.inspector().innerText().catch(() => '')
export const settle = async (app: App) => { await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') }); await app.cameraStable() }

/** Click a world point with Shift held (adds to the selection). */
export async function shiftClickWorld(app: App, w: P3) {
  const p = await px(app, w)
  await app.page.mouse.move(p.x, p.y, { steps: 2 })
  await app.page.keyboard.down('Shift')
  await app.page.mouse.click(p.x, p.y)
  await app.page.keyboard.up('Shift')
}

/** Every entry the Solid tab offers a user: the buttons and the items of every caret menu (each opened and closed again). */
export async function ribbonEntries(app: App, tab = 'Solid'): Promise<string> {
  const { page } = app
  await app.tab(tab)
  const names: string[] = await page.locator('.ribbon-body button').evaluateAll((bs) => bs.map((b) => ((b as HTMLElement).innerText || b.getAttribute('aria-label') || '').trim()))
  const out = [...names]
  for (const n of names.filter((x) => /options$/.test(x))) {
    await page.locator('.ribbon-body').getByRole('button', { name: n }).click()
    out.push(...(await page.getByRole('menuitem').allInnerTexts()))
    await page.keyboard.press('Escape')
  }
  return out.join(' | ')
}
/** Every ribbon tab's buttons and menus, for a tool that might live outside the Solid tab. */
export async function allEntries(app: App): Promise<string> {
  const tabs = await app.page.locator('.ribbon-tabs').getByRole('tab').allInnerTexts()
  const parts: string[] = []
  for (const t of tabs) parts.push(await ribbonEntries(app, t.trim()))
  return parts.join(' | ')
}

/** A box added as a precondition (not under test), position is its base centre. */
export async function seedBox(app: App, w: number, d: number, h: number, at: P3 = [0, 0, 0]) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a[0], depth: a[1], height: a[2], position: a[3] }), [w, d, h, at])
  await app.idle()
  await settle(app)
}

/** Fillet tool: click each world point (edges), type the radius, OK. */
export async function filletAt(app: App, pts: P3[], r: string) {
  await app.ribbon('Fillet').first().click()
  for (const p of pts) await clickWorld(app, p)
  await expect.poll(async () => ((await selection(app)).length)).toBeGreaterThan(0)
  await app.field('Radius', r)
  await app.ok()
}
export async function chamferAt(app: App, pts: P3[], d: string) {
  await app.ribbon('Chamfer').first().click()
  for (const p of pts) await clickWorld(app, p)
  await expect.poll(async () => ((await selection(app)).length)).toBeGreaterThan(0)
  await app.field('Distance', d)
  await app.ok()
}
/** A plate whose (60, 0) corner is a rounded corner (R6) drawn in the sketch, as an extruded imported or sketch-filleted part would be. */
export async function roundedPlate(app: App, w = 60, h = 40, d = 10, r = 6) {
  await addSketch(app, XY, [
    { k: 'line', a: [0, 0], b: [w - r, 0] }, { k: 'arc', c: [w - r, r], s: [w - r, 0], e: [w, r] },
    { k: 'line', a: [w, r], b: [w, h] }, { k: 'line', a: [w, h], b: [0, h] }, { k: 'line', a: [0, h], b: [0, 0] },
  ])
  await app.ribbon('Extrude').click()
  await app.field('Distance', String(d))
  await app.ok()
  await settle(app)
}
/** Open the feature at timeline position i (0 based) for editing. */
export async function editChip(app: App, i: number) {
  await app.page.locator('.tl .chip').nth(i).dblclick()
  await expect(app.inspector()).toBeVisible()
}
export const chipCount = (app: App) => app.page.locator('.tl .chip').count()

/** The labels and buttons of the open dialog (what a user can set), not its help text. */
export const controls = (app: App) => app.inspector().locator('.field-label, button, [role=radio], [role=tab], .seg-btn').allInnerTexts().then((a) => a.join(' | ')).catch(() => '')
/** Click a row in the Browser tree. */
export const treeRow = (app: App, name: string | RegExp) => app.page.locator('.tree-row', { hasText: name }).first().click()
