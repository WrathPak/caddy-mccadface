/**
 * Interactive side of the newer sketch tools (spline, ellipse, slots, polygon, fillet / chamfer, mirror, patterns, text,
 * import): pointer handling, live previews and the tool options. The geometry itself is built by shapes.ts.
 */
import { create } from 'zustand'
import { cloneModel, addCoincident, entityById, entityPoints, pos } from './model'
import { entityPolylines } from './draw'
import { dist, norm, perp, sub, cross } from './geom'
import { hitTest } from './hit'
import { loadFont } from './font'
import { boundsOfImport, insertImported, parseDxf, parseSvg } from './importers'
import {
  addHandles, chamferCorner, cornerOf, drawEllipse, drawPolygon, drawSlotArc, drawSlotCC, drawSlotOverall, drawSpline, drawText, filletCorner,
  mirrorEntities, patternCirc, patternRect, type PolygonKind,
} from './shapes'
import { extraTools, sketchInternals as K, setTool, type Mods, type ToolHandlers, type ToolId } from './store'
import type { Snap } from './snap'
import { ORIGIN, type LineE, type SketchModel, type Vec2 } from './types'

export interface SketchOpts {
  sides: number; polyKind: PolygonKind
  filletR: number; chamferD: number; chamferD2: number
  rectCount: number; rectSpacing: number; rectAngle: number; rectCount2: number; rectSpacing2: number
  circCount: number; circAngle: number
  splineClosed: boolean
  text: string; textH: number; textAngle: number; textFont: string
}
export const useSketchOpts = create<{ o: SketchOpts; set(p: Partial<SketchOpts>): void }>((set) => ({
  o: {
    sides: 6, polyKind: 'inscribed', filletR: 3, chamferD: 3, chamferD2: 0,
    rectCount: 3, rectSpacing: 20, rectAngle: 0, rectCount2: 1, rectSpacing2: 20,
    circCount: 6, circAngle: 360, splineClosed: false,
    text: 'Text', textH: 10, textAngle: 0, textFont: 'Inter',
  },
  set: (p) => set((s) => ({ o: { ...s.o, ...p } })),
}))
const opts = () => useSketchOpts.getState().o

/** What the active tool would draw at the cursor (plane-local polylines), for the overlay. */
export const useToolPreview = create<{ polys: Vec2[][]; dots: Vec2[] }>(() => ({ polys: [], dots: [] }))
const showPreview = (polys: Vec2[][], dots: Vec2[] = []) => { useToolPreview.setState({ polys, dots }); K.invalidate() }
const clearPreview = () => showPreview([])

/** Polylines of what `build` adds to a copy of the model. */
function previewOf(build: (m: SketchModel) => unknown): Vec2[][] {
  const m = cloneModel(K.get().model)
  const old = new Set(m.entities.map((e) => e.id))
  try { build(m) } catch { return [] }
  return entityPolylines(m).filter((p) => !old.has(p.id) && !p.construction).map((p) => p.pts)
}

/** Bind the clicked points to the geometry they were snapped to. */
function bindSnaps(m: SketchModel, old: Set<string>, snaps: Snap[]) {
  for (const s of snaps) {
    if (!s.pointId || !(s.kind === 'point' || s.kind === 'origin' || s.kind === 'center')) continue
    const fresh = m.entities.find((e) => e.type === 'point' && !old.has(e.id) && dist([e.x, e.y], s.pos) < 1e-9)
    if (fresh) addCoincident(m, fresh.id, s.pointId)
  }
}

interface ClickTool {
  /** clicks needed */
  need: number
  build(m: SketchModel, p: Vec2[]): string | void | unknown
}

const lineDist = (p: Vec2, a: Vec2, b: Vec2) => Math.abs(cross(norm(sub(b, a)), sub(p, a)))

const CLICK_TOOLS: Partial<Record<ToolId, ClickTool>> = {
  ellipse: { need: 3, build: (m, p) => drawEllipse(m, p[0], p[1], lineDist(p[2], p[0], p[1])) },
  slotCC: { need: 3, build: (m, p) => drawSlotCC(m, p[0], p[1], 2 * lineDist(p[2], p[0], p[1])) },
  slotOv: { need: 3, build: (m, p) => drawSlotOverall(m, p[0], p[1], 2 * lineDist(p[2], p[0], p[1])) },
  slotArc: { need: 4, build: (m, p) => drawSlotArc(m, p[0], p[1], p[2], 2 * Math.abs(dist(p[3], p[0]) - dist(p[1], p[0]))) },
  polygon: { need: 2, build: (m, p) => drawPolygon(m, p[0], p[1], opts().sides, opts().polyKind) },
}

let snaps: Snap[] = []
let cursor: Vec2 | null = null

function clickHandlers(id: ToolId, t: ClickTool): ToolHandlers {
  const pts = () => snaps.map((s) => s.pos)
  return {
    start() { snaps = []; cursor = null; clearPreview() },
    move(raw, _w, mods) {
      const sn = K.snap(raw, mods, snaps[snaps.length - 1]?.pos)
      cursor = sn.pos
      K.set({ cursor: sn, hover: null })
      if (snaps.length) showPreview(previewOf((m) => t.build(m, [...pts(), sn.pos, ...Array(Math.max(0, t.need - snaps.length - 1)).fill(sn.pos)].slice(0, t.need))))
      K.invalidate()
    },
    down(raw, _w, mods) {
      const sn = K.snap(raw, mods, snaps[snaps.length - 1]?.pos)
      snaps.push(sn)
      if (snaps.length < t.need) { K.invalidate(); return }
      const taken = snaps
      snaps = []
      clearPreview()
      const old = new Set(K.get().model.entities.map((e) => e.id))
      K.commit((m) => {
        const r = t.build(m, taken.map((s) => s.pos))
        if (typeof r === 'string') return r
        bindSnaps(m, old, taken)
      })
      void id
    },
    cancel() { const had = snaps.length > 0; snaps = []; clearPreview(); return had },
  }
}

for (const [id, t] of Object.entries(CLICK_TOOLS) as [ToolId, ClickTool][]) extraTools[id] = clickHandlers(id, t)

// ------------------------------------------------------------------------------------------------ splines

function splineHandlers(mode: 'fit' | 'ctrl'): ToolHandlers {
  const finish = (closed = false) => {
    const taken = snaps
    snaps = []
    clearPreview()
    if (taken.length < 2) return false
    const old = new Set(K.get().model.entities.map((e) => e.id))
    K.commit((m) => { drawSpline(m, taken.map((s) => s.pos), mode, closed && taken.length >= 3, K.get().construction); bindSnaps(m, old, taken) })
    return true
  }
  return {
    start() { snaps = []; clearPreview() },
    move(raw, _w, mods) {
      const sn = K.snap(raw, mods, snaps[snaps.length - 1]?.pos)
      K.set({ cursor: sn, hover: null })
      if (snaps.length) showPreview(previewOf((m) => drawSpline(m, [...snaps.map((s) => s.pos), sn.pos], mode, false)), snaps.map((s) => s.pos))
      K.invalidate()
    },
    down(raw, _w, mods) {
      const sn = K.snap(raw, mods, snaps[snaps.length - 1]?.pos)
      // a click on the first point closes the curve
      if (snaps.length >= 3 && dist(sn.pos, snaps[0].pos) < K.wpp() * 8) { finish(true); return }
      snaps.push(sn)
      showPreview(previewOf((m) => drawSpline(m, snaps.map((s) => s.pos), mode, false)), snaps.map((s) => s.pos))
    },
    dbl() { snaps.pop(); finish(opts().splineClosed) },
    enter() { return finish(opts().splineClosed) },
    cancel() {
      // Esc and right click drop the curve; Enter or a double click finishes it
      const had = snaps.length > 0
      snaps = []
      clearPreview()
      return had
    },
  }
}
extraTools.spline = splineHandlers('fit')
extraTools.splineC = splineHandlers('ctrl')

// ------------------------------------------------------------------------------------------------ fillet / chamfer

function cornerHandlers(kind: 'fillet' | 'chamfer'): ToolHandlers {
  let first: string | null = null
  const apply = (a: LineE, b: LineE) => {
    const o = opts()
    K.commit((m) => {
      const A = entityById(m, a.id) as LineE, B = entityById(m, b.id) as LineE
      const r = kind === 'fillet' ? filletCorner(m, A, B, o.filletR) : chamferCorner(m, A, B, o.chamferD, o.chamferD2 > 0 ? o.chamferD2 : o.chamferD)
      return typeof r === 'string' ? r : undefined
    })
    first = null
    K.set({ picks: [] })
  }
  return {
    start() { first = null; K.set({ picks: [] }) },
    move(raw, wpp) { K.set({ hover: hitTest(K.get().model, raw, 8 * wpp), cursor: null }); K.invalidate() },
    down(raw, wpp) {
      const s = K.get()
      const h = hitTest(s.model, raw, 8 * wpp)
      if (!h) return
      const e = entityById(s.model, h)
      if (e?.type === 'point' || h === ORIGIN) {
        // a click on the corner point: the two lines that end there
        const lines = s.model.entities.filter((x): x is LineE => x.type === 'line' && (x.p1 === h || x.p2 === h || dist(pos(s.model, x.p1), pos(s.model, h)) < 1e-6 || dist(pos(s.model, x.p2), pos(s.model, h)) < 1e-6))
        if (lines.length === 2) apply(lines[0], lines[1])
        else K.flash('Pick the two lines that meet at the corner, or click on the corner itself')
        return
      }
      if (e?.type !== 'line') { K.flash('Fillet and chamfer work on the corner of two lines'); return }
      if (!first) { first = h; K.set({ picks: [h] }); return }
      const a = entityById(s.model, first) as LineE
      if (first === h) return
      if (!cornerOf(s.model, a, e)) { K.flash('The two lines must meet at a corner'); first = null; K.set({ picks: [] }); return }
      apply(a, e)
    },
    cancel() { const had = !!first; first = null; K.set({ picks: [] }); return had },
  }
}
extraTools.fillet = cornerHandlers('fillet')
extraTools.chamfer = cornerHandlers('chamfer')

// ------------------------------------------------------------------------------------------------ mirror and patterns

const curveSelection = () => {
  const s = K.get()
  return s.sel.filter((id) => { const e = entityById(s.model, id); return e && e.type !== 'point' })
}
let mirrorSource: string[] = []

extraTools.mirror = {
  start() {
    mirrorSource = curveSelection()
    if (!mirrorSource.length) K.flash('Select the curves to mirror in the sketch first, then pick the mirror line')
    else K.flash('Pick the line to mirror across')
  },
  move(raw, wpp) { K.set({ hover: hitTest(K.get().model, raw, 8 * wpp, (e) => e.type === 'line'), cursor: null }); K.invalidate() },
  down(raw, wpp) {
    const s = K.get()
    const h = hitTest(s.model, raw, 8 * wpp, (e) => e.type === 'line')
    if (!h) return
    if (!mirrorSource.length) { K.flash('Select the curves to mirror in the sketch first'); return }
    const src = mirrorSource
    const ok = K.commit((m) => { const r = mirrorEntities(m, src, h); return typeof r === 'string' ? r : undefined })
    if (ok) setTool('select')
  },
}

/** Apply the rectangular pattern to the selected curves (the Apply button of the tool bar). */
export function applyPatternR(): boolean {
  const o = opts()
  const ids = curveSelection()
  const a = (o.rectAngle * Math.PI) / 180
  const d1: Vec2 = [Math.cos(a), Math.sin(a)]
  return K.commit((m) => {
    const r = patternRect(m, { ids, dir1: d1, count1: o.rectCount, spacing1: o.rectSpacing, dir2: perp(d1), count2: o.rectCount2, spacing2: o.rectSpacing2 })
    return typeof r === 'string' ? r : undefined
  })
}
extraTools.patternR = {
  start() { if (!curveSelection().length) K.flash('Select the curves to repeat in the sketch first, then set the counts and press Apply') },
  move() { /* nothing to preview until Apply */ },
  down() { /* the options bar drives this tool */ },
}

let patternSource: string[] = []
extraTools.patternC = {
  start() {
    patternSource = curveSelection()
    K.flash(patternSource.length ? 'Click the point to turn about (or the origin)' : 'Select the curves to repeat in the sketch first')
  },
  move(raw, wpp, mods) { const sn = K.snap(raw, mods); K.set({ cursor: sn, hover: null }); K.invalidate(); void wpp },
  down(raw, wpp, mods) {
    if (!patternSource.length) { K.flash('Select the curves to repeat in the sketch first'); return }
    const sn = K.snap(raw, mods)
    const src = patternSource
    const o = opts()
    const ok = K.commit((m) => {
      const centre = sn.pointId && (sn.kind === 'point' || sn.kind === 'origin' || sn.kind === 'center') ? sn.pointId : K.pointFor(m, sn)
      if (src.some((id) => id === centre)) return 'Pick a centre that is not part of the curves being repeated'
      const r = patternCirc(m, { ids: src, centre, count: o.circCount, angle: o.circAngle })
      return typeof r === 'string' ? r : undefined
    })
    if (ok) setTool('select')
  },
}

// ------------------------------------------------------------------------------------------------ text

extraTools.text = {
  move(raw, _w, mods) { const sn = K.snap(raw, mods); K.set({ cursor: sn, hover: null }); K.invalidate() },
  down(raw, _w, mods) {
    const sn = K.snap(raw, mods)
    const o = opts()
    if (!o.text.trim()) { K.flash('Type the text in the bar first'); return }
    void loadFont(o.textFont).then(() => {
      const old = new Set(K.get().model.entities.map((e) => e.id))
      K.commit((m) => {
        drawText(m, sn.pos, o.text, o.textH, o.textAngle, o.textFont)
        bindSnaps(m, old, [sn])
      })
    }, (e) => K.flash('Could not load the font: ' + (e instanceof Error ? e.message : String(e))))
  },
}

/** Change the text, height or angle of the selected text entity. */
export function editSelectedText(p: { text?: string; h?: number; a?: number; font?: string }) {
  const id = K.get().sel.find((i) => entityById(K.get().model, i)?.type === 'text')
  if (!id) return
  void loadFont(p.font ?? 'Inter').then(() => K.commit((m) => {
    const e = entityById(m, id)
    if (e?.type !== 'text') return
    if (p.text !== undefined) e.text = p.text
    if (p.h !== undefined && p.h > 0) e.h = p.h
    if (p.a !== undefined) e.a = p.a
    if (p.font) e.font = p.font
  }))
}

// ------------------------------------------------------------------------------------------------ handles and tangency

/** Give the selected fit splines their end tangent handles. */
export function splineHandlesCommand() {
  const s = K.get()
  const ids = s.sel.filter((i) => entityById(s.model, i)?.type === 'spline')
  if (!ids.length) { K.flash('Select a fit point spline first'); return }
  K.commit((m) => { for (const id of ids) { const err = addHandles(m, id); if (err) return err } })
}

// ------------------------------------------------------------------------------------------------ import

/** Read an SVG or DXF file into the sketch. */
export async function importIntoSketch(file: File): Promise<void> {
  try {
    const text = await file.text()
    const lower = file.name.toLowerCase()
    const imp = lower.endsWith('.dxf') ? parseDxf(text) : parseSvg(text)
    const b = boundsOfImport(imp)
    if (!b) { K.flash(imp.notes[0] ?? 'Nothing to import'); return }
    // SVG artwork has its own origin: put its lower left corner on the sketch origin. DXF keeps its coordinates.
    const offset: Vec2 = lower.endsWith('.dxf') ? [0, 0] : [-b[0], -b[1]]
    let ids: string[] = []
    const ok = K.commit((m) => { ids = insertImported(m, imp, offset) })
    if (ok) {
      K.set({ sel: ids })
      K.flash(`Imported ${ids.length} item${ids.length === 1 ? '' : 's'}${imp.notes.length ? '. ' + imp.notes.join('; ') : ''}`)
    }
  } catch (e) {
    K.flash('Import failed: ' + (e instanceof Error ? e.message : String(e)))
  }
}

/** Open the file chooser for Import SVG / DXF. */
export function chooseImportFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.svg,.dxf,image/svg+xml'
  input.onchange = () => { const f = input.files?.[0]; if (f) void importIntoSketch(f) }
  input.click()
}

export { entityPoints, type Mods }
