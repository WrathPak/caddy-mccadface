import { test, expect, type App } from './helpers'
import { addBaseView, click, drawing, plate, primsOf, sheet, tool, viewBox, zoomTo } from './drawing-kit'

const notes = async (app: App) => (await sheet(app)).notes as { id: string; kind: string; [k: string]: any }[] // eslint-disable-line
const texts = async (app: App) => (await primsOf(app)).filter((p) => p.k === 'text').map((p) => p.text)

async function ready(app: App) {
  await app.open()
  await plate(app)
  await drawing(app)
  await addBaseView(app)
  const v = (await sheet(app)).views[0]
  return { v, box: await viewBox(app, v.id) }
}

async function fillText(app: App, key: string, value: string) {
  const el = app.page.getByTestId('text-' + key)
  await el.click()
  await el.fill(value)
  await el.blur()
}

test('note: place it, type the text, edit it, cancel removes a new one', async ({ app, page }) => {
  const { box } = await ready(app)
  await app.ribbon('Note').click()
  await expect.poll(() => tool(app)).toBe('ann.note')
  await click(app, box[0], box[3] + 25)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Note')
  await expect.poll(async () => (await notes(app)).length).toBe(1) // shown while the dialog is open
  await fillText(app, 'text', 'BREAK ALL EDGES\n0.5 MAX')
  await app.ok()
  const t = await texts(app)
  expect(t).toContain('BREAK ALL EDGES')
  expect(t).toContain('0.5 MAX')
  expect((await notes(app))[0]).toMatchObject({ kind: 'note', text: 'BREAK ALL EDGES\n0.5 MAX' })
  // a second note, cancelled: it is gone again
  await app.ribbon('Note').click()
  await click(app, box[0], box[3] + 45)
  await expect.poll(async () => (await notes(app)).length).toBe(2)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect.poll(async () => (await notes(app)).length).toBe(1)
  // one undo removes the note, and a redo brings it back
  await app.ev((c) => c.drawing.store.getState().undo())
  expect(await notes(app)).toHaveLength(0)
  await app.ev((c) => c.drawing.store.getState().redo())
  expect(await notes(app)).toHaveLength(1)
})

test('leader, GD&T frame, datum and surface finish', async ({ app, page }) => {
  const { box } = await ready(app)
  // leader
  await app.ribbon('Leader').click()
  await click(app, box[2], (box[1] + box[3]) / 2)
  await expect(page.getByTestId('drawing-hint')).toContainText('text goes')
  await click(app, box[2] + 30, box[3] + 20)
  await fillText(app, 'text', 'M4 TAP')
  await app.ok()
  // GD&T: position, diameter zone, 0.2 at MMC, datums A and B
  await app.ribbon('GD&T').click()
  await click(app, box[0], box[1])
  await click(app, box[0] - 20, box[1] - 30)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Tolerance frame')
  await app.inspector().getByRole('checkbox', { name: 'Diameter zone' }).click()
  await app.field('Tolerance', '0.2')
  await app.inspector().getByRole('radio', { name: 'M', exact: true }).click()
  await app.field('Primary', 'A')
  await app.field('Secondary', 'B')
  await app.ok()
  // datum feature symbol
  await app.ribbon('Datum').click()
  await click(app, box[0], (box[1] + box[3]) / 2)
  await click(app, box[0] - 25, (box[1] + box[3]) / 2 + 12)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Datum')
  await app.ok()
  // surface finish
  await app.ribbon('Surface Finish').click()
  await click(app, box[2] - 10, box[3])
  await expect(app.inspector().locator('.panel-title')).toHaveText('Surface finish')
  await app.field('Roughness Ra', '1.6')
  await app.ok()
  const ns = await notes(app)
  expect(ns.map((n) => n.kind)).toEqual(['leader', 'gdt', 'datum', 'finish'])
  expect(ns[1]).toMatchObject({ symbol: 'position', tol: '0.2', modifier: 'M', diameter: true, datums: ['A', 'B'] })
  expect(ns[2]).toMatchObject({ letter: 'A' })
  expect(ns[3]).toMatchObject({ ra: '1.6', method: 'removal' })
  const t = await texts(app)
  for (const s of ['M4 TAP', 'Ø0.2', 'A', 'B', 'M', 'Ra 1.6']) expect(t).toContain(s)
  await zoomTo(app, box[0] - 60, box[1] - 45, box[2] + 60, box[3] + 40)
  await app.shot('drawing-annotations')
  // the frame is a drawn glyph: the position symbol is circle + cross
  const frame = (await primsOf(app)).filter((p) => p.owner === 'note:' + ns[1].id && p.k === 'path')
  expect(frame.length).toBeGreaterThan(8)
})

test('balloon and parts list list the parts of the model', async ({ app, page }) => {
  const { box } = await ready(app)
  // a second part: a box beside the plate
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 10, depth: 10, height: 10, position: [40, 0, 0] }))
  await app.idle()
  await app.ribbon('Parts List').click()
  await click(app, 40, 40)
  await expect.poll(async () => (await notes(app)).filter((n) => n.kind === 'partsList').length).toBe(1)
  let t = await texts(app)
  for (const s of ['ITEM', 'QTY', 'PART NAME', 'Extrude1', 'Box1']) expect(t).toContain(s)
  // a balloon on the front view
  await app.ribbon('Balloon').click()
  await click(app, box[0] + 6, (box[1] + box[3]) / 2)
  await click(app, box[0] - 20, box[3] + 30)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Balloon')
  await app.ok()
  const b = (await notes(app)).find((n) => n.kind === 'balloon')!
  expect(b).toBeTruthy()
  t = await texts(app)
  expect(t.filter((x) => x === '1').length).toBeGreaterThanOrEqual(2) // item 1 in the list and in the balloon
  await app.shot('drawing-parts-list')
  await page.keyboard.press('Escape')
})
