import { test, expect, type App } from './helpers'

/** Screenshot the viewport canvas, then measure a block of pixels: the share that deviates from the block median, and the std. */
async function blockStats(app: App, box: { x: number; y: number; w: number; h: number }) {
  const cb = (await app.page.locator('.vp canvas').boundingBox())!
  const png = await app.page.screenshot({ clip: { x: cb.x + box.x, y: cb.y + box.y, width: box.w, height: box.h } })
  const url = 'data:image/png;base64,' + png.toString('base64')
  return app.page.evaluate(async (u) => {
    const img = new Image()
    img.src = u
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = img.width
    cv.height = img.height
    const ctx = cv.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, img.width, img.height).data
    const lum: number[] = []
    for (let i = 0; i < d.length; i += 4) lum.push((d[i] + d[i + 1] + d[i + 2]) / 3)
    const sorted = [...lum].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const off = lum.filter((v) => Math.abs(v - median) > 1.5).length / lum.length
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length
    const std = Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length)
    return { median, off, std }
  }, url)
}

async function setup(app: App, ao: boolean) {
  await app.open()
  // these sample canvas pixels, so the empty-scene hint drawn over it stays out of the way
  await app.page.addStyleTag({ content: '.empty-hint { display: none !important }' })
  await app.ev((c, on) => {
    c.ui.getState().setTheme('light')
    if (c.ui.getState().ssao !== on) c.ui.getState().toggleSsao()
  }, ao)
  await app.page.waitForTimeout(600)
}

test('light theme, AO on, empty scene: ground and background are grain free', async ({ app }) => {
  await setup(app, true)
  await app.ev((c) => c.bus.emit('view', 'top'))
  await app.cameraStable()
  const cb = (await app.page.locator('.vp canvas').boundingBox())!
  // a block of ground (the grid is on) and a block of background-only pixels in the top corner
  const ground = await blockStats(app, { x: Math.floor(cb.width / 2) + 20, y: Math.floor(cb.height / 2) + 20, w: 30, h: 30 })
  // a few grid lines may cross the block, grain would touch most of it
  expect(ground.off).toBeLessThan(0.15)
  // with the grid hidden the ground area is exactly the clear colour: no noise at all
  await app.ev((c) => c.ui.setState({ showGrid: false, showOrigin: false }))
  await app.page.waitForTimeout(600)
  const bare = await blockStats(app, { x: 300, y: 300, w: 200, h: 200 })
  const corner = await blockStats(app, { x: 4, y: 4, w: 40, h: 40 })
  expect(bare.std).toBeLessThan(0.05)
  expect(corner.std).toBeLessThan(0.05)
})

test('light theme, AO on, box: flat lit face has near zero variance', async ({ app }) => {
  await setup(app, true)
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 40, depth: 40, height: 40, position: [0, 0, 0] }))
  await app.idle()
  await app.ev((c) => c.bus.emit('view', 'top'))
  await app.cameraStable()
  await app.page.waitForTimeout(600)
  // the AO pass really is drawing once the camera has settled
  await expect.poll(() => app.ev((c) => c.ui.getState().aoActive), { timeout: 60_000 }).toBe(true)
  const p = await app.project(0, 0, 40) // centre of the top face
  const cb = (await app.page.locator('.vp canvas').boundingBox())!
  const face = await blockStats(app, { x: p.x - cb.x - 12, y: p.y - cb.y - 12, w: 24, h: 24 })
  console.log('face', face)
  expect(face.std).toBeLessThan(1.5)
  expect(face.off).toBeLessThan(0.02)
  await app.shot('ao-grain-light-on')
})
