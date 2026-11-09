/** The preview's controls over the viewport: layer range slider, move scrubber, legend and the out-of-date pill. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeSlash, Pause, Path, Play, StackSimple, X } from '@phosphor-icons/react'
import { getCommand, runCommand } from '@/app/commands'
import { Select } from '@/ui/Select'
import { Tip } from '@/ui/Tooltip'
import { setPreview, useSlice } from '../engine/sliceStore'
import { EXTRAS_MODES, MODE_LABEL, MODE_UNIT, fmtLength, fmtPct, fmtTime, rampCss, segmentRange, type ColorMode } from './data'
import { setBottom, setMode, setPlaying, setScrub, setTop, setTravel, toggleFilament, toggleRole, usePreview } from './previewStore'
import { roleColor } from './roles'
import { SliceCard } from '../slice/SliceCard'
import './preview.css'

const fmtZ = (z: number | undefined) => (z === undefined ? '' : `${z.toFixed(2)} mm`)

function LayerSlider() {
  const lo = usePreview((s) => s.lo)
  const hi = usePreview((s) => s.hi)
  const info = usePreview((s) => s.info)
  const track = useRef<HTMLDivElement>(null)
  const drag = useRef<'lo' | 'hi' | null>(null)
  const [focus, setFocus] = useState<'lo' | 'hi'>('hi')
  const n = info?.layerCount ?? 0
  if (!info || n < 1) return null
  const pct = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 100)
  const idxAt = (y: number) => {
    const r = track.current!.getBoundingClientRect()
    return Math.round(Math.max(0, Math.min(1, 1 - (y - r.top) / r.height)) * (n - 1))
  }
  const apply = (which: 'lo' | 'hi', i: number) => (which === 'hi' ? setTop(i) : setBottom(i))
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const i = idxAt(e.clientY)
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-thumb]')?.dataset.thumb as 'lo' | 'hi' | undefined
    // a click on the track takes the nearer thumb; on a tie the one that can move toward the click
    const pick = target ?? (Math.abs(i - lo) < Math.abs(i - hi) || (Math.abs(i - lo) === Math.abs(i - hi) && i < lo) ? 'lo' : 'hi')
    drag.current = pick
    setFocus(pick)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (!target) apply(pick, i)
    e.preventDefault()
  }
  const move = (e: React.PointerEvent) => { if (drag.current) apply(drag.current, idxAt(e.clientY)) }
  const up = (e: React.PointerEvent) => { drag.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ } }
  const thumb = (which: 'lo' | 'hi', i: number) => (
    <div
      key={which}
      className="sp-thumb"
      data-thumb={which}
      data-testid={`layer-thumb-${which}`}
      data-focus={focus === which}
      role="slider"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={which === 'hi' ? 'Top layer' : 'Bottom layer'}
      aria-valuemin={1}
      aria-valuemax={n}
      aria-valuenow={i + 1}
      aria-valuetext={`Layer ${i + 1}, ${fmtZ(info.layerZ[i])}`}
      onFocus={() => setFocus(which)}
      style={{ bottom: `${pct(i)}%` }}
    >
      <span className="sp-knob" />
      <span className="sp-chip" data-side={which}><b>{i + 1}</b><i>{fmtZ(info.layerZ[i])}</i></span>
    </div>
  )
  return (
    <div className="sp-slider glass" data-testid="layer-slider" data-lo={lo + 1} data-hi={hi + 1} data-count={n}>
      <div className="sp-slider-in" ref={track} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="sp-rail" />
        <div className="sp-fill" style={{ bottom: `${pct(lo)}%`, height: `${pct(hi) - pct(lo)}%` }} />
        {thumb('lo', lo)}
        {thumb('hi', hi)}
      </div>
    </div>
  )
}

function Scrubber() {
  const scrub = usePreview((s) => s.scrub)
  const playing = usePreview((s) => s.playing)
  const hi = usePreview((s) => s.hi)
  const lo = usePreview((s) => s.lo)
  const info = usePreview((s) => s.info)
  const result = useSlice((s) => s.result)
  const bar = useRef<HTMLDivElement>(null)
  const drag = useRef(false)
  const tp = result?.toolpaths
  const segs = useMemo(() => {
    if (!tp) return 0
    const [a, b] = segmentRange(tp.extrusions.layerStart, { lo: hi, hi, scrub: 1 })
    return b - a
  }, [tp, hi])
  if (!info) return null
  const at = (x: number) => { const r = bar.current!.getBoundingClientRect(); setScrub((x - r.left) / r.width) }
  return (
    <div className="sp-scrub glass" data-testid="move-scrubber" data-scrub={scrub.toFixed(3)}>
      <Tip label={playing ? 'Pause' : 'Play the nozzle path of the top layer'} side="top">
        <button type="button" className="sp-play" aria-label={playing ? 'Pause' : 'Play'} data-testid="scrub-play" onClick={() => setPlaying(!playing)}>
          {playing ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
        </button>
      </Tip>
      <div
        className="sp-bar"
        ref={bar}
        role="slider"
        tabIndex={0}
        aria-label="Move in the top layer"
        aria-valuemin={0}
        aria-valuemax={segs}
        aria-valuenow={Math.round(scrub * segs)}
        onPointerDown={(e) => { drag.current = true; setPlaying(false); e.currentTarget.setPointerCapture(e.pointerId); at(e.clientX) }}
        onPointerMove={(e) => { if (drag.current) at(e.clientX) }}
        onPointerUp={(e) => { drag.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* released */ } }}
        onPointerCancel={() => { drag.current = false }}
      >
        <div className="sp-bar-rail" />
        <div className="sp-bar-fill" style={{ width: `${scrub * 100}%` }} />
        <div className="sp-bar-knob" style={{ left: `${scrub * 100}%` }} />
      </div>
      <div className="sp-scrub-read num">
        <span>Layer {hi + 1}{lo > 0 ? `, from ${lo + 1}` : ''}</span>
        <span>{Math.round(scrub * segs).toLocaleString()} / {segs.toLocaleString()}</span>
      </div>
    </div>
  )
}

/** True while the preview is showing (a slice with toolpaths, built). */
export function usePreviewOn(): boolean {
  const preview = useSlice((s) => s.preview)
  const hasPaths = useSlice((s) => !!s.result?.toolpaths)
  const ready = usePreview((s) => !!s.info)
  return preview && hasPaths && ready
}

/** The legend: lives in the left column of the print HUD, above the result card. */
export function PreviewLegend() {
  const on = usePreviewOn()
  return on ? <Legend /> : null
}

function Legend() {
  const mode = usePreview((s) => s.mode)
  const info = usePreview((s) => s.info)
  const roleOff = usePreview((s) => s.roleOff)
  const filOff = usePreview((s) => s.filOff)
  const travel = usePreview((s) => s.travel)
  const colors = useSlice((s) => s.filamentColors)
  // open where there is room beside the summary card (the Inspector takes a share of narrow windows), a button otherwise
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1000)
  useEffect(() => {
    const narrow = () => { if (window.innerWidth < 1000) setOpen(false) }
    window.addEventListener('resize', narrow)
    return () => window.removeEventListener('resize', narrow)
  }, [])
  const options = useMemo(() => (['feature', 'filament', 'width', 'speed', 'fan', 'temperature', 'layerTime'] as ColorMode[])
    .filter((m) => info?.hasExtras || !EXTRAS_MODES.includes(m))
    .filter((m) => m !== 'filament' || colors.length > 1 || (info?.filaments?.length ?? 0) > 1)
    .map((m) => ({ value: m, label: MODE_LABEL[m] })), [info?.hasExtras, info?.filaments?.length, colors.length])
  if (!info) return null
  const hasTime = info.roles.some((r) => r.seconds !== null)
  const filaments = info.filaments ?? colors.map(() => ({ grams: null, mm: null }))
  const range = info.range
  const unit = MODE_UNIT[mode]
  const fmtRange = (v: number) => (mode === 'layerTime' ? fmtTime(v) : mode === 'width' ? v.toFixed(2) : String(Math.round(v)))
  if (!open) {
    return (
      <Tip label="Show the legend" side="left">
        <button type="button" className="sp-legend-btn glass" aria-label="Show legend" data-testid="legend-open" onClick={() => setOpen(true)}><StackSimple size={18} /></button>
      </Tip>
    )
  }
  return (
    <div className="sp-legend glass" data-testid="slice-legend">
      <div className="sp-legend-head">
        <Select value={mode} onChange={(v) => setMode(v as ColorMode)} options={options} />
        <Tip label={travel ? 'Hide travel moves' : 'Show travel moves'} side="top">
          <button type="button" className="sp-icon" data-active={travel} aria-label="Travel moves" aria-pressed={travel} data-testid="toggle-travel" onClick={() => setTravel(!travel)}><Path size={15} /></button>
        </Tip>
        <Tip label="Close the legend" side="top">
          <button type="button" className="sp-icon" aria-label="Close legend" onClick={() => setOpen(false)}><X size={14} /></button>
        </Tip>
      </div>
      {mode !== 'feature' && mode !== 'filament' && (
        <div className="sp-ramp" data-testid="legend-ramp">
          <div className="sp-ramp-bar" style={{ background: rampCss() }} />
          <div className="sp-ramp-ends num"><span>{range ? fmtRange(range.min) : ''}</span><span>{unit}</span><span>{range ? fmtRange(range.max) : ''}</span></div>
        </div>
      )}
      <div className="sp-group-label">Features</div>
      <div className="sp-rows" data-testid="legend-features">
        {info.roles.map((r) => {
          const off = !!roleOff[r.name]
          const share = r.timeShare ?? r.lengthShare
          return (
            <button key={r.name} type="button" className="sp-row" data-off={off} aria-pressed={!off} data-testid={`legend-role-${r.name}`} onClick={() => toggleRole(r.name)}>
              <span className="sp-eye">{off ? <EyeSlash size={14} /> : <Eye size={14} />}</span>
              <span className="sp-sw" style={{ background: mode === 'feature' ? roleColor(r.name) : 'transparent', borderColor: mode === 'feature' ? 'transparent' : roleColor(r.name) }} />
              <span className="sp-name">{r.name}</span>
              <span className="sp-val num">{hasTime && r.seconds !== null ? fmtTime(r.seconds) : fmtLength(r.lengthMm)}</span>
              <span className="sp-pct num">{fmtPct(share)}</span>
            </button>
          )
        })}
      </div>
      {filaments.length > 0 && (
        <>
          <div className="sp-group-label">Filaments</div>
          <div className="sp-rows" data-testid="legend-filaments">
            {filaments.map((f, i) => {
              const off = !!filOff[i]
              return (
                <button key={i} type="button" className="sp-row" data-off={off} aria-pressed={!off} data-testid={`legend-filament-${i}`} onClick={() => toggleFilament(i)}>
                  <span className="sp-eye">{off ? <EyeSlash size={14} /> : <Eye size={14} />}</span>
                  <span className="sp-sw chip" style={{ background: colors[i] ?? '#cccccc' }} />
                  <span className="sp-name">Filament {i + 1}</span>
                  <span className="sp-val num">{f.mm !== null ? `${(f.mm / 1000).toFixed(2)} m` : ''}</span>
                  <span className="sp-pct num">{f.grams !== null ? `${f.grams.toFixed(1)} g` : ''}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** Arrow keys and space while previewing (typing in a field is left alone). */
function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (t?.closest?.('[role="listbox"], [role="menu"], [role="combobox"]')) return
      if (!useSlice.getState().preview) return
      const st = usePreview.getState()
      const n = st.info?.layerCount ?? 0
      if (n < 1) return
      const step = e.shiftKey ? 10 : 1
      const onThumb = !!t?.dataset?.thumb
      const lowThumb = (document.activeElement as HTMLElement | null)?.dataset?.thumb === 'lo'
      const move = (d: number) => (lowThumb ? setBottom(st.lo + d) : setTop(st.hi + d))
      let used = true
      switch (e.key) {
        case 'ArrowUp': move(step); break
        case 'ArrowDown': move(-step); break
        case 'ArrowRight': if (onThumb) move(step); else setScrub(st.scrub + (e.shiftKey ? 0.1 : 0.02)); break
        case 'ArrowLeft': if (onThumb) move(-step); else setScrub(st.scrub - (e.shiftKey ? 0.1 : 0.02)); break
        case 'PageUp': move(10); break
        case 'PageDown': move(-10); break
        case 'Home': move(-n); break
        case 'End': move(n); break
        case ' ': if (t?.closest('button') && !onThumb) { used = false; break } setPlaying(!st.playing); break
        default: used = false
      }
      if (used) { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

/** The result card's place (bottom right); its height is published as --card-h so the slider and scrubber stop above it. */
function CardSlot({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    const hud = el?.parentElement
    if (!el || !hud) return
    const set = () => hud.style.setProperty('--card-h', `${Math.round(el.getBoundingClientRect().height)}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return <div className="sp-card" ref={ref}>{children}</div>
}

export function SlicePreviewHud() {
  const on = usePreviewOn()
  const stale = useSlice((s) => s.stale)
  useKeys()
  if (!on) return null
  return (
    <div className="sp-hud" data-testid="slice-preview-hud">
      {stale && (
        <button
          type="button"
          className="sp-pill glass"
          data-testid="stale-pill"
          onClick={() => { if (getCommand('print.slice')) { setPreview(true); runCommand('print.slice') } }}
        >
          <span className="sp-dot" />Out of date, slice again
        </button>
      )}
      <div className="sp-right"><LayerSlider /></div>
      <CardSlot><SliceCard variant="result" /></CardSlot>
      <Scrubber />
    </div>
  )
}
