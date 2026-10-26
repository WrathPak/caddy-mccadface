import { test, expect, sketchParam, XY, type App } from './helpers'
import { addBaseView, click, drawing, geomReady, hover, plate, primsOf, sheet, tool, viewBox, viewCenter, zoomView } from './drawing-kit'

const dims = async (app: App) => (await sheet(app)).dims as { id: string; type: string; axis: string; offset: number; text: string; pts: unknown[]; precision: number }[]
const values = (app: App) => app.ev(async (c) => (await c.drawing.sheetOutput(c.drawing.store.getState().doc.sheets[0])).values as Record<string, number>)
const texts = async (app: App) => (await primsOf(app)).filter((p) => p.k === 'text').map((p) => p.text)

/** a front view of the plate, with its box on the sheet */
async function frontView(app: App) {
  await app.open()
  await plate(app)
  await drawing(app)
  await addBaseView(app)
  const v = (await sheet(app)).views[0]
  return { v, box: await viewBox(app, v.id), c: await viewCenter(app, v.id) }
}

test('linear dimension: pick two corners, place it, value and text', async ({ app, page }) => {
  const { box } = await frontView(app)
  await app.ribbon('Linear').click()
  await expect.poll(() => tool(app)).toBe('dim.linear')
  await expect(page.getByTestId('drawing-hint')).toContainText('first point')
  await hover(app, box[0], box[1])
  await expect(page.getByTestId('drawing-snap')).toBeVisible() // the corner is highlighted
  await click(app, box[0], box[1])
  await expect(page.getByTestId('drawing-hint')).toContainText('second point')
  await click(app, box[2], box[1])
  await expect(page.getByTestId('drawing-hint')).toContainText('place')
  await click(app, (box[0] + box[2]) / 2, box[1] - 14) // below the part: a horizontal dimension, offset negative
  await expect.poll(async () => (await dims(app)).length).toBe(1)
  const d = (await dims(app))[0]
  expect(d).toMatchObject({ type: 'linear', axis: 'h' })
  expect(d.offset).toBeCloseTo(-14, 0)
  expect(Object.values(await values(app))[0]).toBeCloseTo(40, 6)
  expect(await texts(app)).toContain('40.00')
  // the tool stays active for the next dimension
  expect(await tool(app)).toBe('dim.linear')
  // a vertical one on the right side
  await click(app, box[2], box[1])
  await click(app, box[2], box[3])
  await click(app, box[2] + 12, (box[1] + box[3]) / 2)
  await expect.poll(async () => (await dims(app)).length).toBe(2)
  expect((await dims(app))[1]).toMatchObject({ axis: 'v' })
  expect(await texts(app)).toContain('10.00')
  await zoomView(app, (await sheet(app)).views[0].id)
  await app.shot('drawing-dim-linear')
})

test('the dimension follows the model when it is edited', async ({ app, page }) => {
  const { box } = await frontView(app)
  await app.ribbon('Linear').click()
  await click(app, box[0], box[1])
  await click(app, box[2], box[1])
  await click(app, (box[0] + box[2]) / 2, box[1] - 14)
  await expect.poll(async () => (await dims(app)).length).toBe(1)
  expect(await texts(app)).toContain('40.00')
  // widen the plate: edit the sketch (a different rectangle, same circle)
  const sk = (await app.features()).find((f) => f.type === 'sketch')!
  await app.ev((c, a) => c.doc.getState().updateFeature(a.id, { sketch: a.sketch }), {
    id: sk.id,
    sketch: sketchParam(XY, [{ k: 'rect', x0: -30, y0: -15, x1: 30, y1: 15 }, { k: 'circle', c: [0, 0], r: 4 }]),
  })
  await app.idle()
  await geomReady(app)
  await expect.poll(async () => (await texts(app)).includes('60.00')).toBe(true)
  expect(await texts(app)).not.toContain('40.00')
  expect(Object.values(await values(app))[0]).toBeCloseTo(60, 6)
  await expect(page.getByTestId('drawing-broken')).toBeHidden()
  await zoomView(app, (await sheet(app)).views[0].id)
  await app.shot('drawing-dim-updated')
  // undo the model edit: back to 40
  await app.ev((c) => c.doc.getState().undo())
  await app.idle()
  await geomReady(app)
  await expect.poll(async () => (await texts(app)).includes('40.00')).toBe(true)
})

test('a dimension whose geometry was deleted is flagged', async ({ app, page }) => {
  const { box } = await frontView(app)
  await app.ribbon('Linear').click()
  await click(app, box[0], box[1])
  await click(app, box[2], box[1])
  await click(app, (box[0] + box[2]) / 2, box[1] - 14)
  await expect.poll(async () => (await dims(app)).length).toBe(1)
  await app.ev((c) => c.doc.getState().removeFeature(c.doc.getState().features[c.doc.getState().features.length - 1].id))
  await app.idle()
  await expect(page.getByTestId('drawing-broken')).toBeVisible()
  await expect(page.getByTestId('drawing-broken')).toContainText('lost a point')
})

test('radius and diameter of the hole, from the top view', async ({ app, page }) => {
  await app.open()
  await plate(app)
  await drawing(app)
  await addBaseView(app, 'Top')
  const v = (await sheet(app)).views[0]
  const [cx, cy] = await viewCenter(app, v.id)
  const r = 4 * v.scale
  await app.ribbon('Diameter').click()
  await expect.poll(() => tool(app)).toBe('dim.diameter')
  await hover(app, cx + r, cy)
  await expect(page.getByTestId('drawing-snap')).toBeVisible()
  await click(app, cx + r, cy)
  await click(app, cx + r + 20, cy + 14)
  await expect.poll(async () => (await dims(app)).length).toBe(1)
  await app.ribbon('Radius').click()
  await click(app, cx, cy + r)
  await click(app, cx - 18, cy + 18)
  await expect.poll(async () => (await dims(app)).length).toBe(2)
  const t = await texts(app)
  expect(t).toContain('Ø8.00')
  expect(t).toContain('R4.00')
  const v2 = await values(app)
  expect(Object.values(v2).map((x) => +x.toFixed(3)).sort()).toEqual([4, 8])
  await zoomView(app, v.id, 40)
  await app.shot('drawing-dim-circle')
})

test('aligned, angular, ordinate and baseline dimensions', async ({ app }) => {
  const { box } = await frontView(app)
  const [x0, y0, x1, y1] = box
  // aligned: diagonal of the front view
  await app.ribbon('Aligned').click()
  await click(app, x0, y0)
  await click(app, x1, y1)
  await click(app, (x0 + x1) / 2 - 10, (y0 + y1) / 2 + 22)
  await expect.poll(async () => (await dims(app)).length).toBe(1)
  // angular: the lower left corner and its two neighbours
  await app.ribbon('Angular').click()
  await click(app, x0, y0)
  await click(app, x1, y0)
  await click(app, x0, y1)
  await click(app, x0 + 14, y0 + 8)
  await expect.poll(async () => (await dims(app)).length).toBe(2)
  // ordinate from the lower left corner to the right corner
  await app.ribbon('Ordinate').click()
  await click(app, x0, y0)
  await click(app, x1, y0)
  await click(app, x1, y0 - 12)
  await expect.poll(async () => (await dims(app)).length).toBe(3)
  // baseline: base corner, then the top right and the bottom right corner, Enter, place
  await app.ribbon('Baseline').click()
  await click(app, x0, y0)
  await click(app, x1, y1)
  await click(app, x1, y0)
  await app.page.keyboard.press('Enter')
  await click(app, (x0 + x1) / 2, y1 + 14)
  await expect.poll(async () => (await dims(app)).length).toBe(4)
  const ds = await dims(app)
  expect(ds.map((d) => d.type)).toEqual(['aligned', 'angular', 'ordinate', 'baseline'])
  const v = await values(app)
  expect(v[ds[0].id]).toBeCloseTo(Math.hypot(40, 10), 6)
  expect(v[ds[1].id]).toBeCloseTo(90, 6)
  expect(v[ds[2].id]).toBeCloseTo(40, 6)
  expect(ds[3].pts).toHaveLength(3)
  const t = await texts(app)
  expect(t).toContain('90.00°')
  expect(t).toContain('41.23')
  await zoomView(app, (await sheet(app)).views[0].id, 40)
  await app.shot('drawing-dims-all')
})

test('edit a dimension: text, decimals, tolerance; drag it; delete it; undo', async ({ app, page }) => {
  const { box } = await frontView(app)
  await app.ribbon('Linear').click()
  await click(app, box[0], box[1])
  await click(app, box[2], box[1])
  await click(app, (box[0] + box[2]) / 2, box[1] - 14)
  await expect.poll(async () => (await dims(app)).length).toBe(1)
  await page.keyboard.press('Escape') // leave the tool
  await expect.poll(() => tool(app)).toBeNull()
  // double-click the dimension line: the dialog
  const lineY = box[1] - 14
  await click(app, (box[0] + box[2]) / 2 - 20, lineY)
  const p = await (async () => { const { px } = await import('./drawing-kit'); return px(app, (box[0] + box[2]) / 2 - 20, lineY) })()
  await page.mouse.dblclick(p.x, p.y)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Dimension')
  await app.field('Text', '<> typ.')
  await app.field('Decimals', '1')
  await app.inspector().getByText('Tolerance').click()
  await app.field('Upper', '+0.1')
  await app.field('Lower', '-0.0')
  await expect.poll(async () => (await texts(app)).includes('40.0 typ.')).toBe(true) // live
  await app.ok()
  const t = await texts(app)
  expect(t).toContain('40.0 typ.')
  expect(t).toContain('+0.1')
  expect(t).toContain('-0.0')
  // cancel puts it back
  await page.mouse.dblclick(p.x, p.y)
  await app.field('Text', 'NOPE')
  await expect.poll(async () => (await texts(app)).includes('NOPE')).toBe(true)
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  expect(await texts(app)).not.toContain('NOPE')
  expect(await texts(app)).toContain('40.0 typ.')
  // drag the dimension line further from the part
  const before = (await dims(app))[0].offset
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x, p.y + 40, { steps: 4 })
  await page.mouse.up()
  const after = (await dims(app))[0].offset
  expect(after).toBeLessThan(before - 5)
  // one undo step for the whole drag, then the dialog edit, then delete with the key and undo that
  await app.ev((c) => c.drawing.store.getState().undo())
  expect((await dims(app))[0].offset).toBeCloseTo(before, 6)
  await click(app, (box[0] + box[2]) / 2 - 20, lineY)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await dims(app)).length).toBe(0)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await dims(app)).length).toBe(1)
  // the body was not deleted by the Delete key
  expect(await app.bodies()).toHaveLength(1)
})
