/** The Assembly panel over the viewport: drive joints, motion study, explode steps, interference and clearance. */
import { useMemo, useState } from 'react'
import { ArrowCounterClockwise, Pause, Play, PencilSimple, Plus, Stop, Trash, X } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { NumberField } from '@/ui/NumberField'
import { Select } from '@/ui/Select'
import { Slider } from '@/ui/Slider'
import { Checkbox } from '@/ui/Toggle'
import { Tip } from '@/ui/Tooltip'
import { toast } from '@/ui/Modal'
import { viewportBus } from '@/viewport/bus'
import { sceneHalfSize } from '@/viewport/Origin'
import {
  addExplodeStep, deleteExplodeStep, deleteJoint, deleteLink, occLabel, resetJointToRest, setJointValues, setMotionSettings, setMotionTrack, updateExplodeStep, updateJoint,
} from './actions'
import { markInterferenceStale, runClearance, runInterference } from './check'
import { clampValue, dofsOf, JOINT_TYPES } from './joints'
import { startJoint, dofChoices } from './jointDialog'
import { animateExplode, playMotion, seekMotion, stopMotion, studyLength, withKeyframe } from './motion'
import { usePlacement } from './place'
import { useAssemblyRuntime, type AssemblyPanel } from './runtime'
import { selectedInstances } from './selection'
import type { ExplodeStep, Joint } from './types'
import { useEffect } from 'react'
import './assembly.css'

const TABS: { id: AssemblyPanel; label: string }[] = [
  { id: 'joints', label: 'Joints' },
  { id: 'motion', label: 'Motion' },
  { id: 'explode', label: 'Explode' },
  { id: 'check', label: 'Check' },
]

export function AssemblyHud() {
  const panel = useAssemblyRuntime((s) => s.panel)
  const setPanel = useAssemblyRuntime((s) => s.setPanel)
  if (!panel) return null
  return (
    <div className="asm-hud" data-testid="asm-hud" data-panel={panel}>
      <div className="asm-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={panel === t.id} data-testid={'asm-tab-' + t.id} onClick={() => setPanel(t.id)}>{t.label}</button>
        ))}
        <span className="grow" />
        <Tip label="Close the panel"><button type="button" className="asm-x" aria-label="Close assembly panel" onClick={() => setPanel(null)}><X size={12} /></button></Tip>
      </div>
      <div className="asm-body">
        {panel === 'joints' && <JointsTab />}
        {panel === 'motion' && <MotionTab />}
        {panel === 'explode' && <ExplodeTab />}
        {panel === 'check' && <CheckTab />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- joints

function DofRow({ joint, k, label, unit, value }: { joint: Joint; k: string; label: string; unit: 'mm' | 'deg'; value: number }) {
  const lim = joint.limits[k]
  const d = dofsOf(joint.type).find((x) => x.key === k)!
  const lo = lim?.enabled ? lim.min : d.defaultMin
  const hi = lim?.enabled ? lim.max : d.defaultMax
  const set = useAssemblyRuntime((s) => s.setDrive)
  const link = useDoc((s) => s.assembly.links.find((l) => l.b.joint === joint.id && l.b.key === k))
  return (
    <div className="asm-dof" data-testid={`dof-${joint.id}-${k}`}>
      <span className="asm-dof-label" title={link ? 'Driven by a motion link' : label}>{label}</span>
      <Slider
        testId={`dof-slider-${joint.id}-${k}`}
        value={Math.min(hi, Math.max(lo, value))} min={lo} max={hi} step={unit === 'deg' ? 0.5 : 0.1}
        onChange={(v) => !link && set(joint.id, k, v)}
        onCommit={() => {
          const r = useAssemblyRuntime.getState()
          const v = r.drive[joint.id]
          if (v && !link) setJointValues({ [joint.id]: { ...v } })
          r.clearDrive(joint.id)
        }}
      />
      <NumberField value={value} unit={unit} min={lo} max={hi} step={unit === 'deg' ? 5 : 1} precision={2} disabled={!!link}
        onChange={(v) => setJointValues({ [joint.id]: { [k]: clampValue(joint, k, v) } })} />
    </div>
  )
}

function JointsTab() {
  const joints = useDoc((s) => s.assembly.joints)
  const links = useDoc((s) => s.assembly.links)
  const place = usePlacement()
  const selected = useAssemblyRuntime((s) => s.selectedJoint)
  const select = useAssemblyRuntime((s) => s.selectJoint)
  const drive = useAssemblyRuntime((s) => s.drive)
  if (!joints.length) return <div className="asm-empty">No joints yet. Use Joint on the Assemble tab: click a face center, edge midpoint, circle center or vertex on two components.</div>
  return (
    <div className="asm-list" data-testid="asm-joints">
      {joints.map((j) => {
        const err = place.solve.errors[j.id] ?? place.frameErrors[j.id]
        const values = place.solve.values[j.id] ?? j.values
        const info = JOINT_TYPES.find((t) => t.type === j.type)!
        return (
          <div key={j.id} className="asm-card" data-selected={selected === j.id} data-error={!!err} data-testid={'asm-joint-' + j.id} onClick={() => select(j.id)}>
            <div className="asm-card-head">
              <span className="asm-name">{j.name}</span>
              <span className="asm-sub">{info.label}</span>
              <span className="grow" />
              <Tip label="Edit the joint"><button type="button" className="icon-btn" aria-label={`Edit ${j.name}`} onClick={() => startJoint(j.id)}><PencilSimple size={12} /></button></Tip>
              <Tip label="Back to the rest position"><button type="button" className="icon-btn" aria-label={`Reset ${j.name}`} onClick={() => resetJointToRest(j.id)}><ArrowCounterClockwise size={12} /></button></Tip>
              <Tip label="Delete the joint"><button type="button" className="icon-btn" aria-label={`Delete ${j.name}`} onClick={() => deleteJoint(j.id)}><Trash size={12} /></button></Tip>
            </div>
            <div className="asm-sub asm-ends">{occLabel(useDoc.getState().assembly, j.a.occ)} <span aria-hidden>to</span> {occLabel(useDoc.getState().assembly, j.b.occ)}{j.suppressed ? ' (suppressed)' : ''}</div>
            {err && <div className="asm-err" role="alert" data-testid={'joint-error-' + j.id}>{err}</div>}
            {dofsOf(j.type).map((d) => (
              <DofRow key={d.key} joint={j} k={d.key} label={d.label} unit={d.unit} value={drive[j.id]?.[d.key] ?? values[d.key] ?? 0} />
            ))}
            {!dofsOf(j.type).length && <div className="asm-sub">Fixed: nothing to drive.</div>}
            <label className="asm-check"><Checkbox checked={!j.suppressed} onChange={(on) => updateJoint(j.id, { suppressed: !on })} /> <span>Active</span></label>
          </div>
        )
      })}
      {links.length > 0 && <div className="asm-section">Motion links</div>}
      {links.map((l) => (
        <div key={l.id} className="asm-card" data-testid={'asm-link-' + l.id}>
          <div className="asm-card-head">
            <span className="asm-name">{l.name}</span>
            <span className="asm-sub">x{+l.ratio.toFixed(4)}</span>
            <span className="grow" />
            <Tip label="Delete the motion link"><button type="button" className="icon-btn" aria-label={`Delete ${l.name}`} onClick={() => deleteLink(l.id)}><Trash size={12} /></button></Tip>
          </div>
          {place.solve.linkErrors[l.id] && <div className="asm-err" role="alert">{place.solve.linkErrors[l.id]}</div>}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- motion study

function MotionTab() {
  const study = useDoc((s) => s.assembly.motion)
  const joints = useDoc((s) => s.assembly.joints)
  const place = usePlacement()
  const playing = useAssemblyRuntime((s) => s.playing)
  const t = useAssemblyRuntime((s) => s.playTime)
  const choices = useMemo(() => dofChoices({ joints }), [joints])
  const [pick, setPick] = useState('')
  const len = studyLength(study)
  const chosen = choices.find((c) => c.value === pick) ?? choices[0]
  const label = (j: string, k: string) => choices.find((c) => c.value === `${j}:${k}`)?.label ?? `${j}:${k}`
  if (!choices.length) return <div className="asm-empty">A motion study animates joint values over time. Add a joint that can move first.</div>
  const keyHere = () => {
    if (!chosen) return
    const [j, k] = chosen.value.split(':')
    const now = useAssemblyRuntime.getState().drive[j]?.[k] ?? place.solve.values[j]?.[k] ?? 0
    const track = study.tracks.find((x) => x.joint === j && x.key === k)
    setMotionTrack(withKeyframe(track, j, k, +t.toFixed(3), now))
  }
  return (
    <div className="asm-list" data-testid="asm-motion">
      <div className="asm-row">
        {playing
          ? <button type="button" className="btn" data-testid="motion-pause" onClick={() => stopMotion()}><Pause size={12} /> Pause</button>
          : <button type="button" className="btn primary" data-testid="motion-play" onClick={() => playMotion(study, t >= len ? 0 : t)}><Play size={12} /> Play</button>}
        <button type="button" className="btn" data-testid="motion-stop" onClick={() => stopMotion(true)}><Stop size={12} /> Reset</button>
        <span className="grow" />
        <span className="asm-time" data-testid="motion-time">{t.toFixed(2)} / {len.toFixed(2)} s</span>
      </div>
      <Slider testId="motion-scrub" value={Math.min(t, Math.max(len, 0.01))} min={0} max={Math.max(len, 0.01)} step={0.01} onChange={(v) => seekMotion(study, v)} />
      <div className="asm-row">
        <span className="asm-sub">Length</span>
        <NumberField value={study.duration} unit="s" min={0.1} step={0.5} precision={2} onChange={(v) => setMotionSettings({ duration: v })} />
        <label className="asm-check"><Checkbox checked={study.loop} onChange={(v) => setMotionSettings({ loop: v })} /> <span>Loop</span></label>
      </div>
      <div className="asm-section">Keyframes</div>
      <div className="asm-row">
        <Select value={chosen?.value ?? ''} options={choices} onChange={setPick} />
        <Tip label="Add a keyframe with the joint's current value at the current time"><button type="button" className="btn" data-testid="motion-key" onClick={keyHere}><Plus size={12} /> Key</button></Tip>
      </div>
      {study.tracks.length === 0 && <div className="asm-empty">Move a joint to where it should be, set the time, then press Key. Add a second keyframe at another time and press Play.</div>}
      {study.tracks.map((tr) => (
        <div key={tr.joint + tr.key} className="asm-card" data-testid={`track-${tr.joint}-${tr.key}`}>
          <div className="asm-card-head"><span className="asm-name">{label(tr.joint, tr.key)}</span><span className="grow" />
            <Tip label="Remove the track"><button type="button" className="icon-btn" aria-label="Remove track" onClick={() => setMotionTrack({ ...tr, frames: [] })}><Trash size={12} /></button></Tip>
          </div>
          <div className="asm-keys">
            {tr.frames.map((f) => (
              <span key={f.t} className="asm-key">
                <button type="button" onClick={() => seekMotion(study, f.t)} title="Go to this keyframe">{f.t}s: {+f.v.toFixed(2)}</button>
                <button type="button" aria-label="Delete keyframe" onClick={() => setMotionTrack({ ...tr, frames: tr.frames.filter((x) => x !== f) })}><X size={9} /></button>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- explode

const DIRS: { value: string; label: string; v: [number, number, number] }[] = [
  { value: '+X', label: '+X', v: [1, 0, 0] }, { value: '-X', label: '-X', v: [-1, 0, 0] },
  { value: '+Y', label: '+Y', v: [0, 1, 0] }, { value: '-Y', label: '-Y', v: [0, -1, 0] },
  { value: '+Z', label: '+Z', v: [0, 0, 1] }, { value: '-Z', label: '-Z', v: [0, 0, -1] },
]
const dirKey = (v: [number, number, number]) => DIRS.find((d) => d.v.every((x, i) => Math.abs(x - v[i] / (Math.hypot(...v) || 1)) < 1e-6))?.value ?? 'custom'

function ExplodeTab() {
  const steps = useDoc((s) => s.assembly.explode.steps)
  const geometry = useDoc((s) => s.geometry)
  const assembly = useDoc((s) => s.assembly)
  const amount = useAssemblyRuntime((s) => s.explode)
  const setExplode = useAssemblyRuntime((s) => s.setExplode)
  const selStep = useAssemblyRuntime((s) => s.explodeStep)
  const selectStep = useAssemblyRuntime((s) => s.selectExplodeStep)
  const [dir, setDir] = useState('+Z')
  const addFromSelection = () => {
    const occs = selectedInstances()
    if (!occs.length) return void toast('Select the components that move in this step (Browser or viewport), then add the step.', 'error')
    const id = addExplodeStep({
      name: `Step ${steps.length + 1}`, occs, direction: DIRS.find((d) => d.value === dir)!.v,
      distance: Math.round(Math.max(20, sceneHalfSize(geometry) * 0.8)), trail: true,
    })
    selectStep(id)
    if (amount === 0) animateExplode(1)
  }
  return (
    <div className="asm-list" data-testid="asm-explode">
      <div className="asm-row">
        <button type="button" className="btn primary" data-testid="explode-toggle" disabled={!steps.length} onClick={() => animateExplode(amount > 0.5 ? 0 : 1)}>{amount > 0.5 ? 'Collapse' : 'Explode'}</button>
        <Slider testId="explode-amount" value={amount} min={0} max={1} step={0.01} onChange={setExplode} />
        <span className="asm-time" data-testid="explode-amount-label">{Math.round(amount * 100)}%</span>
      </div>
      <div className="asm-section">Steps</div>
      {steps.length === 0 && <div className="asm-empty">Select components, pick a direction and add a step. Steps play one after the other as you explode.</div>}
      {steps.map((s: ExplodeStep, n) => (
        <div key={s.id} className="asm-card" data-selected={selStep === s.id} data-testid={'step-' + s.id} onClick={() => selectStep(s.id)}>
          <div className="asm-card-head">
            <span className="asm-num">{n + 1}</span>
            <input className="asm-name-input" value={s.name} aria-label="Step name" onChange={(e) => updateExplodeStep(s.id, { name: e.target.value })} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} />
            <span className="grow" />
            <Tip label="Delete the step"><button type="button" className="icon-btn" aria-label={`Delete ${s.name}`} onClick={(e) => { e.stopPropagation(); deleteExplodeStep(s.id) }}><Trash size={12} /></button></Tip>
          </div>
          <div className="asm-sub asm-ends">{s.occs.map((o) => occLabel(assembly, o)).join(', ')}</div>
          <div className="asm-row" onClick={(e) => e.stopPropagation()}>
            <Select value={dirKey(s.direction)} options={[...DIRS, ...(dirKey(s.direction) === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])]} onChange={(v) => { const d = DIRS.find((x) => x.value === v); if (d) updateExplodeStep(s.id, { direction: d.v }) }} />
            <NumberField value={s.distance} unit="mm" step={5} precision={1} onChange={(v) => updateExplodeStep(s.id, { distance: v })} />
            <label className="asm-check"><Checkbox checked={s.trail} onChange={(v) => updateExplodeStep(s.id, { trail: v })} /> <span>Trail</span></label>
          </div>
        </div>
      ))}
      <div className="asm-row">
        <Select value={dir} options={DIRS} onChange={setDir} />
        <button type="button" className="btn" data-testid="explode-add" onClick={addFromSelection}><Plus size={12} /> Add step from selection</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- interference + clearance

function CheckTab() {
  const report = useAssemblyRuntime((s) => s.interference)
  const clearance = useAssemblyRuntime((s) => s.clearance)
  const set = useAssemblyRuntime((s) => s.setInterference)
  const setClearance = useAssemblyRuntime((s) => s.setClearance)
  const [busy, setBusy] = useState(false)
  const geometry = useDoc((s) => s.geometry)
  const assembly = useDoc((s) => s.assembly)
  // results no longer describe the model once something moves or changes
  useEffect(() => { markInterferenceStale() }, [geometry, assembly])
  const run = async () => {
    setBusy(true)
    try { await runInterference(selectedInstances()) } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error') } finally { setBusy(false) }
  }
  const measure = () => {
    const sel = selectedInstances()
    if (sel.length !== 2) return void toast('Select exactly two components (Browser or viewport) to measure the clearance between them.', 'error')
    const r = runClearance(sel[0], sel[1])
    if (!r) toast('One of the components has no geometry.', 'error')
  }
  const total = report?.hits.reduce((n, h) => n + h.volume, 0) ?? 0
  return (
    <div className="asm-list" data-testid="asm-check">
      <div className="asm-section">Interference</div>
      <div className="asm-row">
        <button type="button" className="btn primary" data-testid="interference-run" disabled={busy} onClick={() => void run()}>{busy ? 'Checking ...' : 'Check interference'}</button>
        {report && <button type="button" className="btn" onClick={() => set(null)}>Clear</button>}
      </div>
      <div className="asm-sub">With nothing selected the whole assembly is checked; with one component it is checked against the rest; with several, against each other.</div>
      {report && (
        <div data-testid="interference-result" data-count={report.hits.length} data-stale={report.stale}>
          <div className={'asm-summary' + (report.hits.length ? ' bad' : ' good')}>
            {report.hits.length ? `${report.hits.length} ${report.hits.length === 1 ? 'interference' : 'interferences'}, ${+total.toFixed(2)} mm³ in all` : 'No interference found'}
            {report.stale ? ' (out of date: the model changed)' : ''}
          </div>
          {report.hits.map((h, i) => (
            <button key={i} type="button" className="asm-hit" data-testid={'interference-hit-' + i}
              onClick={() => viewportBus.emit('frameBox', { min: h.min, max: h.max })}>
              <span className="asm-hit-names">{h.a.name} <span aria-hidden>and</span> {h.b.name}</span>
              <span className="asm-sub">{+h.volume.toFixed(2)} mm³</span>
            </button>
          ))}
        </div>
      )}
      <div className="asm-section">Clearance</div>
      <div className="asm-row">
        <button type="button" className="btn" data-testid="clearance-run" onClick={measure}>Measure between selected</button>
        {clearance && <button type="button" className="btn" onClick={() => setClearance(null)}>Clear</button>}
      </div>
      {clearance && (
        <div className="asm-summary" data-testid="clearance-result" data-distance={clearance.distance}>
          {clearance.a.name} to {clearance.b.name}: {clearance.distance === 0 ? 'touching or overlapping' : `${+clearance.distance.toFixed(3)} mm apart`}
        </div>
      )}
      <div className="asm-sub">Measured on the tessellated surfaces, so it is accurate to about 0.05 mm on curved parts.</div>
    </div>
  )
}

export { useUi }
