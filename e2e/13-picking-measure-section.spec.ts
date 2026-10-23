import { test, expect, addSketch, XY, XZ, type App } from './helpers'
import type { Page } from '@playwright/test'

const okButton = (page: Page) => page.locator('.inspector-foot').getByRole('button', { name: 'OK' })

async function addBox(app: App, position: [number, number, number], size = 20) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size, depth: a.size, height: a.size, position: a.position }), { size, position })
  await app.idle()
}
async function frame(app: App) {
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}
/** Mean colour of a (2r+1)^2 pixel block around a client-space point, read from a fresh render of the canvas. */
async function colorAt(app: App, x: number, y: number, hideCaps = false) {
  return app.page.evaluate(async ({ x, y, hideCaps }) => {
    const t = (window as any).__caddy.three // eslint-disable-line
    const caps: any[] = [] // eslint-disable-line
    t.scene.traverse((o: any) => { if (o.name === 'section-cap-face') caps.push(o) }) // eslint-disable-line
    if (hideCaps) caps.forEach((c) => (c.visible = false))
    t.gl.render(t.scene, t.camera)
    const img = new Image()
    img.src = t.gl.domElement.toDataURL()
    await img.decode()
    caps.forEach((c) => (c.visible = true))
    if (hideCaps) t.gl.render(t.scene, t.camera) // leave the canvas showing the normal frame (the loop only renders on demand)
    const cv = document.createElement('canvas')
    cv.width = img.width; cv.height = img.height
    const ctx = cv.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const r = t.gl.domElement.getBoundingClientRect()
    const d = ctx.getImageData(Math.round(x - r.left) - 4, Math.round(y - r.top) - 4, 9, 9).data
    let R = 0, G = 0, B = 0
    for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2] }
    const n = d.length / 4
    return [R / n, G / n, B / n]
  }, { x, y, hideCaps })
}

test('sweep path can be picked by clicking the sketch curves in the viewport', async ({ app, page }) => {
  await app.open()
  await addSketch(app, XY, [{ k: 'rect', x0: -2, y0: -2, x1: 2, y1: 2 }])
  await addSketch(app, XZ, [{ k: 'line', a: [0, 0], b: [0, 20] }]) // the path, up the Z axis
  await app.tab('Solid')
  await frame(app)
  await app.ribbon('Sweep').first().click()
  await expect(okButton(page)).toBeEnabled() // both picked up automatically
  await app.inspector().getByRole('button', { name: 'Clear' }).last().click() // clear the path
  await expect(okButton(page)).toBeDisabled()
  expect(await app.ev((c) => c.ui.getState().pickSketches)).toBe(true)
  const p = await app.project(0, 0, 12)
  await page.mouse.move(p.x + 40, p.y)
  await page.mouse.move(p.x + 2, p.y, { steps: 5 })
  await expect.poll(() => app.ev((c) => c.ui.getState().hover?.kind)).toBe('sketch') // hover highlight
  await app.shot('sketch-curve-hover')
  await page.mouse.click(p.x + 2, p.y)
  await expect(okButton(page)).toBeEnabled()
  expect(await app.ev((c) => c.ui.getState().selection.map((r: any) => r.kind))).toEqual(['sketch']) // eslint-disable-line
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  expect(await app.ev((c) => c.ui.getState().pickSketches)).toBe(false) // curve picking ends with the dialog
})

test('Measure highlights both picks and draws the dimension line with its label', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0])
  await addBox(app, [50, 0, 0])
  await frame(app)
  await app.ribbon('Measure').click()
  for (const x of [0, 50]) {
    const p = await app.project(x, 0, 20)
    await page.mouse.move(p.x - 20, p.y + 4)
    await page.mouse.move(p.x, p.y, { steps: 4 })
    await page.mouse.click(p.x, p.y)
  }
  const refs = await app.ev((c) => c.ui.getState().highlight.map((r: any) => [r.kind, r.id])) // eslint-disable-line
  expect(refs).toHaveLength(2)
  expect(new Set(refs.map((r: string[]) => r[1])).size).toBe(2) // one on each box
  await expect(page.getByTestId('measure-label')).toHaveText('50 mm')
  expect(await app.ev((c) => !!c.three.scene.getObjectByName('measure-line'))).toBe(true)
  await app.shot('measure-line')
  // both top faces are tinted: compare against the plain body colour
  const a = await app.project(-5, 5, 20), b = await app.project(45, 5, 20) // off the end markers
  const [ca, cb] = [await colorAt(app, a.x, a.y), await colorAt(app, b.x, b.y)]
  for (const col of [ca, cb]) expect(col[2] - col[0], `a highlighted (bluish) face: ${col}`).toBeGreaterThan(25)
  await page.getByRole('button', { name: 'OK' }).click()
  expect(await app.ev((c) => c.ui.getState().highlight.length)).toBe(0)
  expect(await app.ev((c) => !!c.three.scene.getObjectByName('measure-line'))).toBe(false)
})

test('Section Analysis caps the cut: a hatched tinted face where the plane passes through the solid', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0])
  await frame(app)
  await app.ribbon('Section Analysis').click()
  await app.field('Offset', '10')
  await expect.poll(() => app.ev((c) => !!c.three.scene.getObjectByName('section-cap-face'))).toBe(true)
  const p = await app.project(4, 4, 10) // off the Z axis line
  const capped = await colorAt(app, p.x, p.y)
  const open = await colorAt(app, p.x, p.y, true)
  expect(capped[2] - capped[0], `capped colour ${capped}`).toBeGreaterThan(30) // tinted cap
  expect(Math.abs(capped[0] - open[0]) + Math.abs(capped[2] - open[2]), `open ${open} vs capped ${capped}`).toBeGreaterThan(40)
  await app.shot('section-cap')
  // the cap follows the plane: moving it up to z = 25 (above the box) leaves nothing to cap
  await app.field('Offset', '25')
  await expect.poll(async () => {
    const q = await app.project(0, 0, 20)
    const c = await colorAt(app, q.x, q.y)
    return c[2] - c[0] > 30 ? 'capped' : 'plain'
  }).toBe('plain')
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  expect(await app.ev((c) => !!c.three.scene.getObjectByName('section-cap-face'))).toBe(false)
})

test('ViewCube labels are upright and never mirrored when a face is viewed head-on', async ({ app, page }) => {
  await app.open()
  const dirs: [string, number[]][] = [['Top', [0, 0, 1]], ['Bottom', [0, 0, -1]], ['Front', [0, -1, 0]], ['Back', [0, 1, 0]], ['Right', [1, 0, 0]], ['Left', [-1, 0, 0]]]
  for (const [face, v] of dirs) {
    await app.ev((c, v) => c.bus.emit('viewVec', v), v)
    await app.cameraStable()
    // the label's own reading direction (first zone -> last zone of its row) must point right and its column down on the screen
    const g = await page.evaluate((f) => {
      const zones = [...document.querySelectorAll(`.vc-face[data-face="${f}"] .vc-zone`)].map((e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })
      return { right: zones[2][0] - zones[0][0], down: zones[6][1] - zones[0][1], rowDrift: Math.abs(zones[2][1] - zones[0][1]) }
    }, face)
    expect(g.right, `${face}: text reads left to right`).toBeGreaterThan(10)
    expect(g.down, `${face}: text is upright`).toBeGreaterThan(10)
    expect(g.rowDrift, `${face}: baseline is horizontal`).toBeLessThan(1)
  }
})
