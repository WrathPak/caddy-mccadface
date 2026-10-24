/** Options bar of the newer sketch tools: counts, radii, text and so on, shown over the viewport while the tool is active. */
import { useEffect, useState, type ReactNode } from 'react'
import { evalNumber } from '@/doc/params'
import { FONTS } from './font'
import { applyPatternR, editSelectedText, useSketchOpts, type SketchOpts } from './toolsUi'
import { splineHandlesCommand } from './toolsUi'
import { entityById } from './model'
import { useSketch } from './store'

function Num({ id, label, k, min, unit }: { id: string; label: string; k: keyof SketchOpts; min?: number; unit?: string }) {
  const value = useSketchOpts((s) => s.o[k]) as number
  const set = useSketchOpts((s) => s.set)
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  const commit = () => {
    const v = evalNumber(text, unit)
    if (v !== null && (min === undefined || v >= min)) set({ [k]: v } as Partial<SketchOpts>)
    else setText(String(value))
  }
  return (
    <label className="sk-opt"><span>{label}</span>
      <input data-testid={'sk-opt-' + id} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { commit(); (e.target as HTMLElement).blur() } }} />
    </label>
  )
}

function Sel<K extends keyof SketchOpts>({ id, label, k, options }: { id: string; label: string; k: K; options: { value: string; label: string }[] }) {
  const value = useSketchOpts((s) => s.o[k]) as string
  const set = useSketchOpts((s) => s.set)
  return (
    <label className="sk-opt"><span>{label}</span>
      <select data-testid={'sk-opt-' + id} value={value} onChange={(e) => set({ [k]: e.target.value } as Partial<SketchOpts>)} onKeyDown={(e) => e.stopPropagation()}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

function Check({ id, label, k }: { id: string; label: string; k: keyof SketchOpts }) {
  const value = useSketchOpts((s) => s.o[k]) as boolean
  const set = useSketchOpts((s) => s.set)
  return <label className="sk-opt"><input type="checkbox" data-testid={'sk-opt-' + id} checked={value} onChange={(e) => set({ [k]: e.target.checked } as Partial<SketchOpts>)} /><span>{label}</span></label>
}

const FONT_OPTIONS = Object.entries(FONTS).map(([value, f]) => ({ value, label: f.label }))

function Bar({ title, children }: { title: string; children: ReactNode }) {
  return <div className="sk-toolbar" data-testid="sk-toolbar"><b>{title}</b>{children}</div>
}

function TextEditor() {
  const model = useSketch((s) => s.model)
  const sel = useSketch((s) => s.sel)
  const tool = useSketch((s) => s.tool)
  const id = sel.find((i) => entityById(model, i)?.type === 'text')
  const e = id ? entityById(model, id) : undefined
  const [t, setT] = useState('')
  useEffect(() => { if (e?.type === 'text') setT(e.text) }, [e?.type === 'text' ? e.text : '', id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (tool !== 'select' || e?.type !== 'text') return null
  return (
    <Bar title="Text">
      <label className="sk-opt"><span>Text</span><input data-testid="sk-text-edit" value={t} onChange={(ev) => setT(ev.target.value)} onBlur={() => t !== e.text && editSelectedText({ text: t, font: e.font })} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') (ev.target as HTMLElement).blur() }} /></label>
      <label className="sk-opt"><span>Height</span><input data-testid="sk-text-height" defaultValue={e.h} key={e.h} onBlur={(ev) => { const v = evalNumber(ev.target.value, 'mm'); if (v && v !== e.h) editSelectedText({ h: v, font: e.font }) }} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') (ev.target as HTMLElement).blur() }} /></label>
    </Bar>
  )
}

export function SketchToolBar() {
  const tool = useSketch((s) => s.tool)
  const active = useSketch((s) => s.active)
  const o = useSketchOpts((s) => s.o)
  if (!active) return null
  switch (tool) {
    case 'spline': case 'splineC':
      return <Bar title={tool === 'spline' ? 'Fit point spline' : 'Control point spline'}><Check id="closed" label="Closed" k="splineClosed" /><button type="button" className="btn" data-testid="sk-handles" onClick={splineHandlesCommand}>Tangent handles on selected</button><span className="sk-note">Click points, Enter or double click to finish. Click the first point to close.</span></Bar>
    case 'polygon':
      return <Bar title="Polygon"><Num id="sides" label="Sides" k="sides" min={3} /><Sel id="kind" label="Type" k="polyKind" options={[{ value: 'inscribed', label: 'Inscribed' }, { value: 'circumscribed', label: 'Circumscribed' }, { value: 'edge', label: 'Edge' }]} /><span className="sk-note">{o.polyKind === 'edge' ? 'Click the two ends of one side.' : 'Click the centre, then a corner (or the middle of a side when circumscribed).'}</span></Bar>
    case 'slotCC': case 'slotOv': return <Bar title={tool === 'slotCC' ? 'Centre to centre slot' : 'Overall slot'}><span className="sk-note">Click the two ends, then drag out the width.</span></Bar>
    case 'slotArc': return <Bar title="Centre point arc slot"><span className="sk-note">Click the centre, the start, the end, then the width.</span></Bar>
    case 'arcT': return <Bar title="Tangent arc"><span className="sk-note">Click the end of a line or arc, then the end of the new arc.</span></Bar>
    case 'ellipse': return <Bar title="Ellipse"><span className="sk-note">Click the centre, the end of the long axis, then a point for the short radius.</span></Bar>
    case 'fillet': return <Bar title="Sketch fillet"><Num id="radius" label="Radius" k="filletR" min={0.001} unit="mm" /><span className="sk-note">Click the corner, or two lines.</span></Bar>
    case 'chamfer': return <Bar title="Sketch chamfer"><Num id="dist" label="Distance" k="chamferD" min={0.001} unit="mm" /><Num id="dist2" label="Distance 2 (0 = same)" k="chamferD2" min={0} unit="mm" /><span className="sk-note">Click the corner, or two lines.</span></Bar>
    case 'mirror': return <Bar title="Sketch mirror"><span className="sk-note">With the curves selected, click the line to mirror across.</span></Bar>
    case 'patternR':
      return (
        <Bar title="Rectangular pattern">
          <Num id="count" label="Count" k="rectCount" min={1} /><Num id="spacing" label="Spacing" k="rectSpacing" min={0.001} unit="mm" /><Num id="angle" label="Direction" k="rectAngle" unit="deg" />
          <Num id="count2" label="Rows" k="rectCount2" min={1} /><Num id="spacing2" label="Row spacing" k="rectSpacing2" min={0.001} unit="mm" />
          <button type="button" className="btn primary" data-testid="sk-apply" onClick={() => applyPatternR()}>Apply</button>
        </Bar>
      )
    case 'patternC':
      return <Bar title="Circular pattern"><Num id="count" label="Count" k="circCount" min={2} /><Num id="angle" label="Angle" k="circAngle" unit="deg" /><span className="sk-note">With the curves selected, click the point to turn about.</span></Bar>
    case 'text':
      return (
        <Bar title="Text">
          <label className="sk-opt"><span>Text</span><input data-testid="sk-opt-text" value={o.text} onChange={(e) => useSketchOpts.getState().set({ text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} /></label>
          <Num id="height" label="Height" k="textH" min={0.1} unit="mm" /><Num id="angle" label="Angle" k="textAngle" unit="deg" />
          <Sel id="font" label="Font" k="textFont" options={FONT_OPTIONS} />
          <span className="sk-note">Click where the text starts. Its outlines become profiles.</span>
        </Bar>
      )
    default: return <TextEditor />
  }
}
