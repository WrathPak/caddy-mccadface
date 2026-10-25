/** The Drawing workspace: covers the 3D viewport with the sheet, the sheet tabs and a status line. */
import { useEffect, useState } from 'react'
import { ArrowsOut, MagnifyingGlassMinus, MagnifyingGlassPlus, Plus, Sliders, Trash } from '@phosphor-icons/react'
import { useUi } from '@/store/ui'
import { Modal } from '@/ui/Modal'
import { Tip } from '@/ui/Tooltip'
import { Canvas, camHandle, useSheetOutput } from './Canvas'
import { useTemplateDialog } from './templateDialog'
import { useViewGeoms } from './views'
import type { SheetOutput } from './sheetprims'
import { editSheet } from './forms'
import { startBaseView } from './actions'
import { DEFAULT_TEMPLATE, SHEET_SIZES } from './sheets'
import { activeSheet, drawingActions, useDrawing } from './store'
import { endTool, toolKey, useTool } from './tools'
import type { TitleBlockTemplate, TitleCell } from './types'
import './drawing.css'

/** Edit the title block layout (the owner's own template). */
function TemplateDialog() {
  const open = useTemplateDialog((s) => s.open)
  const template = useDrawing((s) => s.doc.template)
  const [t, setT] = useState<TitleBlockTemplate>(template)
  useEffect(() => { if (open) setT(structuredClone(template)) }, [open, template])
  if (!open) return null
  const close = () => useTemplateDialog.getState().set(false)
  const upd = (i: number, p: Partial<TitleCell>) => setT({ ...t, cells: t.cells.map((c, k) => (k === i ? { ...c, ...p } : c)) })
  const num = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0)
  const apply = () => {
    const cells = t.cells.filter((c) => c.w > 0 && c.h > 0).map((c) => ({ ...c, key: c.key.trim() || c.id }))
    useDrawing.getState().edit('Title block template', (d) => { d.template = { ...t, cells } })
    close()
  }
  const add = () => {
    let n = t.cells.length + 1
    while (t.cells.some((c) => c.id === 'field' + n)) n++
    setT({ ...t, cells: [...t.cells, { id: 'field' + n, label: 'New field', key: 'field' + n, x: 0, y: t.h, w: 60, h: 12, size: 3.5 }], h: t.h + 12 })
  }
  return (
    <Modal
      title="Title block template" width={640} onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={() => setT(structuredClone(DEFAULT_TEMPLATE))} data-testid="template-reset">Reset to standard</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn primary" onClick={apply} data-testid="template-ok">OK</button>
        </>
      }
    >
      <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
        Each field is a box in the title block. Positions are in millimetres from the lower left corner of the block. A field with the key
        {' '}<span className="mono">sheet</span> or <span className="mono">scale</span> fills itself in; every other key is a value you type per sheet in Sheet Setup.
      </div>
      <div className="dw-tpl-size">
        <label>Width <input type="number" value={t.w} data-testid="tpl-w" onChange={(e) => setT({ ...t, w: Math.max(40, num(e.target.value)) })} /></label>
        <label>Height <input type="number" value={t.h} data-testid="tpl-h" onChange={(e) => setT({ ...t, h: Math.max(10, num(e.target.value)) })} /></label>
        <label className="chk"><input type="checkbox" checked={t.showProjection} onChange={(e) => setT({ ...t, showProjection: e.target.checked })} /> Projection symbol</label>
      </div>
      <div className="dw-tpl" role="table">
        <div className="dw-tpl-h" role="row">
          <span>Label</span><span>Key</span><span>X</span><span>Y</span><span>Width</span><span>Height</span><span>Text</span><span />
        </div>
        {t.cells.map((c, i) => (
          <div className="dw-tpl-r" role="row" key={c.id} data-testid={'tpl-row-' + c.id}>
            <input value={c.label} spellCheck={false} onChange={(e) => upd(i, { label: e.target.value })} aria-label="Label" />
            <input value={c.key} spellCheck={false} onChange={(e) => upd(i, { key: e.target.value.replace(/\s+/g, '') })} aria-label="Key" />
            <input type="number" value={c.x} onChange={(e) => upd(i, { x: num(e.target.value) })} aria-label="X" />
            <input type="number" value={c.y} onChange={(e) => upd(i, { y: num(e.target.value) })} aria-label="Y" />
            <input type="number" value={c.w} onChange={(e) => upd(i, { w: Math.max(1, num(e.target.value)) })} aria-label="Width" />
            <input type="number" value={c.h} onChange={(e) => upd(i, { h: Math.max(1, num(e.target.value)) })} aria-label="Height" />
            <input type="number" value={c.size} step={0.5} onChange={(e) => upd(i, { size: Math.max(1, num(e.target.value)) })} aria-label="Text height" />
            <button type="button" className="rbtn small" style={{ minWidth: 0, padding: 2 }} aria-label="Remove field" onClick={() => setT({ ...t, cells: t.cells.filter((_, k) => k !== i) })}><Trash size={13} /></button>
          </div>
        ))}
      </div>
      <button type="button" className="btn" style={{ marginTop: 8 }} onClick={add} data-testid="template-add"><Plus size={12} /> Add field</button>
    </Modal>
  )
}

function Status({ sheetId, out }: { sheetId: string; out: SheetOutput | null }) {
  const hint = useTool((s) => s.hint)
  const tool = useTool((s) => s.tool)
  const cursor = useTool((s) => s.cursor)
  const doc = useDrawing((s) => s.doc)
  const sheet = doc.sheets.find((s) => s.id === sheetId)
  const sel = useDrawing((s) => s.selection)
  const broken = out ? Object.entries(out.broken) : []
  let info = ''
  if (sel?.kind === 'dim' && out?.values[sel.id] !== undefined) info = `Dimension ${out.values[sel.id].toFixed(3)}`
  else if (sel?.kind === 'view') info = `View ${sheet?.views.find((v) => v.id === sel.id)?.label ?? ''}`
  const errors = Object.values(useDrawingErrors())
  return (
    <div className="dw-status" data-testid="drawing-status">
      <span className="hint" data-testid="drawing-hint">{tool ? hint : 'Select a view, a dimension or a note. Double-click to edit it.'}</span>
      {info && <span className="info">{info}</span>}
      {broken.length > 0 && (
        <button type="button" className="warn" data-testid="drawing-broken" title={broken.map(([, m]) => m).join('\n')}
          onClick={() => useDrawing.getState().select({ kind: 'dim', id: broken[0][0] })}>
          {broken.length} {broken.length === 1 ? 'dimension has' : 'dimensions have'} lost a point in the model
        </button>
      )}
      {errors.length > 0 && <span className="warn">{errors[0]}</span>}
      <span style={{ flex: 1 }} />
      {cursor && <span className="mono coords">{cursor[0].toFixed(1)}, {cursor[1].toFixed(1)} mm</span>}
    </div>
  )
}

const useDrawingErrors = () => useViewGeoms((s) => s.errors)

export function DrawingWorkspace() {
  const workspace = useUi((s) => s.workspace)
  const doc = useDrawing((s) => s.doc)
  const sheet = activeSheet(doc)
  const on = workspace === 'drawing'
  const out = useSheetOutput(on ? sheet : undefined)

  // keys belong to the drawing while it is open: they must not delete bodies or undo the model
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (typing || document.querySelector('[role="dialog"]')) return
      const ctrl = e.ctrlKey || e.metaKey
      const st = useDrawing.getState()
      if (ctrl && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.stopImmediatePropagation(); if (e.shiftKey) st.redo(); else st.undo(); return }
      if (ctrl && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); e.stopImmediatePropagation(); st.redo(); return }
      if (e.key === 'Escape' || e.key === 'Enter') {
        if (toolKey(e.key)) { e.preventDefault(); e.stopImmediatePropagation() }
        else if (e.key === 'Escape' && st.selection) { st.select(null); e.preventDefault() }
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selection && sheet) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const s = st.selection
        if (s.kind === 'view') drawingActions.removeView(sheet.id, s.id)
        else if (s.kind === 'dim') drawingActions.removeDim(sheet.id, s.id)
        else drawingActions.removeNote(sheet.id, s.id)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [on, sheet])

  useEffect(() => { if (!on) endTool() }, [on])

  if (!on) return <TemplateDialog />
  return (
    <div className="dw" data-testid="drawing-workspace">
      <div className="dw-bar">
        <div className="dw-tabs" role="tablist">
          {doc.sheets.map((s) => (
            <button key={s.id} role="tab" aria-selected={s.id === sheet?.id} className="dw-tab" data-testid={'sheet-tab-' + s.id}
              onClick={() => drawingActions.setActive(s.id)} onDoubleClick={() => editSheet(s)}>{s.name}</button>
          ))}
          <Tip label="New sheet" side="bottom"><button type="button" className="dw-tab add" aria-label="New sheet" data-testid="sheet-add" onClick={() => drawingActions.addSheet()}><Plus size={12} /></button></Tip>
        </div>
        <span style={{ flex: 1 }} />
        {sheet && (
          <div className="dw-tools">
            <span className="dw-size" data-testid="sheet-size">{SHEET_SIZES.find((z) => z.id === sheet.size)?.id} {sheet.portrait ? 'portrait' : 'landscape'}, {sheet.projection} angle</span>
            <Tip label="Sheet setup: size, projection, scale and the title block text" side="bottom">
              <button type="button" className="rbtn small" onClick={() => editSheet(sheet)} data-testid="sheet-setup"><Sliders size={13} /> Setup</button>
            </Tip>
            <Tip label="Zoom out" side="bottom"><button type="button" className="rbtn small" aria-label="Zoom out" onClick={() => camHandle.current?.zoomBy(1 / 1.25)}><MagnifyingGlassMinus size={14} /></button></Tip>
            <Tip label="Zoom in" side="bottom"><button type="button" className="rbtn small" aria-label="Zoom in" onClick={() => camHandle.current?.zoomBy(1.25)}><MagnifyingGlassPlus size={14} /></button></Tip>
            <Tip label="Fit the sheet" side="bottom"><button type="button" className="rbtn small" aria-label="Fit the sheet" onClick={() => camHandle.current?.fit()}><ArrowsOut size={14} /></button></Tip>
          </div>
        )}
      </div>
      {sheet ? (
        <Canvas sheet={sheet} out={out} />
      ) : (
        <div className="dw-empty" data-testid="drawing-empty">
          <div className="dw-card">
            <h3>Technical drawing</h3>
            <p>Make a sheet, then add views of your model. Dimensions follow the model when you change it.</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => drawingActions.addSheet()} data-testid="empty-new-sheet">New sheet</button>
              <button type="button" className="btn primary" onClick={() => startBaseView()} data-testid="empty-base-view">Base view</button>
            </div>
          </div>
        </div>
      )}
      {sheet && <Status sheetId={sheet.id} out={out} />}
      <TemplateDialog />
    </div>
  )
}
