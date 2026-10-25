/**
 * Vector PDF of the sheets: every line is a path in the page's content stream (moveto / lineto / stroke), every piece of
 * text is real text in an embedded, subsetted font. Nothing is rasterised.
 */
import fontkit from '@pdf-lib/fontkit'
import {
  PDFDocument, PDFFont, PDFPage, closePath, fill as fillOp, grayscale, lineTo, moveTo, popGraphicsState, pushGraphicsState, rgb, setDashPattern, setLineCap,
  setLineJoin, setLineWidth, setStrokingColor, setFillingColor, stroke, degrees, LineCapStyle, LineJoinStyle,
} from 'pdf-lib'
import interRegular from '@fontsource/inter/files/inter-latin-400-normal.woff?url'
import interBold from '@fontsource/inter/files/inter-latin-700-normal.woff?url'
import { LINE_STYLES } from '../styles'
import type { Prim } from '../types'

const PT = 72 / 25.4

async function load(url: string): Promise<Uint8Array> {
  if (typeof window === 'undefined') {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises')
    return new Uint8Array(await fs.readFile(url))
  }
  const r = await fetch(url)
  if (!r.ok) throw new Error('Could not load the PDF font')
  return new Uint8Array(await r.arrayBuffer())
}

export interface PdfPage { prims: Prim[]; w: number; h: number; title: string }

/** Build a PDF (one page per sheet, page size = sheet size). */
export async function sheetsToPdf(pages: PdfPage[], title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle(title)
  doc.setProducer('CADdy McCADFace')
  doc.setCreator('CADdy McCADFace')
  const regular = await doc.embedFont(await load(interRegular), { subset: true })
  const bold = await doc.embedFont(await load(interBold), { subset: true })
  for (const pg of pages) drawPage(doc.addPage([pg.w * PT, pg.h * PT]), pg, regular, bold)
  return doc.save({ useObjectStreams: false })
}

function drawPage(page: PDFPage, pg: PdfPage, regular: PDFFont, bold: PDFFont) {
  const ops: ReturnType<typeof moveTo>[] = []
  for (const p of pg.prims) {
    if (p.k !== 'path' || p.pick || p.pts.length < 4) continue
    const spec = LINE_STYLES[p.style]
    ops.push(pushGraphicsState())
    ops.push(setLineWidth(spec.width * PT), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round))
    ops.push(setStrokingColor(grayscale(0)), setFillingColor(grayscale(0)))
    ops.push(setDashPattern(spec.dash.map((d) => d * PT), 0))
    ops.push(moveTo(p.pts[0] * PT, p.pts[1] * PT))
    for (let i = 2; i < p.pts.length; i += 2) ops.push(lineTo(p.pts[i] * PT, p.pts[i + 1] * PT))
    if (p.closed) ops.push(closePath())
    ops.push(p.fill === 'solid' ? fillOp() : stroke())
    ops.push(popGraphicsState())
  }
  page.pushOperators(...ops)
  for (const p of pg.prims) {
    if (p.k !== 'text' || !p.text) continue
    const font = p.bold ? bold : regular
    const size = p.size * PT
    const wd = font.widthOfTextAtSize(p.text, size)
    const shift = p.anchor === 'middle' ? wd / 2 : p.anchor === 'end' ? wd : 0
    const th = ((p.rot ?? 0) * Math.PI) / 180
    const x = p.x * PT - Math.cos(th) * shift, y = p.y * PT - Math.sin(th) * shift
    page.drawText(p.text, { x, y, size, font, color: rgb(0, 0, 0), rotate: degrees(p.rot ?? 0) })
  }
}
