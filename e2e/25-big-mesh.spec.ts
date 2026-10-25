import { test, expect, type App } from './helpers'
import { writeBigStl } from './bigStl'
import { startProdServer } from './prodServer'

/**
 * A 3 million triangle STL imports through the compute pool: no main-thread task over 100 ms (PerformanceObserver longtask),
 * and orbiting it stays above 30 fps because the viewport draws the decimated copy while the camera moves.
 *
 * It runs against a production bundle (see prodServer.ts): React's development build logs every render, which would
 * swamp these numbers. Software WebGL stands in for the GPU, so the full-res frame at rest is slow here, but nothing on the
 * main thread waits for it. Run with the CPU throttle off (the frame rate check is about a desktop).
 */
const PERF_PORT = Number(process.env.E2E_PERF_PORT ?? 5398)
test.use({ baseURL: `http://localhost:${PERF_PORT}` })
let stopServer: (() => void) | undefined
test.beforeAll(async () => {
  test.setTimeout(600_000)
  stopServer = await startProdServer(PERF_PORT)
})
test.afterAll(() => stopServer?.())

test.skip(Number(process.env.E2E_CPU_THROTTLE ?? 1) > 1, 'the frame rate check needs an unthrottled CPU')

async function watchLongTasks(app: App) {
  await app.page.evaluate(() => {
    const w = window as unknown as { __long?: number[]; __watching?: boolean }
    w.__long = []
    if (w.__watching) return
    w.__watching = true
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long!.push(e.duration) }).observe({ type: 'longtask', buffered: false })
  })
}
const longTasks = (app: App) => app.page.evaluate(() => (window as unknown as { __long: number[] }).__long)

test('a 3 million triangle STL imports without a long main-thread task and orbits smoothly', async ({ app, page }) => {
  test.setTimeout(420_000)
  const cells = Number(process.env.BIG_CELLS ?? 1225) // 1225 cells a side = 3.0 million triangles
  const stl = writeBigStl(cells)
  await app.open()
  await page.waitForTimeout(1500)
  await watchLongTasks(app)

  const t0 = Date.now()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Import').click()])
  await chooser.setFiles(stl)
  await expect.poll(() => app.bodies().then((b) => b.length), { timeout: 300_000, intervals: [500] }).toBe(1)
  await app.idle()
  await page.waitForTimeout(3000) // the first full-res frame
  console.log(`import took ${((Date.now() - t0) / 1000).toFixed(1)} s`)

  const [body] = await app.bodies()
  expect(body.kind).toBe('mesh')
  expect(body.tris).toBeGreaterThan(cells * cells * 2 * 0.99)
  expect((await app.features())[0].state).toBe('ok')
  // the worker built a low-res copy and the picking BVH, so the main thread did neither
  const extras = await app.ev((c) => { const m = c.doc.getState().geometry[0].mesh; return { lod: m.lod.indices.length / 3, bvh: !!m.bvh, bounds: !!m.bounds } })
  expect(extras.bvh && extras.bounds).toBe(true)
  expect(extras.lod).toBeGreaterThan(10_000)
  expect(extras.lod).toBeLessThan(150_000)

  const during = await longTasks(app)
  console.log('long tasks during import (ms):', during.map((d) => Math.round(d)).join(', ') || 'none')
  expect(Math.max(0, ...during), `long tasks: ${during.join(', ')}`).toBeLessThan(100)

  // picking uses the worker-built BVH: a ray through the middle of the model hits it, and quickly
  const pick = await app.ev((c) => {
    const t = c.three
    const bodies = t.scene.getObjectByName('bodies')
    t.raycaster.set({ x: 100, y: 100, z: 100 }, { x: 0, y: 0, z: -1 })
    t.raycaster.firstHitOnly = true
    const a = performance.now()
    const hit = t.raycaster.intersectObject(bodies, true)[0]
    return { ms: performance.now() - a, z: hit?.point.z }
  })
  expect(pick.z).toBeDefined()
  expect(Math.abs(pick.z)).toBeLessThan(10)
  expect(pick.ms).toBeLessThan(100)

  // orbit: shift + middle drag under the default (Fusion) navigation preset, sampling frame times
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  const b = (await page.locator('.vp canvas').boundingBox())!
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2
  await page.evaluate(() => {
    const w = window as unknown as { __frames: [number, number][]; __stop: boolean }
    w.__frames = []
    w.__stop = false
    let last = performance.now()
    const tick = (t: number) => {
      w.__frames.push([t, t - last])
      last = t
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await watchLongTasks(app)
  await page.keyboard.down('Shift')
  await page.mouse.move(cx - 150, cy)
  await page.mouse.down({ button: 'middle' })
  const from = await page.evaluate(() => performance.now())
  for (let i = 0; i <= 90; i++) {
    await page.mouse.move(cx - 150 + i * 3.3, cy + Math.sin(i / 14) * 60)
    await page.waitForTimeout(16)
  }
  // while the camera moves the low-res copy is what is drawn
  expect(await app.ev((c) => c.lodState())).toEqual([[false, true]])
  const to = await page.evaluate(() => performance.now())
  await page.mouse.up({ button: 'middle' })
  await page.keyboard.up('Shift')
  const all = await page.evaluate(() => { const w = window as unknown as { __frames: [number, number][]; __stop: boolean }; w.__stop = true; return w.__frames })
  const frames = all.filter(([t]) => t >= from && t <= to).map(([, d]) => d).sort((a, c) => a - c)
  const median = frames[Math.floor(frames.length / 2)]
  const p90 = frames[Math.floor(frames.length * 0.9)]
  const orbitLong = await longTasks(app)
  console.log(`orbit: ${frames.length} frames, median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms, worst ${frames[frames.length - 1].toFixed(0)} ms, long tasks ${orbitLong.map((d) => Math.round(d)).join(', ') || 'none'}`)
  expect(frames.length).toBeGreaterThan(40)
  expect(median).toBeLessThan(33.4) // 30 fps
  expect(p90).toBeLessThan(50)
  expect(Math.max(0, ...orbitLong)).toBeLessThan(100)

  // at rest the full mesh is back
  await expect.poll(() => app.ev((c) => c.lodState()), { timeout: 15_000 }).toEqual([[true, false]])
  await app.shot('big-mesh-3m')
})
