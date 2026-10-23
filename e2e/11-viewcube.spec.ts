import { test, expect, type App } from './helpers'
import type { Page } from '@playwright/test'

type V3 = [number, number, number]
const norm = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l] }
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Camera basis in world space: right, up and "back" (target -> camera) vectors. */
async function basis(app: App): Promise<{ r: V3; u: V3; b: V3 }> {
  return app.ev((c) => {
    const e = c.three.camera.matrixWorld.elements
    return { r: [e[0], e[1], e[2]], u: [e[4], e[5], e[6]], b: [e[8], e[9], e[10]] }
  })
}
const cube = (page: Page) => page.getByTestId('viewcube')

/**
 * Pointer position that really hits a visible zone with this direction key: samples each visible zone's bounding box (a face
 * seen at an angle is a parallelogram, so its box centre may miss it) and returns the middle of the hits plus their count.
 */
function hitPoint(page: Page, key: string) {
  return page.evaluate((k) => {
    const hits: { x: number; y: number }[] = []
    for (const e of document.querySelectorAll('.vc-zone')) {
      if (e.getAttribute('data-zone') !== k || getComputedStyle(e.parentElement!).visibility === 'hidden') continue
      const r = e.getBoundingClientRect()
      for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
        const x = r.left + (r.width * (i + 0.5)) / 9, y = r.top + (r.height * (j + 0.5)) / 9
        if ((document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-zone]')?.getAttribute('data-zone') === k) hits.push({ x, y })
      }
    }
    if (!hits.length) return null
    const mx = hits.reduce((a, h) => a + h.x, 0) / hits.length, my = hits.reduce((a, h) => a + h.y, 0) / hits.length
    hits.sort((a, b) => Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my))
    return { x: hits[0].x, y: hits[0].y, area: hits.length }
  }, key)
}

async function setup(app: App) {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await app.ev((c) => c.runCommand('view.home'))
  await app.cameraStable()
}

test('ViewCube: 6 faces, 12 edges and 8 corners are all clickable zones that snap the view', async ({ app, page }) => {
  await setup(app)
  const keys = await page.locator('.vc-zone').evaluateAll((els) => {
    const kinds = new Map<string, string>()
    for (const e of els) kinds.set(e.getAttribute('data-zone')!, e.getAttribute('data-kind')!)
    return [...kinds.entries()]
  })
  expect(keys).toHaveLength(26)
  const count = (k: string) => keys.filter(([, kind]) => kind === k).length
  expect([count('face'), count('edge'), count('corner')]).toEqual([6, 12, 8])

  const clicked = new Set<string>()
  // from two opposite starting views every zone is visible on at least one face
  for (const start of [[1, -1, 1], [-1, 1, -1]] as V3[]) {
    await app.ev((c, v) => c.bus.emit('viewVec', v), start)
    await app.cameraStable()
    const visibleKeys = await page.locator('.vc-zone').evaluateAll((els) => [...new Set(els.filter((e) => getComputedStyle(e.parentElement!).visibility !== 'hidden').map((e) => e.getAttribute('data-zone')!))])
    expect(visibleKeys.length).toBeGreaterThan(10)
    for (const key of visibleKeys) {
      if (clicked.has(key)) continue
      await app.ev((c, v) => c.bus.emit('viewVec', v), start)
      await app.cameraStable()
      const pt = await hitPoint(page, key)
      if (!pt || pt.area < 2) continue // seen almost edge-on from this start view; the other start view shows it
      await page.mouse.move(pt.x, pt.y)
      await page.mouse.click(pt.x, pt.y)
      await app.cameraStable()
      const want = norm(key.split(',').map(Number) as V3)
      const got = (await basis(app)).b
      expect(dot(want, got), `view after clicking zone ${key}`).toBeGreaterThan(0.999)
      clicked.add(key)
    }
  }
  expect(clicked.size, `zones clicked: ${[...clicked].join(' ')}`).toBe(26)
})

test('ViewCube: every zone highlights on hover (an edge on both of its faces, a corner on all three)', async ({ app, page }) => {
  await setup(app)
  const hoverZone = async (kind: string, minArea = 150) => {
    const pt = await page.locator('.vc-zone').evaluateAll((els, a) => {
      for (const e of els) {
        if (e.getAttribute('data-kind') !== a.kind || getComputedStyle(e.parentElement!).visibility === 'hidden') continue
        const r = e.getBoundingClientRect()
        if (r.width * r.height < a.minArea) continue
        const x = r.left + r.width / 2, y = r.top + r.height / 2
        if (document.elementFromPoint(x, y) === e) return { x, y, key: e.getAttribute('data-zone') }
      }
      return null
    }, { kind, minArea })
    expect(pt, 'a visible ' + kind + ' zone').toBeTruthy()
    await page.mouse.move(pt!.x - 3, pt!.y - 3)
    await page.mouse.move(pt!.x, pt!.y, { steps: 2 })
    return pt!.key!
  }
  const hot = () => page.locator('.vc-zone[data-hot="true"]')

  const face = await hoverZone('face')
  await expect(hot()).toHaveCount(1)
  await expect(hot().first()).toHaveAttribute('data-zone', face)
  await app.shot('viewcube-hover-face')

  const edge = await hoverZone('edge', 30)
  await expect(hot().first()).toHaveAttribute('data-zone', edge)
  const edgeCount = await hot().count()
  expect(edgeCount).toBeGreaterThanOrEqual(1)
  expect(edgeCount).toBeLessThanOrEqual(2)

  const corner = await hoverZone('corner', 20)
  await expect(hot().first()).toHaveAttribute('data-zone', corner)
  expect(await hot().count()).toBeGreaterThanOrEqual(1)
  await app.shot('viewcube-hover-corner')

  // leaving the cube clears the highlight
  await page.mouse.move(600, 500)
  await expect(hot()).toHaveCount(0)
  // an edge zone seen on two visible faces lights both: the Top / Front edge from the home view
  const both = await page.locator('.vc-zone[data-zone="0,-1,1"]').evaluateAll((els) => els.filter((e) => getComputedStyle(e.parentElement!).visibility !== 'hidden').length)
  expect(both).toBe(2)
  const p = await page.locator('.vc-zone[data-zone="0,-1,1"]').evaluateAll((els) => {
    const e = els.find((x) => getComputedStyle(x.parentElement!).visibility !== 'hidden' && document.elementFromPoint(x.getBoundingClientRect().left + x.getBoundingClientRect().width / 2, x.getBoundingClientRect().top + x.getBoundingClientRect().height / 2) === x)!
    const r = e.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.move(p.x, p.y, { steps: 3 })
  await expect(hot()).toHaveCount(2)
})

test('ViewCube: home button, 90 degree step arrows and rolls', async ({ app, page }) => {
  await setup(app)
  const home = await basis(app)
  const near = (a: V3, b: V3, msg: string) => expect(dot(a, b), msg).toBeGreaterThan(0.999)
  const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]]

  // Top face, then Home brings the home view back
  await page.locator('.vc-face', { hasText: 'Top' }).first().click({ force: true })
  await app.cameraStable()
  near((await basis(app)).b, [0, 0, 1], 'top view')
  await cube(page).getByRole('button', { name: 'Home view' }).click()
  await app.cameraStable()
  near((await basis(app)).b, home.b, 'home view direction')
  near((await basis(app)).u, home.u, 'home up')

  const step = async (name: string) => {
    await cube(page).getByRole('button', { name }).click()
    await app.cameraStable()
    return basis(app)
  }
  // turning right / left brings the right / left side to the front: the camera moves to the side
  let b = await step('Rotate right 90°')
  near(b.b, home.r, 'rotate right: back = old right')
  b = await step('Rotate left 90°')
  near(b.b, home.b, 'rotate left undoes it')
  b = await step('Rotate left 90°')
  near(b.b, neg(home.r), 'rotate left')
  await cube(page).getByRole('button', { name: 'Home view' }).click()
  await app.cameraStable()
  b = await step('Rotate up 90°')
  near(b.b, home.u, 'rotate up: the camera goes over the top')
  await cube(page).getByRole('button', { name: 'Home view' }).click()
  await app.cameraStable()
  b = await step('Rotate down 90°')
  near(b.b, neg(home.u), 'rotate down')

  // rolls keep the view direction and turn the image
  await cube(page).getByRole('button', { name: 'Home view' }).click()
  await app.cameraStable()
  b = await step('Roll clockwise 90°')
  near(b.b, home.b, 'roll keeps the view direction')
  near(b.u, neg(home.r), 'roll clockwise: the old right is now up-screen-down')
  b = await step('Roll counter-clockwise 90°')
  near(b.u, home.u, 'roll back')
  b = await step('Roll counter-clockwise 90°')
  near(b.u, home.r, 'roll counter-clockwise')
  await app.shot('viewcube-rolled')

  // quick repeated clicks accumulate: two right turns = half a turn
  await cube(page).getByRole('button', { name: 'Home view' }).click()
  await app.cameraStable()
  const btn = cube(page).getByRole('button', { name: 'Rotate right 90°' })
  await btn.click()
  await btn.click()
  await app.cameraStable()
  near((await basis(app)).b, neg(home.b), 'two quick turns')

  // a face click after a roll gives the upright standard view again
  await page.locator('.vc-face', { hasText: /Front|Right|Top/ }).first().click({ force: true })
  await app.cameraStable()
  const after = await basis(app)
  expect(after.u[2], 'upright after snapping to a face').toBeGreaterThan(0)
})

test('ViewCube: dragging the cube orbits the view; transitions are animated', async ({ app, page }) => {
  await setup(app)
  const home = await basis(app)
  const box = (await page.locator('.vc-stage').boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 25, cy, { steps: 5 })
  await page.mouse.move(cx + 60, cy, { steps: 5 })
  await page.mouse.up()
  await app.cameraStable()
  const after = await basis(app)
  expect(dot(after.b, home.b), 'the view orbited').toBeLessThan(0.97)
  expect(after.b[2], 'a horizontal drag keeps the elevation').toBeCloseTo(home.b[2], 2)
  expect(after.u[2], 'and stays upright').toBeGreaterThan(0.5)
  // a drag is not a click: no zone was snapped to
  expect(Math.abs(Math.abs(after.b[2]) - 1)).toBeGreaterThan(0.2)
  // vertical drag changes the elevation
  const mid = await basis(app)
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx, cy + 20, { steps: 4 })
  await page.mouse.move(cx, cy + 45, { steps: 4 })
  await page.mouse.up()
  await app.cameraStable()
  expect((await basis(app)).b[2], 'dragging down raises the camera').toBeGreaterThan(mid.b[2] + 0.1)

  // animated: sample the camera right after a click, it must pass through intermediate directions
  await app.ev((c) => c.runCommand('view.home'))
  await app.cameraStable()
  await page.locator('.vc-face', { hasText: 'Top' }).first().click({ force: true })
  const samples: number[] = []
  for (let i = 0; i < 6; i++) {
    samples.push(dot((await basis(app)).b, [0, 0, 1]))
    await page.waitForTimeout(60)
  }
  await app.cameraStable()
  samples.push(dot((await basis(app)).b, [0, 0, 1]))
  expect(samples[0], 'not there instantly').toBeLessThan(0.95)
  expect(samples[samples.length - 1]).toBeGreaterThan(0.999)
  expect(samples.slice(1).some((s) => s > samples[0] + 0.02 && s < 0.99), `intermediate frames: ${samples.map((s) => s.toFixed(3))}`).toBe(true)
  for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-6)
  await app.shot('viewcube-top')
})
