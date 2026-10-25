import fs from 'node:fs'
import { test, expect, type App } from './helpers'

async function addBox(app: App, size: [number, number, number], position: [number, number, number]) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size[0], depth: a.size[1], height: a.size[2], position: a.position }), { size, position })
  await app.idle()
}
async function scene(app: App) {
  await addBox(app, [30, 30, 20], [0, 0, 0])
  await addBox(app, [14, 14, 30], [30, 0, 0])
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
  await app.tab('Render')
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: 'f1' }]))
  await app.page.getByTestId('mat-petg').click()
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'body', id: 'f2' }]))
  await app.page.getByTestId('mat-metal').click()
  await app.ev((c) => c.ui.getState().clearSelection())
  await app.idle()
}
async function section(app: App, id: string) {
  const d = app.page.getByTestId(`render-sec-${id}`)
  if (!(await d.evaluate((e) => (e as HTMLDetailsElement).open))) await d.locator('summary').click()
}

/** size and pixel statistics of a PNG, decoded in the page */
async function inspectPng(app: App, bytes: Buffer) {
  return app.page.evaluate(async (b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }))
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const colors = new Set<number>()
    let sum = 0, sum2 = 0
    for (let i = 0; i < d.length; i += 4) {
      colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3
      sum += l; sum2 += l * l
    }
    const n = d.length / 4
    return { width: bmp.width, height: bmp.height, colors: colors.size, variance: sum2 / n - (sum / n) ** 2, mean: sum / n }
  }, bytes.toString('base64'))
}

async function setSmall(app: App, engine: string) {
  await section(app, 'output')
  await app.ev((c, e) => c.render.settings.getState().set({ width: 96, height: 64, samples: 6, engine: e, denoise: true }), engine)
}

async function renderAndSave(app: App, info: import('@playwright/test').TestInfo, name: string) {
  const { page } = app
  await page.getByTestId('render-image').click()
  await expect(page.getByTestId('render-result')).toBeVisible({ timeout: 300_000 })
  const result = page.getByTestId('render-result')
  const meta = { engine: await result.getAttribute('data-engine'), w: await result.getAttribute('data-w'), h: await result.getAttribute('data-h') }
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-png').click()])
  expect(dl.suggestedFilename()).toMatch(/\.png$/)
  const file = info.outputPath(name)
  await dl.saveAs(file)
  const bytes = fs.readFileSync(file)
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return { meta, bytes, file }
}

test('a path traced render is a non-blank PNG of the requested size', async ({ app, page }, info) => {
  await app.open()
  const sup = await app.ev((c) => c.render?.pathTracerSupport?.() ?? { ok: false })
  await scene(app)
  await setSmall(app, 'pathtracer')
  const { meta, bytes } = await renderAndSave(app, info, 'pt.png')
  const st = await inspectPng(app, bytes)
  expect(st.width).toBe(96)
  expect(st.height).toBe(64)
  expect(st.colors).toBeGreaterThan(20)
  expect(st.variance).toBeGreaterThan(20)
  // the engine that ran is the path tracer where this browser can run it, and the rasterizer (with the reason) where it cannot
  if (sup.ok) {
    expect(meta.engine).toBe('pathtracer')
    await expect(page.getByTestId('render-note')).toHaveCount(0)
  }
  else {
    expect(meta.engine).toBe('raster')
    await expect(page.getByTestId('render-note')).toContainText(/Rendered with the rasterizer/)
  }
  expect(meta).toMatchObject({ w: '96', h: '64' })
})

test('the rasterizer path renders the same scene to a PNG of the requested size', async ({ app }, info) => {
  await app.open()
  await scene(app)
  await app.ev((c) => c.render.settings.getState().set({ width: 160, height: 90, samples: 8, engine: 'raster', denoise: true, reflection: true }))
  const { meta, bytes } = await renderAndSave(app, info, 'raster.png')
  expect(meta).toEqual({ engine: 'raster', w: '160', h: '90' })
  const st = await inspectPng(app, bytes)
  expect(st.width).toBe(160)
  expect(st.height).toBe(90)
  expect(st.colors).toBeGreaterThan(40)
  expect(st.variance).toBeGreaterThan(20)
  fs.copyFileSync(info.outputPath('raster.png'), 'e2e/screenshots/render-raster.png')
})

test('depth of field blurs what is out of focus', async ({ app }, info) => {
  await app.open()
  await scene(app)
  const base = { width: 120, height: 80, samples: 24, engine: 'raster', denoise: false, shadow: false }
  await app.ev((c, b) => c.render.settings.getState().set({ ...b, dof: false }), base)
  const sharp = await renderAndSave(app, info, 'sharp.png')
  // focus far behind the model with a wide open lens
  await app.ev((c, b) => c.render.settings.getState().set({ ...b, dof: true, fStop: 1.2, focalMm: 85, focusDistance: 900 }), base)
  const blurred = await renderAndSave(app, info, 'blurred.png')
  const a = await inspectPng(app, sharp.bytes), b = await inspectPng(app, blurred.bytes)
  // blurring merges edges into in-between colors and lowers the contrast of the model against its backdrop
  expect(b.colors).not.toBe(a.colors)
  expect(b.variance).toBeLessThan(a.variance)
  fs.copyFileSync(info.outputPath('blurred.png'), 'e2e/screenshots/render-dof.png')
})

test('the fallback works when the browser lacks float texture filtering', async ({ app, page }, info) => {
  // hide OES_texture_float_linear from WebGL2 contexts: the path tracer needs it, nothing else here does
  await page.addInitScript(() => {
    const orig = WebGL2RenderingContext.prototype.getExtension
    WebGL2RenderingContext.prototype.getExtension = function (this: WebGL2RenderingContext, n: string) { return n === 'OES_texture_float_linear' ? null : orig.call(this, n) } as typeof orig
  })
  await app.open()
  await scene(app)
  await section(app, 'output')
  await expect(page.getByTestId('engine-note')).toContainText('OES_texture_float_linear')
  await app.ev((c) => c.render.settings.getState().set({ width: 80, height: 60, samples: 4, engine: 'auto' }))
  const { meta, bytes } = await renderAndSave(app, info, 'fallback.png')
  expect(meta).toEqual({ engine: 'raster', w: '80', h: '60' })
  await expect(page.getByTestId('render-note')).toContainText('OES_texture_float_linear')
  const st = await inspectPng(app, bytes)
  expect(st.width).toBe(80)
  expect(st.colors).toBeGreaterThan(20)
})

test('a render can be cancelled', async ({ app, page }) => {
  await app.open()
  await scene(app)
  await app.ev((c) => c.render.settings.getState().set({ width: 640, height: 360, samples: 4096, engine: 'pathtracer' }))
  await page.getByTestId('render-image').click()
  await expect(page.getByTestId('render-cancel')).toBeVisible()
  await page.getByTestId('render-cancel').click({ force: true })
  await expect(page.getByTestId('render-status')).toHaveAttribute('data-status', 'idle', { timeout: 120_000 })
  await expect(page.getByTestId('render-result')).toHaveCount(0)
  await expect(page.getByTestId('render-error')).toHaveCount(0)
})

test('an empty document says so instead of rendering', async ({ app, page }) => {
  await app.open()
  await app.tab('Render')
  await page.getByTestId('render-image').click()
  await expect(page.getByTestId('render-error')).toContainText('nothing to render')
})

test('the turntable records a WebM video', async ({ app, page }, info) => {
  test.setTimeout(300_000)
  await app.open()
  await scene(app)
  await app.ev((c) => c.render.settings.getState().setTurntable({ seconds: 1, fps: 8, width: 96, height: 64 }))
  await section(app, 'turntable')
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 240_000 }), page.getByTestId('render-turntable').click()])
  expect(dl.suggestedFilename()).toMatch(/\.webm$/)
  const file = info.outputPath('turn.webm')
  await dl.saveAs(file)
  const bytes = fs.readFileSync(file)
  expect(bytes.length).toBeGreaterThan(500)
  expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  await app.shot('render-turntable-done')
})
