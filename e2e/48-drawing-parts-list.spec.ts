import fs from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import type { Page } from '@playwright/test'
import { test, expect, type App } from './helpers'
import { plateAndBar } from './asm'
import { addBaseView, click, drawing, geomReady, primsOf, sheet } from './drawing-kit'

async function download(page: Page, run: () => Promise<void>) {
  const [dl] = await Promise.all([page.waitForEvent('download'), run()])
  return { name: dl.suggestedFilename(), bytes: new Uint8Array(fs.readFileSync((await dl.path())!)) }
}

const listTexts = async (app: App) => {
  const s = await sheet(app)
  const id = s.notes.find((n: { kind: string }) => n.kind === 'partsList').id
  return (await primsOf(app)).filter((p) => p.k === 'text' && p.owner === 'note:' + id).map((p) => p.text)
}

test('parts list of an assembly: rows, quantities, material, balloons, edits, save and export', async ({ app, page }) => {
  await app.open()
  await plateAndBar(app) // components Plate and Bar

  // material and description through the Browser: right-click the component
  const occOf = (name: string) => app.ev((c, n) => {
    const a = c.doc.getState().assembly
    const def = a.components.find((x: { name: string }) => x.name === n).id
    return a.occurrences.find((o: { component: string }) => o.component === def).id
  }, name) as Promise<string>
  const plateOcc = await occOf('Plate'), barOcc = await occOf('Bar')
  await page.getByTestId('comp-' + plateOcc).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Material and description/ }).click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Component info')
  await app.field('Material', 'Aluminium 6061')
  await app.field('Description', 'Base plate')
  await app.ok()
  const def1 = await app.ev((c, o) => c.doc.getState().assembly.occurrences.find((x: { id: string }) => x.id === o).component, plateOcc)
  expect(await app.ev((c, d) => c.doc.getState().assembly.components.find((x: { id: string }) => x.id === d), def1)).toMatchObject({ name: 'Plate', material: 'Aluminium 6061', description: 'Base plate' })

  // a drawing of the assembly with a parts list
  await drawing(app)
  await addBaseView(app)
  const views = (await sheet(app)).views
  expect(views[0].items.map((i: { occ: string }) => i.occ).sort()).toEqual([plateOcc, barOcc].sort())
  await app.ribbon('Parts List').click()
  await click(app, 40, 40)
  await expect.poll(async () => (await sheet(app)).notes.filter((n: { kind: string }) => n.kind === 'partsList').length).toBe(1)
  let t = await listTexts(app)
  for (const s of ['ITEM', 'QTY', 'PART NAME', 'MATERIAL', 'DESCRIPTION', 'Plate', 'Aluminium 6061', 'Base plate', 'Bar']) expect(t).toContain(s)
  expect(t.filter((x) => x === '1').length).toBe(3) // item 1, and the quantity of both parts
  expect(t.filter((x) => x === '2').length).toBe(1) // item 2
  await app.shot('drawing-parts-list-assembly')

  // a balloon for the Bar through the dialog: its number is the Bar's item number
  const b = await sheet(app)
  const barKey = 'def:' + (await app.ev((c, o) => c.doc.getState().assembly.occurrences.find((x: { id: string }) => x.id === o).component, barOcc))
  await app.ev((c, a) => c.drawing.actions.addNote(a.sid, { kind: 'balloon', pos: [150, 150], item: a.key, tip: [180, 130] }), { sid: b.id, key: barKey })
  const balloonText = async () => {
    const n = (await sheet(app)).notes.find((x: { kind: string }) => x.kind === 'balloon')
    return (await primsOf(app)).filter((p) => p.k === 'text' && p.owner === 'note:' + n.id).map((p) => p.text)
  }
  expect(await balloonText()).toEqual(['2'])

  // add an instance of the Bar: the quantity goes up with no sheet edit
  const extra = await app.ev((c, o) => c.assembly.actions.instanceOf(o, 20), barOcc) as string
  await app.idle()
  await expect.poll(async () => (await listTexts(app)).filter((x) => x === '2').length).toBe(2) // item 2 and quantity 2
  t = await listTexts(app)
  expect(t.filter((x) => x === 'Bar').length).toBe(1) // still one row
  await geomReady(app)

  // remove it again, and the part list is back to quantity 1
  await app.ev((c, o) => c.assembly.actions.deleteOccurrence(o), extra)
  await app.idle()
  await expect.poll(async () => (await listTexts(app)).filter((x) => x === '2').length).toBe(1) // back to quantity 1: only the item number
  expect(await balloonText()).toEqual(['2'])

  // save, forget everything, open: same table, same balloon
  const bytes: number[] = await app.ev(async (c) => Array.from(await c.serializeProject(false)))
  await app.ev((c) => c.doc.getState().newDocument())
  await app.ev((c) => c.drawing.store.getState().load(null))
  await app.ev(async (_c, b) => {
    const { loadProject } = await import('/src/io/project.ts')
    loadProject(new Uint8Array(b))
  }, bytes)
  await app.idle()
  await expect.poll(async () => (await app.ev((c) => c.drawing.store.getState().doc.sheets.length))).toBe(1)
  await geomReady(app)
  await expect.poll(async () => (await listTexts(app)).includes('Aluminium 6061')).toBe(true)
  t = await listTexts(app)
  for (const s of ['Plate', 'Bar', 'Base plate']) expect(t).toContain(s)
  expect(await balloonText()).toEqual(['2'])

  // deleting the plate renumbers: the Bar is item 1, in the table and in its balloon
  await app.ev((c, o) => c.assembly.actions.deleteOccurrence(o), plateOcc)
  await app.idle()
  await expect.poll(async () => (await listTexts(app)).includes('Plate')).toBe(false)
  expect(await balloonText()).toEqual(['1'])

  // exports carry the table
  const s = await sheet(app)
  await app.ev((c, id) => c.drawing.actions.updateSheet(id, { size: 'A3' }), s.id)
  const svg = await download(page, () => app.ribbon('SVG').click())
  expect(new TextDecoder().decode(svg.bytes)).toContain('PART NAME')
  const dxf = await download(page, () => app.ribbon('DXF').click())
  expect(new TextDecoder().decode(dxf.bytes)).toContain('DESCRIPTION')
  const pdf = await download(page, () => app.ribbon('PDF').click())
  expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(1)
  expect(new TextDecoder('latin1').decode(pdf.bytes)).toContain('/ToUnicode')
})

test('a drawing of a plain part keeps its parts list working', async ({ app }) => {
  await app.open()
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 20, depth: 20, height: 5, position: [0, 0, 0] }, 'Block'))
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 20, depth: 20, height: 5, position: [40, 0, 0] }, 'Block'))
  await app.idle()
  await drawing(app)
  await addBaseView(app)
  await app.ribbon('Parts List').click()
  await click(app, 40, 40)
  await expect.poll(async () => (await sheet(app)).notes.length).toBe(1)
  const t = await listTexts(app)
  expect(t).toContain('Block')
  expect(t).toContain('2')
})
