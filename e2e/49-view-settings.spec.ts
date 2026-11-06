import { test, expect, type App } from './helpers'
import type { Page } from '@playwright/test'

/**
 * Two display settings: the selection colour (bodies, faces, edges, sketch lines; the hover follows it) and the origin axes.
 * Both are persisted. The colour is checked on the highlight material and on the pixels the GPU actually drew.
 */

async function openDisplay(page: Page) {
  await page.getByTestId('settings-gear').click()
  await page.getByTestId('settings-dialog-nav-display').click()
}
async function closeSettings(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
}

/**
 * Render a frame, then count the canvas pixels that are clearly magenta: the custom selection colour of these specs, a colour nothing
 * else in the scene has (the theme accent is a green, the axes are red, green and blue).
 */
async function magentaPixels(app: App): Promise<number> {
  return app.page.evaluate(() => {
    const t = (window as any).__caddy.three // eslint-disable-line
    t.gl.render(t.scene, t.camera)
    const g = t.gl.getContext() as WebGL2RenderingContext
    const w = g.drawingBufferWidth, h = g.drawingBufferHeight
    const px = new Uint8Array(w * h * 4)
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px)
    let n = 0
    for (let i = 0; i < px.length; i += 4) if (px[i] > px[i + 1] + 20 && px[i + 2] > px[i + 1] + 20) n++
    return n
  })
}
/** Colours of the highlight materials in the scene (the translucent overlay that tints a selected / hovered face). */
const highlightHex = (app: App) => app.page.evaluate(() => {
  const t = (window as any).__caddy.three // eslint-disable-line
  const out: string[] = []
  t.scene.traverse((o: any) => { // eslint-disable-line
    const m = o.material
    if (m && m.isMeshBasicMaterial && m.transparent && Math.abs(m.opacity - 0.42) < 1e-6) out.push('#' + m.color.getHexString())
  })
  return out
})

async function boxScene(app: App) {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}

test('selection colour: picked in Settings, drawn on faces and edges and sketch lines, hover follows, persists', async ({ app, page }) => {
  await boxScene(app)
  const body = await app.ev((c) => c.doc.getState().geometry[0].id)
  // (the custom colour is a magenta: nothing else in the scene is)
  await app.ev((c) => c.ui.setState({ showOrigin: false, showGrid: false }))
  const select = (kind: string, index: number) => app.ev((c, a) => c.ui.getState().setSelection([{ kind: a.kind, id: a.id, index: a.index }]), { kind, id: body, index })

  // default: the theme accent, nothing magenta
  await select('face', 0)
  await app.cameraStable()
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
  const before = await highlightHex(app)
  expect(before.length).toBeGreaterThan(0)
  expect(before[0].toLowerCase()).toBe(accent.toLowerCase())
  expect(await magentaPixels(app)).toBe(0)

  // pick magenta with the custom colour input
  await openDisplay(page)
  await expect(page.getByTestId('sel-color-default')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('sel-color-custom').fill('#dd33dd')
  await closeSettings(page)
  await app.cameraStable()
  expect((await highlightHex(app))[0]).toBe('#dd33dd')
  const faceCustom = await magentaPixels(app)
  expect(faceCustom).toBeGreaterThan(300) // the face is tinted magenta on screen (the box is framed with a generous margin: a face is a few hundred pixels)

  // hover (pre-selection) is drawn in the same colour: clear the selection, hover a face
  await app.ev((c) => c.ui.getState().setSelection([]))
  await app.ev((c, id) => c.ui.setState({ hover: { kind: 'face', id, index: 0 } }), body)
  await app.cameraStable()
  expect(await magentaPixels(app)).toBeGreaterThan(300)
  await app.ev((c) => c.ui.setState({ hover: null }))

  // edges
  await app.ev((c) => c.ui.getState().setSelectionFilter('edge'))
  await select('edge', 0)
  await app.cameraStable()
  const edgeCustom = await magentaPixels(app)
  expect(edgeCustom).toBeGreaterThan(0) // a thin antialiased line, nothing else is magenta
  await app.shot('selection-color-custom')

  // persisted in the settings, and picked up again after a reload
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.settings')!).selectionColor)).toBe('#dd33dd')
  await page.reload()
  await boxScene(app)
  await app.ev((c) => c.ui.getState().setSelection([]))
  const body2 = await app.ev((c) => c.doc.getState().geometry[0].id)
  await app.ev((c, id) => c.ui.getState().setSelection([{ kind: 'face', id, index: 0 }]), body2)
  await app.cameraStable()
  expect((await highlightHex(app))[0]).toBe('#dd33dd')
  await openDisplay(page)
  await expect(page.getByTestId('sel-color-custom')).toHaveValue('#dd33dd')

  // sketch entities: a selected sketch line is magenta too
  await closeSettings(page)
  await app.sketchRect('XY', 40, 30)
  await app.ev((c) => c.sketch.setState({ sel: c.sketch.getState().model.entities.filter((e: any) => e.type !== 'point').map((e: any) => e.id) })) // eslint-disable-line
  await app.cameraStable()
  const skSel = await magentaPixels(app)
  await app.ev((c) => c.sketch.setState({ sel: [] }))
  await app.cameraStable()
  const unselected = await magentaPixels(app)
  expect(skSel).toBeGreaterThan(unselected + 50)
  await app.finishSketch()

  // Default goes back to the accent
  await openDisplay(page)
  await page.getByTestId('sel-color-default').click()
  await expect(page.getByTestId('sel-color-default')).toHaveAttribute('aria-checked', 'true')
  await closeSettings(page)
  await app.ev((c, id) => c.ui.getState().setSelection([{ kind: 'face', id, index: 0 }]), body2)
  await app.cameraStable()
  expect((await highlightHex(app))[0].toLowerCase()).toBe(accent.toLowerCase())
  expect(await magentaPixels(app)).toBe(0)
})

test('origin axes: hidden and shown from Settings, in step with the viewport button, and persisted', async ({ app, page }) => {
  await boxScene(app)
  const has = () => page.evaluate(() => !!(window as any).__caddy.three.scene.getObjectByName('origin')) // eslint-disable-line
  expect(await has()).toBe(true)

  await openDisplay(page)
  const cb = page.getByTestId('set-origin').getByRole('checkbox')
  await expect(cb).toBeChecked()
  await cb.click()
  await expect(cb).not.toBeChecked()
  await closeSettings(page)
  await app.cameraStable()
  expect(await has()).toBe(false)
  expect(await app.ev((c) => c.ui.getState().showOrigin)).toBe(false)
  await expect(page.getByRole('button', { name: 'Origin', exact: true })).toHaveAttribute('data-active', 'false')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.settings')!).showOrigin)).toBe(false)

  // still hidden after a reload
  await page.reload()
  await boxScene(app)
  expect(await has()).toBe(false)

  // the viewport button flips it back, and the setting follows
  await page.getByRole('button', { name: 'Origin', exact: true }).click()
  await app.cameraStable()
  expect(await has()).toBe(true)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.settings')!).showOrigin)).toBe(true)
  await openDisplay(page)
  await expect(page.getByTestId('set-origin').getByRole('checkbox')).toBeChecked()
})
