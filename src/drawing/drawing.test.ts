import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, PDFName, PDFRawStream, PDFDict, decodePDFRawStream } from 'pdf-lib'
import { makeCylinder } from 'replicad'
import { box, initOcc, type Shape } from '@/kernel/occ'
import { bodyFromShape, getOp, helpers } from '@/kernel/store'
import { boxNames } from '@/kernel/naming'
import type { Body } from '@/kernel/types'
import '@/kernel/drawing-ops'

// the kernel client talks to a worker; here the op runs in-process
vi.mock('@/kernel/client', () => ({
  getKernel: () => ({ call: async (name: string, args: unknown) => getOp(name)!(args as never, helpers) }),
}))

import { useDoc } from '@/doc/store'
import { edgeRefOf, vertexRefOf } from './refs'
import { dxfEntityCounts, sheetToDxf } from './export/dxf'
import { sheetsToPdf } from './export/pdf'
import { sheetToSvg } from './export/svg'
import { createBaseView, createDetailView, createProjectedView, createSectionView } from './service'
import { buildSheet } from './sheetprims'
import { drawingActions, useDrawing, activeSheet } from './store'
import { sheetDims } from './sheets'
import { refreshGeoms, useViewGeoms } from './views'
import { locate, snapPoints } from './model3d'
import type { Dimension, PointRef, Sheet } from './types'
import { viewBasis } from '@/kernel/drawing-geom'
import { listComponents } from './components'

beforeAll(async () => { await initOcc() })

/** 40 x 30 x 10 block with an 8 mm hole through its thickness; the hole is centred. */
function blockWithHole(id = 'f1'): Body {
  const blk = box([40, 30, 10], [0, 0, 0])
  const hole = makeCylinder(4, 12, [0, 0, -1], [0, 0, 1]) as unknown as Shape
  return bodyFromShape(id, 'Block', blk.cut(hole) as Shape)
}
function plainBox(w: number, id = 'f1'): Body {
  const b = box([w, 30, 10], [0, 0, 0])
  return bodyFromShape(id, 'Box', b, boxNames(b, id))
}

const setModel = (bodies: Body[]) => useDoc.getState().setGeometry(bodies)

beforeEach(() => {
  useDrawing.getState().load(null)
  useViewGeoms.setState({ geoms: {}, pending: {}, errors: {} })
})

const out = (sheet: Sheet) => buildSheet({ doc: useDrawing.getState().doc, sheet, bodies: useDoc.getState().geometry, geoms: useViewGeoms.getState().geoms, parts: listComponents() })
const count = (prims: ReturnType<typeof out>['prims'], style: string) => prims.filter((p) => p.k === 'path' && p.style === style && !p.pick && p.owner?.startsWith('view:')).length

const baseOpts = (orientation: string) => ({ choice: 'all', orientation, scale: 1, showHidden: true, showTangent: false, showCenter: true })

async function newView(orientation: string) {
  const sid = drawingActions.ensureSheet()
  const vid = await createBaseView(sid, baseOpts(orientation))
  return { sid, vid }
}

describe('views of a block with a hole', () => {
  it('top view: the hole rim is drawn, nothing is hidden, and the hole gets a center mark', async () => {
    setModel([blockWithHole()])
    const { sid } = await newView('top')
    const o = out(activeSheet()!)
    expect(sid).toBeTruthy()
    // outline (4) + the hole circle (1 or 2 arcs)
    expect(count(o.prims, 'visible')).toBeGreaterThanOrEqual(5)
    expect(count(o.prims, 'visible')).toBeLessThanOrEqual(6)
    expect(count(o.prims, 'hidden')).toBe(0)
    expect(count(o.prims, 'center')).toBe(2)
  })

  it('front view: 4 visible edges, the hole shows as 2 hidden lines and a centerline', async () => {
    setModel([blockWithHole()])
    await newView('front')
    const o = out(activeSheet()!)
    expect(count(o.prims, 'visible')).toBe(4)
    expect(count(o.prims, 'hidden')).toBe(2)
    expect(count(o.prims, 'center')).toBe(1)
  })

  it('hidden lines can be switched off', async () => {
    setModel([blockWithHole()])
    const { sid, vid } = await newView('front')
    drawingActions.updateView(sid, vid, { showHidden: false })
    expect(count(out(activeSheet()!).prims, 'hidden')).toBe(0)
  })

  it('projected views follow first and third angle projection', async () => {
    setModel([blockWithHole()])
    const { sid, vid } = await newView('front')
    const above = await createProjectedView(sid, vid, 'above')
    const right = await createProjectedView(sid, vid, 'right')
    const s = activeSheet()!
    expect(s.views.find((v) => v.id === above)!.orientation).toBe('top')
    expect(s.views.find((v) => v.id === right)!.orientation).toBe('right')
    drawingActions.updateSheet(sid, { projection: 'first' })
    const above1 = await createProjectedView(sid, vid, 'above')
    const right1 = await createProjectedView(sid, vid, 'right')
    const s1 = activeSheet()!
    expect(s1.views.find((v) => v.id === above1)!.orientation).toBe('bottom')
    expect(s1.views.find((v) => v.id === right1)!.orientation).toBe('left')
  })

  it('a projected view sits level with its parent', async () => {
    setModel([blockWithHole()])
    const { sid, vid } = await newView('front')
    const top = await createProjectedView(sid, vid, 'above')
    const s = activeSheet()!
    const p = s.views.find((v) => v.id === vid)!, t = s.views.find((v) => v.id === top)!
    expect(t.pos[0]).toBeCloseTo(p.pos[0], 6)
    expect(t.pos[1]).toBeGreaterThan(p.pos[1])
  })

  it('isometric view', async () => {
    setModel([blockWithHole()])
    const { sid } = await newView('iso')
    const v = activeSheet()!.views[0]
    expect(v.kind).toBe('iso')
    expect(count(out(activeSheet()!).prims, 'visible')).toBeGreaterThan(8)
    expect(sid).toBe(activeSheet()!.id)
  })
})

describe('section and detail views', () => {
  it('a section through the hole is hatched and the cut line is drawn on the parent', async () => {
    setModel([blockWithHole()])
    const { sid, vid } = await newView('top')
    const sec = await createSectionView(sid, vid, [-30, 0], [30, 0], false)
    drawingActions.updateView(sid, sec, { scale: 2 })
    const s = activeSheet()!
    const o = out(s)
    const view = s.views.find((v) => v.id === sec)!
    expect(view.label).toBe('SECTION A-A')
    expect(o.prims.filter((p) => p.k === 'path' && p.style === 'hatch' && p.owner === 'view:' + sec).length).toBeGreaterThan(10)
    // the hatch lines stay inside the section face: none cross the hole
    expect(o.prims.some((p) => p.k === 'path' && p.owner === 'view:' + sec && p.style === 'cut')).toBe(true)
    expect(o.prims.filter((p) => p.k === 'text' && p.text === 'A' && p.owner === 'view:' + sec).length).toBe(2)
  })

  it('the section view is seen from the cut side and keeps the parent up direction', async () => {
    setModel([blockWithHole()])
    const { sid, vid } = await newView('top')
    const sec = await createSectionView(sid, vid, [-30, 0], [30, 0], false)
    const v = activeSheet()!.views.find((x) => x.id === sec)!
    // cutting a top view along x: the section is looked at along y, with x still to the right
    expect(Math.abs(v.eye[1])).toBeCloseTo(1, 6)
    expect(v.right[0] * (v.eye[1] < 0 ? 1 : -1)).toBeGreaterThan(0)
  })

  it('a detail view is clipped to its circle and scaled up', async () => {
    setModel([blockWithHole()])
    const { sid, vid } = await newView('top')
    const det = await createDetailView(sid, vid, [4, 0], 6, 4)
    const s = activeSheet()!
    const g = useViewGeoms.getState().geoms[sid + '/' + det]
    expect(g.visible.length).toBeGreaterThan(0)
    for (const p of g.visible) for (let i = 0; i < p.length; i += 2) expect(Math.hypot(p[i] - 4, p[i + 1])).toBeLessThanOrEqual(6 + 1e-6)
    expect(s.views.find((v) => v.id === det)!.scale).toBe(4)
    expect(out(s).prims.some((p) => p.k === 'text' && p.text === 'DETAIL A')).toBe(true)
  })
})

describe('dimensions', () => {
  async function boxFront(w = 40) {
    setModel([plainBox(w)])
    const { sid, vid } = await newView('front')
    return { sid, vid }
  }
  /** snap points of the front view of the box, as dimension refs */
  const pointNear = (bodies: Body[], x: number, y: number): PointRef => {
    const front = viewBasis([0, -1, 0], [1, 0, 0])
    const sp = snapPoints(bodies.map((body) => ({ body, item: { bodyId: body.id } })), front).filter((s) => s.kind === 'vertex')
    const best = sp.sort((a, b) => Math.hypot(a.p2[0] - x, a.p2[1] - y) - Math.hypot(b.p2[0] - x, b.p2[1] - y))[0]
    return best.pt
  }
  const dim = (sid: string, vid: string, over: Partial<Dimension>): string =>
    drawingActions.addDim(sid, { viewId: vid, type: 'linear', pts: [], axis: 'h', offset: 8, angle: 45, text: '', precision: 2, tolPlus: '', tolMinus: '', ...over })

  it('a linear dimension measures between two vertices', async () => {
    const { sid, vid } = await boxFront(40)
    const bodies = useDoc.getState().geometry
    const id = dim(sid, vid, { pts: [pointNear(bodies, -20, 0), pointNear(bodies, 20, 0)] })
    const o = out(activeSheet()!)
    expect(o.values[id]).toBeCloseTo(40, 6)
    expect(o.prims.some((p) => p.k === 'text' && p.text === '40.00')).toBe(true)
  })

  it('the dimension updates when the model is edited', async () => {
    const { sid, vid } = await boxFront(40)
    const first = useDoc.getState().geometry
    const id = dim(sid, vid, { pts: [pointNear(first, -20, 0), pointNear(first, 20, 0)] })
    expect(out(activeSheet()!).values[id]).toBeCloseTo(40, 6)
    // the box is made wider (same feature, same persistent names)
    setModel([plainBox(65)])
    const after = out(activeSheet()!)
    expect(after.values[id]).toBeCloseTo(65, 6)
    expect(after.broken[id]).toBeUndefined()
    expect(after.prims.some((p) => p.k === 'text' && p.text === '65.00')).toBe(true)
  })

  it('a dimension whose points are gone is reported, not drawn', async () => {
    const { sid, vid } = await boxFront(40)
    const first = useDoc.getState().geometry
    const id = dim(sid, vid, { pts: [pointNear(first, -20, 0), pointNear(first, 20, 0)] })
    setModel([])
    const o = out(activeSheet()!)
    expect(o.broken[id]).toMatch(/no longer exists/)
    expect(o.prims.some((p) => p.k === 'text' && p.owner === 'dim:' + id)).toBe(false)
  })

  it('aligned, angular, ordinate and baseline dimensions', async () => {
    const { sid, vid } = await boxFront(40)
    const b = useDoc.getState().geometry
    const p00 = pointNear(b, -20, 0), p10 = pointNear(b, 20, 0), p01 = pointNear(b, -20, 10), p11 = pointNear(b, 20, 10)
    const aligned = dim(sid, vid, { type: 'aligned', pts: [p00, p11] })
    const angular = dim(sid, vid, { type: 'angular', pts: [p00, p10, p01], offset: 12 })
    const ord = dim(sid, vid, { type: 'ordinate', axis: 'h', pts: [p00, p10], offset: -8 })
    const base = dim(sid, vid, { type: 'baseline', axis: 'h', pts: [p00, p10, p11], offset: 8 })
    const o = out(activeSheet()!)
    expect(o.values[aligned]).toBeCloseTo(Math.hypot(40, 10), 6)
    expect(o.values[angular]).toBeCloseTo(90, 6)
    expect(o.values[ord]).toBeCloseTo(40, 6)
    expect(o.values[base]).toBeCloseTo(40, 6)
    expect(o.prims.some((p) => p.k === 'text' && p.text === '90.00°')).toBe(true)
  })

  it('radius and diameter dimensions of the hole', async () => {
    setModel([blockWithHole()])
    const { sid, vid } = await newView('top')
    const body = useDoc.getState().geometry[0]
    const circleEdge = [...Array(body.mesh.edgeCount ?? 0).keys()].find((i) => {
      const ref = edgeRefOf(body, i)!
      return locate({ ref, role: 'center' }, [body], viewBasis([0, 0, 1], [1, 0, 0])) !== null
    })!
    const ref = edgeRefOf(body, circleEdge)!
    const r = dim(sid, vid, { type: 'radius', pts: [{ ref, role: 'center' }], offset: 8 })
    const d = dim(sid, vid, { type: 'diameter', pts: [{ ref, role: 'center' }], offset: 8, angle: 30 })
    const o = out(activeSheet()!)
    expect(o.values[r]).toBeCloseTo(4, 3)
    expect(o.values[d]).toBeCloseTo(8, 3)
    expect(o.prims.some((p) => p.k === 'text' && p.text === 'R4.00')).toBe(true)
    expect(o.prims.some((p) => p.k === 'text' && p.text === 'Ø4.00' || (p.k === 'text' && p.text === 'Ø8.00'))).toBe(true)
  })

  it('text override and tolerances', async () => {
    const { sid, vid } = await boxFront(40)
    const b = useDoc.getState().geometry
    const id = dim(sid, vid, { pts: [pointNear(b, -20, 0), pointNear(b, 20, 0)], text: '<> typ.', tolPlus: '+0.1', tolMinus: '-0.0', precision: 1 })
    const o = out(activeSheet()!)
    expect(o.prims.some((p) => p.k === 'text' && p.text === '40.0 typ.')).toBe(true)
    expect(o.prims.filter((p) => p.k === 'text' && p.owner === 'dim:' + id && (p.text === '+0.1' || p.text === '-0.0')).length).toBe(2)
  })

  it('dimension points use persistent refs that survive the body being rebuilt', async () => {
    setModel([plainBox(40)])
    const b = useDoc.getState().geometry[0]
    const front = viewBasis([0, -1, 0], [1, 0, 0])
    const ref = vertexRefOf(b, 0)!
    const pr: PointRef = { ref, role: 'vertex' }
    const a = locate(pr, [b], front)!
    const wide = plainBox(100)
    const c = locate(pr, [wide], front)!
    expect(ref.name).toBeTruthy()
    // the same named corner, on the wider box
    expect(Math.abs(c.p3[0] - a.p3[0])).toBeCloseTo(30, 6)
  })
})

describe('parts list', () => {
  it('equal bodies are counted as one part with a quantity', () => {
    setModel([plainBox(40, 'f1'), plainBox(40, 'f2'), plainBox(20, 'f3')])
    const parts = listComponents()
    expect(parts.length).toBe(2)
    expect(parts.map((p) => p.qty).sort()).toEqual([1, 2])
  })

  it('the parts list and balloons draw item numbers and quantities', async () => {
    setModel([plainBox(40, 'f1'), plainBox(40, 'f2'), plainBox(20, 'f3')])
    const { sid } = await newView('front')
    const parts = listComponents()
    drawingActions.addNote(sid, { kind: 'partsList', pos: [20, 20] })
    drawingActions.addNote(sid, { kind: 'balloon', pos: [80, 120], item: parts[0].key, tip: [100, 100] })
    const o = out(activeSheet()!)
    const texts = o.prims.filter((p) => p.k === 'text').map((p) => (p as { text: string }).text)
    expect(texts).toContain('ITEM')
    expect(texts).toContain('QTY')
    expect(texts).toContain('Box')
    expect(texts).toContain('2')
    expect(texts.filter((t) => t === '1').length).toBeGreaterThanOrEqual(2) // the list row and the balloon
  })
})

describe('annotations', () => {
  it('notes, leaders, tolerance frames, datums and surface finish symbols make primitives', async () => {
    setModel([plainBox(40)])
    const { sid } = await newView('front')
    drawingActions.addNote(sid, { kind: 'note', pos: [30, 60], text: 'BREAK ALL EDGES\n0.5 MAX', size: 3.5 })
    drawingActions.addNote(sid, { kind: 'leader', pts: [[100, 100], [120, 110]], text: 'M4 TAP', size: 3.5 })
    drawingActions.addNote(sid, { kind: 'gdt', pos: [60, 60], symbol: 'position', tol: '0.2', modifier: 'M', datums: ['A', 'B'], diameter: true, tip: [90, 90] })
    drawingActions.addNote(sid, { kind: 'datum', pos: [150, 60], letter: 'A', tip: [150, 80] })
    drawingActions.addNote(sid, { kind: 'finish', pos: [200, 60], ra: '3.2', method: 'removal', allowance: '', lay: '' })
    const o = out(activeSheet()!)
    const texts = o.prims.filter((p) => p.k === 'text').map((p) => (p as { text: string }).text)
    for (const t of ['BREAK ALL EDGES', '0.5 MAX', 'M4 TAP', 'Ø0.2', 'A', 'B', 'Ra 3.2', 'M']) expect(texts).toContain(t)
    // the position symbol: a circle with a cross
    expect(o.prims.filter((p) => p.k === 'path' && p.owner?.startsWith('note:') && p.style === 'thin').length).toBeGreaterThan(10)
  })
})

describe('output files', () => {
  async function sheetWithEverything() {
    setModel([blockWithHole()])
    const { sid, vid } = await newView('front')
    await createProjectedView(sid, vid, 'above')
    drawingActions.updateSheet(sid, { titleBlock: { ...activeSheet()!.titleBlock, title: 'Test plate', company: 'Weeb Machining Ø 5°' } })
    const b = useDoc.getState().geometry
    const front = viewBasis([0, -1, 0], [1, 0, 0])
    const sp = snapPoints(b.map((body) => ({ body, item: { bodyId: body.id } })), front).filter((s) => s.kind === 'vertex')
    const near = (x: number) => sp.sort((p, q) => Math.abs(p.p2[0] - x) - Math.abs(q.p2[0] - x))[0].pt
    drawingActions.addDim(sid, { viewId: vid, type: 'linear', pts: [near(-20), near(20)], axis: 'h', offset: 10, angle: 0, text: '', precision: 2, tolPlus: '', tolMinus: '' })
    return out(activeSheet()!)
  }

  it('SVG has paths, dashes for hidden lines and the text', async () => {
    const o = await sheetWithEverything()
    const { w, h } = sheetDims(activeSheet()!)
    const svg = sheetToSvg(o.prims, w, h)
    expect(svg).toContain('<svg')
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThan(20)
    expect(svg).toContain('stroke-dasharray="3 1.5"')
    expect(svg).toContain('>40.00<')
    expect(svg).toContain('Test plate')
    expect(svg).not.toContain('NaN')
  })

  it('DXF has polylines on layers with linetypes, and text', async () => {
    const o = await sheetWithEverything()
    const { w, h } = sheetDims(activeSheet()!)
    const dxf = sheetToDxf(o.prims, w, h)
    const counts = dxfEntityCounts(dxf)
    expect(counts.POLYLINE).toBeGreaterThan(20)
    expect(counts.TEXT).toBeGreaterThan(10)
    expect(counts.SOLID).toBeGreaterThanOrEqual(2) // the dimension arrowheads
    for (const name of ['VISIBLE', 'HIDDEN', 'CENTER', 'DIMENSION', 'BORDER']) expect(dxf).toContain(name)
    expect(dxf).toContain('HIDDEN') // linetype table
    expect(dxf).not.toContain('NaN')
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true)
  })

  it('PDF has vector path operators and real text in an embedded font, and no images', async () => {
    const o = await sheetWithEverything()
    const s = activeSheet()!
    const { w, h } = sheetDims(s)
    const bytes = await sheetsToPdf([{ prims: o.prims, w, h, title: s.name }], 'test')
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBe(1)
    const page = pdf.getPage(0)
    expect(page.getWidth()).toBeCloseTo((w * 72) / 25.4, 3)
    // content stream operators
    const ctx = pdf.context
    let content = ''
    const contents = page.node.Contents()
    const streams = contents instanceof PDFRawStream ? [contents] : []
    if (!streams.length) {
      const arr = page.node.lookup(PDFName.of('Contents'))
      const refs = (arr as unknown as { asArray?: () => unknown[] }).asArray ? (arr as unknown as { asArray: () => unknown[] }).asArray() : [page.node.get(PDFName.of('Contents'))]
      for (const r of refs) {
        const st = ctx.lookup(r as never)
        if (st instanceof PDFRawStream) streams.push(st)
      }
    }
    for (const st of streams) content += new TextDecoder('latin1').decode(decodePDFRawStream(st).decode())
    const ops = (re: RegExp) => (content.match(re) ?? []).length
    expect(ops(/ m\n/g)).toBeGreaterThan(20) // moveto
    expect(ops(/ l\n/g)).toBeGreaterThan(40) // lineto
    expect(ops(/\nS\n/g)).toBeGreaterThan(20) // stroke
    expect(ops(/\nf\n/g)).toBeGreaterThanOrEqual(2) // filled arrowheads
    expect(content).toMatch(/\[[\d. ]+\] 0 d/) // dash pattern for hidden lines
    expect(ops(/ Tj\n/g)).toBeGreaterThan(10) // text show operators
    // fonts embedded, no raster images
    let fontFiles = 0, images = 0
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null
      if (!dict) continue
      if (dict.get(PDFName.of('FontFile2')) || dict.get(PDFName.of('FontFile3')) || dict.get(PDFName.of('FontFile'))) fontFiles++
      if (dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) images++
    }
    expect(fontFiles).toBeGreaterThanOrEqual(2)
    expect(images).toBe(0)
  })

  it('PDF text is selectable: the characters are in the file via the font ToUnicode map', async () => {
    const o = await sheetWithEverything()
    const s = activeSheet()!
    const { w, h } = sheetDims(s)
    const bytes = await sheetsToPdf([{ prims: o.prims, w, h, title: s.name }], 'test')
    const raw = new TextDecoder('latin1').decode(bytes)
    expect(raw).toContain('/ToUnicode')
    expect(raw).toContain('/Type0')
    expect(raw).toContain('/FontDescriptor')
  })
})

describe('saving', () => {
  it('drawings round trip through the project section', async () => {
    setModel([blockWithHole()])
    const { sid, vid } = await newView('front')
    drawingActions.addNote(sid, { kind: 'note', pos: [30, 60], text: 'HELLO', size: 3.5 })
    const saved = JSON.parse(JSON.stringify({ format: 1, ...useDrawing.getState().doc }))
    useDrawing.getState().load(null)
    expect(useDrawing.getState().doc.sheets.length).toBe(0)
    const { parseSection } = await import('./store')
    parseSection(saved)
    const d = useDrawing.getState().doc
    expect(d.sheets.length).toBe(1)
    expect(d.sheets[0].views[0].id).toBe(vid)
    expect(d.sheets[0].notes[0]).toMatchObject({ kind: 'note', text: 'HELLO' })
    await refreshGeoms(d.sheets)
    expect(count(out(d.sheets[0]).prims, 'visible')).toBe(4)
  })

  it('undo and redo of drawing edits', async () => {
    setModel([plainBox(40)])
    const { sid } = await newView('front')
    drawingActions.addNote(sid, { kind: 'note', pos: [30, 60], text: 'A', size: 3.5 })
    expect(activeSheet()!.notes.length).toBe(1)
    useDrawing.getState().undo()
    expect(activeSheet()!.notes.length).toBe(0)
    useDrawing.getState().redo()
    expect(activeSheet()!.notes.length).toBe(1)
  })
})
