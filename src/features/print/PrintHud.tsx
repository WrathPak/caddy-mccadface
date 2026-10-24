/** Print overlays outside the canvas: map legend, drain hole bar and the filament legend. */
import { useEffect, useMemo } from 'react'
import { Drop, Eraser, Trash, X } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
import { Tip } from '@/ui/Tooltip'
import { colorById } from './palette'
import { computePaintMap, usedSlots } from './paint'
import { settingsOf } from './settings'
import { useDrains } from './hollow'
import { runMap, showMap, usePrintView, type MapKind } from './view'
import './print.css'

const TITLES: Record<MapKind, string> = { overhang: 'Overhang map', thin: 'Thin walls', small: 'Small features' }

const LEGENDS: Record<MapKind, { ramp: string; from: string; to: string }> = {
  overhang: { ramp: 'linear-gradient(90deg, #f2cf2e, #f08a24, #d63a31)', from: 'just over the angle', to: 'flat ceiling' },
  thin: { ramp: 'linear-gradient(90deg, #f2cf2e, #f08a24, #d63a31)', from: 'just under the limit', to: 'paper thin' },
  small: { ramp: 'linear-gradient(90deg, #b861eb, #b861eb)', from: 'narrower than the limit', to: '' },
}

function MapPanel() {
  const { kind, angle, minThickness, minFeature, busy, result } = usePrintView()
  const geometry = useDoc((s) => s.geometry)
  const hiddenKey = useDoc((s) => s.features.length)
  // recompute when the thresholds or the bodies change
  useEffect(() => {
    if (!kind) return
    const t = setTimeout(() => void runMap(), 180)
    return () => clearTimeout(t)
  }, [kind, angle, minThickness, minFeature, geometry, hiddenKey])
  if (!kind) return null
  const lg = LEGENDS[kind]
  const field = kind === 'overhang' ? { label: 'Angle', unit: 'deg', value: angle, key: 'angle' as const, min: 5, max: 85, tip: 'Steepest overhang that prints without support, from vertical' }
    : kind === 'thin' ? { label: 'Min wall', unit: 'mm', value: minThickness, key: 'minThickness' as const, min: 0.1, max: 20, tip: 'Thinnest wall you accept, in mm' }
      : { label: 'Min size', unit: 'mm', value: minFeature, key: 'minFeature' as const, min: 0.05, max: 20, tip: 'Narrowest feature you accept, in mm' }
  return (
    <div className="print-card" data-testid="map-panel">
      <div className="print-card-head">
        <span>{TITLES[kind]}</span>
        <Tip label="Close the map" side="top"><button type="button" aria-label="Close map" onClick={() => showMap(null)}><X size={12} /></button></Tip>
      </div>
      <label className="print-field" title={field.tip}>
        <span>{field.label}</span>
        <input type="number" min={field.min} max={field.max} step={kind === 'overhang' ? 5 : 0.1} value={field.value} data-testid="map-threshold"
          onChange={(e) => { const v = +e.target.value; if (v >= field.min && v <= field.max) usePrintView.setState({ [field.key]: v }) }} />
        <span className="unit">{field.unit}</span>
      </label>
      <div className="print-legend" data-testid="map-legend">
        <div className="ramp" style={{ background: lg.ramp }} />
        <div className="ends"><span>{lg.from}</span><span>{lg.to}</span></div>
      </div>
      <div className="print-result" data-testid="map-result" data-flagged={result?.flagged ?? 0}>{busy ? 'Checking ...' : result ? result.lines.join(' ') : ''}</div>
    </div>
  )
}

function FilamentLegend() {
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const geometry = useDoc((s) => s.geometry)
  const kind = usePrintView((s) => s.kind)
  const items = useMemo(() => {
    const used = usedSlots(computePaintMap(features, rollback, geometry))
    if (!used.length) return []
    const s = settingsOf(features, rollback)
    return used.map((slot) => ({ slot, color: colorById(s.slotColors[slot - 1]) }))
  }, [features, rollback, geometry])
  if (!items.length || kind) return null
  return (
    <div className="print-card" data-testid="filament-legend">
      <div className="print-card-head"><span>Filaments</span></div>
      {items.map((i) => (
        <div className="print-chip" key={i.slot}><span className="sw" style={{ background: i.color.hex }} />Filament {i.slot}: {i.color.label}</div>
      ))}
    </div>
  )
}

function DrainBar() {
  const { open, adding, holes, set } = useDrains()
  if (!open) return null
  return (
    <div className="print-drain-bar">
      <div className="vp-bar" data-testid="drain-bar">
        <Tip label="Click the surface to place a drain hole. Alt+click a hole to remove it." side="bottom">
          <button type="button" data-active={adding} onClick={() => useDrains.setState({ adding: !adding })}><Drop size={14} /> Add drain holes</button>
        </Tip>
        <span className="sep" />
        <span className="print-count" data-testid="drain-count">{holes.length} {holes.length === 1 ? 'hole' : 'holes'}</span>
        <Tip label="Remove the last hole" side="bottom">
          <button type="button" disabled={!holes.length} onClick={() => set?.(holes.slice(0, -1))}><Eraser size={14} /></button>
        </Tip>
        <Tip label="Remove all holes" side="bottom">
          <button type="button" disabled={!holes.length} onClick={() => set?.([])}><Trash size={14} /></button>
        </Tip>
      </div>
    </div>
  )
}

/** Mounted once in the viewport. */
export function PrintHud() {
  useEffect(() => {
    // test handle: the stores
    const w = window as unknown as { __caddy?: Record<string, unknown> }
    if (import.meta.env.DEV && w.__caddy) w.__caddy.print = { view: usePrintView, drains: useDrains, showMap }
  }, [])
  return (
    <>
      <DrainBar />
      <div className="print-cards">
        <MapPanel />
        <FilamentLegend />
      </div>
    </>
  )
}
