import { test, expect, type App } from './helpers'

/**
 * Renders the scene once and returns, for every canvas row, how far the pixels around the centre column are from the background
 * (sum of the channel differences, strongest of five columns). The camera looks along +Y, so the green Y axis runs straight up
 * the middle of the screen to the vanishing point: sampling that column walks the grid from the viewer out to the horizon.
 */
async function centreColumn(app: App): Promise<{ rows: number[]; height: number }> {
  const out: number[] = await app.page.evaluate(async () => {
    const t = (window as any).__caddy.three // eslint-disable-line
    t.gl.render(t.scene, t.camera) // read the canvas in the same task as the render
    const img = new Image()
    img.src = t.gl.domElement.toDataURL()
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = img.width
    cv.height = img.height
    const ctx = cv.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const bg = ctx.getImageData(2, 2, 1, 1).data // the top corner is above the horizon: pure background
    const cx = Math.floor(img.width / 2)
    const col = ctx.getImageData(cx - 2, 0, 5, img.height).data
    const rows: number[] = []
    for (let y = 0; y < img.height; y++) {
      let best = 0
      for (let k = 0; k < 5; k++) {
        const i = (y * 5 + k) * 4
        best = Math.max(best, Math.abs(col[i] - bg[0]) + Math.abs(col[i + 1] - bg[1]) + Math.abs(col[i + 2] - bg[2]))
      }
      rows.push(best)
    }
    return [img.height, ...rows]
  })
  return { height: out[0], rows: out.slice(1) }
}

/** Median of five rows: a horizontal grid line crossing the column is a one or two row spike, not part of the fade. */
function smooth(rows: number[]): number[] {
  return rows.map((_, y) => {
    const w = rows.slice(Math.max(0, y - 2), y + 3).sort((p, q) => p - q)
    return w[Math.floor(w.length / 2)]
  })
}

/** Largest change between neighbouring rows of a profile. */
function maxStep(p: number[]): { step: number; at: number } {
  let step = 0, at = 0
  for (let y = 0; y < p.length - 1; y++) {
    const d = Math.abs(p[y + 1] - p[y])
    if (d > step) { step = d; at = y }
  }
  return { step, at }
}

test('perspective ground grid fades smoothly into the background towards the horizon (no hard plane edge)', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.ui.getState().setProjection('perspective'))
  await app.ev((c) => c.ui.setState({ showOrigin: false })) // the origin marker would sit on the sampled column
  const vp = (await page.locator('.vp canvas').boundingBox())!
  await page.mouse.move(vp.x + vp.width * 0.5, vp.y + vp.height * 0.5)

  for (const [label, elevDeg, wheel] of [['grazing', 3, 0], ['grazing, zoomed out', 3, 6], ['low', 8, 0]] as [string, number, number][]) {
    const e = (elevDeg * Math.PI) / 180
    await app.ev((c, v) => c.bus.emit('viewVec', v), [0, -Math.cos(e), Math.sin(e)]) // eslint-disable-line
    for (let i = 0; i < wheel; i++) await page.mouse.wheel(0, 200)
    await app.cameraStable()
    await page.waitForTimeout(300)
    const { rows, height } = await centreColumn(app)

    const prof = smooth(rows)
    const peak = Math.max(...prof)
    expect(peak, `${label}: the grid is visible`).toBeGreaterThan(15)
    // nothing is drawn above the horizon
    expect(prof.slice(0, 4).every((v) => v < 3), `${label}: top of the screen is plain background`).toBe(true)
    const first = prof.findIndex((v) => v >= 3)
    expect(first, `${label}: the grid starts below the top of the screen`).toBeGreaterThan(2)
    // from the horizon down the brightness only ever changes a little per row
    const { step, at } = maxStep(prof)
    expect(step, `${label}: biggest brightness step between rows (at row ${at} of ${height}, peak ${peak}, rows around: ${prof.slice(Math.max(0, at - 4), at + 6).join(',')})`).toBeLessThan(Math.max(6, peak * 0.2))
    // and the far end really tapers: the first visible rows are faint, not already at full strength
    expect(prof[first + 2], `${label}: the grid fades in from the horizon`).toBeLessThan(peak * 0.5)
    await app.shot('grid-horizon-' + label.replace(/\W+/g, '-'))
  }
})

test('orthographic ground grid never ends in a hard edge, even looking along the ground', async ({ app, page }) => {
  await app.open()
  expect(await app.ev((c) => c.ui.getState().projection)).toBe('orthographic')
  await app.ev((c) => c.ui.setState({ showOrigin: false }))
  for (const [label, elevDeg] of [['ortho grazing', 3], ['ortho low', 8], ['ortho tilted', 25]] as [string, number][]) {
    const e = (elevDeg * Math.PI) / 180
    await app.ev((c, v) => c.bus.emit('viewVec', v), [0, -Math.cos(e), Math.sin(e)]) // eslint-disable-line
    await app.cameraStable()
    await page.waitForTimeout(300)
    const { rows, height } = await centreColumn(app)
    const prof = smooth(rows)
    const peak = Math.max(...prof)
    // looking along the ground the grid fades away; tilted further it is plainly there
    if (elevDeg >= 25) expect(peak, `${label}: the grid is visible`).toBeGreaterThan(15)
    const { step, at } = maxStep(prof)
    expect(step, `${label}: biggest brightness step between rows (at row ${at} of ${height}, peak ${peak})`).toBeLessThan(Math.max(6, peak * 0.2))
    await app.shot('grid-horizon-' + label.replace(/\W+/g, '-'))
  }
})
