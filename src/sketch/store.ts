/**
 * Sketch editing session: model, tools, selection, dragging, history. The viewport overlay renders this state and
 * forwards pointer events to the functions at the bottom.
 */
import { create } from 'zustand'
import { evalNumber } from '@/doc/params'
import { useDoc } from '@/doc/store'
import { getKernel } from '@/kernel/client'
import type { ProjectedCurve } from '@/kernel/sketch-ops'
import { useUi, type SelectionRef } from '@/store/ui'
import { viewportBus } from '@/viewport/bus'
import { applyConstraint, ready, type CKind } from './constraints'
import { defaultOff, measure, refreshDims } from './dims'
import {
  addArc, addCircle, addCoincident, addConstraint, addLine, addPoint, cloneModel, entityById, entityPoints, lineEnds, pos, removeIds, tangentValue,
} from './model'
import { boxSelect, hitTest } from './hit'
import { detectProfiles } from './profiles'
import { snap as snapAt, gridStep, type Snap } from './snap'
import { inferSnap, type Rel } from './infer'
import { ensureFonts } from './curves'
import { useDevice } from '@/app/device'
import { useSnapFlags } from './snapSettings'
import { analyze, ensureSolver, solveModel, solvePruned, type DragSpec, type SolveInfo } from './solver'
import { circumcircle, cross, dist, norm, sub } from './geom'
import { applyOffset, collectChain, sideOf, type Chain } from './offsetTool'
import { encodeRef, refFromSelection } from '@/doc/refs'
import { addProjected, reprojectModel } from './project'
import { applyTrim, prepareTrim, trimSpan } from './trim'
import {
  arcThrough, fieldsFor, hasText, resolveEnd, valuesOf, wrapDeg, type DrawTool, type Typed, type Values,
} from './typed'
import { ORIGIN, emptyModel, type Constraint, type ConstraintType, type PlaneDef, type Profile, type SketchModel, type Vec2 } from './types'

export type ToolId =
  | 'select' | 'line' | 'rect' | 'rectC' | 'circle' | 'arc' | 'dimension' | 'constraint' | 'trim' | 'offset' | 'project'
  | 'spline' | 'splineC' | 'ellipse' | 'slotCC' | 'slotOv' | 'slotArc' | 'polygon' | 'fillet' | 'chamfer' | 'mirror' | 'patternR' | 'patternC' | 'text' | 'arcT'

/**
 * Handlers of the tools that live outside this file (sketch/toolsUi.ts). A tool registered here gets the pointer and keyboard
 * events while it is active, and `reset` when it is left or cancelled.
 */
export interface ToolHandlers {
  start?(): void
  move?(raw: Vec2, wpp: number, mods: Mods): void
  down?(raw: Vec2, wpp: number, mods: Mods): void
  dbl?(raw: Vec2, wpp: number): void
  /** Enter: finish what is in progress; returns true when it did something */
  enter?(): boolean
  /** Escape / right click: drop what is in progress; returns true when there was something to drop */
  cancel?(): boolean
}
export const extraTools: Partial<Record<ToolId, ToolHandlers>> = {}
/** The pieces of this file the extra tools build on. */
export const sketchInternals = {
  get: () => get(),
  set: (p: Partial<SketchState>) => set(p),
  commit: (fn: (m: SketchModel) => string | void, opts?: { strict?: boolean }) => commit(fn, opts),
  flash: (msg: string) => flash(msg),
  snap: (raw: Vec2, mods: Mods, anchor?: Vec2) => doSnap(raw, mods, anchor),
  pointFor: (m: SketchModel, s: Snap) => pointFor(m, s),
  wpp: () => wppNow,
  invalidate: () => invalidate(),
}

export interface Draft {
  tool: ToolId
  pts: Vec2[]
  snaps: Snap[]
  chainStart?: string
  /** arc: the chord length / angle typed for the first two points, applied as dimensions when the arc is made */
  pend?: { len?: string; ang?: string }
}
export interface Mods { shift: boolean; ctrl: boolean }
/** A chain picked with the Offset tool, previewed at signed distance `d` (left of travel; for a circle: outward). */
export interface OffsetSession { chain: Chain; d: number }

const emptyInfo = (): SolveInfo => ({ ok: true, status: -1, dof: 1, conflicts: [], redundant: [], fixed: new Set() })

export interface SketchState {
  active: boolean
  editing: string | null
  face: string | null
  plane: PlaneDef
  model: SketchModel
  info: SolveInfo
  profiles: Profile[]
  tool: ToolId
  ckind: CKind | null
  construction: boolean
  sel: string[]
  hover: string | null
  cursor: Snap | null
  draft: Draft | null
  /** values being typed for the current draft (or offset) */
  typed: Typed | null
  /** Trim: the piece that would be removed under the cursor */
  trimHover: Vec2[] | null
  offset: OffsetSession | null
  picks: string[]
  placing: Constraint | null
  dimEdit: string | null
  dimNew: boolean
  box: [Vec2, Vec2] | null
  dragging: boolean
  status: string | null
  badDims: string[]
  past: SketchModel[]
  future: SketchModel[]
}

const initial = (): SketchState => ({
  active: false, editing: null, face: null,
  plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
  model: emptyModel(), info: emptyInfo(), profiles: [],
  tool: 'select', ckind: null, construction: false,
  sel: [], hover: null, cursor: null, draft: null, typed: null, trimHover: null, offset: null, picks: [], placing: null, dimEdit: null, dimNew: false,
  box: null, dragging: false,
  status: null, badDims: [], past: [], future: [],
})

export const useSketch = create<SketchState>(() => initial())
const get = useSketch.getState
const set = useSketch.setState

let onClose: (() => void) | null = null
let wppNow = 1
let flashTimer: ReturnType<typeof setTimeout> | undefined

export function flash(msg: string) {
  set({ status: msg })
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => set({ status: null }), 3200)
  invalidate()
}
function invalidate() {
  viewportBus.emit('redraw', undefined)
}

// ---------------------------------------------------------------- solving

interface Solved { model: SketchModel; info: SolveInfo; profiles: Profile[]; bad: string[] }
/** Evaluate dimension expressions, solve, and work out what is fully constrained and which profiles exist. */
export function solveFull(model: SketchModel): Solved {
  const m0 = cloneModel(model)
  const bad = refreshDims(m0)
  const r = solveModel(m0)
  r.info.fixed = r.info.ok ? analyze(r.model, r.info) : new Set()
  return { model: r.model, info: r.info, profiles: detectProfiles(r.model), bad }
}

/**
 * Apply a mutation to a copy of the model, solve, and keep it if consistent.
 *  - contradicting constraints: the edit is refused and nothing changes
 *  - a new constraint implied by the others: refused when `strict` (constraints / dimensions the user asked for),
 *    silently dropped otherwise (constraints a tool adds on its own)
 */
export function commit(fn: (m: SketchModel) => string | void, opts: { strict?: boolean } = {}): boolean {
  const s = get()
  const draft = cloneModel(s.model)
  const existing = new Set(s.model.constraints.map((c) => c.id))
  const err = fn(draft)
  if (typeof err === 'string') { flash(err); return false }
  const bad = refreshDims(draft)
  const p = solvePruned(draft, existing, opts.strict)
  if (p.overConstrained) { flash('That is already fully determined by the existing constraints'); return false }
  if (!p.info.ok || p.info.conflicts.length) {
    flash(p.info.conflicts.length ? 'Conflicts with existing constraints' : 'Could not solve the sketch')
    return false
  }
  p.info.fixed = analyze(p.model, p.info)
  const profiles = detectProfiles(p.model)
  const ids = new Set([...p.model.entities.map((e) => e.id), ...p.model.constraints.map((c) => c.id)])
  set({
    model: p.model, info: p.info, profiles, badDims: bad,
    past: [...s.past.slice(-100), s.model], future: [],
    sel: s.sel.filter((i) => ids.has(i)),
  })
  invalidate()
  return true
}

/** The drafts of a polyline, one per point placed: "Undo point" (the touch layout has no Escape) steps back through them. */
const draftStack: Draft[] = []
/** A dimension just placed whose value box opens when the mouse button comes up. */
let pendingDim: string | null = null

function resetTransient(extra: Partial<SketchState> = {}) {
  pendingDim = null
  draftStack.length = 0
  woken.clear()
  lastDir = null
  set({ draft: null, typed: null, picks: [], placing: null, dimEdit: null, trimHover: null, offset: null, ...extra })
}

export function undoSketch() {
  const s = get()
  const prev = s.past[s.past.length - 1]
  if (!prev) return
  const r = solveFull(prev)
  set({ model: r.model, info: r.info, profiles: r.profiles, past: s.past.slice(0, -1), future: [s.model, ...s.future], sel: [] })
  resetTransient()
  invalidate()
}
export function redoSketch() {
  const s = get()
  const next = s.future[0]
  if (!next) return
  const r = solveFull(next)
  set({ model: r.model, info: r.info, profiles: r.profiles, past: [...s.past, s.model], future: s.future.slice(1), sel: [] })
  resetTransient()
  invalidate()
}

// ---------------------------------------------------------------- session

export const sketchActive = () => get().active

export async function beginSketch(o: { plane: PlaneDef; face?: string | null; model?: SketchModel; editing?: string | null; onClose?: () => void }) {
  await ensureSolver()
  if (o.model) await ensureFonts(o.model)
  onClose = o.onClose ?? null
  const model = o.model ?? emptyModel()
  // projected geometry follows its source: refresh it against the bodies as they are now (a broken source is flagged, never fatal)
  if (model.projections?.length) {
    try { await reprojectModel(model, o.plane, useDoc.getState().geometry, (n, a) => getKernel().call(n, a as never)) } catch { /* keep the stored geometry */ }
  }
  const r = solveFull(model)
  set({
    ...initial(), active: true, editing: o.editing ?? null, face: o.face ?? null, plane: o.plane,
    model: r.model, info: r.info, profiles: r.profiles, badDims: r.bad, tool: o.model ? 'select' : 'line',
  })
  const ui = useUi.getState()
  ui.clearSelection()
  ui.setSketchMode(true)
  ui.setActiveTool(o.model ? null : 'sketch.line')
  const n = o.plane.normal
  if (n[2] > 0.9999) viewportBus.emit('view', 'top')
  else if (n[2] < -0.9999) viewportBus.emit('view', 'bottom')
  else viewportBus.emit('viewVec', n)
  invalidate()
}

export function sketchParams(s = get()): Record<string, string> {
  return { sketch: JSON.stringify({ plane: s.plane, face: s.face, model: s.model }) }
}

function close() {
  const cb = onClose
  onClose = null
  watchProject(false)
  set(initial())
  const ui = useUi.getState()
  ui.setSketchMode(false)
  ui.setActiveTool(null)
  cb?.()
  invalidate()
}

export function finishSketch() {
  const s = get()
  if (!s.active) return
  if (s.dimEdit) set({ dimEdit: null })
  const empty = s.model.entities.length === 0
  if (s.editing) useDoc.getState().updateFeature(s.editing, sketchParams(s))
  else if (!empty) useDoc.getState().addFeature('sketch', sketchParams(s))
  close()
}
export function cancelSketch() {
  if (get().active) close()
}

// ---------------------------------------------------------------- tools

export function setTool(tool: ToolId, ckind: CKind | null = null) {
  extraTools[get().tool]?.cancel?.()
  watchProject(tool === 'project')
  resetTransient({ tool, ckind, box: null })
  const id = tool === 'select' ? null : tool in extraTools ? 'sketch.' + tool : tool === 'constraint' && ckind ? 'sketch.' + (ckind === 'hv' ? 'horizontal' : ckind) : tool === 'dimension' ? 'sketch.dimension' : tool === 'rectC' ? 'sketch.rectCenter' : 'sketch.' + tool
  useUi.getState().setActiveTool(id)
  extraTools[tool]?.start?.()
  if (tool === 'offset') {
    // an already selected curve starts the offset straight away
    const s = get()
    const first = s.sel.find((i) => { const e = entityById(s.model, i); return e && e.type !== 'point' })
    if (first) startOffset(first)
  }
  invalidate()
}

/** Constraint command: apply to the current selection if complete, otherwise wait for picks. */
export function runConstraintCommand(kind: CKind) {
  const s = get()
  const ids = s.sel.filter((i) => !s.model.constraints.some((c) => c.id === i))
  if (ready(s.model, kind, ids)) {
    const err = { v: null as string | null }
    commit((m) => { err.v = applyConstraint(m, kind, ids); return err.v ?? undefined }, { strict: true })
    return
  }
  setTool('constraint', kind)
}

export function toggleConstruction() {
  const s = get()
  const curves = s.sel.filter((i) => { const e = entityById(s.model, i); return e && e.type !== 'point' })
  if (!curves.length) { set({ construction: !s.construction }); flash(get().construction ? 'Construction mode on' : 'Construction mode off'); return }
  commit((m) => {
    for (const id of curves) { const e = entityById(m, id); if (e && e.type !== 'point') e.construction = !e.construction || undefined }
  })
}

export function deleteSelection() {
  const s = get()
  if (s.dimEdit) return
  if (!s.sel.length) return
  const sel = s.sel.filter((i) => i !== ORIGIN)
  commit((m) => removeIds(m, sel))
  set({ sel: [] })
}

/**
 * Enter: commit a typed value (handled by typedKey); otherwise end what is in progress - the open polyline / shape, then the
 * active tool - and, with no tool active, finish the sketch.
 */
export function enterSketch() {
  const s = get()
  if (!s.active || s.dimEdit) return
  if (extraTools[s.tool]?.enter?.()) return
  if (s.draft || s.picks.length || s.placing || s.offset) { resetTransient(); invalidate(); return }
  if (s.tool !== 'select') { setTool('select'); return }
  finishSketch()
}

/** Escape: cancel typed values, then the draft / placing / offset, then the tool, then the selection. */
export function escapeSketch() {
  const s = get()
  if (s.dimEdit) { cancelDimEdit(); return }
  if (extraTools[s.tool]?.cancel?.()) { invalidate(); return }
  if (s.typed && hasText(s.typed)) { set({ typed: { ...s.typed, fields: s.typed.fields.map((f) => ({ ...f, text: '' })), active: 0 } }); invalidate(); return }
  if (s.draft || s.picks.length || s.placing || s.offset) { resetTransient(); invalidate(); return }
  if (s.tool !== 'select') { setTool('select'); return }
  if (s.sel.length) set({ sel: [] })
  invalidate()
}

export function select(ids: string[], additive = false) {
  set((s) => {
    if (!additive) return { sel: ids }
    const out = [...s.sel]
    for (const id of ids) { const i = out.indexOf(id); if (i >= 0) out.splice(i, 1); else out.push(id) }
    return { sel: out }
  })
  invalidate()
}

// -------- dimension editing

export function editDim(id: string, isNew = false) {
  set({ dimEdit: id, dimNew: isNew, sel: [id] })
  invalidate()
}
export function cancelDimEdit() {
  const s = get()
  if (s.dimEdit && s.dimNew) commit((m) => removeIds(m, [s.dimEdit!]))
  set({ dimEdit: null, dimNew: false })
  invalidate()
}
export function applyDimEdit(id: string, text: string): boolean {
  const ok = commit((m) => {
    const c = m.constraints.find((x) => x.id === id)
    if (!c) return
    // dimensions created together (an offset) follow one value
    for (const k of m.constraints) if (k.id === id || (c.group && k.group === c.group)) k.expr = text
    if (refreshDims(m).includes(id)) return 'Invalid expression'
  })
  if (ok) { set({ dimEdit: null, dimNew: false }); invalidate() }
  return ok
}

// -------- snapping helpers

/** Curves the cursor has passed over while drawing: reference geometry for inference. */
const woken = new Set<string>()
let lastDir: Vec2 | null = null

function doSnap(raw: Vec2, mods: Mods, anchor?: Vec2, exclude?: Set<string>, anchorId?: string): Snap {
  // Ctrl holds all snapping and inference off for as long as it is down
  if (mods.ctrl) return { pos: raw, kind: 'free', guides: [] }
  const ctx = { model: get().model, wpp: wppNow, grid: useUi.getState().snap, anchor, exclude }
  const flags = useSnapFlags.getState().flags
  const r = inferSnap(raw, { ...ctx, flags, anchorId, woken, lock: mods.shift && lastDir ? { dir: lastDir } : null })
  if (!(mods.shift && lastDir)) lastDir = r.dir ?? null
  // starting a circle or arc on the centre of another one makes them concentric (the new centre is bound to the old)
  const t = get().tool
  if (r.kind === 'center' && (t === 'circle' || t === 'arc') && !get().draft && flags.coincident) return { ...r, hint: 'Concentric' }
  return r
}

/** Constraints for the relations inferred for a new line from p1 to p2. */
function applyRelations(m: SketchModel, line: string, p1: string, p2: string, rel: Rel[] | undefined) {
  for (const r of rel ?? []) {
    if (r.type === 'horizontal' || r.type === 'vertical') continue // placed by the caller
    if (r.type === 'parallel' || r.type === 'perpendicular' || r.type === 'equal') addConstraint(m, { type: r.type, refs: [line, r.ref] })
    else if (r.type === 'radial') addConstraint(m, { type: 'pointOnLine', refs: [r.center, line] })
    else if (r.type === 'collinear') {
      addConstraint(m, { type: 'parallel', refs: [line, r.ref] })
      addConstraint(m, { type: 'pointOnLine', refs: [p1, r.ref] })
    } else if (r.type === 'tangent') {
      if (r.at) addConstraint(m, { type: 'tangentAt', refs: [r.ref, line, p1], value: tangentValue(m, r.ref, line, p1) })
      else {
        addConstraint(m, { type: 'tangent', refs: [line, r.ref] })
        addConstraint(m, { type: 'pointOnCurve', refs: [p2, r.ref] })
      }
    }
  }
}

/**
 * Create the point a snap refers to. Snapping onto an existing point / centre / the origin makes a NEW point bound to
 * it by a coincident constraint (a real constraint: visible as a glyph and deletable); on-curve, midpoint and axis
 * snaps bind the new point with the matching constraint.
 */
function pointFor(m: SketchModel, s: Snap): string {
  const id = addPoint(m, s.pos[0], s.pos[1])
  if (s.pointId && (s.kind === 'point' || s.kind === 'origin' || s.kind === 'center')) { addCoincident(m, id, s.pointId); return id }
  if (s.kind === 'quad' && s.entityId && s.quad) {
    addConstraint(m, { type: 'pointOnCurve', refs: [id, s.entityId] })
    addConstraint(m, { type: s.quad.axis === 'h' ? 'horizontal' : 'vertical', refs: [id, s.quad.center] })
    return id
  }
  if (s.kind === 'int' && s.entityIds) {
    for (const eid of s.entityIds) { const t = entityById(m, eid); if (t) addConstraint(m, { type: t.type === 'line' ? 'pointOnLine' : 'pointOnCurve', refs: [id, eid] }) }
    return id
  }
  const e = s.entityId ? entityById(m, s.entityId) : undefined
  if (s.kind === 'mid' && e) addConstraint(m, { type: 'midpoint', refs: [id, e.id] })
  else if (s.kind === 'on' && e) addConstraint(m, { type: e.type === 'line' ? 'pointOnLine' : 'pointOnCurve', refs: [id, e.id] })
  else if (s.kind === 'axis' && s.axis) addConstraint(m, { type: 'onAxis', refs: [id], axis: s.axis })
  return id
}

// -------- pointer handling

interface DragState { id: string; start: Vec2; orig: Record<string, Vec2>; started: boolean; downPx: Vec2 }
let drag: DragState | null = null
let boxStart: Vec2 | null = null

/** Pick tolerance in pixels: a fingertip needs twice what a mouse pointer does. */
const tolPx = () => (useDevice.getState().coarse ? 16 : 8)
const curvesOnly = (e: { type: string }) => e.type !== 'point'
const DRAW: ToolId[] = ['line', 'rect', 'rectC', 'circle', 'arc']
const isDraw = (t: ToolId): t is DrawTool & ToolId => DRAW.includes(t)

export function pointerMove(raw: Vec2, wpp: number, mods: Mods) {
  wppNow = wpp
  const s = get()
  if (!s.active) return
  const tool = s.tool

  if (drag) { dragMove(raw, mods); return }
  if (boxStart) { set({ box: [boxStart, raw] }); invalidate(); return }
  const extra = extraTools[tool]
  if (extra) { extra.move?.(raw, wpp, mods); return }

  if (tool === 'select' || tool === 'constraint') {
    const h = hitTest(s.model, raw, tolPx() * wpp)
    if (h !== s.hover) set({ hover: h })
    set({ cursor: null })
    invalidate()
    return
  }
  if (tool === 'dimension') {
    const h = hitTest(s.model, raw, tolPx() * wpp)
    set({ hover: h, cursor: null, placing: s.picks.length ? previewDim(s, raw, mods) : null })
    invalidate()
    return
  }
  if (tool === 'trim') {
    const h = hitTest(s.model, raw, tolPx() * wpp, curvesOnly)
    const span = h ? trimSpan(s.model, h, raw) : null
    set({ hover: h, cursor: null, trimHover: span ? span.poly : null })
    invalidate()
    return
  }
  if (tool === 'offset') {
    if (!s.offset) {
      set({ hover: hitTest(s.model, raw, tolPx() * wpp, curvesOnly), cursor: null })
    } else {
      const { side, distance } = sideOf(s.model, s.offset.chain, raw)
      const typedV = valuesOf(s.typed).dist
      let mag = typedV !== undefined ? Math.abs(typedV) : distance
      if (typedV === undefined && useUi.getState().snap && !mods.ctrl) mag = Math.round(mag / gridStep(wpp)) * gridStep(wpp)
      set({ offset: { ...s.offset, d: side * mag }, cursor: { pos: raw, kind: 'free', guides: [] } })
    }
    invalidate()
    return
  }
  if (tool === 'project') { set({ cursor: null }); return }
  const d = s.draft
  const anchor = d ? (tool === 'line' ? d.pts[d.pts.length - 1] : undefined) : undefined
  // hovering over a curve wakes it up as reference geometry for the inference
  const over = hitTest(s.model, raw, 12 * wpp, curvesOnly)
  if (over) woken.add(over)
  const anchorId = d && tool === 'line' ? d.snaps[d.snaps.length - 1]?.pointId : undefined
  const sn = doSnap(raw, mods, anchor, undefined, anchorId)
  set({ cursor: sn, hover: sn.refs?.[0] ?? null })
  invalidate()
}

export function pointerDown(raw: Vec2, wpp: number, mods: Mods, px: Vec2) {
  wppNow = wpp
  const s = get()
  if (!s.active) return
  const extra = extraTools[s.tool]
  if (extra) { extra.down?.(raw, wpp, mods); return }
  switch (s.tool) {
    case 'select': return downSelect(raw, mods, px)
    case 'constraint': return downConstraint(raw, mods)
    case 'dimension': return downDimension(raw, mods)
    case 'trim': return downTrim(raw)
    case 'offset': return downOffset(raw)
    case 'project': return
    default: return downDraw(raw, mods)
  }
}

export function pointerUp(raw: Vec2, wpp: number, mods: Mods) {
  wppNow = wpp
  if (pendingDim) {
    const id = pendingDim
    pendingDim = null
    if (get().model.constraints.some((c) => c.id === id)) editDim(id, true)
  }
  if (drag) { dragEnd(raw, mods); return }
  if (boxStart) {
    const b = get().box
    boxStart = null
    set({ box: null })
    if (b && dist(b[0], b[1]) > 3 * wpp) select(boxSelect(get().model, b[0], b[1]), mods.shift)
    else if (!mods.shift) select([])
    invalidate()
  }
}

export function doubleClick(raw: Vec2, wpp: number) {
  wppNow = wpp
  const s = get()
  if (!s.active) return
  const extra = extraTools[s.tool]
  if (extra?.dbl) { extra.dbl(raw, wpp); return }
  if (s.tool === 'line' && s.draft) { resetTransient(); invalidate(); return }
  if (s.tool === 'select') {
    const h = hitTest(s.model, raw, tolPx() * wpp)
    const c = s.model.constraints.find((k) => k.id === h)
    if (c) editDim(c.id)
  }
}

export function rightClick() {
  const s = get()
  if (extraTools[s.tool]?.cancel?.()) { invalidate(); return }
  if (s.draft || s.picks.length || s.offset) { resetTransient(); invalidate() }
  else if (s.tool !== 'select') setTool('select')
}

// ---- select tool

function downSelect(raw: Vec2, mods: Mods, px: Vec2) {
  const s = get()
  const h = hitTest(s.model, raw, tolPx() * wppNow)
  if (!h) { boxStart = raw; set({ box: [raw, raw] }); return }
  if (mods.shift) select([h], true)
  else if (!s.sel.includes(h)) select([h])
  if (h === ORIGIN) return
  const e = entityById(s.model, h)
  if (!e) return
  if (e.ref) return // projected geometry is locked in place: selectable, never dragged
  const orig: Record<string, Vec2> = {}
  for (const p of entityPoints(s.model, h)) orig[p] = pos(s.model, p)
  drag = { id: h, start: raw, orig, started: false, downPx: px }
}

function dragMove(raw: Vec2, mods: Mods) {
  const d = drag!
  const s = get()
  if (!d.started) {
    if (dist(raw, d.start) < 3 * wppNow) return
    d.started = true
    set({ dragging: true })
    // history entry for the whole drag
    set({ past: [...s.past.slice(-100), s.model], future: [] })
  }
  const e = entityById(s.model, d.id)
  if (!e) return
  const spec: DragSpec = {}
  if (e.type === 'point') {
    const sn = doSnap(raw, mods, undefined, new Set([d.id]))
    spec.points = { [d.id]: sn.pos }
    set({ cursor: sn })
  } else if (e.type === 'line') {
    const dx = raw[0] - d.start[0], dy = raw[1] - d.start[1]
    spec.points = {}
    for (const [id, p] of Object.entries(d.orig)) spec.points[id] = [p[0] + dx, p[1] + dy]
  } else {
    spec.curve = { id: d.id, to: raw }
  }
  const r = solveModel(s.model, spec)
  if (r.info.ok) set({ model: r.model, profiles: detectProfiles(r.model) })
  invalidate()
}

function dragEnd(raw: Vec2, mods: Mods) {
  const d = drag!
  drag = null
  const s = get()
  set({ dragging: false, cursor: null })
  if (!d.started) return
  const e = entityById(s.model, d.id)
  let model = s.model
  if (e?.type === 'point') {
    const sn = doSnap(raw, mods, undefined, new Set([d.id]))
    const m = cloneModel(model)
    if (sn.pointId && (sn.kind === 'point' || sn.kind === 'origin' || sn.kind === 'center') && sn.pointId !== d.id) addCoincident(m, sn.pointId, d.id)
    else if (sn.kind === 'on' && sn.entityId) {
      const t = entityById(m, sn.entityId)
      if (t && !entityPoints(m, t.id).includes(d.id)) addConstraint(m, { type: t.type === 'line' ? 'pointOnLine' : 'pointOnCurve', refs: [d.id, t.id] })
    } else if (sn.kind === 'axis' && sn.axis) addConstraint(m, { type: 'onAxis', refs: [d.id], axis: sn.axis })
    model = m
  }
  const existing = new Set(s.model.constraints.map((c) => c.id))
  const p = solvePruned(refreshed(model), existing)
  if (!p.info.ok || p.info.conflicts.length) {
    // fall back to the pre-drag state
    const prev = s.past[s.past.length - 1]
    if (prev) { const pr = solveFull(prev); set({ model: pr.model, info: pr.info, profiles: pr.profiles, past: s.past.slice(0, -1) }) }
    flash('Move conflicts with constraints')
  } else {
    p.info.fixed = analyze(p.model, p.info)
    set({ model: p.model, info: p.info, profiles: detectProfiles(p.model), badDims: [] })
  }
  invalidate()
}
function refreshed(m: SketchModel): SketchModel {
  const c = cloneModel(m)
  refreshDims(c)
  return c
}

// ---- constraint tool

function downConstraint(raw: Vec2, mods: Mods) {
  const s = get()
  if (!s.ckind) return
  const h = hitTest(s.model, raw, tolPx() * wppNow)
  if (!h) return
  const picks = [...s.picks, h]
  if (ready(s.model, s.ckind, picks) || (s.ckind === 'fix')) {
    if (s.ckind === 'fix') {
      commit((m) => applyConstraint(m, 'fix', [h]) ?? undefined, { strict: true })
      set({ picks: [] })
    } else {
      commit((m) => applyConstraint(m, s.ckind!, picks) ?? undefined, { strict: true })
      set({ picks: [] })
    }
    return
  }
  // an incomplete or invalid pair: keep only the latest pick if the pair is nonsense
  if (picks.length >= 2) { flash('Pick valid entities'); set({ picks: [h] }); return }
  set({ picks })
  void mods
}

// ---- dimension tool

const isCurveT = (t?: string) => t === 'circle' || t === 'arc'

function placeReady(m: SketchModel, picks: string[]) {
  const t = picks.map((p) => (p === ORIGIN ? 'point' : entityById(m, p)?.type))
  if (picks.length === 1) return t[0] === 'line' || isCurveT(t[0])
  if (picks.length === 2) return (t[0] === 'point' && t[1] === 'point') || (t[0] === 'point' && t[1] === 'line') || (t[0] === 'line' && t[1] === 'line')
  return false
}

function dimFor(m: SketchModel, picks: string[], at: Vec2, k: number): Omit<Constraint, 'id'> | null {
  const t = picks.map((p) => (p === ORIGIN ? 'point' : entityById(m, p)?.type))
  let type: ConstraintType
  let refs: string[]
  if (picks.length === 1 && t[0] === 'line') {
    const l = entityById(m, picks[0])
    if (l?.type !== 'line') return null
    refs = [l.p1, l.p2]
    type = pairType(m, refs, at)
  } else if (picks.length === 1) {
    type = t[0] === 'circle' ? 'diameter' : 'radius'
    refs = picks
  } else if (t[0] === 'point' && t[1] === 'point') {
    refs = picks
    type = pairType(m, refs, at)
  } else if (t[0] === 'point' && t[1] === 'line') {
    refs = picks
    type = 'distance'
  } else if (t[0] === 'line' && t[1] === 'line') {
    refs = picks
    type = 'angle'
  } else return null
  const me = measure(m, type, refs)
  if (!me) return null
  const off: Vec2 = type === 'hdist' || type === 'vdist' || type === 'distance' || type === 'radius' || type === 'diameter' || type === 'angle' ? at : defaultOff(m, type, refs, k)
  return { type, refs, value: me.value, sgn: me.sgn, expr: String(+me.value.toFixed(3)), off }
}

/** aligned / horizontal / vertical from where the cursor sits relative to the two points */
function pairType(m: SketchModel, refs: string[], at: Vec2): ConstraintType {
  const A = pos(m, refs[0]), B = pos(m, refs[1])
  const u = norm(sub(B, A))
  const mid: Vec2 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]
  const v = sub(at, mid)
  const n: Vec2 = [-u[1], u[0]]
  const vl = Math.hypot(v[0], v[1])
  if (vl < 1e-9 || dist(A, B) < 1e-9) return 'distance'
  const cosN = Math.abs(v[0] * n[0] + v[1] * n[1]) / vl
  if (cosN > Math.cos((35 * Math.PI) / 180)) return 'distance'
  return Math.abs(v[1]) > Math.abs(v[0]) ? 'hdist' : 'vdist'
}

function previewDim(s: SketchState, raw: Vec2, mods: Mods): Constraint | null {
  void mods
  if (!placeReady(s.model, s.picks)) return null
  const d = dimFor(s.model, s.picks, raw, wppNow * 20)
  return d ? { id: '~preview', ...d } : null
}

function downDimension(raw: Vec2, mods: Mods) {
  const s = get()
  const h = hitTest(s.model, raw, tolPx() * wppNow)
  const t = (id: string) => (id === ORIGIN ? 'point' : entityById(s.model, id)?.type)
  if (!s.picks.length) {
    if (h && t(h) !== undefined) set({ picks: [h] })
    return
  }
  const first = s.picks[0]
  if (s.picks.length === 1) {
    if (h && h !== first) {
      const a = t(first), b = t(h)
      if ((a === 'point' && (b === 'point' || b === 'line')) || (a === 'line' && (b === 'line' || b === 'point'))) {
        set({ picks: a === 'line' && b === 'point' ? [h, first] : [first, h] })
        return
      }
    }
    if (!placeReady(s.model, s.picks)) return
  }
  place(raw, mods)
}

function place(at: Vec2, mods: Mods) {
  void mods
  const s = get()
  const d = dimFor(s.model, s.picks, at, wppNow * 20)
  if (!d) { set({ picks: [], placing: null }); return }
  let newId = ''
  const ok = commit((m) => { newId = addConstraint(m, d).id }, { strict: true })
  set({ picks: [], placing: null })
  // the value box opens when the button comes up: the browser moves the focus to the canvas as part of the press, which would
  // take it straight back from a box opened here
  if (ok) pendingDim = newId
}

// ---- trim

function downTrim(raw: Vec2) {
  const s = get()
  const h = hitTest(s.model, raw, tolPx() * wppNow, curvesOnly)
  if (!h) return
  const ok = commit((m) => {
    const target = prepareTrim(m, h, raw)
    const span = trimSpan(m, target, raw)
    return span ? applyTrim(m, span) ?? undefined : 'Nothing to trim here'
  })
  if (ok) set({ trimHover: null, hover: null })
}

// ---- offset

function startOffset(id: string) {
  const s = get()
  const chain = collectChain(s.model, id)
  if (!chain) { flash('Pick a line, arc or circle to offset'); return }
  set({ offset: { chain, d: 0 }, typed: { ...fieldsTyped('offset', 0), active: 0 }, sel: chain.items.map((i) => i.id) })
  invalidate()
}
const fieldsTyped = (tool: string, stage: number): Typed => ({ fields: fieldsFor(tool as 'offset', stage), active: 0, tool, stage })

function downOffset(raw: Vec2) {
  const s = get()
  if (!s.offset) {
    const h = hitTest(s.model, raw, tolPx() * wppNow, curvesOnly)
    if (h) startOffset(h)
    return
  }
  commitOffset()
}

/** Create the previewed offset. */
export function commitOffset() {
  const s = get()
  const o = s.offset
  if (!o) return
  if (Math.abs(o.d) < 1e-6) { flash('Move the cursor or type a distance'); return }
  const typedText = s.typed?.fields[0]?.text.trim()
  const text = typedText && valuesOf(s.typed).dist !== undefined ? typedText.replace(/^-/, '') : String(+Math.abs(o.d).toFixed(3))
  const ok = commit((m) => applyOffset(m, o.chain, o.d, text, wppNow * 20) ?? undefined)
  if (ok) { resetTransient(); setTool('select') }
}

// ---- project

let projUnsub: (() => void) | null = null
function watchProject(on: boolean) {
  projUnsub?.()
  projUnsub = null
  if (!on) return
  useUi.getState().setSelectionFilter('face')
  projUnsub = useUi.subscribe((st, prev) => {
    if (st.selection === prev.selection || !st.selection.length) return
    const refs = st.selection.filter((r) => r.kind === 'face' || r.kind === 'edge' || r.kind === 'body')
    if (!refs.length) return
    useUi.getState().clearSelection()
    void projectRefs(refs)
  })
}

/** Project the picked faces (their boundary), edges, or whole bodies onto the sketch plane as fixed reference geometry. */
export async function projectRefs(refs: SelectionRef[]) {
  const s = get()
  const bodies = useDoc.getState().geometry
  // one associative projection per picked face / edge / body (the ref is what is re-projected on regeneration)
  const jobs: { ref: string; key: string; faces: number[]; edges: number[]; all: boolean }[] = []
  for (const r of refs) {
    const b = bodies.find((x) => x.id === r.id)
    if (!b) continue
    if (b.kind !== 'brep') { flash('Only solid (B-rep) bodies can be projected'); continue }
    const g = refFromSelection(r, bodies)
    if (!g) continue
    jobs.push({
      ref: encodeRef(g), key: b.key,
      faces: g.kind === 'face' ? [g.index] : [], edges: g.kind === 'edge' ? [g.index] : [], all: g.kind === 'body',
    })
  }
  if (!jobs.length) return
  try {
    const done: { ref: string; curves: ProjectedCurve[] }[] = []
    for (const j of jobs) {
      done.push({ ref: j.ref, curves: (await getKernel().call('projectEdges', { key: j.key, plane: s.plane, faces: j.faces, edges: j.edges, all: j.all })) as ProjectedCurve[] })
    }
    let n = 0
    const ok = commit((m) => { for (const d of done) n += addProjected(m, d.curves, d.ref) })
    if (ok) flash(n ? `Projected ${n} curve${n === 1 ? '' : 's'}` : 'Nothing new to project (already in the sketch, or edge-on to the plane)')
  } catch (e) {
    flash('Projection failed: ' + (e instanceof Error ? e.message : String(e)))
  }
}

// ---- drawing tools

const MIN = 1e-6

/** Which part of a multi-click tool the draft is in (arc: 0 = looking for the second point, 1 = the third). */
const stageOf = (d: Draft) => (d.tool === 'arc' ? Math.max(0, d.pts.length - 1) : 0)

/** The typed-value state for the current draft, created on demand (it resets when the stage changes). */
function typedFor(): Typed | null {
  const s = get()
  const d = s.draft
  if (s.tool === 'offset') return s.offset ? s.typed ?? fieldsTyped('offset', 0) : null
  if (!d || !isDraw(s.tool)) return null
  const stage = stageOf(d)
  if (s.typed && s.typed.tool === s.tool && s.typed.stage === stage) return s.typed
  return fieldsTyped(s.tool, stage)
}

/**
 * Keyboard input for typed values. Digits / operators go to the active field, Tab cycles the fields, Enter commits,
 * Backspace edits. Returns true when the key was consumed.
 */
export function typedKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  const s = get()
  if (!s.active || e.ctrlKey || e.metaKey || e.altKey) return false
  const t = typedFor()
  if (!t || !t.fields.length) return false
  const k = e.key
  if (k === 'Tab') {
    set({ typed: { ...t, active: (t.active + (e.shiftKey ? t.fields.length - 1 : 1)) % t.fields.length } })
    invalidate()
    return true
  }
  if (k === 'Enter') {
    if (s.tool === 'offset') commitOffset()
    else if (hasText(t)) commitTyped()
    else enterSketch()
    return true
  }
  const f = t.fields[t.active]
  const setText = (text: string) => {
    set({ typed: { ...t, fields: t.fields.map((x, i) => (i === t.active ? { ...x, text } : x)) } })
    if (get().tool === 'offset') refreshOffsetDistance()
    invalidate()
  }
  if (k === 'Backspace') {
    if (!f.text) return false
    setText(f.text.slice(0, -1))
    return true
  }
  if (k.length !== 1) return false
  const isNum = /[0-9.\-+*/()^, ]/.test(k)
  const isName = /[A-Za-z_]/.test(k)
  if (isNum || (isName && f.text !== '')) {
    if (k === ',') setText(f.text + '.')
    else if (k === ' ') return false
    else setText(f.text + k)
    return true
  }
  return false
}

function refreshOffsetDistance() {
  const s = get()
  if (!s.offset) return
  const v = valuesOf(s.typed).dist
  if (v === undefined) return
  const sign = s.offset.d < 0 ? -1 : 1
  set({ offset: { ...s.offset, d: sign * Math.abs(v) } })
}

/** Enter: place the next point at the resolved (typed / cursor) position. */
export function commitTyped() {
  const s = get()
  const d = s.draft
  if (!d) return
  const raw = s.cursor?.pos ?? [d.pts[d.pts.length - 1][0] + 1, d.pts[d.pts.length - 1][1]]
  downDraw(raw, { shift: false, ctrl: false })
}

/** A dimension from typed text: created from the measured geometry so it starts out satisfied. */
function typedDim(m: SketchModel, type: ConstraintType, refs: string[], text: string) {
  const me = measure(m, type, refs)
  if (!me) return
  const n = evalNumber(text, type === 'angle' ? 'deg' : 'mm')
  const expr = n !== null && Math.abs(Math.abs(n) - me.value) < 1e-9 && n >= 0 ? text : String(+me.value.toFixed(6))
  addConstraint(m, { type, refs, value: me.value, sgn: me.sgn, expr, off: defaultOff(m, type, refs, wppNow * 20) })
}
const textOf = (t: Typed | null, key: string) => t?.fields.find((f) => f.key === key)?.text.trim() || undefined

function downDraw(raw: Vec2, mods: Mods) {
  const s = get()
  const d = s.draft
  const tool = s.tool as DrawTool
  const anchor = d && s.tool === 'line' ? d.pts[d.pts.length - 1] : undefined
  let sn = doSnap(raw, mods, anchor, undefined, d && s.tool === 'line' ? d.snaps[d.snaps.length - 1]?.pointId : undefined)
  const constr = s.construction
  const typed = d && s.typed && s.typed.tool === s.tool && s.typed.stage === stageOf(d) ? s.typed : null
  const vals: Values = valuesOf(typed)
  const useTyped = !!d && hasText(typed) && Object.keys(vals).length > 0
  if (useTyped) sn = { pos: resolveEnd(tool, stageOf(d!), d!.pts, raw, vals), kind: 'free', guides: [] }
  const tt = useTyped ? typed : null

  switch (s.tool) {
    case 'line': {
      if (!d) { set({ draft: { tool: 'line', pts: [sn.pos], snaps: [sn] }, typed: null }); return }
      const a = d.snaps[d.snaps.length - 1]
      if (dist(a.pos, sn.pos) < Math.max(MIN, useTyped ? 1e-9 : wppNow * 1.5)) return
      let startId = '', endId = ''
      const ok = commit((m) => {
        const p1 = pointFor(m, a)
        const p2 = pointFor(m, sn)
        const l = addLine(m, p1, p2, constr)
        if (!useTyped && !constr) applyRelations(m, l.id, p1, p2, sn.rel)
        if (sn.h && !constr) addConstraint(m, { type: 'horizontal', refs: [l.id] })
        else if (sn.v && !constr) addConstraint(m, { type: 'vertical', refs: [l.id] })
        const len = textOf(tt, 'len'), ang = textOf(tt, 'ang')
        if (len !== undefined && vals.len !== undefined) typedDim(m, 'distance', [p1, p2], len)
        if (ang !== undefined && vals.ang !== undefined) {
          const a2 = Math.abs(wrapDeg(vals.ang - (vals.len !== undefined && vals.len < 0 ? 180 : 0)))
          if (a2 < 1e-9 || Math.abs(a2 - 180) < 1e-9) addConstraint(m, { type: 'horizontal', refs: [l.id] })
          else if (Math.abs(a2 - 90) < 1e-9) addConstraint(m, { type: 'vertical', refs: [l.id] })
          else typedDim(m, 'angle', [p1, p2], ang)
        }
        startId = p1
        endId = p2
      })
      if (!ok || !endId) return
      draftStack.push(d)
      const chainStart = d.chainStart ?? startId
      const model = get().model
      const e = entityById(model, endId)
      const p: Vec2 = e && e.type === 'point' ? [e.x, e.y] : sn.pos
      const closes = !useTyped && sn.pointId !== undefined && (sn.pointId === chainStart || dist(pos(model, sn.pointId), pos(model, chainStart)) < 1e-6)
      if (closes) { resetTransient(); return }
      set({ draft: { tool: 'line', pts: [p], snaps: [{ pos: p, kind: 'point', pointId: endId, guides: [] }], chainStart }, typed: null })
      return
    }
    case 'rect':
    case 'rectC': {
      if (!d) { set({ draft: { tool: s.tool, pts: [sn.pos], snaps: [sn] }, typed: null }); return }
      const a = d.snaps[0]
      const [x0, y0] = a.pos, [x1, y1] = sn.pos
      if (Math.abs(x1 - x0) < (useTyped ? 1e-9 : wppNow * 1.5) || Math.abs(y1 - y0) < (useTyped ? 1e-9 : wppNow * 1.5)) return
      commit((m) => {
        let c: [Vec2, Vec2, Vec2, Vec2]
        if (s.tool === 'rect') c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        else c = [[x0 - (x1 - x0), y0 - (y1 - y0)], [x1, y0 - (y1 - y0)], [x1, y1], [x0 - (x1 - x0), y1]]
        const ids: string[] = []
        for (let i = 0; i < 4; i++) {
          // corners that coincide with a snap are bound to that point
          if (s.tool === 'rect' && i === 0) ids.push(pointFor(m, a))
          else if (s.tool === 'rect' && i === 2 && !useTyped) ids.push(pointFor(m, sn))
          else ids.push(addPoint(m, c[i][0], c[i][1]))
        }
        const ls = [0, 1, 2, 3].map((i) => addLine(m, ids[i], ids[(i + 1) % 4], constr))
        if (!constr) {
          addConstraint(m, { type: 'horizontal', refs: [ls[0].id] })
          addConstraint(m, { type: 'horizontal', refs: [ls[2].id] })
          addConstraint(m, { type: 'vertical', refs: [ls[1].id] })
          addConstraint(m, { type: 'vertical', refs: [ls[3].id] })
        }
        if (s.tool === 'rectC') {
          // centre point bound to the diagonals' midpoint
          const cp = pointFor(m, a)
          const diag = addLine(m, ids[0], ids[2], true)
          addConstraint(m, { type: 'midpoint', refs: [cp, diag.id] })
        }
        const w = textOf(tt, 'w'), h = textOf(tt, 'h')
        if (w !== undefined && vals.w !== undefined) typedDim(m, 'hdist', [ids[0], ids[1]], w)
        if (h !== undefined && vals.h !== undefined) typedDim(m, 'vdist', [ids[1], ids[2]], h)
      })
      resetTransient()
      return
    }
    case 'circle': {
      if (!d) { set({ draft: { tool: 'circle', pts: [sn.pos], snaps: [sn] }, typed: null }); return }
      const a = d.snaps[0]
      const r = dist(a.pos, sn.pos)
      if (r < Math.max(MIN, useTyped ? 1e-9 : wppNow * 2)) return
      commit((m) => {
        const k = addCircle(m, pointFor(m, a), r, constr)
        const dia = textOf(tt, 'dia')
        if (dia !== undefined && vals.dia !== undefined) typedDim(m, 'diameter', [k.id], dia)
      })
      resetTransient()
      return
    }
    case 'arc': {
      if (!d) { set({ draft: { tool: 'arc', pts: [sn.pos], snaps: [sn] }, typed: null }); return }
      if (d.pts.length === 1) {
        if (dist(d.pts[0], sn.pos) < Math.max(MIN, useTyped ? 1e-9 : wppNow * 2)) return
        set({
          draft: { ...d, pts: [...d.pts, sn.pos], snaps: [...d.snaps, sn], pend: { len: vals.len !== undefined ? textOf(tt, 'len') : undefined, ang: vals.ang !== undefined ? textOf(tt, 'ang') : undefined } },
          typed: null,
        })
        return
      }
      const [p1, p2] = d.pts
      const third = arcThrough(p1, p2, sn.pos, useTyped ? vals.rad : undefined)
      const cc = circumcircle(p1, p2, third)
      if (!cc) { flash('Points are collinear'); return }
      // travelling p1 -> through -> p2: counter-clockwise when the turn is left
      const ccw = cross(sub(third, p1), sub(p2, third)) > 0
      commit((m) => {
        const a = pointFor(m, d.snaps[0]), b = pointFor(m, d.snaps[1])
        const c = addPoint(m, cc.c[0], cc.c[1])
        const arc = ccw ? addArc(m, c, a, b, constr) : addArc(m, c, b, a, constr)
        if (d.pend?.len && evalNumber(d.pend.len, 'mm') !== null) typedDim(m, 'distance', [a, b], d.pend.len)
        if (d.pend?.ang && evalNumber(d.pend.ang, 'deg') !== null) typedDim(m, 'angle', [a, b], d.pend.ang)
        const rad = textOf(tt, 'rad')
        if (rad !== undefined && vals.rad !== undefined) typedDim(m, 'radius', [arc.id], rad)
      })
      resetTransient()
      return
    }
  }
}

// -------- the touch layout's stand-ins for Escape, Enter and the keyboard

/**
 * Undo point: the last point of what is being drawn (a polyline steps back one segment, an arc one point), else the draft itself,
 * else the last thing drawn. Same job as Escape / Ctrl+Z, for screens without a keyboard.
 */
export function undoPoint() {
  const s = get()
  if (!s.active || s.dimEdit) return
  if (extraTools[s.tool]?.cancel?.()) { invalidate(); return }
  const d = s.draft
  if (s.tool === 'line' && d && draftStack.length) {
    const rest = draftStack.slice(0, -1)
    const prev = draftStack[draftStack.length - 1]
    undoSketch()
    draftStack.push(...rest)
    set({ draft: prev })
    invalidate()
    return
  }
  if (s.tool === 'arc' && d && d.pts.length > 1) {
    set({ draft: { ...d, pts: d.pts.slice(0, -1), snaps: d.snaps.slice(0, -1), pend: undefined }, typed: null })
    invalidate()
    return
  }
  if (d || s.picks.length || s.placing || s.offset) { resetTransient(); invalidate(); return }
  undoSketch()
}

/** The value box being typed into while a draft or offset is open (null when there is none). */
export function typedInfo(): { label: string; unit: 'mm' | 'deg'; text: string; index: number; count: number } | null {
  const t = typedFor()
  if (!t || !t.fields.length) return null
  const f = t.fields[t.active]
  return { label: f.label, unit: f.unit, text: f.text, index: t.active, count: t.fields.length }
}
/** Put text into the active value box (the on-screen number field). */
export function setTypedText(text: string) {
  const t = typedFor()
  if (!t) return
  set({ typed: { ...t, fields: t.fields.map((x, i) => (i === t.active ? { ...x, text } : x)) } })
  if (get().tool === 'offset') refreshOffsetDistance()
  invalidate()
}
/** Tab: the next value box. */
export function nextTypedField() {
  const t = typedFor()
  if (!t || t.fields.length < 2) return
  set({ typed: { ...t, active: (t.active + 1) % t.fields.length } })
  invalidate()
}
/** Enter on a value box: place the point (or finish the offset). */
export function acceptTyped() {
  typedKey({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })
}

/** Update the cached world-per-pixel from the overlay (for status / hit tolerance outside pointer events). */
export function setWpp(w: number) { wppNow = w }
