import { test, expect, type App } from './helpers'

interface Line { x: number; peak: number; green: number }

/** Renders the scene once and returns the lines found along one pixel row of the WebGL canvas (canvas pixel x). */
async function rowLines(app: App, rowFrac: number): Promise<Line[]> {
  const row: number[] = await app.page.evaluate(async (frac) => {
    const t = (window as any).__caddy.three // eslint-disable-line
    t.gl.render(t.scene, t.camera) // read the framebuffer in the same task as the render
    const gl: WebGLRenderingContext = t.gl.getContext()
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight
    // only the 40 row band is read (readPixels is bottom-up); encoding the whole canvas is far too slow on software GL
    const top = Math.min(Math.floor(H * frac), H - 40)
    const buf = new Uint8Array(W * 40 * 4)
    gl.readPixels(0, H - top - 40, W, 40, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const refPx = new Uint8Array(4)
    gl.readPixels(2, H - 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, refPx) // the far corner is outside the faded grid: pure background
    const ref = refPx
    // a row that happens to run along a horizontal grid line would light up entirely: take the quietest row of the band
    let best: number[] = [], bestSum = Infinity
    for (let k = 0; k < 40; k++) {
      const off = (39 - k) * W * 4 // band row k counted from the top
      const row = Array.from(buf.subarray(off, off + W * 4))
      let sum = 0
      for (let i = 0; i < row.length; i += 4) sum += Math.abs(row[i] - ref[0]) + Math.abs(row[i + 1] - ref[1]) + Math.abs(row[i + 2] - ref[2])
      if (sum < bestSum) { bestSum = sum; best = row }
    }
    return [ref[0], ref[1], ref[2], 255, ...best]
  }, rowFrac)
  const bg = row.slice(0, 3)
  row.splice(0, 4)
  const width = row.length / 4
  const diff = (i: number) => Math.abs(row[i * 4] - bg[0]) + Math.abs(row[i * 4 + 1] - bg[1]) + Math.abs(row[i * 4 + 2] - bg[2])
  const lo = Math.floor(width * 0.15), hi = Math.floor(width * 0.85)
  const lines: Line[] = []
  for (let i = lo; i < hi;) {
    if (diff(i) < 3.5) { i++; continue }
    let j = i, sum = 0, wsum = 0, peak = 0, green = 0
    while (j < hi && diff(j) >= 3.5) {
      sum += j * diff(j); wsum += diff(j); peak = Math.max(peak, diff(j))
      green = Math.max(green, row[j * 4 + 1] - (row[j * 4] + row[j * 4 + 2]) / 2)
      j++
    }
    lines.push({ x: sum / wsum, peak, green })
    i = j
  }
  return lines
}

/** The grid shader's current layer (uStep / uBlend) and where world x = 0 and x = 1 land in canvas pixels (top view: vertical lines). */
async function gridState(app: App) {
  return app.page.evaluate(() => {
    const t = (window as any).__caddy.three // eslint-disable-line
    let u: any = null // eslint-disable-line
    t.scene.traverse((o: any) => { if (o.material?.uniforms?.uStep && o.material.uniforms.uHalf) u = o.material.uniforms }) // eslint-disable-line
    const cam = t.camera
    cam.updateMatrixWorld()
    const V = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements
    const mul = (m: number[], v: number[]) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3])
    const w = t.gl.domElement.width
    const px = (x: number) => { const c = mul(P, mul(V, [x, 0, 0, 1])); return ((c[0] / c[3] + 1) / 2) * w }
    return { step: u.uStep.value as number, blend: u.uBlend.value as number, width: w, origin: px(0), unit: px(1) - px(0) }
  })
}

async function startSketch(app: App) {
  const { page } = app
  await app.ribbon('Sketch').first().click()
  const planes = page.getByText('Planes', { exact: true })
  if (!(await page.getByText('XY plane').isVisible())) await planes.click()
  await page.getByText('XY plane').click()
  await expect(page.locator('.sk-bar')).toBeVisible()
  await app.cameraStable()
}

const nearest = (xs: number[], x: number) => xs.reduce((best, v) => (Math.abs(v - x) < Math.abs(best - x) ? v : best), xs[0])

/**
 * Checks one view: the grid shader's layers sit on the origin-aligned lattice (world x = multiple of the step), every line seen
 * in the pixel row is on it (so spacing is regular), every position of the minor lattice is present and every 10th is stronger.
 */
async function checkGrid(app: App, what: string): Promise<number> {
  await app.cameraStable()
  const g = await gridState(app)
  const lines = await rowLines(app, 0.78)
  const axis = lines.reduce((a, l) => (l.green > a.green ? l : a))
  expect(axis.green, `${what}: the sketch Y axis (green) is in the row`).toBeGreaterThan(20)
  expect(Math.abs(axis.x - g.origin), `${what}: the axis line is at the sketch origin`).toBeLessThan(1.5)

  const S = g.step * 10 // the minor layer (cells of 12..120 px): always visible, the finer layer fades out
  const cell = S * g.unit
  expect(cell, `${what}: minor cell in px (step ${g.step}, blend ${g.blend.toFixed(2)})`).toBeGreaterThan(11.5)
  expect(cell, `${what}: minor cell in px`).toBeLessThan(125)
  const lo = g.width * 0.15, hi = g.width * 0.85
  const jMin = Math.ceil((lo - g.origin) / cell), jMax = Math.floor((hi - g.origin) / cell)
  const e1: number[] = [], e0: number[] = []
  for (let j = jMin; j <= jMax; j++) if (j !== 0) e1.push(g.origin + j * cell)
  if (g.blend <= 0.45) for (let j = Math.ceil((lo - g.origin) / (cell / 10)); j <= Math.floor((hi - g.origin) / (cell / 10)); j++) e0.push(g.origin + (j * cell) / 10)

  const others = lines.filter((l) => l !== axis)
  for (const l of others) {
    const d = Math.min(Math.abs(l.x - nearest(e1, l.x)), e0.length ? Math.abs(l.x - nearest(e0, l.x)) : Infinity)
    expect(d, `${what}: the line at x=${l.x.toFixed(1)} is on the origin-aligned lattice (cell ${cell.toFixed(2)}px)`).toBeLessThan(1.6)
  }
  const found = (x: number) => others.find((l) => Math.abs(l.x - x) < 1.6)
  const major: number[] = [], minor: number[] = []
  for (let j = jMin; j <= jMax; j++) {
    if (j === 0) continue
    const l = found(g.origin + j * cell)
    expect(l, `${what}: a line at lattice position ${j} (x=${(g.origin + j * cell).toFixed(1)})`).toBeTruthy()
    ;(j % 10 === 0 ? major : minor).push(l!.peak)
  }
  if (major.length && minor.length) {
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
    expect(avg(major), `${what}: every 10th line is stronger`).toBeGreaterThan(avg(minor) * 1.08)
  }
  return cell
}

test('sketch grid: regular, origin-aligned minor / major lines (major every 10th) that adapt to the zoom', async ({ app, page }) => {
  await app.open()
  await startSketch(app)
  await app.shot('sketch-grid')
  const vp = (await page.locator('.vp canvas').boundingBox())!
  await page.mouse.move(vp.x + vp.width * 0.5, vp.y + vp.height * 0.5)

  const cells: number[] = [await checkGrid(app, 'initial')]
  // zoom in, far in, then out and far out: the layers cross-fade between decades and the pattern stays regular and aligned
  for (const [label, delta, n] of [['zoomed in', -200, 3], ['zoomed in more', -200, 5], ['zoomed out', 200, 9], ['zoomed out far', 200, 6], ['zoomed out farther', 200, 4]] as [string, number, number][]) {
    for (let i = 0; i < n; i++) await page.mouse.wheel(0, delta)
    cells.push(await checkGrid(app, label))
  }
  // the minor cell in pixels changes as the view zooms (the grid adapts) but always stays readable
  expect(new Set(cells.map((s) => Math.round(s))).size).toBeGreaterThan(3)
  await app.shot('sketch-grid-zoomed')
})
