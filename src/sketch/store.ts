/**
 * Sketch editing session: model, tools, selection, dragging, history. The viewport overlay renders this state and
 * forwards pointer events to the functions at the bottom.
 */
import { create } from 'zustand'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { viewportBus } from '@/viewport/bus'
import { applyConstraint, ready, type CKind } from './constraints'
import { defaultOff, measure, refreshDims } from './dims'
import { arcOf, addArc, addCircle, addConstraint, addLine, addPoint, cloneModel, entityById, entityPoints, lineEnds, mergePoints, pos, removeIds } from './model'
import { boxSelect, hitTest } from './hit'
import { detectProfiles } from './profiles'
import { snap as snapAt, type Snap } from './snap'
import { analyze, ensureSolver, solveModel, type DragSpec, type SolveInfo } from './solver'
import { circumcircle, cross, dist, norm, sub } from './geom'
import { ORIGIN, emptyModel, type Constraint, type ConstraintType, type PlaneDef, type Profile, type SketchModel, type Vec2 } from './types'

export type ToolId = 'select' | 'line' | 'rect' | 'rectC' | 'circle' | 'arc' | 'dimension' | 'constraint'

export interface Draft { tool: ToolId; pts: Vec2[]; snaps: Snap[]; chainStart?: string }
export interface Mods { shift: boolean; ctrl: boolean }

const emptyInfo = (): SolveInfo => ({ ok: true, dof: 1, conflicts: [], redundant: [], fixed: new Set() })

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
  sel: [], hover: null, cursor: null, draft: null, picks: [], placing: null, dimEdit: null, dimNew: false, box: null, dragging: false,
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
export function solveFull(model: SketchModel): Solved {
  const m0 = cloneModel(model)
  const bad = refreshDims(m0)
  const r = solveModel(m0)
  r.info.fixed = r.info.ok ? analyze(r.model, r.info) : new Set()
  return { model: r.model, info: r.info, profiles: detectProfiles(r.model), bad }
}

/** Apply a mutation to a copy of the model, solve, and keep it if consistent. */
export function commit(fn: (m: SketchModel) => string | void): boolean {
  const s = get()
  const draft = cloneModel(s.model)
  const err = fn(draft)
  if (typeof err === 'string') { flash(err); return false }
  const r = solveFull(draft)
  if (!r.info.ok || r.info.conflicts.length) {
    flash(r.info.conflicts.length ? 'Conflicts with existing constraints' : 'Could not solve the sketch')
    return false
  }
  const ids = new Set([...r.model.entities.map((e) => e.id), ...r.model.constraints.map((c) => c.id)])
  set({
    model: r.model, info: r.info, profiles: r.profiles, badDims: r.bad,
    past: [...s.past.slice(-100), s.model], future: [],
    sel: s.sel.filter((i) => ids.has(i)),
  })
  invalidate()
  return true
}

export function undoSketch() {
  const s = get()
  const prev = s.past[s.past.length - 1]
  if (!prev) return
  const r = solveFull(prev)
  set({ model: r.model, info: r.info, profiles: r.profiles, past: s.past.slice(0, -1), future: [s.model, ...s.future], sel: [], draft: null, picks: [], placing: null, dimEdit: null })
  invalidate()
}
export function redoSketch() {
  const s = get()
  const next = s.future[0]
  if (!next) return
  const r = solveFull(next)
  set({ model: r.model, info: r.info, profiles: r.profiles, past: [...s.past, s.model], future: s.future.slice(1), sel: [], draft: null })
  invalidate()
}

// ---------------------------------------------------------------- session

export const sketchActive = () => get().active

export async function beginSketch(o: { plane: PlaneDef; face?: string | null; model?: SketchModel; editing?: string | null; onClose?: () => void }) {
  await ensureSolver()
  onClose = o.onClose ?? null
  const model = o.model ?? emptyModel()
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
  set({ tool, ckind, draft: null, picks: [], placing: null, box: null })
  const id = tool === 'select' ? null : tool === 'constraint' && ckind ? 'sketch.' + (ckind === 'hv' ? 'horizontal' : ckind) : tool === 'dimension' ? 'sketch.dimension' : tool === 'rectC' ? 'sketch.rectCenter' : 'sketch.' + tool
  useUi.getState().setActiveTool(id)
  invalidate()
}

/** Constraint command: apply to the current selection if complete, otherwise wait for picks. */
export function runConstraintCommand(kind: CKind) {
  const s = get()
  const ids = s.sel.filter((i) => !s.model.constraints.some((c) => c.id === i))
  if (ready(s.model, kind, ids)) {
    const err = { v: null as string | null }
    commit((m) => { err.v = applyConstraint(m, kind, ids); return err.v ?? undefined })
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

/** Escape: cancel the draft / placing, then the tool, then the selection. */
export function escapeSketch() {
  const s = get()
  if (s.dimEdit) { cancelDimEdit(); return }
  if (s.draft || s.picks.length || s.placing) { set({ draft: null, picks: [], placing: null }); invalidate(); return }
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
    c.expr = text
    if (refreshDims(m).includes(id)) return 'Invalid expression'
  })
  if (ok) { set({ dimEdit: null, dimNew: false }); invalidate() }
  return ok
}

// -------- snapping helpers

function doSnap(raw: Vec2, mods: Mods, anchor?: Vec2, exclude?: Set<string>): Snap {
  if (mods.ctrl) return { pos: raw, kind: 'free', guides: [] }
  return snapAt(raw, { model: get().model, wpp: wppNow, grid: useUi.getState().snap, anchor, exclude })
}

/** Create (or reuse) the point a snap refers to, binding constraints for on-curve / midpoint / axis snaps. */
function pointFor(m: SketchModel, s: Snap): string {
  if (s.pointId && (s.kind === 'point' || s.kind === 'origin' || s.kind === 'center')) return s.pointId
  const id = addPoint(m, s.pos[0], s.pos[1])
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

const tolPx = 8

export function pointerMove(raw: Vec2, wpp: number, mods: Mods) {
  wppNow = wpp
  const s = get()
  if (!s.active) return
  const tool = s.tool

  if (drag) { dragMove(raw, mods); return }
  if (boxStart) { set({ box: [boxStart, raw] }); invalidate(); return }

  if (tool === 'select' || tool === 'constraint') {
    const h = hitTest(s.model, raw, tolPx * wpp)
    if (h !== s.hover) set({ hover: h })
    set({ cursor: null })
    invalidate()
    return
  }
  if (tool === 'dimension') {
    const h = hitTest(s.model, raw, tolPx * wpp)
    set({ hover: h, cursor: null, placing: s.picks.length ? previewDim(s, raw, mods) : null })
    invalidate()
    return
  }
  const d = s.draft
  const anchor = d ? (tool === 'line' ? d.pts[d.pts.length - 1] : undefined) : undefined
  const sn = doSnap(raw, mods, anchor)
  set({ cursor: sn, hover: null })
  invalidate()
}

export function pointerDown(raw: Vec2, wpp: number, mods: Mods, px: Vec2) {
  wppNow = wpp
  const s = get()
  if (!s.active) return
  switch (s.tool) {
    case 'select': return downSelect(raw, mods, px)
    case 'constraint': return downConstraint(raw, mods)
    case 'dimension': return downDimension(raw, mods)
    default: return downDraw(raw, mods)
  }
}

export function pointerUp(raw: Vec2, wpp: number, mods: Mods) {
  wppNow = wpp
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
  if (s.tool === 'line' && s.draft) { set({ draft: null }); invalidate(); return }
  if (s.tool === 'select') {
    const h = hitTest(s.model, raw, tolPx * wpp)
    const c = s.model.constraints.find((k) => k.id === h)
    if (c) editDim(c.id)
  }
}

export function rightClick() {
  const s = get()
  if (s.draft || s.picks.length) { set({ draft: null, picks: [], placing: null }); invalidate() }
  else if (s.tool !== 'select') setTool('select')
}

// ---- select tool

function downSelect(raw: Vec2, mods: Mods, px: Vec2) {
  const s = get()
  const h = hitTest(s.model, raw, tolPx * wppNow)
  if (!h) { boxStart = raw; set({ box: [raw, raw] }); return }
  if (mods.shift) select([h], true)
  else if (!s.sel.includes(h)) select([h])
  if (h === ORIGIN) return
  const e = entityById(s.model, h)
  if (!e) return
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
    if (sn.pointId && (sn.kind === 'point' || sn.kind === 'origin' || sn.kind === 'center') && sn.pointId !== d.id) mergePoints(m, sn.pointId, d.id)
    else if (sn.kind === 'on' && sn.entityId) {
      const t = entityById(m, sn.entityId)
      if (t && !entityPoints(m, t.id).includes(d.id)) addConstraint(m, { type: t.type === 'line' ? 'pointOnLine' : 'pointOnCurve', refs: [d.id, t.id] })
    } else if (sn.kind === 'axis' && sn.axis) addConstraint(m, { type: 'onAxis', refs: [d.id], axis: sn.axis })
    model = m
  }
  const r = solveFull(model)
  if (!r.info.ok || r.info.conflicts.length) {
    // fall back to the pre-drag state
    const prev = s.past[s.past.length - 1]
    if (prev) { const pr = solveFull(prev); set({ model: pr.model, info: pr.info, profiles: pr.profiles, past: s.past.slice(0, -1) }) }
    flash('Move conflicts with constraints')
  } else set({ model: r.model, info: r.info, profiles: r.profiles, badDims: r.bad })
  invalidate()
}

// ---- constraint tool

function downConstraint(raw: Vec2, mods: Mods) {
  const s = get()
  if (!s.ckind) return
  const h = hitTest(s.model, raw, tolPx * wppNow)
  if (!h) return
  const picks = [...s.picks, h]
  if (ready(s.model, s.ckind, picks) || (s.ckind === 'fix')) {
    if (s.ckind === 'fix') {
      commit((m) => applyConstraint(m, 'fix', [h]) ?? undefined)
      set({ picks: [] })
    } else {
      commit((m) => applyConstraint(m, s.ckind!, picks) ?? undefined)
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
  const h = hitTest(s.model, raw, tolPx * wppNow)
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
  const ok = commit((m) => { newId = addConstraint(m, d).id })
  set({ picks: [], placing: null })
  if (ok) editDim(newId, true)
}

// ---- drawing tools

const MIN = 1e-6

function downDraw(raw: Vec2, mods: Mods) {
  const s = get()
  const d = s.draft
  const anchor = d && s.tool === 'line' ? d.pts[d.pts.length - 1] : undefined
  const sn = doSnap(raw, mods, anchor)
  const constr = s.construction
  switch (s.tool) {
    case 'line': {
      if (!d) { set({ draft: { tool: 'line', pts: [sn.pos], snaps: [sn] } }); return }
      const a = d.snaps[d.snaps.length - 1]
      if (dist(a.pos, sn.pos) < Math.max(MIN, wppNow * 1.5)) return
      let startId = '', endId = ''
      const ok = commit((m) => {
        const p1 = pointFor(m, a)
        const p2 = pointFor(m, sn)
        if (p1 === p2) return
        const l = addLine(m, p1, p2, constr)
        if (sn.h && !sn.pointId && !constr) addConstraint(m, { type: 'horizontal', refs: [l.id] })
        else if (sn.v && !sn.pointId && !constr) addConstraint(m, { type: 'vertical', refs: [l.id] })
        startId = p1
        endId = p2
      })
      if (!ok || !endId) return
      const chainStart = d.chainStart ?? startId
      if (endId === chainStart) { set({ draft: null }); return }
      const e = entityById(get().model, endId)
      const p: Vec2 = e && e.type === 'point' ? [e.x, e.y] : sn.pos
      set({ draft: { tool: 'line', pts: [p], snaps: [{ pos: p, kind: 'point', pointId: endId, guides: [] }], chainStart } })
      return
    }
    case 'rect':
    case 'rectC': {
      if (!d) { set({ draft: { tool: s.tool, pts: [sn.pos], snaps: [sn] } }); return }
      const a = d.snaps[0]
      const [x0, y0] = a.pos, [x1, y1] = sn.pos
      if (Math.abs(x1 - x0) < wppNow * 1.5 || Math.abs(y1 - y0) < wppNow * 1.5) return
      commit((m) => {
        let c: [Vec2, Vec2, Vec2, Vec2]
        if (s.tool === 'rect') c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        else c = [[x0 - (x1 - x0), y0 - (y1 - y0)], [x1, y0 - (y1 - y0)], [x1, y1], [x0 - (x1 - x0), y1]]
        const ids: string[] = []
        for (let i = 0; i < 4; i++) {
          // corners that coincide with a snap reuse that point
          if (s.tool === 'rect' && i === 0) ids.push(pointFor(m, a))
          else if (s.tool === 'rect' && i === 2) ids.push(pointFor(m, sn))
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
      })
      set({ draft: null })
      return
    }
    case 'circle': {
      if (!d) { set({ draft: { tool: 'circle', pts: [sn.pos], snaps: [sn] } }); return }
      const a = d.snaps[0]
      const r = dist(a.pos, sn.pos)
      if (r < Math.max(MIN, wppNow * 2)) return
      commit((m) => { addCircle(m, pointFor(m, a), r, constr) })
      set({ draft: null })
      return
    }
    case 'arc': {
      if (!d) { set({ draft: { tool: 'arc', pts: [sn.pos], snaps: [sn] } }); return }
      if (d.pts.length === 1) {
        if (dist(d.pts[0], sn.pos) < Math.max(MIN, wppNow * 2)) return
        set({ draft: { ...d, pts: [...d.pts, sn.pos], snaps: [...d.snaps, sn] } })
        return
      }
      const [p1, p2] = d.pts
      const cc = circumcircle(p1, p2, sn.pos)
      if (!cc) { flash('Points are collinear'); return }
      // travelling p1 -> through -> p2: counter-clockwise when the turn is left
      const ccw = cross(sub(sn.pos, p1), sub(p2, sn.pos)) > 0
      commit((m) => {
        const a = pointFor(m, d.snaps[0]), b = pointFor(m, d.snaps[1])
        const c = addPoint(m, cc.c[0], cc.c[1])
        if (ccw) addArc(m, c, a, b, constr)
        else addArc(m, c, b, a, constr)
      })
      set({ draft: null })
      return
    }
  }
}

/** Update the cached world-per-pixel from the overlay (for status / hit tolerance outside pointer events). */
export function setWpp(w: number) { wppNow = w }
