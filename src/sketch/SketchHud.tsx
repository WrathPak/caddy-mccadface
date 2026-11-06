/** DOM overlay on the viewport: status flashes, plane-pick hint, and the Finish / Cancel buttons while sketching. */
import { useState } from 'react'
import { CaretDown, CaretRight, Check, Crosshair, X } from '@phosphor-icons/react'
import { useUi } from '@/store/ui'
import { Tip } from '@/ui/Tooltip'
import { useSketch, finishSketch, cancelSketch, lookAtSketch, setSketchView, type SketchView } from './store'
import { useSketchPick } from './create'
import { SketchToolBar } from './ToolBar'
import { useDevice } from '@/app/device'
import './sketch.css'

/** Fusion's Sketch Palette: what the sketch shows, Look At, Slice and the grid snap. It lives in the Inspector while a sketch is open (the panel has nothing else to show then), so it never sits on the drawing. */
export function SketchPalette() {
  const show = useSketch((s) => s.show)
  const snap = useUi((s) => s.snap)
  const [open, setOpen] = useState(true)
  const row = (key: keyof SketchView, label: string) => (
    <label className="sk-pal-row"><input type="checkbox" checked={show[key]} onChange={(e) => setSketchView({ [key]: e.target.checked })} />{label}</label>
  )
  return (
    <div className="sk-palette" data-testid="sk-palette">
      <button type="button" className="sk-pal-head" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <CaretDown size={10} /> : <CaretRight size={10} />}Sketch Palette</button>
      {open && (
        <>
          <button type="button" className="btn sk-pal-look" onClick={lookAtSketch}><Crosshair size={12} /> Look At</button>
          {row('profile', 'Show Profile')}
          {row('points', 'Show Points')}
          {row('dims', 'Show Dimensions')}
          {row('constraints', 'Show Constraints')}
          {row('slice', 'Slice')}
          <label className="sk-pal-row"><input type="checkbox" checked={snap} onChange={() => useUi.getState().toggleSnap()} />Snap</label>
        </>
      )}
    </div>
  )
}

export function SketchHud() {
  const active = useSketch((s) => s.active)
  const status = useSketch((s) => s.status)
  const info = useSketch((s) => s.info)
  const profiles = useSketch((s) => s.profiles)
  const tool = useSketch((s) => s.tool)
  const construction = useSketch((s) => s.construction)
  const picking = useSketchPick((s) => s.picking)
  const compact = useDevice((s) => s.compact)
  const text = status ?? (picking ? 'Select a plane or a planar face to sketch on' : null)
  const state = info.ok ? (info.dof === 0 ? 'Fully constrained' : 'Under-constrained') : 'Conflict'
  return (
    <>
      <div className="sk-stack">
        {/* (on a desktop the options of the tool sit in the Inspector, beside the Sketch Palette, so they never cover the drawing) */}
        {compact && <SketchToolBar />}
        {text && <div className="sk-status" data-kind={status ? 'warn' : 'info'}>{text}</div>}
      </div>
      {active && (
        <div className="sk-bar">
          <span className="info">
            {state}
            <span className="more"> · {profiles.length} profile{profiles.length === 1 ? '' : 's'}{construction ? ' · construction' : ''}{tool === 'dimension' ? ' · dimension' : ''}</span>
          </span>
          <Tip label="Cancel" desc="Leave the sketch and drop the changes made to it." side="bottom"><button type="button" className="btn" aria-label="Cancel" onClick={cancelSketch}><X size={12} /><span className="lbl"> Cancel</span></button></Tip>
          <Tip label="Finish Sketch" desc="Keep the sketch and go back to the model." side="bottom"><button type="button" className="btn primary" aria-label="Finish Sketch" onClick={finishSketch}><Check size={12} /><span className="lbl"> Finish Sketch</span></button></Tip>
        </div>
      )}
    </>
  )
}
