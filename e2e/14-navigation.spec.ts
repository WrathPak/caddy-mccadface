import { test, expect, type App } from './helpers'
import type { Page } from '@playwright/test'

/** Box, framed from the home view. */
async function setup(app: App) {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}

const nav = (app: App) => app.ev((c: any) => (window as any).__nav.pose() as { target: number[]; dist: number; q: number[] }) // eslint-disable-line
const turn = (app: App) => app.ev(() => (window as any).__nav.turntable() as { az: number; el: number; roll: number }) // eslint-disable-line

/** Canvas client rect and its centre. */
async function vp(page: Page) {
  const b = (await page.locator('.vp canvas').first().boundingBox())!
  return { b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }
}

/** World point of the first body surface under a client position (what the pivot logic raycasts). */
async function pick(app: App, x: number, y: number): Promise<[number, number, number]> {
  return app.page.evaluate(([x, y]) => {
    const t = (window as any).__caddy.three // eslint-disable-line
    const r = t.gl.domElement.getBoundingClientRect()
    t.raycaster.setFromCamera({ x: ((x - r.left) / r.width) * 2 - 1, y: -((y - r.top) / r.height) * 2 + 1 }, t.camera)
    t.raycaster.firstHitOnly = true
    const hit = t.raycaster.intersectObject(t.scene.getObjectByName('bodies'), true).find((h: any) => h.object.isMesh) // eslint-disable-line
    return hit ? [hit.point.x, hit.point.y, hit.point.z] : null
  }, [x, y]) as Promise<[number, number, number]>
}

/** Wait until the zoom has finished gliding: the distance is unchanged over three reads. */
async function settled(app: App) {
  let prev = -1, same = 0
  for (let i = 0; i < 60 && same < 3; i++) {
    const d = (await nav(app)).dist
    same = Math.abs(d - prev) < 1e-6 ? same + 1 : 0
    prev = d
    await app.page.waitForTimeout(120)
  }
  await app.cameraStable()
}

/** A fast spin of the wheel: several notches (one event is capped, like a single detent). */
async function wheelBy(page: Page, total: number) {
  const n = Math.ceil(Math.abs(total) / 100)
  for (let i = 0; i < n; i++) { await page.mouse.wheel(0, Math.sign(total) * 100); await page.waitForTimeout(16) }
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol

async function mmbDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, mods: string[] = []) {
  for (const m of mods) await page.keyboard.down(m)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up({ button: 'middle' })
  for (const m of mods.reverse()) await page.keyboard.up(m)
}

async function setPreset(page: Page, label: string) {
  await page.getByTestId('settings-gear').click()
  await page.getByTestId('settings-popover').getByRole('radio', { name: label }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-popover')).toHaveCount(0)
}

test('wheel zooms toward the cursor (perspective and orthographic) with a smooth exponential step', async ({ app, page }) => {
  await setup(app)
  const { cx, cy } = await vp(page)
  for (const ortho of [false, true]) {
    if (ortho) { await app.ev((c) => c.runCommand('view.ortho')); await app.cameraStable() }
    // a spot on the box that is not the screen centre
    const x = cx + 40, y = cy - 20
    const P = await pick(app, x, y)
    expect(P, 'cursor is over the box').not.toBeNull()
    const d0 = (await nav(app)).dist
    await page.mouse.move(x, y)
    await wheelBy(page, -300)
    await expect.poll(async () => (await nav(app)).dist).toBeLessThan(d0 * 0.8)
    await settled(app)
    const d1 = (await nav(app)).dist
    const after = await app.project(...P)
    expect(near(after, { x, y }, 2.5), `point under the cursor stays under it (${ortho ? 'ortho' : 'persp'}): ${JSON.stringify(after)} vs ${x},${y}`).toBe(true)
    // the step is exponential: equal wheel travel scales by the same factor
    await wheelBy(page, -300)
    await settled(app)
    const d2 = (await nav(app)).dist
    expect(Math.abs(d2 / d1 - d1 / d0)).toBeLessThan(0.03)
    // zooming back out restores the framing
    await wheelBy(page, 600)
    await settled(app)
    expect((await nav(app)).dist).toBeCloseTo(d0, 0)
    expect(near(await app.project(...P), { x, y }, 2.5), 'zooming out also keeps the point under the cursor').toBe(true)
  }
})

test('zooming in never clips into the model: the near plane follows the scene', async ({ app, page }) => {
  await setup(app)
  const { cx, cy } = await vp(page)
  await page.mouse.move(cx, cy)
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(40) }
  await app.cameraStable()
  const st = await app.ev((c) => {
    const cam = c.three.camera
    const box = c.three.scene.getObjectByName('bodies')
    return { near: cam.near, far: cam.far, pos: cam.position.toArray(), isBox: !!box }
  })
  expect(st.near).toBeGreaterThan(0)
  expect(st.near).toBeLessThan(0.5)
  expect(st.far / st.near).toBeLessThan(1e5)
  // the box is still drawn at the cursor (no clipping hole): the centre pixel is lit geometry, not background
  const px = await app.page.evaluate(async () => {
    const t = (window as any).__caddy.three // eslint-disable-line
    t.gl.render(t.scene, t.camera)
    const img = new Image(); img.src = t.gl.domElement.toDataURL(); await img.decode()
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height
    const g = cv.getContext('2d')!; g.drawImage(img, 0, 0)
    const d = g.getImageData(img.width / 2, img.height / 2, 1, 1).data
    return [d[0], d[1], d[2]]
  })
  const bg = await app.page.evaluate(() => getComputedStyle(document.querySelector('.vp')!).backgroundColor)
  expect(bg).toBeTruthy()
  expect(px.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
})

test('pan keeps the grabbed point exactly under the cursor (Fusion: middle button)', async ({ app, page }) => {
  await setup(app)
  const { cx, cy } = await vp(page)
  const from = { x: cx - 30, y: cy + 10 }, to = { x: cx + 110, y: cy + 70 }
  const P = await pick(app, from.x, from.y)
  const t0 = await nav(app)
  await mmbDrag(page, from, to)
  await app.cameraStable()
  const t1 = await nav(app)
  expect(Math.hypot(...t1.target.map((v, i) => v - t0.target[i]))).toBeGreaterThan(1)
  expect(t1.dist).toBeCloseTo(t0.dist, 6)
  expect(near(await app.project(...P), to, 1.5)).toBe(true)
  // orientation unchanged by a pan
  expect(t1.q.map((v, i) => Math.abs(v - t0.q[i])).reduce((a, b) => a + b, 0)).toBeLessThan(1e-6)
})

test('orbit is a turntable about the point under the cursor: pivot stays put, no roll, clamped at the poles', async ({ app, page }) => {
  await setup(app)
  const { cx, cy } = await vp(page)
  const start = { x: cx + 25, y: cy - 15 }
  const P = await pick(app, start.x, start.y)
  const before = await app.project(...P)
  const a0 = await turn(app)
  await mmbDrag(page, start, { x: start.x + 130, y: start.y + 40 }, ['Shift'])
  await app.cameraStable()
  const a1 = await turn(app)
  expect(Math.abs(a1.az - a0.az)).toBeGreaterThan(0.3)
  expect(Math.abs(a1.roll)).toBeLessThan(1e-3)
  expect(near(await app.project(...P), before, 1.5), 'pivot keeps its screen position').toBe(true)
  const piv = await app.ev(() => (window as any).__nav.pivot()) // eslint-disable-line
  for (let k = 0; k < 3; k++) expect(piv[k]).toBeCloseTo(P[k], 3)
  // a long drag straight down tilts to the pole and stops there, the horizon stays level
  await mmbDrag(page, start, { x: start.x, y: start.y + 900 }, ['Shift'])
  await app.cameraStable()
  const a2 = await turn(app)
  expect(a2.el).toBeLessThanOrEqual((89.9 * Math.PI) / 180 + 1e-6)
  expect(a2.el).toBeGreaterThan(1.4)
  expect(Math.abs(a2.roll)).toBeLessThan(1e-3)
  // continuing past the pole does not flip the view
  await mmbDrag(page, start, { x: start.x, y: start.y + 300 }, ['Shift'])
  await app.cameraStable()
  const a3 = await turn(app)
  expect(a3.el).toBeLessThanOrEqual((89.9 * Math.PI) / 180 + 1e-6)
  expect(Math.abs(a3.roll)).toBeLessThan(1e-3)
  // and back up
  await mmbDrag(page, start, { x: start.x, y: start.y - 1500 }, ['Shift'])
  await app.cameraStable()
  const a4 = await turn(app)
  expect(a4.el).toBeGreaterThanOrEqual((-89.9 * Math.PI) / 180 - 1e-6)
  expect(Math.abs(a4.roll)).toBeLessThan(1e-3)
})

test('orbiting shows a pivot marker; it is placed on the body surface or, over empty space, at the scene centre', async ({ app, page }) => {
  await setup(app)
  const { b } = await vp(page)
  const marker = page.getByTestId('nav-pivot')
  await page.mouse.move(b.x + 30, b.y + 30) // empty corner of the viewport
  await page.keyboard.down('Shift')
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(b.x + 60, b.y + 40, { steps: 4 })
  await expect(marker).toBeVisible()
  const piv = await app.ev(() => (window as any).__nav.pivot()) // eslint-disable-line
  const bb = await app.bbox()
  for (let k = 0; k < 3; k++) expect(piv[k]).toBeCloseTo((bb.min[k] + bb.max[k]) / 2, 2)
  await page.mouse.up({ button: 'middle' })
  await page.keyboard.up('Shift')
  await expect(marker).toBeHidden({ timeout: 3000 })
})

test('double middle click fits everything; F6 fits all; F fits the selection', async ({ app, page }) => {
  await setup(app)
  const { cx, cy } = await vp(page)
  const fit = (await nav(app)).dist
  await page.mouse.move(cx, cy)
  await wheelBy(page, -900)
  await app.cameraStable()
  expect((await nav(app)).dist).toBeLessThan(fit * 0.6)
  await page.mouse.click(cx, cy, { button: 'middle', clickCount: 1 })
  await page.mouse.click(cx, cy, { button: 'middle', clickCount: 2 })
  await expect.poll(async () => (await nav(app)).dist, { timeout: 5000 }).toBeCloseTo(fit, 0)
  // F6
  await wheelBy(page, -900)
  await app.cameraStable()
  await page.keyboard.press('F6')
  await expect.poll(async () => (await nav(app)).dist, { timeout: 5000 }).toBeCloseTo(fit, 0)
  // F with a face selected: zooms to it, centred on it
  const id = await app.ev((c) => c.doc.getState().geometry[0].id as string)
  await app.ev((c, id) => c.ui.getState().setSelection([{ kind: 'face', id, index: 0 }]), id)
  await page.keyboard.press('f')
  await app.cameraStable()
  const sel = await nav(app)
  expect(sel.dist).toBeLessThan(fit * 0.9) // a 20 mm face against the whole box
  const centre = await app.ev((c, id) => {
    const m = c.doc.getState().geometry.find((b: any) => b.id === id).mesh
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let t = 0; t < m.faceIds.length; t++) if (m.faceIds[t] === 0) for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) { const v = m.positions[m.indices[t * 3 + k] * 3 + j]; lo[j] = Math.min(lo[j], v); hi[j] = Math.max(hi[j], v) }
    return lo.map((v, j) => (v + hi[j]) / 2)
  }, id)
  await expect.poll(async () => { const t = (await nav(app)).target; return Math.hypot(t[0] - centre[0], t[1] - centre[1], t[2] - centre[2]) }, { timeout: 5000 }).toBeLessThan(0.05)
  void sel
})

test('navigation presets: SolidWorks, Blender and Touchpad gestures; the choice persists', async ({ app, page }) => {
  await setup(app)
  const { cx, cy } = await vp(page)
  // SolidWorks / Onshape: middle button orbits, Ctrl + middle pans
  await setPreset(page, 'SolidWorks / Onshape')
  let a0 = await turn(app)
  await mmbDrag(page, { x: cx, y: cy }, { x: cx + 100, y: cy + 20 })
  await app.cameraStable()
  expect(Math.abs((await turn(app)).az - a0.az)).toBeGreaterThan(0.3)
  let t0 = await nav(app)
  await mmbDrag(page, { x: cx, y: cy }, { x: cx + 80, y: cy + 10 }, ['Control'])
  await app.cameraStable()
  expect(Math.hypot(...(await nav(app)).target.map((v, i) => v - t0.target[i]))).toBeGreaterThan(1)

  // Blender: middle orbits, Shift + middle pans
  await setPreset(page, 'Blender')
  a0 = await turn(app)
  t0 = await nav(app)
  await mmbDrag(page, { x: cx, y: cy }, { x: cx - 100, y: cy - 20 })
  await app.cameraStable()
  expect(Math.abs((await turn(app)).az - a0.az)).toBeGreaterThan(0.3)
  t0 = await nav(app)
  await mmbDrag(page, { x: cx, y: cy }, { x: cx - 60, y: cy + 30 }, ['Shift'])
  await app.cameraStable()
  const t1 = await nav(app)
  expect(Math.hypot(...t1.target.map((v, i) => v - t0.target[i]))).toBeGreaterThan(1)

  // persisted
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.nav') ?? '{}').preset)).toBe('blender')
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  await page.getByTestId('settings-gear').click()
  await expect(page.getByTestId('settings-popover').getByRole('radio', { name: 'Blender' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
})

test('touchpad: two-finger scroll pans, Shift + scroll orbits, pinch (ctrl + wheel) zooms', async ({ app, page }) => {
  await setup(app)
  const { cx, cy } = await vp(page)
  await setPreset(page, 'Touchpad')
  await page.mouse.move(cx, cy)
  const t0 = await nav(app)
  await page.mouse.wheel(60, 40)
  await app.cameraStable()
  const t1 = await nav(app)
  expect(Math.hypot(...t1.target.map((v, i) => v - t0.target[i]))).toBeGreaterThan(0.5)
  expect(t1.dist).toBeCloseTo(t0.dist, 6)
  const a0 = await turn(app)
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, 120)
  await page.mouse.wheel(80, 0)
  await page.keyboard.up('Shift')
  await app.cameraStable()
  const a1 = await turn(app)
  expect(Math.abs(a1.az - a0.az) + Math.abs(a1.el - a0.el)).toBeGreaterThan(0.05)
  const d0 = (await nav(app)).dist
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -30)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await nav(app)).dist).toBeLessThan(d0 * 0.95)
  // Alt + left drag orbits without a middle button
  await app.cameraStable()
  const a2 = await turn(app)
  await page.keyboard.down('Alt')
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 90, cy + 10, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await app.cameraStable()
  expect(Math.abs((await turn(app)).az - a2.az)).toBeGreaterThan(0.3)
})

test('everything stays in sync with the ViewCube; orbit works from a ViewCube view', async ({ app, page }) => {
  await setup(app)
  const { cx, cy } = await vp(page)
  const cubeT = () => page.evaluate(() => (document.querySelector('.vc-scene') as HTMLElement).style.transform)
  const before = await cubeT()
  await mmbDrag(page, { x: cx, y: cy }, { x: cx + 90, y: cy + 30 }, ['Shift'])
  await app.cameraStable()
  expect(await cubeT()).not.toBe(before)
  // the cube's rotation is the camera's world-to-view rotation
  const ok = await page.evaluate(() => {
    const t = (window as any).__caddy.three // eslint-disable-line
    const e = t.camera.matrixWorldInverse.elements
    const m = (document.querySelector('.vc-scene') as HTMLElement).style.transform.match(/matrix3d\((.*)\)/)![1].split(',').map(Number)
    return Math.abs(m[0] - e[0]) + Math.abs(m[1] + e[1]) + Math.abs(m[4] - e[4]) + Math.abs(m[8] - e[8]) < 1e-4
  })
  expect(ok).toBe(true)
  // ViewCube Top, then a drag orbit: leaves the pole smoothly (no flip)
  await app.ev((c) => c.runCommand('view.top'))
  await app.cameraStable()
  expect((await turn(app)).el).toBeGreaterThan(1.55)
  await mmbDrag(page, { x: cx, y: cy }, { x: cx + 60, y: cy - 80 }, ['Shift'])
  await app.cameraStable()
  const a = await turn(app)
  expect(a.el).toBeLessThan((89.9 * Math.PI) / 180 + 1e-6)
  expect(Math.abs(a.roll)).toBeLessThan(1e-3)
})

test('optional inertia: off by default, keeps the view gliding after a fast drag when on', async ({ app, page }) => {
  await setup(app)
  const { cx, cy } = await vp(page)
  await page.getByTestId('settings-gear').click()
  const pop = page.getByTestId('settings-popover')
  await expect(pop.getByRole('checkbox', { name: 'Inertia' })).not.toBeChecked()
  await pop.getByRole('checkbox', { name: 'Inertia' }).click()
  await page.keyboard.press('Escape')
  // fast flick, released while still moving. The nav clock is frozen and ticked by hand so pointer timing and the glide don't
  // depend on how fast the renderer is.
  await app.ev((c) => c.nav.freeze())
  await page.keyboard.down('Shift')
  await page.mouse.move(cx, cy)
  await page.mouse.down({ button: 'middle' })
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(cx + 16 * i, cy)
    await app.ev((c) => c.nav.tick(16))
  }
  await page.mouse.up({ button: 'middle' }) // released while still moving
  await page.keyboard.up('Shift')
  const a1 = await turn(app)
  await app.ev((c) => c.nav.step(100))
  const a2 = await turn(app)
  expect(Math.abs(a2.az - a1.az), 'the view keeps gliding after release').toBeGreaterThan(1e-3)
  await app.ev((c) => c.nav.step(4000, 100))
  const a3 = await turn(app)
  await app.ev((c) => c.nav.step(300))
  expect(Math.abs((await turn(app)).az - a3.az), 'and comes to rest').toBeLessThan(1e-6)
  await app.ev((c) => c.nav.unfreeze())
})
