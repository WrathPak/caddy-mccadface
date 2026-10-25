/** Rendering the whole drawing to files: PDF (all sheets), DXF and SVG (one sheet). */
import { useDoc } from '@/doc/store'
import { downloadFile } from '@/io/files'
import { listComponents } from './components'
import { sheetToDxf } from './export/dxf'
import { sheetsToPdf } from './export/pdf'
import { sheetToSvg } from './export/svg'
import { sheetDims } from './sheets'
import { buildSheet, type SheetOutput } from './sheetprims'
import { activeSheet, useDrawing } from './store'
import type { Sheet } from './types'
import { refreshGeoms, useViewGeoms } from './views'

/** Primitives of a sheet from the live document (geometry is brought up to date first). */
export async function sheetOutput(sheet: Sheet): Promise<SheetOutput> {
  await refreshGeoms([sheet])
  return buildSheet({ doc: useDrawing.getState().doc, sheet, bodies: useDoc.getState().geometry, geoms: useViewGeoms.getState().geoms, parts: listComponents() })
}

const baseName = () => (useDoc.getState().name || 'drawing').replace(/[^\w\- ]+/g, '').trim() || 'drawing'
const fileFor = (sheet: Sheet, ext: string) => `${baseName()}-${sheet.name.replace(/[^\w\- ]+/g, '').trim() || 'sheet'}.${ext}`

export async function pdfBytes(): Promise<Uint8Array> {
  const doc = useDrawing.getState().doc
  if (!doc.sheets.length) throw new Error('The drawing has no sheets yet')
  const pages = []
  for (const sheet of doc.sheets) {
    const { w, h } = sheetDims(sheet)
    pages.push({ prims: (await sheetOutput(sheet)).prims, w, h, title: sheet.name })
  }
  return sheetsToPdf(pages, baseName())
}

export async function svgText(sheet: Sheet): Promise<string> {
  const { w, h } = sheetDims(sheet)
  return sheetToSvg((await sheetOutput(sheet)).prims, w, h, sheet.titleBlock.title || sheet.name)
}

export async function dxfText(sheet: Sheet): Promise<string> {
  const { w, h } = sheetDims(sheet)
  return sheetToDxf((await sheetOutput(sheet)).prims, w, h)
}

export async function exportPdf() {
  downloadFile(`${baseName()}.pdf`, await pdfBytes(), 'application/pdf')
}
export async function exportSvg() {
  const s = activeSheet()
  if (!s) throw new Error('The drawing has no sheets yet')
  downloadFile(fileFor(s, 'svg'), new TextEncoder().encode(await svgText(s)), 'image/svg+xml')
}
export async function exportDxf() {
  const s = activeSheet()
  if (!s) throw new Error('The drawing has no sheets yet')
  downloadFile(fileFor(s, 'dxf'), new TextEncoder().encode(await dxfText(s)), 'application/dxf')
}
