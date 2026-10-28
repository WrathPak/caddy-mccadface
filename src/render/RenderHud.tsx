/** The Render workspace panel: materials, scene, camera, still output and turntable. */
import { Tip } from '@/ui/Tooltip'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Camera, FilmStrip, FloppyDisk, Crosshair } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { computeAppearanceMap } from './appearanceMap'
import { assignMaterial, focusOnSelection } from './assign'
import { ENVIRONMENTS } from './envmap'
import { cancelJob, renderImage, renderTurntableVideo, saveStill, useRenderJob } from './job'
import { PRESETS, parseHex, type MaterialPreset } from './presets'
import { pathTracerSupport, webmSupport } from './renderer'
import { LIMITS, useRenderSettings, type Engine } from './settings'
import './render.css'

function ballStyle(p: MaterialPreset): CSSProperties {
  if (p.texture === 'wood') return { background: 'repeating-linear-gradient(100deg, #c99a62 0 5px, #a8773f 5px 8px, #d4a86f 8px 13px)' }
  if (p.texture === 'carbon') return { background: 'repeating-linear-gradient(45deg, #15171a 0 3px, #2a2d33 3px 5px), #15171a', backgroundBlendMode: 'normal' }
  if (p.transmission > 0) return { background: 'radial-gradient(circle at 32% 30%, rgba(255,255,255,0.85), rgba(190,225,250,0.35) 55%, rgba(120,170,210,0.45))' }
  if (p.metalness > 0.8) return { background: `radial-gradient(circle at 32% 28%, #ffffff, ${p.color} 40%, #4a4f57)` }
  return { background: p.color }
}

function Sec({ title, open, children, id }: { title: string; open?: boolean; children: ReactNode; id: string }) {
  return (
    <details className="render-sec" open={open} data-testid={`render-sec-${id}`}>
      <summary>{title}</summary>
      <div className="render-body">{children}</div>
    </details>
  )
}

function Num({ label, value, min, max, step, unit, onChange, testid }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; testid: string }) {
  // typed text is applied on blur / Enter, so half typed numbers never reach the settings
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const v = parseFloat(text)
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
    else setText(String(value))
  }
  return (
    <label className="render-row">
      <span>{label}</span>
      <input type="number" data-testid={testid} min={min} max={max} step={step ?? 1} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      {unit && <span className="unit">{unit}</span>}
    </label>
  )
}

function Check({ label, value, onChange, testid }: { label: string; value: boolean; onChange: (v: boolean) => void; testid: string }) {
  return (
    <label className="render-row">
      <span>{label}</span>
      <input type="checkbox" data-testid={testid} checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function Panel() {
  const s = useRenderSettings((x) => x.s)
  const set = useRenderSettings((x) => x.set)
  const setTurn = useRenderSettings((x) => x.setTurntable)
  const job = useRenderJob()
  const [color, setColor] = useState('')
  const sup = pathTracerSupport()
  const busy = job.status === 'running'
  const colorOk = color.trim() === '' || !!parseHex(color)

  return (
    <div className="render-card" data-testid="render-panel">
      <div className="render-scroll">
        <Sec id="materials" title="Materials" open>
          <div className="render-swatches">
            {PRESETS.map((p) => (
              <Tip key={p.id} label={p.label} desc={`${p.desc}. Click to give it to the selected bodies or faces.`} side="left">
                <button type="button" className="render-swatch" data-testid={`mat-${p.id}`} onClick={() => assignMaterial(p.id, color)}>
                  <span className="ball" style={ballStyle(p)} />
                  {p.label}
                </button>
              </Tip>
            ))}
          </div>
          <Tip label="Color" desc="A color as #rrggbb. Leave it blank to keep the color of the material." side="left"><label className="render-row">
            <span>Color</span>
            <input type="text" data-testid="mat-color" placeholder="Material color" value={color} onChange={(e) => setColor(e.target.value)} style={colorOk ? undefined : { borderColor: 'var(--danger)' }} />
            <input type="color" aria-label="Pick a color" value={parseHex(color) ?? '#808080'} onChange={(e) => setColor(e.target.value)} />
          </label></Tip>
        </Sec>

        <Sec id="scene" title="Scene" open>
          <label className="render-row">
            <span>Environment</span>
            <select data-testid="env-select" value={s.env} onChange={(e) => set({ env: e.target.value })}>
              {ENVIRONMENTS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </label>
          <label className="render-row">
            <span>Backdrop</span>
            <select data-testid="backdrop-select" value={s.backdrop} onChange={(e) => set({ backdrop: e.target.value as 'color' | 'environment' })}>
              <option value="color">Plain color</option>
              <option value="environment">Environment</option>
            </select>
            <input type="color" aria-label="Backdrop color" value={s.backdropColor} onChange={(e) => set({ backdropColor: e.target.value })} disabled={s.backdrop !== 'color'} />
          </label>
          <Check label="Ground shadow" value={s.shadow} onChange={(v) => set({ shadow: v })} testid="shadow-check" />
          <Check label="Reflection" value={s.reflection} onChange={(v) => set({ reflection: v })} testid="reflection-check" />
          <Num label="Exposure" value={s.exposure} min={LIMITS.exposure[0]} max={LIMITS.exposure[1]} step={0.1} onChange={(v) => set({ exposure: v })} testid="exposure" />
        </Sec>

        <Sec id="camera" title="Camera">
          <Num label="Focal length" value={s.focalMm} min={LIMITS.focalMm[0]} max={LIMITS.focalMm[1]} unit="mm" onChange={(v) => set({ focalMm: v })} testid="focal" />
          <Check label="Depth of field" value={s.dof} onChange={(v) => set({ dof: v })} testid="dof-check" />
          <Num label="Aperture f/" value={s.fStop} min={LIMITS.fStop[0]} max={LIMITS.fStop[1]} step={0.5} onChange={(v) => set({ fStop: v })} testid="fstop" />
          <Num label="Focus at" value={s.focusDistance} min={1} max={100000} unit="mm" onChange={(v) => set({ focusDistance: v })} testid="focus" />
          <div className="render-btns">
            <Tip label="Focus on selection" desc="Set the sharp point of the depth of field blur to the selection, or to the whole model when nothing is selected." side="left">
              <button type="button" className="render-btn" data-testid="focus-selection" onClick={() => focusOnSelection()}>
                <Crosshair size={13} /> Focus on selection
              </button>
            </Tip>
          </div>
        </Sec>

        <Sec id="output" title="Image" open>
          <Num label="Width" value={s.width} min={LIMITS.size[0]} max={LIMITS.size[1]} unit="px" onChange={(v) => set({ width: v })} testid="out-w" />
          <Num label="Height" value={s.height} min={LIMITS.size[0]} max={LIMITS.size[1]} unit="px" onChange={(v) => set({ height: v })} testid="out-h" />
          <label className="render-row">
            <span>Engine</span>
            <select data-testid="engine-select" value={s.engine} onChange={(e) => set({ engine: e.target.value as Engine })}>
              <option value="auto">Automatic</option>
              <option value="pathtracer">Path tracer</option>
              <option value="raster">Rasterizer</option>
            </select>
          </label>
          <Num label="Samples" value={s.samples} min={LIMITS.samples[0]} max={LIMITS.samples[1]} onChange={(v) => set({ samples: v })} testid="samples" />
          <Check label="Denoise" value={s.denoise} onChange={(v) => set({ denoise: v })} testid="denoise-check" />
          <Num label="Denoise amount" value={s.denoiseStrength} min={0} max={1} step={0.1} onChange={(v) => set({ denoiseStrength: v })} testid="denoise-strength" />
          {!sup.ok && s.engine !== 'raster' && <div className="render-status note" data-testid="engine-note">{sup.reason} Images will be rasterized.</div>}
          <div className="render-btns">
            <button type="button" className="render-btn primary" data-testid="render-image" disabled={busy} onClick={() => void renderImage()}><Camera size={13} /> Render image</button>
          </div>
        </Sec>

        <Sec id="turntable" title="Turntable">
          <Num label="Length" value={s.turntable.seconds} min={LIMITS.seconds[0]} max={LIMITS.seconds[1]} unit="s" onChange={(v) => setTurn({ seconds: v })} testid="tt-seconds" />
          <Num label="Frame rate" value={s.turntable.fps} min={LIMITS.fps[0]} max={LIMITS.fps[1]} unit="fps" onChange={(v) => setTurn({ fps: v })} testid="tt-fps" />
          <Num label="Width" value={s.turntable.width} min={LIMITS.size[0]} max={LIMITS.size[1]} unit="px" onChange={(v) => setTurn({ width: v })} testid="tt-w" />
          <Num label="Height" value={s.turntable.height} min={LIMITS.size[0]} max={LIMITS.size[1]} unit="px" onChange={(v) => setTurn({ height: v })} testid="tt-h" />
          {!webmSupport() && <div className="render-status err">This browser cannot record WebM video.</div>}
          <div className="render-btns">
            <button type="button" className="render-btn" data-testid="render-turntable" disabled={busy || !webmSupport()} onClick={() => void renderTurntableVideo()}><FilmStrip size={13} /> Record WebM</button>
          </div>
        </Sec>
      </div>

      <div className="render-body" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }} data-testid="render-status" data-status={job.status}>
        {busy && (
          <>
            <div className="render-progress"><div style={{ width: `${Math.round(job.progress * 100)}%` }} data-testid="render-progress" /></div>
            <div className="render-status">{job.text}</div>
            <div className="render-btns"><button type="button" className="render-btn" data-testid="render-cancel" onClick={cancelJob}>Cancel</button></div>
          </>
        )}
        {job.error && <div className="render-status err" data-testid="render-error">{job.error}</div>}
        {!busy && job.still && (
          <div className="render-result" data-testid="render-result" data-engine={job.still.engine} data-w={job.still.width} data-h={job.still.height}>
            <img src={job.still.url} alt="Last render" />
            <div className="render-status">
              {job.still.width} x {job.still.height}, {job.still.engine === 'pathtracer' ? 'path traced' : 'rasterized'}, {job.still.seconds.toFixed(1)} s
            </div>
            {job.still.note && <div className="render-status note" data-testid="render-note">{job.still.note}</div>}
            <div className="render-btns"><button type="button" className="render-btn" data-testid="save-png" onClick={saveStill}><FloppyDisk size={13} /> Save PNG</button></div>
          </div>
        )}
      </div>
    </div>
  )
}

export function RenderHud() {
  const workspace = useUi((s) => s.workspace)
  // dev handle for the browser tests
  useEffect(() => {
    const w = window as unknown as { __caddy?: Record<string, unknown> }
    if (import.meta.env.DEV && w.__caddy) w.__caddy.render = {
      /** the resolved look of every body: its default and the faces with their own */
      appearance: () => {
        const d = useDoc.getState()
        return Object.fromEntries([...computeAppearanceMap(d.features, d.rollback, d.geometry)].map(([id, e]) => [id, { body: e.body, faces: Object.fromEntries(e.faces) }]))
      },
      settings: useRenderSettings, job: useRenderJob, renderImage, renderTurntableVideo, saveStill, assignMaterial, pathTracerSupport }
  }, [])
  return workspace === 'render' ? <Panel /> : null
}
