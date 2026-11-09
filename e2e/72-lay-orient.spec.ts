/** Print workspace: Lay on face highlights the whole flat face and turns the part about no extra axis; Auto Orient leaves it flat. */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, SHOTS, type App } from './helpers'

/* eslint-disable @typescript-eslint/no-explicit-any */
const DIR = process.env.ORIENT_SHOTS
async function shot(app: App, name: string) {
  await app.shot(name)
  if (DIR) { fs.mkdirSync(DIR, { recursive: true }); fs.copyFileSync(path.join(SHOTS, name + '.png'), path.join(DIR, name + '.png')) }
}
const part = (app: App) => app.ev((c) => { const p = c.print.model().list[0]; return { id: p.id, size: p.size, lo: p.lo, hi: p.hi, r: p.entry.r, x: p.entry.x, y: p.entry.y } }) as Promise<{ id: string; size: number[]; lo: number[]; hi: number[]; r: number[]; x: number; y: number }>
/** how many vertices sit on the bed (z = 0 within 0.01 mm) as drawn */
const onBed = (app: App) => app.ev((c) => {
  const p = c.print.model().list[0], m = p.m
  const b = c.doc.getState().geometry.find((g: any) => g.id === p.id).mesh.positions
  let n = 0
  for (let i = 0; i < b.length; i += 3) if (Math.abs(m[2] * b[i] + m[6] * b[i + 1] + m[10] * b[i + 2] + m[14]) < 0.01) n++
  return n
}) as Promise<number>

test('Lay on face picks the whole face without yaw, Auto Orient rests flat', async ({ app, page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await app.open()
  // an enclosure with a mounting tab
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 80, depth: 50, height: 30, position: [0, 0, 0] }))
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 30, depth: 12, height: 4, position: [70, 10, 0] }))
  await app.ev((c) => c.doc.getState().addFeature('combine', { target: ['f1'], tools: ['f2'], operation: 'join', keepTools: false }))
  await app.idle()
  await app.tab('Print')
  await expect.poll(async () => (await app.ev((c) => c.print.model().list.length)) as number).toBe(1)
  let p = await part(app)
  await app.ev((c, id) => c.ui.getState().setSelection([{ kind: 'body', id }]), p.id)

  // hover a face: the highlight is the whole face (every triangle of that B-rep face)
  await page.getByTestId('tool-face').click()
  const front = await app.project(p.x - p.size[0] / 2 + 40, p.lo[1], 15)
  await page.mouse.move(front.x - 6, front.y - 6)
  await page.mouse.move(front.x, front.y, { steps: 4 })
  await expect.poll(async () => app.ev((c) => !!c.three.scene.getObjectByName('face-region'))).toBe(true)
  const hl = await app.ev((c) => {
    const o: any = c.three.scene.getObjectByName('face-region')
    const idx = o.geometry.index.array
    const pos = o.geometry.getAttribute('position').array
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < idx.length; i++) for (let k = 0; k < 3; k++) { const v = pos[idx[i] * 3 + k]; lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v) }
    return { tris: idx.length / 3, lo, hi }
  }) as { tris: number; lo: number[]; hi: number[] }
  // the whole front wall: 80 x 30 (a single sliver would be far smaller)
  expect(hl.hi[0] - hl.lo[0]).toBeGreaterThan(79)
  expect(hl.hi[2] - hl.lo[2]).toBeGreaterThan(29)
  await shot(app, 'orient-hover-face')

  // click: that wall becomes the bottom, and the part is not turned about the vertical
  await page.mouse.click(front.x, front.y)
  await expect.poll(async () => (await part(app)).size[2], { timeout: 15_000 }).toBeCloseTo(50, 1)
  p = await part(app)
  expect(p.size[0]).toBeCloseTo(125, 1) // 80 + the tab: the long side still runs along X
  expect(p.size[1]).toBeCloseTo(30, 1)
  expect(await onBed(app)).toBeGreaterThanOrEqual(4)
  await app.cameraStable()
  await shot(app, 'orient-after-lay-on-face')

  // tip the part to an odd angle by hand, then Auto Orient: it ends up flat again
  await app.ev((c, id) => c.ui.getState().setSelection([{ kind: 'body', id }]), p.id)
  for (const [k, v] of [['Rx', '33'], ['Ry', '21']]) {
    const f = page.getByTestId(`pose-${k}`)
    await f.fill(v)
    await f.press('Enter')
  }
  await expect.poll(async () => (await part(app)).r[1]).toBeCloseTo(21, 0)
  expect(await onBed(app)).toBeLessThan(4)
  await shot(app, 'orient-tilted')
  await page.getByTestId('tool-orient').click()
  await expect.poll(async () => onBed(app), { timeout: 30_000 }).toBeGreaterThanOrEqual(4)
  await app.cameraStable()
  await shot(app, 'orient-after-auto-orient')
  expect((await part(app)).lo[2]).toBe(0)
})
