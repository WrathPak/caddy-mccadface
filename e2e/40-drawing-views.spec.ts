import { test, expect } from './helpers'
import { addBaseView, click, drawing, geomReady, hover, plate, primsOf, sheet, tool, viewBox, viewCenter } from './drawing-kit'

test('DRAWING tab: empty state, ribbon groups, first base view', async ({ app, page }) => {
  await app.open()
  await plate(app)
  await drawing(app)
  await expect(page.getByTestId('drawing-empty')).toBeVisible()
  for (const name of ['New Sheet', 'Setup', 'Title', 'Base View', 'Projected', 'Section', 'Detail', 'Iso', 'Linear', 'Aligned', 'Angular', 'Radius', 'Diameter', 'Ordinate', 'Baseline', 'Note', 'Leader', 'GD&T', 'Datum', 'Finish', 'Balloon', 'Parts List', 'PDF', 'DXF', 'SVG']) {
    await expect(app.ribbon(name).first()).toBeVisible()
  }
  await addBaseView(app)
  await expect(page.getByTestId('drawing-empty')).toBeHidden()
  const s = await sheet(app)
  expect(s.size).toBe('A3')
  expect(s.views).toHaveLength(1)
  expect(s.views[0]).toMatchObject({ kind: 'base', orientation: 'front', label: 'FRONT' })
  await app.shot('drawing-first-view')
})

test('front view: visible, hidden and center lines of the plate with a hole', async ({ app }) => {
  await app.open()
  await plate(app)
  await drawing(app)
  await addBaseView(app)
  const prims = await primsOf(app)
  const lines = (style: string) => prims.filter((p) => p.k === 'path' && p.style === style && !p.pick && p.owner?.startsWith('view:')).length
  expect(lines('visible')).toBe(4)
  expect(lines('hidden')).toBe(2)
  expect(lines('center')).toBe(1)
})

test('projected views: top above and right on the right (third angle), then first angle', async ({ app, page }) => {
  await app.open()
  await plate(app)
  await drawing(app)
  await addBaseView(app)
  const s0 = await sheet(app)
  const front = s0.views[0].id
  const [fx, fy] = await viewCenter(app, front)
  // Projected tool: click the view, move above it, click
  await app.ribbon('Projected').click()
  await expect.poll(() => tool(app)).toBe('view.projected')
  await click(app, fx, fy)
  const box = await viewBox(app, front)
  await hover(app, fx, box[3] + 30)
  await expect(page.getByTestId('drawing-hint')).toContainText('side you want')
  await click(app, fx, box[3] + 30)
  await expect.poll(async () => (await sheet(app)).views.length).toBe(2)
  await geomReady(app)
  const top = (await sheet(app)).views[1]
  expect(top).toMatchObject({ kind: 'projected', orientation: 'top', label: 'TOP', parentId: front, align: 'v' })
  expect(top.pos[0]).toBeCloseTo(fx, 3)
  expect(top.pos[1]).toBeGreaterThan(fy)
  // to the right
  await app.ribbon('Projected').click()
  await click(app, fx, fy)
  await click(app, box[2] + 40, fy)
  await expect.poll(async () => (await sheet(app)).views.length).toBe(3)
  await geomReady(app)
  const right = (await sheet(app)).views[2]
  expect(right).toMatchObject({ orientation: 'right', label: 'RIGHT', align: 'h' })
  expect(right.pos[1]).toBeCloseTo(fy, 3)
  expect(right.pos[0]).toBeGreaterThan(fx)
  await app.shot('drawing-projected')
  // first angle projection swaps them
  await app.ribbon('Setup').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Sheet')
  await app.inspector().getByRole('radio', { name: 'First angle' }).click()
  await app.ok()
  await app.ribbon('Projected').click()
  await click(app, fx, fy)
  await click(app, fx, box[3] + 30)
  await expect.poll(async () => (await sheet(app)).views.length).toBe(4)
  expect((await sheet(app)).views[3].orientation).toBe('bottom')
})

test('section view: cut line, arrows, letters and hatching', async ({ app, page }) => {
  await app.open()
  await plate(app)
  await drawing(app)
  await addBaseView(app, 'Top')
  const top = (await sheet(app)).views[0]
  const [cx, cy] = await viewCenter(app, top.id)
  const box = await viewBox(app, top.id)
  await app.ribbon('Section').click()
  await click(app, cx, cy)
  await expect(page.getByTestId('drawing-hint')).toContainText('start of the cut line')
  await click(app, box[0] - 8, cy)
  await hover(app, box[2] + 8, cy + 0.5)
  await click(app, box[2] + 8, cy + 0.5) // a nearly horizontal line snaps to horizontal
  await expect.poll(async () => (await sheet(app)).views.length).toBe(2)
  await geomReady(app)
  const sec = (await sheet(app)).views[1]
  expect(sec).toMatchObject({ kind: 'section', label: 'SECTION A-A', parentId: top.id })
  expect(sec.cut.a[1]).toBeCloseTo(sec.cut.b[1], 6)
  const prims = await primsOf(app)
  const mine = prims.filter((p) => p.owner === 'view:' + sec.id)
  expect(mine.filter((p) => p.style === 'hatch').length).toBeGreaterThan(8)
  expect(prims.filter((p) => p.k === 'text' && p.text === 'A' && p.owner === 'view:' + sec.id)).toHaveLength(2)
  expect(prims.some((p) => p.k === 'text' && p.text === 'SECTION A-A')).toBe(true)
  // the cut line chain on the parent
  expect(prims.some((p) => p.style === 'cut' && p.owner === 'view:' + sec.id)).toBe(true)
  await app.shot('drawing-section')
  // flip the cut direction from the view's properties
  const sid = (await sheet(app)).id
  await app.ev((c, a) => c.drawing.actions.updateView(a.s, a.v, { cut: { ...a.cut, flip: true } }), { s: sid, v: sec.id, cut: sec.cut })
  await geomReady(app)
  expect((await sheet(app)).views[1].cut.flip).toBe(true)
  const g = await app.ev((c, a) => c.drawing.geoms.getState().geoms[a.s + '/' + a.v].cut.length, { s: sid, v: sec.id })
  expect(g).toBe(2)
})

test('detail view: circle, larger scale, label', async ({ app, page }) => {
  await app.open()
  await plate(app)
  await drawing(app)
  await addBaseView(app, 'Top')
  const top = (await sheet(app)).views[0]
  const [cx, cy] = await viewCenter(app, top.id)
  await app.ribbon('Detail').click()
  await click(app, cx, cy)
  await click(app, cx, cy) // center of the detail circle
  await expect(page.getByTestId('drawing-hint')).toContainText('size of the circle')
  await click(app, cx + 14, cy)
  await expect.poll(async () => (await sheet(app)).views.length).toBe(2)
  await geomReady(app)
  const det = (await sheet(app)).views[1]
  expect(det).toMatchObject({ kind: 'detail', label: 'DETAIL A', parentId: top.id })
  expect(det.scale).toBeGreaterThan(top.scale)
  expect(det.detail.r).toBeCloseTo(14 / top.scale, 1)
  const prims = await primsOf(app)
  expect(prims.some((p) => p.k === 'text' && p.text === 'DETAIL A')).toBe(true)
  await app.shot('drawing-detail')
})

test('isometric view does not overlap the first view', async ({ app }) => {
  await app.open()
  await plate(app)
  await drawing(app)
  await addBaseView(app)
  await addBaseView(app, 'Isometric', { ribbon: 'Iso' })
  const s = await sheet(app)
  expect(s.views[1]).toMatchObject({ kind: 'iso', label: 'ISOMETRIC' })
  const a = await viewBox(app, s.views[0].id), b = await viewBox(app, s.views[1].id)
  const overlap = a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  expect(overlap).toBe(false)
  await app.shot('drawing-iso')
})
