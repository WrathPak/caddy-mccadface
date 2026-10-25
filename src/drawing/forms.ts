/** Dialogs of the Drawing workspace: schema forms shown in the Inspector, with live preview and one undo step. */
import { useUi } from '@/store/ui'
import { missingRequired, schemaDefaults, type ParamSchema, type ParamValues } from '@/ui/schema'
import { listComponents, viewChoices } from './components'
import { GDT_LABELS } from './gdt'
import { SCALES, SHEET_SIZES, scaleText } from './sheets'
import { drawingActions, nextId, useDrawing, type NewAnnotation } from './store'
import { setViewScale } from './service'
import type { Annotation, Dimension, DrawingDoc, DrawingView, GdtSymbol, Sheet } from './types'
import { ORIENTATIONS } from '@/kernel/drawing-geom'

interface FormOpts {
  schema: ParamSchema
  values: ParamValues
  /** every change, for a live preview (does not make an undo step) */
  onChange?: (v: ParamValues) => void
  onOk: (v: ParamValues) => void
  onCancel?: () => void
  tool?: string
}

/** Show a form in the Inspector. Only one at a time: opening another cancels the first. */
export function openForm(o: FormOpts) {
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  let done = false
  const finish = () => {
    if (done) return false
    done = true
    useUi.getState().closeInspector()
    useUi.getState().setActiveTool(null)
    return true
  }
  ui.setActiveTool(o.tool ?? null)
  ui.openInspector({
    schema: o.schema,
    values: { ...schemaDefaults(o.schema), ...o.values },
    onChange: o.onChange,
    onOk: (v) => {
      if (missingRequired(o.schema, v).length) return
      if (finish()) o.onOk(v)
    },
    onCancel: () => {
      if (finish()) o.onCancel?.()
    },
  })
}

/** A form that edits part of the drawing document: changes show at once, OK is one undo step, Cancel puts everything back. */
function editDoc(schema: ParamSchema, values: ParamValues, apply: (d: DrawingDoc, v: ParamValues) => void, tool?: string, after?: () => void) {
  const base = useDrawing.getState().doc
  const st = useDrawing.getState()
  openForm({
    schema, values, tool,
    onChange: (v) => st.preview(base, (d) => apply(d, v)),
    onOk: (v) => {
      st.preview(base, (d) => apply(d, v))
      st.commit(base)
      after?.()
    },
    onCancel: () => st.revert(base),
  })
}

const scaleOptions = (auto = false) => [
  ...(auto ? [{ value: '0', label: 'Fit the sheet' }] : []),
  ...SCALES.map((s) => ({ value: String(s), label: scaleText(s) })),
]

// ---------------------------------------------------------------- sheet

export function sheetSchema(titleKeys: { key: string; label: string }[]): ParamSchema {
  return {
    id: 'drawingSheet',
    title: 'Sheet',
    params: [
      { type: 'text', key: 'name', label: 'Name', default: 'Sheet 1' },
      { type: 'enum', key: 'size', label: 'Size', display: 'select', default: 'A3', options: SHEET_SIZES.map((s) => ({ value: s.id, label: s.label })), help: 'The paper size. Everything you draw is in millimetres on this sheet.' },
      { type: 'enum', key: 'orientation', label: 'Orientation', display: 'segmented', default: 'landscape', options: [{ value: 'landscape', label: 'Landscape' }, { value: 'portrait', label: 'Portrait' }] },
      { type: 'enum', key: 'projection', label: 'Projection', display: 'segmented', default: 'third', options: [{ value: 'third', label: 'Third angle' }, { value: 'first', label: 'First angle' }], help: 'Third angle (US) puts the top view above the front view. First angle (ISO) puts it below.' },
      { type: 'enum', key: 'scale', label: 'Sheet scale', display: 'select', default: '1', options: scaleOptions(), help: 'The scale written in the title block.' },
      { type: 'group', label: 'Title block', children: titleKeys.map((k): import('@/ui/schema').ParamDef => ({ type: 'text', key: 'tb_' + k.key, label: k.label, default: '' })) },
    ],
  }
}

export function editSheet(sheet: Sheet) {
  const doc = useDrawing.getState().doc
  const keys = doc.template.cells.filter((c) => !['sheet', 'scale'].includes(c.key)).map((c) => ({ key: c.key, label: c.label }))
  const values: ParamValues = {
    name: sheet.name, size: sheet.size, orientation: sheet.portrait ? 'portrait' : 'landscape', projection: sheet.projection, scale: String(sheet.scale),
  }
  for (const k of keys) values['tb_' + k.key] = sheet.titleBlock[k.key] ?? ''
  editDoc(sheetSchema(keys), values, (d, v) => {
    const s = d.sheets.find((x) => x.id === sheet.id)
    if (!s) return
    s.name = String(v.name) || s.name
    s.size = String(v.size)
    s.portrait = v.orientation === 'portrait'
    s.projection = v.projection === 'first' ? 'first' : 'third'
    s.scale = Number(v.scale) || 1
    for (const k of keys) s.titleBlock[k.key] = String(v['tb_' + k.key] ?? '')
  }, 'drawing.sheet')
}

// ---------------------------------------------------------------- views

export function baseViewSchema(): ParamSchema {
  return {
    id: 'drawingBaseView',
    title: 'Base view',
    params: [
      { type: 'enum', key: 'choice', label: 'Show', display: 'select', default: 'all', options: viewChoices(), help: 'What to draw: the whole model, or one part of it.' },
      { type: 'enum', key: 'orientation', label: 'Orientation', display: 'select', default: 'front', options: Object.entries(ORIENTATIONS).map(([value, o]) => ({ value, label: o.label })), help: 'Which way you look at the part. Isometric makes an isometric view.' },
      { type: 'enum', key: 'scale', label: 'Scale', display: 'select', default: '0', options: scaleOptions(true), help: 'Fit the sheet picks the largest standard scale that leaves room for the other views.' },
      { type: 'group', label: 'Lines', children: [
        { type: 'bool', key: 'showHidden', label: 'Hidden lines', default: true, help: 'Dashed lines for edges behind the part.' },
        { type: 'bool', key: 'showTangent', label: 'Tangent edges', default: false, help: 'Thin lines where a fillet meets a flat face.' },
        { type: 'bool', key: 'showCenter', label: 'Center marks and centerlines', default: true, help: 'Marks on holes and cylinders.' },
      ] },
    ],
  }
}

export function viewSchema(v: DrawingView): ParamSchema {
  const params: ParamSchema['params'] = [
    { type: 'text', key: 'label', label: 'Label', default: v.label },
    { type: 'enum', key: 'scale', label: 'Scale', display: 'select', default: String(v.scale), options: [...scaleOptions(), ...(SCALES.includes(v.scale) ? [] : [{ value: String(v.scale), label: scaleText(v.scale) }])] },
    { type: 'bool', key: 'showLabel', label: 'Show label', default: true },
    { type: 'group', label: 'Lines', children: [
      { type: 'bool', key: 'showHidden', label: 'Hidden lines', default: true },
      { type: 'bool', key: 'showTangent', label: 'Tangent edges', default: false },
      { type: 'bool', key: 'showCenter', label: 'Center marks and centerlines', default: true },
    ] },
  ]
  if (v.kind === 'section') params.push({ type: 'bool', key: 'flip', label: 'Flip the cut direction', default: false, help: 'Look at the other half of the part.' })
  return { id: 'drawingView', title: `View: ${v.label}`, params }
}

export function editView(sheetId: string, v: DrawingView) {
  editDoc(viewSchema(v), {
    label: v.label, scale: String(v.scale), showLabel: v.showLabel, showHidden: v.showHidden, showTangent: v.showTangent, showCenter: v.showCenter, flip: v.cut?.flip ?? false,
  }, (d, vals) => {
    const s = d.sheets.find((x) => x.id === sheetId)
    const x = s?.views.find((q) => q.id === v.id)
    if (!s || !x) return
    x.label = String(vals.label)
    x.showLabel = !!vals.showLabel
    x.showHidden = !!vals.showHidden
    x.showTangent = !!vals.showTangent
    x.showCenter = !!vals.showCenter
    if (x.cut) x.cut.flip = !!vals.flip
    const sc = Number(vals.scale)
    if (sc > 0 && sc !== x.scale) {
      const setAll = (q: DrawingView) => {
        q.scale = sc
        for (const c of s.views) if (c.parentId === q.id && c.kind !== 'detail') setAll(c)
      }
      setAll(x)
    }
  }, 'drawing.view')
}

// ---------------------------------------------------------------- dimensions

export function dimSchema(d: Dimension): ParamSchema {
  const params: ParamSchema['params'] = [
    { type: 'text', key: 'text', label: 'Text', default: '', placeholder: '<> for the measured value', help: 'Leave empty to show the measured value. Use <> to put the value inside your own text, for example "<> typ.".' },
    { type: 'number', key: 'precision', label: 'Decimals', min: 0, max: 6, step: 1, default: 2 },
    { type: 'number', key: 'offset', label: d.type === 'radius' || d.type === 'diameter' ? 'Leader length' : 'Distance from the part', unit: 'mm', step: 1, default: 8, help: 'Sheet millimetres. You can also drag the dimension on the sheet.' },
  ]
  if (d.type === 'radius' || d.type === 'diameter') params.push({ type: 'number', key: 'angle', label: 'Leader angle', unit: 'deg', step: 5, default: 45 })
  if (d.type === 'linear' || d.type === 'ordinate' || d.type === 'baseline') params.push({ type: 'enum', key: 'axis', label: 'Measures', display: 'segmented', default: 'h', options: [{ value: 'h', label: 'Across' }, { value: 'v', label: 'Up' }] })
  params.push({ type: 'group', label: 'Tolerance', collapsed: !d.tolPlus && !d.tolMinus, children: [
    { type: 'text', key: 'tolPlus', label: 'Upper', default: '', placeholder: '+0.1' },
    { type: 'text', key: 'tolMinus', label: 'Lower', default: '', placeholder: '-0.1' },
  ] })
  return { id: 'drawingDim', title: 'Dimension', params }
}

export function editDim(sheetId: string, dim: Dimension) {
  editDoc(dimSchema(dim), { text: dim.text, precision: dim.precision, offset: dim.offset, angle: dim.angle, axis: dim.axis, tolPlus: dim.tolPlus, tolMinus: dim.tolMinus }, (d, v) => {
    const x = d.sheets.find((s) => s.id === sheetId)?.dims.find((q) => q.id === dim.id)
    if (!x) return
    x.text = String(v.text)
    x.precision = Math.max(0, Math.min(6, Math.round(Number(v.precision))))
    x.offset = Number(v.offset)
    x.angle = Number(v.angle)
    x.axis = v.axis === 'v' ? 'v' : 'h'
    x.tolPlus = String(v.tolPlus)
    x.tolMinus = String(v.tolMinus)
  }, 'drawing.dim')
}

// ---------------------------------------------------------------- annotations

const GDT_OPTIONS = (Object.keys(GDT_LABELS) as GdtSymbol[]).map((k) => ({ value: k, label: GDT_LABELS[k] }))

export function noteSchema(kind: Annotation['kind']): ParamSchema {
  switch (kind) {
    case 'note':
    case 'leader':
      return { id: 'drawingNote', title: kind === 'note' ? 'Note' : 'Leader', params: [
        { type: 'text', key: 'text', label: 'Text', multiline: true, default: '', help: 'Each line starts a new line on the sheet.' },
        { type: 'number', key: 'size', label: 'Text height', unit: 'mm', min: 1.5, max: 20, step: 0.5, default: 3.5 },
      ] }
    case 'gdt':
      return { id: 'drawingGdt', title: 'Tolerance frame', params: [
        { type: 'enum', key: 'symbol', label: 'Characteristic', display: 'select', default: 'position', options: GDT_OPTIONS },
        { type: 'bool', key: 'diameter', label: 'Diameter zone', default: false, help: 'Puts a diameter sign in front of the tolerance.' },
        { type: 'text', key: 'tol', label: 'Tolerance', default: '0.1' },
        { type: 'enum', key: 'modifier', label: 'Material condition', display: 'segmented', default: '', options: [{ value: '', label: 'None' }, { value: 'M', label: 'M' }, { value: 'L', label: 'L' }] },
        { type: 'group', label: 'Datums', children: [
          { type: 'text', key: 'd1', label: 'Primary', default: '' },
          { type: 'text', key: 'd2', label: 'Secondary', default: '' },
          { type: 'text', key: 'd3', label: 'Tertiary', default: '' },
        ] },
      ] }
    case 'datum':
      return { id: 'drawingDatum', title: 'Datum', params: [{ type: 'text', key: 'letter', label: 'Letter', default: 'A' }] }
    case 'finish':
      return { id: 'drawingFinish', title: 'Surface finish', params: [
        { type: 'enum', key: 'method', label: 'Machining', display: 'select', default: 'removal', options: [{ value: 'any', label: 'Any process' }, { value: 'removal', label: 'Material removal required' }, { value: 'prohibited', label: 'Material removal prohibited' }] },
        { type: 'text', key: 'ra', label: 'Roughness Ra', default: '3.2', help: 'In micrometres.' },
        { type: 'text', key: 'allowance', label: 'Machining allowance', default: '' },
        { type: 'text', key: 'lay', label: 'Lay', default: '', placeholder: '= or X or M' },
      ] }
    case 'balloon': {
      const parts = listComponents()
      return { id: 'drawingBalloon', title: 'Balloon', params: [
        { type: 'enum', key: 'item', label: 'Part', display: 'select', default: parts[0]?.key ?? '', options: parts.map((p, i) => ({ value: p.key, label: `${i + 1}  ${p.name}` })), help: 'The balloon shows the item number this part has in the parts list.' },
      ] }
    }
    default:
      return { id: 'drawingPartsList', title: 'Parts list', params: [] }
  }
}

export function noteValues(a: Annotation): ParamValues {
  switch (a.kind) {
    case 'note': case 'leader': return { text: a.text, size: a.size }
    case 'gdt': return { symbol: a.symbol, diameter: a.diameter, tol: a.tol, modifier: a.modifier, d1: a.datums[0] ?? '', d2: a.datums[1] ?? '', d3: a.datums[2] ?? '' }
    case 'datum': return { letter: a.letter }
    case 'finish': return { method: a.method, ra: a.ra, allowance: a.allowance, lay: a.lay }
    case 'balloon': return { item: a.item }
    default: return {}
  }
}

export function notePatch(kind: Annotation['kind'], v: ParamValues): Record<string, unknown> {
  switch (kind) {
    case 'note': case 'leader': return { text: String(v.text), size: Number(v.size) }
    case 'gdt': return { symbol: v.symbol, diameter: !!v.diameter, tol: String(v.tol), modifier: String(v.modifier), datums: [v.d1, v.d2, v.d3].map(String).filter(Boolean) }
    case 'datum': return { letter: String(v.letter) }
    case 'finish': return { method: v.method, ra: String(v.ra), allowance: String(v.allowance), lay: String(v.lay) }
    case 'balloon': return { item: String(v.item) }
    default: return {}
  }
}

export function editNote(sheetId: string, a: Annotation) {
  if (a.kind === 'partsList') return
  editDoc(noteSchema(a.kind), noteValues(a), (d, v) => {
    const n = d.sheets.find((s) => s.id === sheetId)?.notes.find((q) => q.id === a.id)
    if (n) Object.assign(n, notePatch(a.kind, v))
  }, 'drawing.note')
}

/**
 * Put a new annotation on the sheet and ask for its details. It shows at once; OK keeps it (one undo step), Cancel takes it away.
 * Annotations with nothing to ask (the parts list) are just added.
 */
export function placeNote(sheetId: string, ann: NewAnnotation) {
  if (ann.kind === 'partsList') {
    drawingActions.addNote(sheetId, ann)
    return
  }
  const st = useDrawing.getState()
  const base = st.doc
  const id = nextId('n', base.sheets.flatMap((s) => s.notes.map((n) => n.id)))
  const withDefaults = { ...ann, id } as Annotation
  const apply = (d: DrawingDoc, v?: ParamValues) => {
    const sheet = d.sheets.find((x) => x.id === sheetId)
    if (!sheet) return
    if (!sheet.notes.some((q) => q.id === id)) sheet.notes.push({ ...withDefaults } as Annotation)
    const n = sheet.notes.find((q) => q.id === id)
    if (n && v) Object.assign(n, notePatch(ann.kind, v))
  }
  st.preview(base, (d) => apply(d))
  st.select({ kind: 'note', id })
  openForm({
    schema: noteSchema(ann.kind), values: { ...noteValues(withDefaults) }, tool: 'drawing.note',
    onChange: (v) => st.preview(base, (d) => apply(d, v)),
    onOk: (v) => { st.preview(base, (d) => apply(d, v)); st.commit(base) },
    onCancel: () => { st.revert(base); st.select(null) },
  })
}

export { setViewScale }
