/**
 * Interactive side of the newer sketch tools (spline, ellipse, slots, polygon, rectangles and circles by other means, centre arcs,
 * points, fillet / chamfer, Extend / Break / Scale, mirror, patterns, text, import): pointer handling, live previews, typed values
 * and the tool options. The geometry itself is built by shapes.ts, newShapes.ts, corners.ts and modify.ts.
 */
import { create } from 'zustand'
import { evalNumber } from '@/doc/params'
import { cloneModel, addCoincident, addConstraint, entityById, entityPoints, pos } from './model'
import { entityPolylines } from './draw'
import { dist, norm, perp, sub, cross, dot, polar, relAngle, sampleArc, TAU } from './geom'
import { axisHit, hitTest } from './hit'
import { loadFont } from './font'
import { boundsOfImport, insertImported, parseDxf, parseSvg } from './importers'
import { defaultOff, measureDim } from './dims'
import {
  addHandles, chamferCorner, cornerOf, drawEllipse, drawTangentArc, drawPolygon, drawSlotArc, drawSlotCC, drawSlotOverall, drawSpline, drawText, filletCorner,
  mirrorEntities, patternCirc, patternRect, curveEndingAt, pointsOf, type PolygonKind,
} from './shapes'
import { circleTouching, drawArcCentre, drawCircle2, drawCircle2Tangent, drawCircle3, drawConic, drawRect3, isTangentTarget } from './newShapes'
import { chamferAngle, chamferCurves, cornerOfCurves, filletCurves, isCornerCurve } from './corners'
import { breakCurve, duplicateCurves, extendCurve, moveCurves, scaleCurves, transformOf } from './modify'
import { F, polarFrom, valuesOf, hasText, type FieldKey, type Typed, type TypedField, type Values } from './typed'
import { extraTools, sketchInternals as K, setTool, tangentDrag, type Mods, type ToolHandlers, type ToolId } from './store'
import type { Snap } from './snap'
import { ORIGIN, type ConstraintType, type LineE, type SketchModel, type Vec2 } from './types'

export interface SketchOpts {
  sides: number; polyKind: PolygonKind
  filletR: number; chamferD: number; chamferD2: number; chamferAngle: number; chamferKind: 'equal' | 'two' | 'angle'
  moveX: number; moveY: number; moveAngle: number; moveCopy: boolean
  rectCount: number; rectSpacing: number; rectAngle: number; rectCount2: number; rectSpacing2: number
  circCount: number; circAngle: number
  scaleF: number
  splineClosed: boolean
  text: string; textH: number; textAngle: number; textFont: string
}
export const useSketchOpts = create<{ o: SketchOpts; set(p: Partial<SketchOpts>): void }>((set) => ({
  o: {
    sides: 6, polyKind: 'inscribed', filletR: 3, chamferD: 3, chamferD2: 0, chamferAngle: 45, chamferKind: 'equal',
    moveX: 10, moveY: 0, moveAngle: 0, moveCopy: false,
    rectCount: 3, rectSpacing: 20, rectAngle: 0, rectCount2: 1, rectSpacing2: 20,
    circCount: 6, circAngle: 360, scaleF: 2,
    splineClosed: false,
    text: 'Text', textH: 10, textAngle: 0, textFont: 'Inter',
  },
  set: (p) => set((s) => ({ o: { ...s.o, ...p } })),
}))
const opts = () => useSketchOpts.getState().o

/** What the active tool would draw at the cursor (plane-local polylines), for the overlay. */
export const useToolPreview = create<{ polys: Vec2[][]; dots: Vec2[] }>(() => ({ polys: [], dots: [] }))
const showPreview = (polys: Vec2[][], dots: Vec2[] = []) => { useToolPreview.setState({ polys, dots }); K.invalidate() }
const clearPreview = () => showPreview([])

/** The value boxes of the active tool (typed numbers), drawn next to the cursor. */
export const useToolTyped = create<{ fields: TypedField[]; active: number; at: Vec2 | null; live: Values }>(() => ({ fields: [], active: 0, at: null, live: {} }))

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
    const fresh = m.entities.find((e) => e.type === 'point' && !old.has(e.id) && dist([e.x, e.y], s.pos) < 1e-9)
    if (fresh) K.bindPoint(m, fresh.id, s) // onto a point, a curve, a midpoint, a crossing or an axis
  }
}

/** Construction mode (X with nothing selected) makes what a tool draws guide geometry. */
function markConstruction(m: SketchModel, old: Set<string>) {
  if (K.get().construction) for (const e of m.entities) if (!old.has(e.id) && e.type !== 'point') e.construction = true
}

// ------------------------------------------------------------------------------------------------ typed values

/** What was typed while each point was placed: the numbers, and the text they came from (a parameter name stays a name in the dimension). */
interface Typing { v: Values; t: Partial<Record<FieldKey, string>> }
type Hist = Typing[]

/** A dimension from typed text: made from the measured geometry so it starts out satisfied (the text is kept when it matches). */
function typedDim(m: SketchModel, type: ConstraintType, refs: string[], text: string) {
  const me = measureDim(m, type, refs)
  if (!me) return
  const n = evalNumber(text, type === 'angle' ? 'deg' : 'mm')
  const expr = n !== null && Math.abs(Math.abs(n) - me.value) < 1e-9 && n >= 0 ? text : String(+me.value.toFixed(6))
  addConstraint(m, { type, refs, value: me.value, sgn: me.sgn, expr, off: defaultOffFor(m, type, refs) })
}
const defaultOffFor = (m: SketchModel, type: ConstraintType, refs: string[]) => defaultOff(m, type, refs, K.wpp() * 20)
/** Add the dimension for a typed field of stage `stage`, when it has a value. */
const dimFrom = (m: SketchModel, h: Hist, stage: number, key: FieldKey, type: ConstraintType, refs: string[]) => {
  const t = h[stage]
  if (t && t.v[key] !== undefined && t.t[key] !== undefined) typedDim(m, type, refs, t.t[key]!)
}

/**
 * The value boxes of the tool that is active: Tab moves between them, digits fill the active one and Enter places the point where
 * the typed numbers say (and, with nothing typed, goes on to end the tool as usual).
 */
const box = {
  typed: null as Typed | null,
  /** the fields for the stage (points placed so far); they start over when the stage or the tool changes */
  sync(tool: string, stage: number, fields: TypedField[]): Typed {
    if (!this.typed || this.typed.tool !== tool || this.typed.stage !== stage) this.typed = { fields, active: 0, tool, stage }
    return this.typed
  },
  has: () => hasText(box.typed),
  clear() { this.typed = null; useToolTyped.setState({ fields: [], active: 0, at: null, live: {} }) },
  typing(): Typing {
    const t: Typing = { v: valuesOf(this.typed), t: {} }
    for (const f of this.typed?.fields ?? []) if (f.text.trim()) t.t[f.key] = f.text.trim()
    return t
  },
  show(at: Vec2 | null, live: Values) {
    const t = this.typed
    useToolTyped.setState({ fields: t && at ? t.fields : [], active: t?.active ?? 0, at, live })
  },
  info() {
    const t = this.typed
    if (!t || !t.fields.length) return null
    const f = t.fields[t.active]
    return { label: f.label, unit: f.unit, text: f.text, index: t.active, count: t.fields.length }
  },
  set(text: string) {
    const t = this.typed
    if (!t) return
    this.typed = { ...t, fields: t.fields.map((x, i) => (i === t.active ? { ...x, text } : x)) }
  },
  next() {
    const t = this.typed
    if (t && t.fields.length > 1) this.typed = { ...t, active: (t.active + 1) % t.fields.length }
  },
  /** Keys for the active box; `enter` places the point. Returns true when the key was used. */
  key(e: { key: string; shiftKey: boolean }, tool: string, enter: () => void): boolean {
    const t = this.typed
    if (!t || t.tool !== tool || !t.fields.length) return false
    const k = e.key
    if (k === 'Tab') { this.typed = { ...t, active: (t.active + (e.shiftKey ? t.fields.length - 1 : 1)) % t.fields.length }; return true }
    if (k === 'Enter') { if (!hasText(t)) return false; enter(); return true }
    const f = t.fields[t.active]
    if (k === 'Backspace') { if (!f.text) return false; this.set(f.text.slice(0, -1)); return true }
    if (k.length !== 1) return false
    if (/[0-9.\-+*/()^, ]/.test(k) || (/[A-Za-z_]/.test(k) && f.text !== '')) {
      if (k === ' ') return false
      this.set(f.text + (k === ',' ? '.' : k))
      return true
    }
    return false
  },
}

// ------------------------------------------------------------------------------------------------ click-by-click tools

interface ClickTool {
  /** clicks needed */
  need: number
  /** `h[i]` is what was typed when point i was placed (the last entry belongs to the point being placed) */
  build(m: SketchModel, p: Vec2[], h: Hist): string | void | unknown
  /** value boxes for placing point `stage` (0 = the first, which has none) */
  fields?(stage: number): TypedField[]
  /** where the point being placed lands, given the typed numbers */
  resolve?(stage: number, pts: Vec2[], cursor: Vec2, v: Values): Vec2
  /** the numbers to show in boxes that are still following the cursor */
  live?(stage: number, pts: Vec2[], end: Vec2): Values
  /** extra constraints for the clicks that snapped onto existing geometry */
  bind?(m: SketchModel, made: unknown, snaps: Snap[]): void
}

const lineDist = (p: Vec2, a: Vec2, b: Vec2) => Math.abs(cross(norm(sub(b, a)), sub(p, a)))
const side = (p: Vec2, a: Vec2, b: Vec2) => (cross(norm(sub(b, a)), sub(p, a)) < 0 ? -1 : 1)
const deg = (r: number) => (r * 180) / Math.PI
/** A point `d` off the line a-b, on the cursor's side (what a typed width / minor radius means). */
const offLine = (a: Vec2, b: Vec2, cursor: Vec2, d: number): Vec2 => {
  const n = perp(norm(sub(b, a))), s = side(cursor, a, b)
  return [a[0] + n[0] * s * d, a[1] + n[1] * s * d]
}
const polarLive = (a: Vec2, end: Vec2, key: FieldKey): Values => ({ [key]: dist(a, end), ang: deg(Math.atan2(end[1] - a[1], end[0] - a[0])) })
/** First point to a second one: a length and an angle. */
const polarFields = (label: string, key: FieldKey = 'len') => [F(key, label, 'mm'), F('ang', 'Angle', 'deg')]
const widthFields = (label = 'Width') => [F('wd', label, 'mm')]

const polygonField = () => (opts().polyKind === 'edge' ? 'len' : 'rad')

const CLICK_TOOLS: Partial<Record<ToolId, ClickTool>> = {
  ellipse: {
    need: 3,
    build: (m, p, h) => {
      const r = drawEllipse(m, p[0], p[1], lineDist(p[2], p[0], p[1]))
      dimFrom(m, h, 1, 'maj', 'majorRadius', [r.ellipse])
      dimFrom(m, h, 2, 'min', 'radius', [r.ellipse])
      return r
    },
    fields: (s) => (s === 1 ? polarFields('Major radius', 'maj') : s === 2 ? [F('min', 'Minor radius', 'mm')] : []),
    resolve: (s, pts, c, v) => (s === 1 ? polarFrom(pts[0], c, v.maj, v.ang) : v.min !== undefined ? offLine(pts[0], pts[1], c, v.min) : c),
    live: (s, pts, end) => (s === 1 ? polarLive(pts[0], end, 'maj') : { min: lineDist(end, pts[0], pts[1]) }),
  },
  slotCC: {
    need: 3,
    build: (m, p, h) => {
      const r = drawSlotCC(m, p[0], p[1], 2 * lineDist(p[2], p[0], p[1]))
      dimFrom(m, h, 1, 'len', 'distance', [r.c1, r.c2])
      dimFrom(m, h, 1, 'ang', 'angle', [r.c1, r.c2])
      dimFrom(m, h, 2, 'wd', 'diameter', [r.arcs[0]])
      return r
    },
    fields: (s) => (s === 1 ? polarFields('Length') : s === 2 ? widthFields() : []),
    resolve: (s, pts, c, v) => (s === 1 ? polarFrom(pts[0], c, v.len, v.ang) : v.wd !== undefined ? offLine(pts[0], pts[1], c, v.wd / 2) : c),
    live: (s, pts, end) => (s === 1 ? polarLive(pts[0], end, 'len') : { wd: 2 * lineDist(end, pts[0], pts[1]) }),
  },
  slotOv: {
    need: 3,
    build: (m, p, h) => {
      const r = drawSlotOverall(m, p[0], p[1], 2 * lineDist(p[2], p[0], p[1]))
      if (typeof r === 'string') return r
      dimFrom(m, h, 1, 'len', 'distance', [r.c1, r.c2])
      dimFrom(m, h, 1, 'ang', 'angle', [r.c1, r.c2])
      dimFrom(m, h, 2, 'wd', 'diameter', [r.arcs[0]])
      return r
    },
    fields: (s) => (s === 1 ? polarFields('Overall length') : s === 2 ? widthFields() : []),
    resolve: (s, pts, c, v) => (s === 1 ? polarFrom(pts[0], c, v.len, v.ang) : v.wd !== undefined ? offLine(pts[0], pts[1], c, v.wd / 2) : c),
    live: (s, pts, end) => (s === 1 ? polarLive(pts[0], end, 'len') : { wd: 2 * lineDist(end, pts[0], pts[1]) }),
  },
  slotArc: {
    need: 4,
    build: (m, p, h) => {
      const r = drawSlotArc(m, p[0], p[1], p[2], 2 * Math.abs(dist(p[3], p[0]) - dist(p[1], p[0])))
      if (typeof r === 'string') return r
      dimFrom(m, h, 1, 'rad', 'radius', [r.arcs[0]])
      dimFrom(m, h, 3, 'wd', 'diameter', [r.arcs[3]])
      return r
    },
    fields: (s) => (s === 1 ? polarFields('Radius', 'rad') : s === 2 ? [F('sw', 'Sweep', 'deg')] : s === 3 ? widthFields() : []),
    resolve: (s, pts, c, v) => {
      const a0 = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0])
      if (s === 1) return polarFrom(pts[0], c, v.rad, v.ang)
      if (s === 2) return v.sw !== undefined ? polar(pts[0], dist(pts[0], pts[1]), a0 + (Math.abs(v.sw) * Math.PI) / 180) : c
      return v.wd !== undefined ? polarFrom(pts[0], c, dist(pts[0], pts[1]) + v.wd / 2, undefined) : c
    },
    live: (s, pts, end) => (s === 1 ? polarLive(pts[0], end, 'rad') : s === 2 ? { sw: deg(relAngle(Math.atan2(end[1] - pts[0][1], end[0] - pts[0][0]), Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]))) } : { wd: 2 * Math.abs(dist(end, pts[0]) - dist(pts[1], pts[0])) }),
  },
  arcT: { need: 2, build: (m, p) => drawTangentArc(m, p[0], p[1]) },
  conic: { need: 4, build: (m, p) => drawConic(m, p[0], p[1], p[2], p[3]) },
  polygon: {
    need: 2,
    build: (m, p, h) => {
      const r = drawPolygon(m, p[0], p[1], opts().sides, opts().polyKind)
      if (typeof r === 'string') return r
      if (opts().polyKind === 'edge') { const l = entityById(m, r.lines[0]) as LineE; dimFrom(m, h, 1, 'len', 'distance', [l.p1, l.p2]) }
      else if (opts().polyKind === 'inscribed') dimFrom(m, h, 1, 'rad', 'radius', [r.circle])
      return r
    },
    fields: (s) => (s === 1 ? polarFields(opts().polyKind === 'edge' ? 'Side length' : opts().polyKind === 'circumscribed' ? 'Apothem' : 'Radius', polygonField()) : []),
    resolve: (_s, pts, c, v) => polarFrom(pts[0], c, v[polygonField()], v.ang),
    live: (_s, pts, end) => polarLive(pts[0], end, polygonField()),
  },
  rect3: {
    need: 3,
    build: (m, p, h) => {
      const r = drawRect3(m, p[0], p[1], p[2])
      if (typeof r === 'string') return r
      dimFrom(m, h, 1, 'len', 'distance', [r.pts[0], r.pts[1]])
      const axis = Math.abs(p[1][1] - p[0][1]) < 1e-9 || Math.abs(p[1][0] - p[0][0]) < 1e-9
      if (!axis) dimFrom(m, h, 1, 'ang', 'angle', [r.pts[0], r.pts[1]])
      dimFrom(m, h, 2, 'wd', 'distance', [r.pts[1], r.pts[2]])
      return r
    },
    fields: (s) => (s === 1 ? polarFields('Length') : s === 2 ? widthFields() : []),
    resolve: (s, pts, c, v) => (s === 1 ? polarFrom(pts[0], c, v.len, v.ang) : v.wd !== undefined ? offLine(pts[0], pts[1], c, v.wd) : c),
    live: (s, pts, end) => (s === 1 ? polarLive(pts[0], end, 'len') : { wd: lineDist(end, pts[0], pts[1]) }),
  },
  circle2: {
    need: 2,
    build: (m, p, h) => {
      const c = drawCircle2(m, p[0], p[1])
      if (typeof c === 'string') return c
      dimFrom(m, h, 1, 'dia', 'diameter', [c.id])
      return c
    },
    fields: (s) => (s === 1 ? [F('dia', 'Diameter', 'mm')] : []),
    resolve: (_s, pts, c, v) => {
      const u = dist(c, pts[0]) < 1e-9 ? ([1, 0] as Vec2) : norm(sub(c, pts[0]))
      return v.dia !== undefined ? [pts[0][0] + u[0] * Math.abs(v.dia), pts[0][1] + u[1] * Math.abs(v.dia)] : c
    },
    live: (_s, pts, end) => ({ dia: dist(pts[0], end) }),
    bind: (m, c, snaps) => bindOnCircle(m, c as { id: string }, snaps),
  },
  circle3: {
    need: 3,
    build: (m, p) => drawCircle3(m, p[0], p[1], p[2]),
    bind: (m, c, snaps) => bindOnCircle(m, c as { id: string }, snaps),
  },
  arcC: {
    need: 3,
    build: (m, p, h) => {
      const sw = h[2]?.v.sw
      const arc = drawArcCentre(m, p[0], p[1], p[2], sw)
      if (typeof arc === 'string') return arc
      dimFrom(m, h, 1, 'rad', 'radius', [arc.id])
      return arc
    },
    fields: (s) => (s === 1 ? polarFields('Radius', 'rad') : s === 2 ? [F('sw', 'Sweep', 'deg')] : []),
    resolve: (s, pts, c, v) => {
      if (s === 1) return polarFrom(pts[0], c, v.rad, v.ang)
      const a0 = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0])
      return v.sw !== undefined ? polar(pts[0], dist(pts[0], pts[1]), a0 + (v.sw * Math.PI) / 180) : c
    },
    live: (s, pts, end) => (s === 1 ? polarLive(pts[0], end, 'rad') : { sw: deg(Math.atan2(cross(sub(pts[1], pts[0]), sub(end, pts[0])), dot(sub(pts[1], pts[0]), sub(end, pts[0])))) }),
  },
}

/** A circle drawn through points that were snapped to existing points passes through them, for good. */
function bindOnCircle(m: SketchModel, circle: { id: string }, snaps: Snap[]) {
  for (const s of snaps) {
    if (s.pointId && (s.kind === 'point' || s.kind === 'origin' || s.kind === 'center')) addConstraint(m, { type: 'pointOnCurve', refs: [s.pointId, circle.id] })
  }
}

let snaps: Snap[] = []
let hist: Hist = []
let lastRaw: Vec2 | null = null
let lastMods: Mods = { shift: false, ctrl: false }

function clickHandlers(id: ToolId, t: ClickTool): ToolHandlers {
  const pts = () => snaps.map((s) => s.pos)
  const fieldsAt = (stage: number) => (t.fields && stage > 0 ? t.fields(stage) : [])
  /** the typed boxes for the point being placed, and where that point lands */
  const aim = (raw: Vec2, mods: Mods) => {
    const stage = snaps.length
    const sn = K.snap(raw, mods, snaps[stage - 1]?.pos)
    const fields = fieldsAt(stage)
    const typed = fields.length ? box.sync(id, stage, fields) : null
    if (!typed) { box.typed = null; return { sn, end: sn.pos, typed: false } }
    const typedNow = hasText(typed)
    const end = typedNow ? t.resolve!(stage, pts(), sn.pos, valuesOf(typed)) : sn.pos
    return { sn: typedNow ? { pos: end, kind: 'free' as const, guides: [] } : sn, end, typed: typedNow }
  }
  const refresh = (raw: Vec2, mods: Mods) => {
    const stage = snaps.length
    const a = aim(raw, mods)
    K.set({ cursor: a.sn, hover: null })
    if (stage) {
      const h = [...hist.slice(0, stage), box.typed && a.typed ? box.typing() : { v: {}, t: {} }]
      showPreview(previewOf((m) => t.build(m, [...pts(), a.end, ...Array(Math.max(0, t.need - stage - 1)).fill(a.end)].slice(0, t.need), h)))
      box.show(a.end, t.live?.(stage, pts(), a.end) ?? {})
    } else box.show(null, {})
    K.invalidate()
  }
  const place = (raw: Vec2, mods: Mods) => {
    const stage = snaps.length
    const a = aim(raw, mods)
    hist[stage] = a.typed ? box.typing() : { v: {}, t: {} }
    snaps.push(a.sn)
    box.clear()
    if (snaps.length < t.need) { refresh(raw, mods); return }
    const taken = snaps, h = hist
    snaps = []
    hist = []
    clearPreview()
    const old = new Set(K.get().model.entities.map((e) => e.id))
    K.commit((m) => {
      const r = t.build(m, taken.map((s) => s.pos), h)
      if (typeof r === 'string') return r
      bindSnaps(m, old, taken)
      t.bind?.(m, r, taken)
      markConstruction(m, old)
    })
    K.set({ cursor: null })
  }
  return {
    start() { snaps = []; hist = []; box.clear(); clearPreview() },
    move(raw, _w, mods) { lastRaw = raw; lastMods = mods; refresh(raw, mods) },
    down(raw, _w, mods) { lastRaw = raw; lastMods = mods; place(raw, mods) },
    cancel() {
      if (box.has()) { box.typed = null; if (lastRaw) refresh(lastRaw, lastMods); return true }
      const had = snaps.length > 0
      snaps = []
      hist = []
      box.clear()
      clearPreview()
      return had
    },
    // Ctrl+Z takes back the last point only
    undoPoint() {
      if (!snaps.length) return false
      snaps.pop()
      hist.length = snaps.length
      box.typed = null
      if (lastRaw) refresh(lastRaw, lastMods); else { clearPreview(); box.clear() }
      return true
    },
    typed: {
      key: (e) => { const used = box.key(e, id, () => { if (lastRaw) place(lastRaw, lastMods) }); if (used && e.key !== 'Enter' && lastRaw) refresh(lastRaw, lastMods); return used },
      info: () => box.info(),
      set: (text) => { box.set(text); if (lastRaw) refresh(lastRaw, lastMods) },
      next: () => box.next(),
    },
  }
}

for (const [id, t] of Object.entries(CLICK_TOOLS) as [ToolId, ClickTool][]) extraTools[id] = clickHandlers(id, t)

// the Line tool: drag from the end of a line or arc for a tangent arc
tangentDrag.canStart = (m, at) => !!curveEndingAt(m, at)
tangentDrag.preview = (from, to) => {
  if (!to) { clearPreview(); return }
  showPreview(previewOf((m) => drawTangentArc(m, from, to)))
}
tangentDrag.make = (from, to) => {
  const old = new Set(K.get().model.entities.map((e) => e.id))
  K.commit((m) => {
    const r = drawTangentArc(m, from.pos, to.pos)
    if (typeof r === 'string') return r
    bindSnaps(m, old, [from, to])
    markConstruction(m, old)
  })
}

// ------------------------------------------------------------------------------------------------ splines

function splineHandlers(mode: 'fit' | 'ctrl'): ToolHandlers {
  const tool = mode === 'fit' ? 'spline' : 'splineC'
  const fields = () => (snaps.length ? [F('len', 'Length', 'mm'), F('ang', 'Angle', 'deg')] : [])
  const finish = (closed = false) => {
    const taken = snaps, h = hist
    snaps = []
    hist = []
    box.clear()
    clearPreview()
    if (taken.length < 2) return false
    const old = new Set(K.get().model.entities.map((e) => e.id))
    K.commit((m) => {
      const s = drawSpline(m, taken.map((p) => p.pos), mode, closed && taken.length >= 3, K.get().construction)
      bindSnaps(m, old, taken)
      // each point placed by length and angle from the one before keeps that length and angle
      for (let i = 1; i < s.pts.length; i++) {
        dimFrom(m, h, i, 'len', 'distance', [s.pts[i - 1], s.pts[i]])
        dimFrom(m, h, i, 'ang', 'angle', [s.pts[i - 1], s.pts[i]])
      }
    })
    return true
  }
  const aim = (raw: Vec2, mods: Mods) => {
    const last = snaps[snaps.length - 1]?.pos
    const sn = K.snap(raw, mods, last)
    const f = fields()
    if (!f.length) { box.typed = null; return { sn, end: sn.pos, typed: false } }
    const typed = box.sync(tool, snaps.length, f)
    if (!hasText(typed)) return { sn, end: sn.pos, typed: false }
    const end = polarFrom(last, sn.pos, valuesOf(typed).len, valuesOf(typed).ang)
    return { sn: { pos: end, kind: 'free' as const, guides: [] }, end, typed: true }
  }
  const refresh = (raw: Vec2, mods: Mods) => {
    const a = aim(raw, mods)
    K.set({ cursor: a.sn, hover: null })
    if (snaps.length) {
      showPreview(previewOf((m) => drawSpline(m, [...snaps.map((s) => s.pos), a.end], mode, false)), snaps.map((s) => s.pos))
      box.show(a.end, polarLive(snaps[snaps.length - 1].pos, a.end, 'len'))
    } else box.show(null, {})
    K.invalidate()
  }
  const place = (raw: Vec2, mods: Mods) => {
    const a = aim(raw, mods)
    // a click on the first point closes the curve
    if (snaps.length >= 3 && !a.typed && dist(a.sn.pos, snaps[0].pos) < K.wpp() * 8) { finish(true); return }
    hist[snaps.length] = a.typed ? box.typing() : { v: {}, t: {} }
    snaps.push(a.sn)
    box.clear()
    showPreview(previewOf((m) => drawSpline(m, snaps.map((s) => s.pos), mode, false)), snaps.map((s) => s.pos))
  }
  return {
    start() { snaps = []; hist = []; box.clear(); clearPreview() },
    move(raw, _w, mods) { lastRaw = raw; lastMods = mods; refresh(raw, mods) },
    down(raw, _w, mods) { lastRaw = raw; lastMods = mods; place(raw, mods) },
    dbl() { snaps.pop(); hist.length = snaps.length; finish(opts().splineClosed) },
    enter() { return finish(opts().splineClosed) },
    cancel() {
      // Esc and right click drop the curve; Enter or a double click finishes it
      if (box.has()) { box.typed = null; if (lastRaw) refresh(lastRaw, lastMods); return true }
      const had = snaps.length > 0
      snaps = []
      hist = []
      box.clear()
      clearPreview()
      return had
    },
    undoPoint() {
      if (!snaps.length) return false
      snaps.pop()
      hist.length = snaps.length
      box.typed = null
      if (snaps.length) showPreview(previewOf((m) => drawSpline(m, snaps.map((s) => s.pos), mode, false)), snaps.map((s) => s.pos))
      else clearPreview()
      if (lastRaw) refresh(lastRaw, lastMods)
      return true
    },
    typed: {
      key: (e) => { const used = box.key(e, tool, () => { if (lastRaw) place(lastRaw, lastMods) }); if (used && e.key !== 'Enter' && lastRaw) refresh(lastRaw, lastMods); return used },
      info: () => box.info(),
      set: (text) => { box.set(text); if (lastRaw) refresh(lastRaw, lastMods) },
      next: () => box.next(),
    },
  }
}
extraTools.spline = splineHandlers('fit')
extraTools.splineC = splineHandlers('ctrl')

// ------------------------------------------------------------------------------------------------ point

extraTools.point = {
  move(raw, _w, mods) { K.set({ cursor: K.snap(raw, mods), hover: null }); K.invalidate() },
  down(raw, _w, mods) {
    const sn = K.snap(raw, mods)
    if (sn.pointId && (sn.kind === 'point' || sn.kind === 'origin' || sn.kind === 'center')) { K.flash('There is already a point there'); return }
    K.commit((m) => { const old = new Set(m.entities.map((e) => e.id)); K.pointFor(m, sn); markConstruction(m, old) })
  },
}

// ------------------------------------------------------------------------------------------------ circle by two tangent curves

const tangentPicks: string[] = []
const targets = (id: string) => isTangentTarget(entityById(K.get().model, id))
extraTools.circle2T = {
  start() {
    tangentPicks.length = 0
    for (const id of K.get().sel) if (tangentPicks.length < 2 && targets(id)) tangentPicks.push(id)
    K.set({ picks: [...tangentPicks] })
    K.flash(tangentPicks.length === 2 ? 'Click where the circle should sit' : 'Click the two lines, circles or arcs the circle should touch')
  },
  move(raw, wpp) {
    const s = K.get()
    if (tangentPicks.length < 2) { K.set({ hover: hitTest(s.model, raw, 8 * wpp, (e) => isTangentTarget(e)), cursor: null }); clearPreview(); return }
    const [a, b] = tangentPicks.map((i) => entityById(s.model, i))
    const hit = isTangentTarget(a) && isTangentTarget(b) ? circleTouching(s.model, a, b, raw) : null
    showPreview(hit ? [sampleArc(hit.c, hit.r, 0, TAU, Math.PI / 48)] : [])
    K.set({ hover: null, cursor: { pos: raw, kind: 'free', guides: [] } })
  },
  down(raw, wpp) {
    const s = K.get()
    if (tangentPicks.length < 2) {
      const h = hitTest(s.model, raw, 8 * wpp, (e) => isTangentTarget(e))
      if (!h || tangentPicks.includes(h)) return
      tangentPicks.push(h)
      K.set({ picks: [...tangentPicks], sel: [...tangentPicks] })
      if (tangentPicks.length === 2) K.flash('Click where the circle should sit')
      return
    }
    const [a, b] = tangentPicks
    const ok = K.commit((m) => { const r = drawCircle2Tangent(m, a, b, raw, K.get().construction); return typeof r === 'string' ? r : undefined })
    if (ok) { tangentPicks.length = 0; K.set({ picks: [], sel: [] }); clearPreview(); K.flash('Pick two more curves, or press Esc') }
  },
  cancel() { const had = tangentPicks.length > 0; tangentPicks.length = 0; K.set({ picks: [] }); clearPreview(); return had },
}

// ------------------------------------------------------------------------------------------------ extend and break

const curveHover = (types: string[]) => (raw: Vec2, wpp: number) => {
  K.set({ hover: hitTest(K.get().model, raw, 8 * wpp, (e) => types.includes(e.type)), cursor: null })
  K.invalidate()
}
extraTools.extend = {
  move: curveHover(['line', 'arc']),
  down(raw, wpp) {
    const h = hitTest(K.get().model, raw, 8 * wpp, (e) => e.type === 'line' || e.type === 'arc')
    if (!h) return
    K.commit((m) => extendCurve(m, h, raw) ?? undefined)
  },
}
extraTools.break = {
  move: curveHover(['line', 'arc', 'circle']),
  down(raw, wpp) {
    const h = hitTest(K.get().model, raw, 8 * wpp, (e) => e.type === 'line' || e.type === 'arc' || e.type === 'circle')
    if (!h) return
    K.commit((m) => breakCurve(m, h, raw) ?? undefined)
  },
}

// ------------------------------------------------------------------------------------------------ fillet / chamfer

function cornerHandlers(kind: 'fillet' | 'chamfer'): ToolHandlers {
  let first: string | null = null
  const apply = (a: ReturnType<typeof entityById>, b: ReturnType<typeof entityById>) => {
    const o = opts()
    K.commit((m) => {
      const A = entityById(m, a!.id), B = entityById(m, b!.id)
      if (!isCornerCurve(A) || !isCornerCurve(B)) return 'Fillet and chamfer work on lines and arcs'
      const lines = A.type === 'line' && B.type === 'line'
      let r: string | object
      if (kind === 'fillet') r = lines ? filletCorner(m, A, B, o.filletR) : filletCurves(m, A, B, o.filletR)
      else if (o.chamferKind === 'angle') r = chamferAngle(m, A, B, o.chamferD, o.chamferAngle)
      else {
        const d2 = o.chamferKind === 'two' && o.chamferD2 > 0 ? o.chamferD2 : o.chamferD
        r = lines ? chamferCorner(m, A, B, o.chamferD, d2) : chamferCurves(m, A, B, o.chamferD, d2)
      }
      return typeof r === 'string' ? r : undefined
    })
    first = null
    K.set({ picks: [] })
  }
  const curve = (e: ReturnType<typeof entityById>) => (e?.type === 'line' || e?.type === 'arc' ? e : null)
  return {
    start() { first = null; K.set({ picks: [] }) },
    move(raw, wpp) { K.set({ hover: hitTest(K.get().model, raw, 8 * wpp), cursor: null }); K.invalidate() },
    down(raw, wpp) {
      const s = K.get()
      const h = hitTest(s.model, raw, 8 * wpp)
      if (!h) return
      const e = entityById(s.model, h)
      if (e?.type === 'point' || h === ORIGIN) {
        // a click on the corner point: the two lines / arcs that end there
        const at = pos(s.model, h)
        const here = s.model.entities.filter((x) => (x.type === 'line' || x.type === 'arc') && (x.type === 'line' ? [x.p1, x.p2] : [x.s, x.e]).some((p) => p === h || dist(pos(s.model, p), at) < 1e-6))
        if (here.length === 2) apply(here[0], here[1])
        else K.flash('Pick the two lines or arcs that meet at the corner, or click on the corner itself')
        return
      }
      if (!curve(e)) { K.flash('Fillet and chamfer work on the corner of two lines or arcs'); return }
      if (!first) { first = h; K.set({ picks: [h] }); return }
      if (first === h) return
      const a = entityById(s.model, first)
      if (!curve(a) || !cornerOfCurves(s.model, curve(a)!, curve(e)!)) { K.flash('The two curves must meet at a corner'); first = null; K.set({ picks: [] }); return }
      apply(a, e)
    },
    cancel() { const had = !!first; first = null; K.set({ picks: [] }); return had },
  }
}
extraTools.fillet = cornerHandlers('fillet')
extraTools.chamfer = cornerHandlers('chamfer')

// ------------------------------------------------------------------------------------------------ mirror, patterns and scale

const curveSelection = () => {
  const s = K.get()
  return s.sel.filter((id) => { const e = entityById(s.model, id); return e && e.type !== 'point' })
}
let mirrorSource: string[] = []
let patternSource: string[] = []
let scaleSource: string[] = []

/** Mirror, Circular Pattern and Scale take the curves first. With none selected the clicks pick them, and Enter (or the bar's button) moves on to the line / centre / base point. */
type Stage = 'curves' | 'target'
const stages: Partial<Record<ToolId, Stage>> = {}
const toggleCurve = (raw: Vec2, wpp: number) => {
  const s = K.get()
  const h = hitTest(s.model, raw, 8 * wpp, (e) => e.type !== 'point')
  if (!h) return
  K.set({ sel: s.sel.includes(h) ? s.sel.filter((i) => i !== h) : [...s.sel, h] })
  K.invalidate()
}
const NEXT_HINT: Partial<Record<ToolId, string>> = {
  mirror: 'Pick the line to mirror across', patternC: 'Click the point to turn about (or the origin)', scale: 'Click the point to scale about (or the origin)',
}
/** Done picking curves: on to the mirror line / the centre to turn about / the base point. Returns false when there is nothing to move on from. */
export function toolNext(): boolean {
  const tool = K.get().tool
  if (stages[tool] !== 'curves') return false
  const ids = curveSelection()
  if (!ids.length) { K.flash('Click the curves first'); return true }
  if (tool === 'mirror') mirrorSource = ids
  else if (tool === 'scale') scaleSource = ids
  else patternSource = ids
  stages[tool] = 'target'
  K.flash(NEXT_HINT[tool] ?? '')
  return true
}

extraTools.mirror = {
  start() {
    mirrorSource = curveSelection()
    stages.mirror = mirrorSource.length ? 'target' : 'curves'
    K.flash(mirrorSource.length ? 'Pick the line to mirror across' : 'Click the curves to mirror, then press Enter and pick the line')
  },
  move(raw, wpp) { K.set({ hover: hitTest(K.get().model, raw, 8 * wpp, stages.mirror === 'curves' ? (e) => e.type !== 'point' : (e) => e.type === 'line'), cursor: null }); K.invalidate() },
  down(raw, wpp) {
    if (stages.mirror === 'curves') { toggleCurve(raw, wpp); return }
    const s = K.get()
    // a drawn line, or a sketch axis
    const h = hitTest(s.model, raw, 8 * wpp, (e) => e.type === 'line') ?? axisHit(raw, 8 * wpp)
    if (!h) return
    const src = mirrorSource
    const ok = K.commit((m) => { const r = mirrorEntities(m, src, h); return typeof r === 'string' ? r : undefined })
    if (ok) setTool('select')
  },
  enter: toolNext,
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
  start() { if (!curveSelection().length) K.flash('Click the curves to repeat, then set the counts and press Apply') },
  move(raw, wpp) { K.set({ hover: hitTest(K.get().model, raw, 8 * wpp, (e) => e.type !== 'point'), cursor: null }); K.invalidate() },
  // a click adds a curve to the ones being repeated, or takes it out again
  down(raw, wpp) { toggleCurve(raw, wpp) },
  enter() { if (!curveSelection().length) return false; applyPatternR(); return true },
}

extraTools.patternC = {
  start() {
    patternSource = curveSelection()
    stages.patternC = patternSource.length ? 'target' : 'curves'
    K.flash(patternSource.length ? 'Click the point to turn about (or the origin)' : 'Click the curves to repeat, then press Enter and pick the centre')
  },
  move(raw, wpp, mods) {
    if (stages.patternC === 'curves') { K.set({ hover: hitTest(K.get().model, raw, 8 * wpp, (e) => e.type !== 'point'), cursor: null }); K.invalidate(); return }
    const sn = K.snap(raw, mods); K.set({ cursor: sn, hover: null }); K.invalidate()
  },
  down(raw, wpp, mods) {
    if (stages.patternC === 'curves') { toggleCurve(raw, wpp); return }
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
  enter: toolNext,
}

/** Move or copy the selected curves by the amounts in the bar: turned about their middle, then shifted. */
export function applyMoveCopy(): boolean {
  const o = opts()
  const ids = curveSelection()
  if (!ids.length) { K.flash('Click the curves to move or copy first'); return false }
  let made: string[] = []
  const ok = K.commit((m) => {
    if (!o.moveCopy) return moveCurves(m, { ids, dx: o.moveX, dy: o.moveY, angle: o.moveAngle }) ?? undefined
    if (Math.abs(o.moveX) < 1e-12 && Math.abs(o.moveY) < 1e-12 && Math.abs(o.moveAngle) < 1e-12) return 'Set a distance or an angle to copy by'
    made = duplicateCurves(m, ids, transformOf(m, ids, { dx: o.moveX, dy: o.moveY, angle: o.moveAngle }), m, o.moveAngle)
  })
  if (ok && made.length) K.set({ sel: made })
  return ok
}
extraTools.moveCopy = {
  start() { K.flash(curveSelection().length ? 'Set the distance and angle, then press Apply' : 'Click the curves to move or copy, then set the distance and angle') },
  move(raw, wpp) { K.set({ hover: hitTest(K.get().model, raw, 8 * wpp, (e) => e.type !== 'point'), cursor: null }); K.invalidate() },
  down(raw, wpp) { toggleCurve(raw, wpp) },
  enter() { if (!curveSelection().length) return false; applyMoveCopy(); return true },
}

extraTools.scale = {
  start() {
    scaleSource = curveSelection()
    stages.scale = scaleSource.length ? 'target' : 'curves'
    K.flash(scaleSource.length ? 'Click the point to scale about (or the origin)' : 'Click the curves to scale, then press Enter and pick the base point')
  },
  move(raw, wpp, mods) {
    if (stages.scale === 'curves') { K.set({ hover: hitTest(K.get().model, raw, 8 * wpp, (e) => e.type !== 'point'), cursor: null }); K.invalidate(); return }
    const sn = K.snap(raw, mods); K.set({ cursor: sn, hover: null }); K.invalidate()
  },
  down(raw, wpp, mods) {
    if (stages.scale === 'curves') { toggleCurve(raw, wpp); return }
    const sn = K.snap(raw, mods)
    const src = scaleSource
    const ok = K.commit((m) => scaleCurves(m, { ids: src, base: sn.pos, factor: opts().scaleF }) ?? undefined)
    if (ok) setTool('select')
  },
  enter: toolNext,
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
