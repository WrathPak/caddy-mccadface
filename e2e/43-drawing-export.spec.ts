import fs from 'node:fs'
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import type { Page } from '@playwright/test'
import { test, expect, type App } from './helpers'
import { addBaseView, click, drawing, plate, sheet, viewBox, viewCenter } from './drawing-kit'

async function download(page: Page, run: () => Promise<void>) {
  const [dl] = await Promise.all([page.waitForEvent('download'), run()])
  return { name: dl.suggestedFilename(), bytes: new Uint8Array(fs.readFileSync((await dl.path())!)) }
}

/** front + top + a section, a dimension, a note and a title block, on an A3 sheet */
async function fullDrawing(app: App) {
  await app.open()
  await plate(app)
  await drawing(app)
  await addBaseView(app, 'Top')
  const top = (await sheet(app)).views[0]
  const [cx, cy] = await viewCenter(app, top.id)
  const box = await viewBox(app, top.id)
  // section through the hole
  await app.ribbon('Section').click()
  await click(app, cx, cy)
  await click(app, box[0] - 8, cy)
  await click(app, box[2] + 8, cy)
  await expect.poll(async () => (await sheet(app)).views.length).toBe(2)
  // a dimension
  await app.ribbon('Linear').click()
  await click(app, box[0], box[1])
  await click(app, box[2], box[1])
  await click(app, cx, box[1] - 14)
  await expect.poll(async () => (await sheet(app)).dims.length).toBe(1)
  await app.page.keyboard.press('Escape')
  // title block text
  const s = await sheet(app)
  await app.ev((c, a) => c.drawing.actions.updateSheet(a.id, { titleBlock: { ...a.tb, title: 'Mounting plate', company: 'Weeb Machining', number: 'WM-0042', material: 'Aluminium 6061' } }), { id: s.id, tb: s.titleBlock })
  await app.page.waitForTimeout(300)
}

test('PDF: vector paths, real text in an embedded font, no images, one page per sheet', async ({ app, page }) => {
  await fullDrawing(app)
  await app.ribbon('New Sheet').click()
  await expect.poll(async () => (await app.ev((c) => c.drawing.store.getState().doc.sheets.length))).toBe(2)
  await app.ev((c) => c.drawing.actions.updateSheet(c.drawing.store.getState().doc.sheets[1].id, { size: 'A4', portrait: true }))
  const { name, bytes } = await download(page, () => app.ribbon('PDF').click())
  expect(name).toMatch(/\.pdf$/)
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  fs.mkdirSync('e2e/screenshots', { recursive: true })
  fs.writeFileSync('e2e/screenshots/drawing-export.pdf', bytes)
  const pdf = await PDFDocument.load(bytes)
  expect(pdf.getPageCount()).toBe(2)
  // page sizes follow the sheets: A3 landscape and A4 portrait
  const [p1, p2] = [pdf.getPage(0), pdf.getPage(1)]
  expect(p1.getWidth()).toBeCloseTo((420 * 72) / 25.4, 1)
  expect(p1.getHeight()).toBeCloseTo((297 * 72) / 25.4, 1)
  expect(p2.getWidth()).toBeCloseTo((210 * 72) / 25.4, 1)
  expect(p2.getHeight()).toBeCloseTo((297 * 72) / 25.4, 1)
  // the first page's content stream
  const ctx = pdf.context
  const contents = ctx.lookup(p1.node.get(PDFName.of('Contents')) as never)
  const streams: PDFRawStream[] = []
  if (contents instanceof PDFRawStream) streams.push(contents)
  else for (const r of (contents as unknown as { asArray(): unknown[] }).asArray()) { const st = ctx.lookup(r as never); if (st instanceof PDFRawStream) streams.push(st) }
  const content = streams.map((s) => new TextDecoder('latin1').decode(decodePDFRawStream(s).decode())).join('\n')
  const count = (re: RegExp) => (content.match(re) ?? []).length
  expect(count(/ m\n/g)).toBeGreaterThan(50)
  expect(count(/ l\n/g)).toBeGreaterThan(100)
  expect(count(/\nS\n/g)).toBeGreaterThan(40)
  expect(count(/\nf\n/g)).toBeGreaterThanOrEqual(2)
  expect(content).toMatch(/\[[\d. ]+\] 0 d/) // hidden / center line dashes
  expect(count(/ Tj\n/g)).toBeGreaterThan(20)
  // fonts are embedded and subset, there is no raster image
  const raw = new TextDecoder('latin1').decode(bytes)
  expect(raw).toContain('/FontFile2')
  expect(raw).toContain('/ToUnicode')
  expect(raw).not.toContain('/Subtype /Image')
  expect(bytes.length).toBeLessThan(400_000)
})

test('SVG and DXF of the active sheet', async ({ app, page }) => {
  await fullDrawing(app)
  const svg = await download(page, () => app.ribbon('SVG').click())
  expect(svg.name).toMatch(/\.svg$/)
  const s = new TextDecoder().decode(svg.bytes)
  expect(s).toContain('viewBox="0 0 420 297"')
  expect((s.match(/<path /g) ?? []).length).toBeGreaterThan(30)
  expect(s).toContain('Mounting plate')
  expect(s).toContain('WM-0042')
  expect(s).toContain('>40.00<')
  expect(s).toContain('SECTION A-A')
  expect(s).toContain('stroke-dasharray')
  const dxf = await download(page, () => app.ribbon('DXF').click())
  expect(dxf.name).toMatch(/\.dxf$/)
  const d = new TextDecoder().decode(dxf.bytes)
  expect(d.startsWith('0\r\nSECTION')).toBe(true)
  for (const layer of ['VISIBLE', 'HIDDEN', 'CENTER', 'DIMENSION', 'HATCH', 'BORDER', 'CUTLINE']) expect(d).toContain(layer)
  expect((d.match(/\r\nPOLYLINE\r\n/g) ?? []).length).toBeGreaterThan(30)
  expect(d).toContain('Mounting plate')
  expect(d.trimEnd().endsWith('EOF')).toBe(true)
})

test('exporting with no sheets says so instead of failing silently', async ({ app, page }) => {
  await app.open()
  await plate(app)
  await drawing(app)
  await app.ribbon('PDF').click()
  await expect(page.getByText('The drawing has no sheets yet')).toBeVisible()
})
