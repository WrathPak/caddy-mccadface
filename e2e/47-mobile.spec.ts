import { test, expect, type App } from './helpers'
import type { CDPSession, Page } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'

/**
 * Phones and tablets: the phone layout under ~800 px, finger navigation and picking, sketching with taps, the bottom sheets,
 * files without the File System Access API, and the screen turning. Touches are real pointer events (pointerType "touch")
 * from the browser's own input pipeline (CDP Input.dispatchTouchEvent), not synthetic DOM events.
 */

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: IPHONE_UA }

type P = { x: number; y: number }

/** Fingers: raw touch points through the browser's input pipeline, each finger with its own id. */
class Fingers {
  private constructor(private cdp: CDPSession) {}
  static async on(page: Page) { return new Fingers(await page.context().newCDPSession(page)) }
  private send(type: 'touchStart' | 'touchMove' | 'touchEnd', pts: P[]) {
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) })
  }
  down(...pts: P[]) { return this.send('touchStart', pts) }
  move(...pts: P[]) { return this.send('touchMove', pts) }
  up() { return this.send('touchEnd', []) }
  /** One finger from a to b in steps. */
  async drag(a: P, b: P, steps = 10) {
    await this.down(a)
    for (let i = 1; i <= steps; i++) await this.move({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps })
    await this.up()
  }
  /** Two fingers, each from its start to its end. */
  async drag2(a0: P, b0: P, a1: P, b1: P, steps = 10) {
    await this.down(a0, b0)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await this.move({ x: a0.x + (a1.x - a0.x) * t, y: a0.y + (a1.y - a0.y) * t }, { x: b0.x + (b1.x - b0.x) * t, y: b0.y + (b1.y - b0.y) * t })
    }
    await this.up()
  }
}

const nav = (app: App) => app.ev(() => (window as any).__nav.pose() as { target: number[]; dist: number; q: number[] }) // eslint-disable-line
const turn = (app: App) => app.ev(() => (window as any).__nav.turntable() as { az: number; el: number; roll: number }) // eslint-disable-line
const canvasBox = async (page: Page) => (await page.locator('.vp canvas').first().boundingBox())!
/** A client position inside the canvas, as fractions of it. */
async function at(page: Page, fx: number, fy: number): Promise<P> {
  const b = await canvasBox(page)
  return { x: b.x + b.width * fx, y: b.y + b.height * fy }
}
const strip = (page: Page, name: string | RegExp) => page.getByTestId('m-strip').getByRole('button', { name }).first()

async function boxScene(app: App) {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}

test.describe('phone, portrait', () => {
  test.use(phone)

  test('layout: top bar, tool strip, workspaces, sheets, box, undo and redo', async ({ app, page }) => {
    await app.open()
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    await expect(page.getByTestId('mobile-layout')).toBeVisible()
    await expect(page.locator('.dockview-theme-caddy')).toHaveCount(0) // no dock on a phone
    await expect(page.locator('.ribbon-tabs')).toHaveCount(0)
    // the page never scrolls sideways, and the viewport fills the width
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect((await canvasBox(page)).width).toBeGreaterThan(380)
    await app.shot('mobile-empty')

    // workspace switcher
    await page.getByTestId('m-workspace').tap()
    await page.getByRole('menuitem', { name: 'Mesh' }).tap()
    expect(await app.ev((c) => c.ui.getState().workspace)).toBe('mesh')
    await expect(page.getByTestId('m-workspace')).toContainText('Mesh')
    await expect(strip(page, /Smooth/)).toBeVisible()
    await page.getByTestId('m-workspace').tap()
    await page.getByRole('menuitem', { name: 'Solid' }).tap()
    expect(await app.ev((c) => c.ui.getState().workspace)).toBe('solid')

    // the Browser slides in, the scrim closes it again
    await page.getByTestId('m-browser').tap()
    await expect(page.getByTestId('m-sheet-browser')).toBeVisible()
    await expect(page.getByTestId('m-sheet-browser')).toContainText('Bodies')
    await app.shot('mobile-browser-empty')
    await page.getByTestId('m-scrim').tap({ position: { x: 370, y: 400 } })
    await expect(page.getByTestId('m-sheet-browser')).toHaveCount(0)

    // Box from the strip: the Inspector is a bottom sheet with OK in reach
    await strip(page, 'Box').tap()
    const sheet = page.getByTestId('m-sheet-inspector')
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('.panel-title')).toHaveText('Box')
    await page.waitForTimeout(300) // (it slides in)
    const ok = sheet.getByRole('button', { name: 'OK' })
    const vh = await page.evaluate(() => window.innerHeight)
    const ob = (await ok.boundingBox())!
    expect(ob.y + ob.height).toBeLessThanOrEqual(vh)
    expect(ob.height).toBeGreaterThanOrEqual(36)
    // number boxes open the number pad
    await expect(sheet.locator('.field', { hasText: 'Width' }).locator('input')).toHaveAttribute('inputmode', 'decimal')
    await app.field('Width', '30')
    await app.shot('mobile-inspector')
    await ok.tap()
    await app.idle()
    await expect(sheet).toHaveCount(0)
    expect((await app.bodies()).length).toBe(1)
    expect((await app.bbox()).max[0]).toBeCloseTo(15, 3)
    await app.shot('mobile-model')

    // undo / redo / delete are buttons
    await page.getByTestId('m-undo').tap()
    await app.idle()
    expect((await app.bodies()).length).toBe(0)
    await page.getByTestId('m-redo').tap()
    await app.idle()
    expect((await app.bodies()).length).toBe(1)

    // the timeline is a bottom sheet with an Edit button for the chosen step
    await page.getByTestId('m-timeline').tap()
    await expect(page.getByTestId('m-sheet-timeline')).toBeVisible()
    await page.locator('.m-tl .chip').first().tap()
    await page.getByTestId('m-tl-edit').tap()
    await expect(page.getByTestId('m-sheet-inspector').locator('.panel-title')).toHaveText('Box')
    await page.getByTestId('m-sheet-inspector').getByRole('button', { name: 'Cancel' }).tap()
    await expect(page.getByTestId('m-sheet-inspector')).toHaveCount(0)

    // a selection has an action bar: Delete is a button, not a key
    await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: c.doc.getState().geometry[0].id }]))
    await expect(page.getByTestId('m-selbar')).toBeVisible()
    await page.getByTestId('m-delete').tap()
    await app.idle()
    expect((await app.bodies()).length).toBe(0)
  })

  test('the Inspector sheet is pulled between peek, half and full, and OK stays above the keyboard', async ({ app, page }) => {
    await app.open()
    await app.ev((c) => c.runCommand('solid.box'))
    const sheet = page.getByTestId('m-sheet-inspector')
    await expect(sheet).toBeVisible()
    await expect(sheet).toHaveAttribute('data-snap', 'half')
    await page.waitForTimeout(300) // (it slides in)
    const h0 = (await sheet.boundingBox())!.height
    const grab = (await page.getByTestId('m-grab').boundingBox())!
    const f = await Fingers.on(page)
    await f.drag({ x: grab.x + 100, y: grab.y + 10 }, { x: grab.x + 100, y: grab.y - 420 })
    await expect(sheet).toHaveAttribute('data-snap', 'full')
    expect((await sheet.boundingBox())!.height).toBeGreaterThan(h0 + 100)
    const g2 = (await page.getByTestId('m-grab').boundingBox())!
    await f.drag({ x: g2.x + 100, y: g2.y + 10 }, { x: g2.x + 100, y: g2.y + 900 })
    await expect(sheet).toHaveAttribute('data-snap', 'peek')
    // peek still has OK and Cancel
    await expect(sheet.getByRole('button', { name: 'OK' })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await app.shot('mobile-inspector-peek')
    // the on-screen keyboard: the sheet rides above it (the page reports the covered height in --kb)
    await page.evaluate(() => document.documentElement.style.setProperty('--kb', '300px'))
    const vh = await page.evaluate(() => window.innerHeight)
    const b = (await sheet.boundingBox())!
    expect(b.y + b.height).toBeLessThanOrEqual(vh - 299)
    await page.evaluate(() => document.documentElement.style.removeProperty('--kb'))
    await page.waitForTimeout(300)
    await sheet.getByRole('button', { name: 'Cancel' }).tap()
    await expect(sheet).toHaveCount(0)
  })

  test('touch navigation: one finger orbits, two pan, a pinch zooms, a double tap fits', async ({ app, page }) => {
    await boxScene(app)
    const f = await Fingers.on(page)
    const empty = await at(page, 0.12, 0.8)

    // one finger orbits
    const t0 = await turn(app)
    await f.drag(empty, { x: empty.x + 150, y: empty.y - 60 })
    const t1 = await turn(app)
    expect(Math.abs(t1.az - t0.az)).toBeGreaterThan(0.3)
    expect(Math.abs(t1.el - t0.el)).toBeGreaterThan(0.05)

    // a pinch zooms in toward its centre (fingers apart = nearer)
    await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
    await app.cameraStable()
    const d0 = (await nav(app)).dist
    const mid = await at(page, 0.5, 0.65)
    await f.drag2({ x: mid.x - 30, y: mid.y }, { x: mid.x + 30, y: mid.y }, { x: mid.x - 100, y: mid.y }, { x: mid.x + 100, y: mid.y })
    const d1 = (await nav(app)).dist
    expect(d1).toBeLessThan(d0 * 0.6)
    // and fingers together zoom out
    await f.drag2({ x: mid.x - 100, y: mid.y }, { x: mid.x + 100, y: mid.y }, { x: mid.x - 25, y: mid.y }, { x: mid.x + 25, y: mid.y })
    expect((await nav(app)).dist).toBeGreaterThan(d1 * 1.5)

    // two fingers dragging together pan: the view target moves, the distance and the orientation do not
    await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
    await app.cameraStable()
    const p0 = await nav(app)
    await f.drag2({ x: mid.x - 40, y: mid.y }, { x: mid.x + 40, y: mid.y }, { x: mid.x + 20, y: mid.y - 120 }, { x: mid.x + 100, y: mid.y - 120 })
    const p1 = await nav(app)
    expect(Math.hypot(p1.target[0] - p0.target[0], p1.target[1] - p0.target[1], p1.target[2] - p0.target[2])).toBeGreaterThan(5)
    expect(p1.dist).toBeCloseTo(p0.dist, 1)
    for (let i = 0; i < 4; i++) expect(p1.q[i]).toBeCloseTo(p0.q[i], 4)

    // double tap fits everything again
    const far = await nav(app)
    await app.ev((_c, d) => (window as any).__nav.setPose({ dist: d }), far.dist * 3) // eslint-disable-line
    await app.cameraStable()
    const farDist = (await nav(app)).dist
    await page.touchscreen.tap(empty.x, empty.y)
    await page.waitForTimeout(80)
    await page.touchscreen.tap(empty.x, empty.y)
    await app.cameraStable()
    expect((await nav(app)).dist).toBeLessThan(farDist * 0.6)
    await app.shot('mobile-nav')
  })

  test('tap selects (a little finger wobble is still a tap), tapping nothing clears, a long press opens the marking menu', async ({ app, page }) => {
    await boxScene(app)
    const f = await Fingers.on(page)
    const top = await app.project(0, 0, 20)
    await page.touchscreen.tap(top.x, top.y)
    await expect.poll(() => app.ev((c) => c.ui.getState().selection.map((r: any) => r.kind))).toEqual(['face'])
    // tap on nothing
    const empty = await at(page, 0.1, 0.85)
    await page.touchscreen.tap(empty.x, empty.y)
    await expect.poll(() => app.ev((c) => c.ui.getState().selection.length)).toBe(0)
    // a finger is never still: 5 px of wobble between down and up is still a tap
    await f.down(top)
    await f.move({ x: top.x + 3, y: top.y + 2 })
    await f.move({ x: top.x + 5, y: top.y + 3 })
    await f.up()
    await expect.poll(() => app.ev((c) => c.ui.getState().selection.map((r: any) => r.kind))).toEqual(['face'])
    // a tap on a body never moved the camera
    const sideFace = await app.project(10, 0, 10)
    await page.touchscreen.tap(sideFace.x, sideFace.y)
    await expect.poll(() => app.ev((c) => c.ui.getState().selection.length)).toBe(1)
    await expect(page.getByTestId('m-selbar')).toBeVisible()

    // long press opens the marking menu around the finger
    await page.touchscreen.tap(empty.x, empty.y)
    const before = await nav(app)
    await f.down(top)
    await page.waitForTimeout(750)
    await expect(page.locator('.marking')).toHaveCount(1)
    await expect(page.locator('.marking .m-item').first()).toBeVisible()
    await f.up()
    await expect(page.locator('.marking .m-item')).toHaveCount(8)
    await app.shot('mobile-marking')
    // an item runs its command; the menu closes
    await page.locator('.marking .m-item', { hasText: 'Frame' }).tap()
    await expect(page.locator('.marking')).toHaveCount(0)
    const after = await nav(app)
    for (let i = 0; i < 4; i++) expect(after.q[i]).toBeCloseTo(before.q[i], 6)
  })

  test('edges are picked with a fingertip from a few pixels away', async ({ app, page }) => {
    await boxScene(app)
    await app.ev((c) => c.ui.getState().setSelectionFilter('edge'))
    // the top-front edge: 12 px off its line is outside a mouse's reach, inside a finger's
    const e = await app.project(0, -10, 20)
    await page.touchscreen.tap(e.x, e.y + 12)
    await expect.poll(() => app.ev((c) => c.ui.getState().selection.map((r: any) => r.kind))).toEqual(['edge'])
  })

  test('sketch with taps: plane buttons, tap a rectangle, undo point, typed value, finish, extrude', async ({ app, page }) => {
    await app.open()
    await strip(page, 'Sketch').tap()
    await expect(page.getByTestId('m-planebar')).toBeVisible()
    await page.getByTestId('m-plane-XY').tap()
    await expect.poll(() => app.ev((c) => c.sketch.getState().active)).toBe(true)
    await app.cameraStable()
    await expect(page.getByTestId('m-sketch-actions')).toBeVisible()
    await app.shot('mobile-sketch')

    // rectangle: two taps. The second one makes it.
    await strip(page, 'Rectangle').tap()
    const a = await at(page, 0.3, 0.35), b = await at(page, 0.62, 0.55)
    await page.touchscreen.tap(a.x, a.y)
    await expect.poll(() => app.ev((c) => !!c.sketch.getState().draft)).toBe(true)
    await page.touchscreen.tap(b.x, b.y)
    await expect.poll(() => app.ev((c) => c.sketch.getState().profiles.length)).toBe(1)
    expect(await app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'line').length)).toBe(4)

    // line: tap, tap, then Undo point takes the second point back, the first stays as the start of the next segment
    await strip(page, 'Line').tap()
    const l0 = await at(page, 0.2, 0.62), l1 = await at(page, 0.45, 0.68), l2 = await at(page, 0.7, 0.64)
    await page.touchscreen.tap(l0.x, l0.y)
    await page.touchscreen.tap(l1.x, l1.y)
    await page.touchscreen.tap(l2.x, l2.y)
    await expect.poll(() => app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'line').length)).toBe(6)
    await page.getByTestId('m-undo-point').tap()
    await expect.poll(() => app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'line').length)).toBe(5)
    expect(await app.ev((c) => c.sketch.getState().draft?.pts.length)).toBe(1)
    await page.getByTestId('m-undo-point').tap()
    await expect.poll(() => app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'line').length)).toBe(4)
    // End drops what is being drawn, Done (the same button) then leaves the tool
    await page.getByTestId('m-sk-done').tap()
    await expect.poll(() => app.ev((c) => !!c.sketch.getState().draft)).toBe(false)
    await page.getByTestId('m-sk-done').tap()
    await expect.poll(() => app.ev((c) => c.sketch.getState().tool)).toBe('select')

    // hold and drag: a reticle sits above the finger, snapping and guides work there, lifting places the point
    await strip(page, 'Circle').tap()
    const f = await Fingers.on(page)
    const c0 = await at(page, 0.5, 0.2)
    await f.down(c0)
    await f.move({ x: c0.x + 5, y: c0.y + 5 })
    await f.move({ x: c0.x + 30, y: c0.y + 20 })
    await expect(page.locator('.m-aim')).toHaveCSS('display', 'block')
    await f.up()
    await expect(page.locator('.m-aim')).toHaveCSS('display', 'none')
    expect(await app.ev((c) => c.sketch.getState().draft?.tool)).toBe('circle')
    // the typed value box opens the number pad; Place makes the circle exactly that size
    const typed = page.getByTestId('m-typed-input')
    await expect(typed).toBeVisible()
    await expect(typed).toHaveAttribute('inputmode', 'decimal')
    await typed.fill('12')
    // (the number box still has the keyboard: the first tap must work anyway)
    await page.getByTestId('m-typed-ok').tap()
    await expect.poll(() => app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'circle').length)).toBe(1)
    const r = await app.ev((c) => c.sketch.getState().model.entities.find((e: any) => e.type === 'circle').r)
    expect(r).toBeCloseTo(6, 3)

    // delete the circle with the button (it has no key here), then finish
    await app.ev((c) => c.sketch.getState().tool !== 'select' && c.runCommand('sketch.select'))
    await app.ev((c) => c.sketch.setState({ sel: [c.sketch.getState().model.entities.find((e: any) => e.type === 'circle').id] }))
    await page.getByTestId('m-sk-delete').tap()
    await expect.poll(() => app.ev((c) => c.sketch.getState().model.entities.filter((e: any) => e.type === 'circle').length)).toBe(0)
    await app.shot('mobile-sketch-done')
    await page.getByTestId('m-sk-finish').tap()
    await app.idle()
    expect((await app.features()).map((x) => x.type)).toEqual(['sketch'])
    await expect(page.getByTestId('m-sketch-actions')).toHaveCount(0)

    // extrude it: the sheet opens with the profile already chosen, Distance, OK
    await strip(page, 'Extrude').tap()
    const sheet = page.getByTestId('m-sheet-inspector')
    await expect(sheet.locator('.panel-title')).toHaveText('Extrude')
    await app.field('Distance', '12')
    await app.ok()
    const feats = await app.features()
    expect(feats.map((x) => [x.type, x.state])).toEqual([['sketch', 'ok'], ['extrude', 'ok']])
    const bb = await app.bbox()
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(12, 3)
    await app.shot('mobile-extruded')
  })

  test('the extrude arrow is dragged with a finger, from a fingertip away', async ({ app, page }) => {
    await app.open()
    await app.ev((c) => {
      c.doc.getState().addFeature('sketch', { sketch: JSON.stringify({ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, face: null, model: { entities: [
        { id: 'p1', type: 'point', x: -15, y: -10 }, { id: 'p2', type: 'point', x: 15, y: -10 }, { id: 'p3', type: 'point', x: 15, y: 10 }, { id: 'p4', type: 'point', x: -15, y: 10 },
        { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' },
      ], constraints: [], next: 9 } }) })
    })
    await app.idle()
    await strip(page, 'Extrude').tap()
    await app.field('Distance', '10')
    await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
    await app.cameraStable()
    await expect.poll(() => app.ev((c) => c.manip.getState().active)).toBe(true)
    const m = await app.ev((c) => { const s = c.manip.getState(); return { o: s.origin, d: s.dir, tip: s.tip } })
    const at3 = (t: number) => app.project(m.o[0] + m.d[0] * t, m.o[1] + m.d[1] * t, m.o[2] + m.d[2] * t)
    const p1 = await at3(m.tip - 0.5), p2 = await at3(m.tip + 5)
    const v = { x: p2.x - p1.x, y: p2.y - p1.y }
    const len = Math.hypot(v.x, v.y)
    // 26 px beside the arrow: outside a mouse pointer's target, inside the one made for fingers
    const start = { x: p1.x + (-v.y / len) * 26, y: p1.y + (v.x / len) * 26 }
    const f = await Fingers.on(page)
    const cam0 = await nav(app)
    await f.drag(start, { x: start.x + v.x * 1.6, y: start.y + v.y * 1.6 }, 12)
    await expect.poll(() => app.ev((c) => c.manip.getState().tip)).toBeGreaterThan(m.tip + 3)
    // it was the arrow, not the camera, that took the finger
    const cam1 = await nav(app)
    for (let i = 0; i < 4; i++) expect(cam1.q[i]).toBeCloseTo(cam0.q[i], 4)
    await app.shot('mobile-arrow')
    await app.ok()
    const ex = (await app.features()).find((x) => x.type === 'extrude')!
    expect(ex.params.distance).toBeGreaterThan(13)
  })

  test('save without the File System Access API downloads a file; open picks it back up; the share sheet is used where there is one', async ({ app, page }) => {
    await boxScene(app)
    // 1. no share sheet (desktop Chrome on a phone-sized window): a plain download
    await page.evaluate(() => { Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }); Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }) })
    await page.getByRole('button', { name: 'File' }).tap()
    const dl = page.waitForEvent('download')
    await page.getByRole('menuitem').filter({ has: page.locator('.kbd', { hasText: /^Ctrl\+S$/ }) }).tap()
    const download = await dl
    expect(download.suggestedFilename()).toMatch(/\.caddy$/)
    const file = path.join(os.tmpdir(), 'caddy-mobile-' + Date.now() + '.caddy')
    await download.saveAs(file)
    // 2. a new document, then Open through the plain file input
    page.on('dialog', (d) => void d.accept())
    await app.ev((c) => c.runCommand('file.new'))
    await app.idle()
    expect((await app.features()).length).toBe(0)
    await page.getByRole('button', { name: 'File' }).tap()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem').filter({ has: page.locator('.kbd', { hasText: /^Ctrl\+O$/ }) }).tap()
    await (await chooser).setFiles(file)
    await expect.poll(async () => (await app.features()).length).toBe(1)
    // 3. a share sheet that takes files gets the file and no download starts
    await page.evaluate(() => {
      ;(window as any).__shared = [] // eslint-disable-line
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true })
      Object.defineProperty(navigator, 'share', { value: async (d: { files: File[] }) => { (window as any).__shared.push(...d.files.map((f) => f.name)) }, configurable: true }) // eslint-disable-line
    })
    let downloaded = false
    page.on('download', () => { downloaded = true })
    await page.getByRole('button', { name: 'File' }).tap()
    await page.getByRole('menuitem').filter({ has: page.locator('.kbd', { hasText: /^Ctrl\+S$/ }) }).tap()
    await expect.poll(() => page.evaluate(() => (window as any).__shared.length)).toBe(1) // eslint-disable-line
    expect(await page.evaluate(() => (window as any).__shared[0])).toMatch(/\.caddy$/) // eslint-disable-line
    expect(downloaded).toBe(false)
  })

  test('shell: viewport meta, no page zoom or scroll, canvas owns touches, AO off and pixel ratio capped by default', async ({ app, page }) => {
    await app.open()
    const meta = await page.locator('meta[name=viewport]').getAttribute('content')
    expect(meta).toContain('user-scalable=no')
    expect(meta).toContain('viewport-fit=cover')
    expect(await page.locator('link[rel=apple-touch-icon]').count()).toBe(1)
    const css = await page.evaluate(() => ({
      canvas: getComputedStyle(document.querySelector('.vp canvas')!).touchAction,
      html: getComputedStyle(document.documentElement).overscrollBehaviorY,
      body: getComputedStyle(document.body).position,
      ribbon: getComputedStyle(document.querySelector('[data-testid=m-strip] .ribbon-body')!).touchAction,
    }))
    expect(css.canvas).toBe('none')
    expect(css.html).toBe('none')
    expect(css.body).toBe('fixed')
    expect(css.ribbon).toBe('pan-x')
    // touch screens start with AO off; the setting is still there to turn on
    expect(await app.ev((c) => c.ui.getState().ssao)).toBe(false)
    // the canvas draws at most 1.5 pixels per CSS pixel unless Settings says more
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2)
    expect(await app.ev(() => (window as any).__caddy.three.gl.getPixelRatio())).toBe(1.5) // eslint-disable-line
    await page.getByTestId('m-more').tap()
    await page.getByRole('menuitem', { name: 'Settings' }).tap()
    await page.getByTestId('settings-dialog-nav-display').tap()
    await expect(page.getByTestId('set-sharpness')).toBeVisible()
    await expect(page.getByTestId('set-ao')).toBeVisible()
    await app.shot('mobile-settings')
  })
})

test.describe('phone, landscape', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: PIXEL_UA })

  test('compact layout, the Inspector docks at the side, everything fits', async ({ app, page }) => {
    await app.open()
    await expect(page.getByTestId('mobile-layout')).toBeVisible()
    await expect(page.locator('.dockview-theme-caddy')).toHaveCount(0)
    expect((await canvasBox(page)).height).toBeGreaterThan(240)
    await app.shot('mobile-landscape-empty')
    await strip(page, 'Box').tap()
    const sheet = page.getByTestId('m-sheet-inspector')
    await expect(sheet).toBeVisible()
    await page.waitForTimeout(300)
    const b = (await sheet.boundingBox())!
    expect(b.width).toBeLessThanOrEqual(844 / 2 + 1)
    expect(b.y + b.height).toBeLessThanOrEqual(390)
    await expect(sheet.getByRole('button', { name: 'OK' })).toBeVisible()
    await app.shot('mobile-landscape-inspector')
    await sheet.getByRole('button', { name: 'OK' }).tap()
    await app.idle()
    expect((await app.bodies()).length).toBe(1)
    await app.shot('mobile-landscape-model')
  })
})

test.describe('tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: IPHONE_UA.replace('iPhone; CPU iPhone', 'iPad; CPU') })

  test('keeps the desktop layout with finger-sized taps', async ({ app, page }) => {
    await app.open()
    await expect(page.locator('.dockview-theme-caddy')).toBeVisible()
    await expect(page.getByTestId('mobile-layout')).toHaveCount(0)
    const btn = (await page.locator('.ribbon-body .rbtn:not(.small)').first().boundingBox())!
    expect(btn.height).toBeGreaterThanOrEqual(44)
    const tab = (await page.locator('.ribbon-tab').first().boundingBox())!
    expect(tab.height).toBeGreaterThanOrEqual(34)
    // touch navigation works in the dock too
    await app.ev((c) => c.runCommand('solid.box'))
    await app.ok()
    const f = await Fingers.on(page)
    const b = await canvasBox(page)
    const t0 = await turn(app)
    await f.drag({ x: b.x + 60, y: b.y + b.height - 80 }, { x: b.x + 200, y: b.y + b.height - 120 })
    expect(Math.abs((await turn(app)).az - t0.az)).toBeGreaterThan(0.3)
    await app.shot('mobile-tablet')
  })
})

test.describe('turning the screen', () => {
  test.use({ viewport: { width: 1100, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: PIXEL_UA })

  test('crossing the breakpoint keeps the document and the view, and the dock comes back whole', async ({ app, page }) => {
    await boxScene(app)
    await page.evaluate(() => window.matchMedia('(max-width: 800px)').matches) // (just touching the media query)
    await expect(page.locator('.dockview-theme-caddy')).toBeVisible()
    // wide -> phone
    const pose0 = await nav(app)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('mobile-layout')).toBeVisible()
    await expect(page.locator('.dockview-theme-caddy')).toHaveCount(0)
    await app.idle()
    expect((await app.bodies()).length).toBe(1)
    await page.waitForFunction(() => !!(window as any).__caddy?.three) // eslint-disable-line
    const pose1 = await nav(app)
    expect(pose1.dist).toBeCloseTo(pose0.dist, 3)
    // an open dialog survives the turn of the screen too
    await strip(page, 'Fillet').tap()
    await expect(page.getByTestId('m-sheet-inspector')).toBeVisible()
    await page.setViewportSize({ width: 844, height: 390 })
    await expect(page.getByTestId('m-sheet-inspector')).toBeVisible()
    await page.getByTestId('m-sheet-inspector').getByRole('button', { name: 'Cancel' }).tap()
    // phone -> wide and back again a few times: the dock builds each time
    for (const w of [1100, 390, 1100]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 800 })
      await expect(w === 390 ? page.getByTestId('mobile-layout') : page.locator('.dockview-theme-caddy')).toBeVisible()
    }
    await expect(page.locator('.dv-dockview, .dockview-theme-caddy').first()).toBeVisible()
    await expect(page.locator('[data-tour="browser"]')).toBeVisible()
    await expect(page.locator('.tl')).toBeVisible()
    expect((await app.bodies()).length).toBe(1)
    expect((await app.features()).map((x) => x.type)).toEqual(['box'])
    await app.shot('mobile-back-to-dock')
  })
})
