/** DOM overlay on the viewport: status flashes, plane-pick hint, and the Finish / Cancel buttons while sketching. */
import { Check, X } from '@phosphor-icons/react'
import { useSketch, finishSketch, cancelSketch } from './store'
import { useSketchPick } from './create'
import './sketch.css'

export function SketchHud() {
  const active = useSketch((s) => s.active)
  const status = useSketch((s) => s.status)
  const info = useSketch((s) => s.info)
  const profiles = useSketch((s) => s.profiles)
  const tool = useSketch((s) => s.tool)
  const construction = useSketch((s) => s.construction)
  const picking = useSketchPick((s) => s.picking)
  const text = status ?? (picking ? 'Select a plane or a planar face to sketch on' : null)
  const state = info.ok ? (info.dof === 0 ? 'Fully constrained' : 'Under-constrained') : 'Conflict'
  return (
    <>
      {text && <div className="sk-status" data-kind={status ? 'warn' : 'info'}>{text}</div>}
      {active && (
        <div className="sk-bar">
          <span className="info">
            {state} · {profiles.length} profile{profiles.length === 1 ? '' : 's'}
            {construction ? ' · construction' : ''}
            {tool === 'dimension' ? ' · dimension' : ''}
          </span>
          <button type="button" className="btn" onClick={cancelSketch}><X size={12} /> Cancel</button>
          <button type="button" className="btn primary" onClick={finishSketch}><Check size={12} /> Finish Sketch</button>
        </div>
      )}
    </>
  )
}
