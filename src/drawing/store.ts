/** The drawings of the open document: sheets, views, dimensions, annotations. Saved as drawings.json inside the .caddy. */
import { produce } from 'immer'
import { create } from 'zustand'
import { useDoc } from '@/doc/store'
import { registerProjectSection } from '@/io/project'
import { emptyDrawing, newSheet } from './sheets'
import type { Annotation, Dimension, DrawingDoc, DrawingView, Sheet } from './types'

/** An annotation before it gets its id. */
export type NewAnnotation = Annotation extends infer A ? (A extends Annotation ? Omit<A, 'id'> : never) : never

export type Selection = { kind: 'view' | 'dim' | 'note'; id: string } | null

interface DrawingState {
  doc: DrawingDoc
  selection: Selection
  undoDepth: number
  redoDepth: number
  /** run an edit on the document (undoable, marks the project as changed) */
  edit: (label: string, fn: (d: DrawingDoc) => void) => void
  select: (s: Selection) => void
  undo: () => void
  redo: () => void
  load: (d: DrawingDoc | null) => void
}

const past: DrawingDoc[] = []
const future: DrawingDoc[] = []

export const useDrawing = create<DrawingState>((set, get) => ({
  doc: emptyDrawing(),
  selection: null,
  undoDepth: 0,
  redoDepth: 0,
  edit: (_label, fn) => {
    const before = get().doc
    const next = produce(before, fn)
    if (next === before) return
    past.push(before)
    if (past.length > 100) past.shift()
    future.length = 0
    set({ doc: next, undoDepth: past.length, redoDepth: 0 })
    useDoc.setState({ dirty: true })
  },
  select: (selection) => set({ selection }),
  undo: () => {
    const prev = past.pop()
    if (!prev) return
    future.push(get().doc)
    set({ doc: prev, undoDepth: past.length, redoDepth: future.length, selection: null })
    useDoc.setState({ dirty: true })
  },
  redo: () => {
    const next = future.pop()
    if (!next) return
    past.push(get().doc)
    set({ doc: next, undoDepth: past.length, redoDepth: future.length, selection: null })
    useDoc.setState({ dirty: true })
  },
  load: (d) => {
    past.length = 0
    future.length = 0
    set({ doc: d ?? emptyDrawing(), selection: null, undoDepth: 0, redoDepth: 0 })
  },
}))

// ---------------------------------------------------------------- lookups

export const activeSheet = (d: DrawingDoc = useDrawing.getState().doc): Sheet | undefined => d.sheets.find((s) => s.id === d.active) ?? d.sheets[0]

export function nextId(prefix: string, ids: string[]): string {
  let n = 1
  for (const id of ids) {
    const m = new RegExp('^' + prefix + '(\\d+)$').exec(id)
    if (m) n = Math.max(n, parseInt(m[1], 10) + 1)
  }
  return prefix + n
}

/** Every id used in the document for a kind of thing, so a new id is never reused. */
const allIds = (d: DrawingDoc, prefix: string) =>
  d.sheets.flatMap((s) => [s.id, ...s.views.map((v) => v.id), ...s.dims.map((x) => x.id), ...s.notes.map((n) => n.id)]).filter((id) => id.startsWith(prefix))

// ---------------------------------------------------------------- actions

export const drawingActions = {
  /** The active sheet, made on demand (the first view or sheet ever asked for creates "Sheet 1"). */
  ensureSheet(): string {
    const cur = activeSheet()
    if (cur) return cur.id
    return drawingActions.addSheet()
  },
  addSheet(over: Partial<Sheet> = {}): string {
    let id = ''
    useDrawing.getState().edit('Add sheet', (d) => {
      id = nextId('s', allIds(d, 's'))
      const prev = d.sheets[d.sheets.length - 1]
      const s = newSheet(id, `Sheet ${d.sheets.length + 1}`, over)
      if (prev) {
        s.size = over.size ?? prev.size
        s.portrait = over.portrait ?? prev.portrait
        s.projection = over.projection ?? prev.projection
        s.titleBlock = { ...prev.titleBlock, number: prev.titleBlock.number }
      }
      d.sheets.push(s)
      d.active = id
    })
    return id
  },
  removeSheet(id: string) {
    useDrawing.getState().edit('Delete sheet', (d) => {
      d.sheets = d.sheets.filter((s) => s.id !== id)
      if (d.active === id) d.active = d.sheets[0]?.id ?? ''
    })
  },
  setActive(id: string) {
    useDrawing.setState((s) => ({ doc: { ...s.doc, active: id }, selection: null }))
  },
  updateSheet(id: string, patch: Partial<Sheet>) {
    useDrawing.getState().edit('Sheet setup', (d) => {
      const s = d.sheets.find((x) => x.id === id)
      if (s) Object.assign(s, patch)
    })
  },
  setTitleValue(sheetId: string, key: string, value: string) {
    useDrawing.getState().edit('Title block', (d) => {
      const s = d.sheets.find((x) => x.id === sheetId)
      if (s) s.titleBlock[key] = value
    })
  },
  addView(sheetId: string, v: Omit<DrawingView, 'id'>): string {
    let id = ''
    useDrawing.getState().edit('Add view', (d) => {
      id = nextId('v', allIds(d, 'v'))
      d.sheets.find((s) => s.id === sheetId)?.views.push({ ...v, id })
    })
    return id
  },
  updateView(sheetId: string, id: string, patch: Partial<DrawingView>) {
    useDrawing.getState().edit('Edit view', (d) => {
      const v = d.sheets.find((s) => s.id === sheetId)?.views.find((x) => x.id === id)
      if (v) Object.assign(v, patch)
    })
  },
  /** Move a view; views projected from it follow (they keep their offset). */
  moveView(sheetId: string, id: string, pos: [number, number]) {
    useDrawing.getState().edit('Move view', (d) => {
      const s = d.sheets.find((x) => x.id === sheetId)
      const v = s?.views.find((x) => x.id === id)
      if (!s || !v) return
      const dx = pos[0] - v.pos[0], dy = pos[1] - v.pos[1]
      v.pos = pos
      const follow = (pid: string) => {
        for (const c of s.views) if (c.parentId === pid && c.align) { c.pos = [c.pos[0] + dx, c.pos[1] + dy]; follow(c.id) }
      }
      follow(id)
    })
  },
  removeView(sheetId: string, id: string) {
    useDrawing.getState().edit('Delete view', (d) => {
      const s = d.sheets.find((x) => x.id === sheetId)
      if (!s) return
      const gone = new Set<string>([id])
      let grew = true
      while (grew) {
        grew = false
        for (const v of s.views) if (v.parentId && gone.has(v.parentId) && !gone.has(v.id)) { gone.add(v.id); grew = true }
      }
      s.views = s.views.filter((v) => !gone.has(v.id))
      s.dims = s.dims.filter((x) => !gone.has(x.viewId))
    })
    useDrawing.setState({ selection: null })
  },
  addDim(sheetId: string, dim: Omit<Dimension, 'id'>): string {
    let id = ''
    useDrawing.getState().edit('Add dimension', (d) => {
      id = nextId('d', allIds(d, 'd'))
      d.sheets.find((s) => s.id === sheetId)?.dims.push({ ...dim, id })
    })
    return id
  },
  updateDim(sheetId: string, id: string, patch: Partial<Dimension>) {
    useDrawing.getState().edit('Edit dimension', (d) => {
      const x = d.sheets.find((s) => s.id === sheetId)?.dims.find((q) => q.id === id)
      if (x) Object.assign(x, patch)
    })
  },
  removeDim(sheetId: string, id: string) {
    useDrawing.getState().edit('Delete dimension', (d) => {
      const s = d.sheets.find((x) => x.id === sheetId)
      if (s) s.dims = s.dims.filter((x) => x.id !== id)
    })
    useDrawing.setState({ selection: null })
  },
  addNote(sheetId: string, a: NewAnnotation): string {
    let id = ''
    useDrawing.getState().edit('Add annotation', (d) => {
      id = nextId('n', allIds(d, 'n'))
      d.sheets.find((s) => s.id === sheetId)?.notes.push({ ...a, id } as Annotation)
    })
    return id
  },
  updateNote(sheetId: string, id: string, patch: Record<string, unknown>) {
    useDrawing.getState().edit('Edit annotation', (d) => {
      const n = d.sheets.find((s) => s.id === sheetId)?.notes.find((q) => q.id === id)
      if (n) Object.assign(n, patch)
    })
  },
  removeNote(sheetId: string, id: string) {
    useDrawing.getState().edit('Delete annotation', (d) => {
      const s = d.sheets.find((x) => x.id === sheetId)
      if (s) s.notes = s.notes.filter((x) => x.id !== id)
    })
    useDrawing.setState({ selection: null })
  },
}

// ---------------------------------------------------------------- saving

const FORMAT = 1

/** Load the saved form of the drawings (drawings.json); null or anything unreadable gives an empty drawing. */
export function parseSection(j: unknown) {
  if (!j || typeof j !== 'object') return useDrawing.getState().load(null)
  const o = j as Partial<DrawingDoc>
  const base = emptyDrawing()
  useDrawing.getState().load({
    sheets: o.sheets ?? [],
    active: o.active ?? o.sheets?.[0]?.id ?? '',
    template: o.template ?? base.template,
    settings: { ...base.settings, ...(o.settings ?? {}) },
  })
}

registerProjectSection({
  file: 'drawings.json',
  save: () => {
    const d = useDrawing.getState().doc
    return d.sheets.length ? { format: FORMAT, ...d } : null
  },
  load: parseSection,
})
