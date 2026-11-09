/** The Print sidebar: printer, filaments, process (the quick settings inline) and the objects on the plate. Replaces the Browser in Print mode. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CaretDown, Cube, Gear, Plus, Printer, Stack, Warning, X } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { Select } from '@/ui/Select'
import { Tip } from '@/ui/Tooltip'
import { FILAMENT_COLORS, SLOT_COUNT } from '../palette'
import { currentSettings, updatePrintSettings, writeProfile } from '../settings'
import { loadUserPresets, refOf } from '../slice/userPresets'
import { profileNow, setBedType, setFilament, setPrinter, setProcess, slotCount, syncResolvedFromDoc } from '../slice/controller'
import { PresetPicker, PrinterPicker, usePresetNames } from '../slice/Pickers'
import { PlatePicker } from '../slice/PlatePicker'
import { QuickTab } from '../slice/QuickTab'
import { useSlicer } from '../slice/store'
import { withSlots } from '../slice/profile'
import { plateObjects } from '../plate'
import { computePaintMap, usedSlots } from '../paint'
import { useBed, usePlateModel } from './store'
import './workspace.css'

const OPEN_KEY = 'caddy.print.sections'
const savedOpen = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean> } catch { return {} }
}

function Section({ id, title, icon, aside, children }: { id: string; title: string; icon: ReactNode; aside?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => savedOpen()[id] ?? true)
  const toggle = () => {
    setOpen((o) => {
      try { localStorage.setItem(OPEN_KEY, JSON.stringify({ ...savedOpen(), [id]: !o })) } catch { /* storage unavailable */ }
      return !o
    })
  }
  return (
    <section className="ws-sec" data-open={open} data-testid={`side-${id}`}>
      <div className="ws-sec-head">
        <button type="button" className="ws-sec-toggle" aria-expanded={open} onClick={toggle}>
          <span className="ws-sec-icon">{icon}</span>
          <span className="ws-sec-title">{title}</span>
          <CaretDown size={11} weight="bold" className="ws-caret" />
        </button>
        {aside}
      </div>
      <div className="ws-sec-body"><div className="ws-sec-in">{children}</div></div>
    </section>
  )
}

function PrinterCard() {
  const profile = profileNow()
  const bed = useBed()
  const resolved = useSlicer((s) => s.resolved)
  const w = bed.hi[0] - bed.lo[0], d = bed.hi[1] - bed.lo[1]
  return (
    <div className="ws-card">
      <PrinterPicker machine={profile.machine} onPick={(m) => void setPrinter(m)} />
      {resolved?.plate && <PlatePicker plate={resolved.plate} filaments={resolved.filaments} names={resolved.filamentNames} onPick={(id) => void setBedType(id)} />}
      <div className="ws-facts" data-testid="plate-size">
        <span><b>{+w.toFixed(0)} x {+d.toFixed(0)}</b> mm plate</span>
        <span><b>{+bed.height.toFixed(0)}</b> mm high</span>
        <span><b>{profile.nozzle}</b> mm nozzle</span>
      </div>
    </div>
  )
}

function Filaments() {
  const resolved = useSlicer((s) => s.resolved)
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const geometry = useDoc((s) => s.geometry)
  const profile = profileNow()
  const settings = currentSettings()
  const n = slotCount()
  const used = useMemo(() => Math.max(1, ...usedSlots(computePaintMap(features, rollback, geometry))), [features, rollback, geometry])
  const [edit, setEdit] = useState<number | null>(null)
  const names = usePresetNames('filament', profile.vendor, profile.machine, resolved?.processName)
  const colorOpts = useMemo(() => FILAMENT_COLORS.map((c) => ({ value: c.id, label: c.label })), [])
  const add = () => writeProfile(withSlots(profile, n + 1), {}, 'Add filament')
  const remove = () => { setEdit(null); writeProfile(withSlots(profile, n - 1), {}, 'Remove filament') }
  return (
    <div className="ws-card ws-fils" data-testid="filaments">
      {Array.from({ length: n }, (_, i) => {
        const hex = FILAMENT_COLORS.find((c) => c.id === settings.slotColors[i])?.hex ?? '#ffffff'
        const name = profile.user.filaments[i]?.name ?? resolved?.filamentNames[i] ?? '...'
        return (
          <div key={i} className="ws-fil" data-open={edit === i}>
            <button type="button" className="ws-chip" data-testid={`filament-chip-${i}`} aria-expanded={edit === i} onClick={() => setEdit(edit === i ? null : i)}>
              <span className="fil-dot" style={{ background: hex, width: 16, height: 16 }} />
              <span className="ws-chip-slot">{i + 1}</span>
              <span className="ws-chip-name">{name}</span>
              <CaretDown size={10} className="ws-caret" />
            </button>
            {edit === i && resolved && (
              <div className="ws-fil-edit">
                <PresetPicker
                  type="filament" label="Preset" vendor={profile.vendor} name={resolved.filamentNames[i] ?? ''} userName={profile.user.filaments[i]?.name} names={names}
                  modified={Object.keys(profile.overrides.filaments[i] ?? {}).length > 0} onPick={(nm) => void setFilament(i, nm)} onPickUser={(u) => void setFilament(i, u.inherits, refOf(u))}
                />
                <div className="ws-colorrow">
                  <span className="sl-fieldlabel">Color</span>
                  <Select value={settings.slotColors[i]} options={colorOpts} onChange={(v) => updatePrintSettings(() => ({ [`slot${i + 1}`]: v }), 'Filament color')} />
                </div>
              </div>
            )}
          </div>
        )
      })}
      <div className="ws-fil-actions">
        <button type="button" className="ws-link" data-testid="filament-add" disabled={n >= SLOT_COUNT} onClick={add}><Plus size={12} weight="bold" /> Add filament</button>
        {n > 1 && n > used && (
          <Tip label="Remove the last filament" desc="Only a filament no part is painted with can be removed." side="top">
            <button type="button" className="ws-link" data-testid="filament-remove" onClick={remove}><X size={12} weight="bold" /> Remove {n}</button>
          </Tip>
        )}
      </div>
      {n === 1 && <p className="sl-hint">Paint a body or a face with Filament 2 or more to print in several colors.</p>}
    </div>
  )
}

function ProcessCard() {
  const profile = profileNow()
  const resolved = useSlicer((s) => s.resolved)
  const names = usePresetNames('process', profile.vendor, profile.machine)
  return (
    <div className="ws-card ws-process">
      {resolved
        ? <PresetPicker
            type="process" label="Preset" vendor={profile.vendor} name={resolved.processName} userName={profile.user.process?.name} names={names}
            modified={Object.keys(profile.overrides.process).length > 0} onPick={(n) => void setProcess(n)} onPickUser={(u) => void setProcess(u.inherits, refOf(u))}
          />
        : <p className="sl-empty">Loading presets ...</p>}
      <QuickTab profile={profile} parts="settings" />
      <button type="button" className="btn ws-all" data-testid="all-settings" onClick={() => useSlicer.getState().openSheet('process')}><Gear size={14} /> All settings</button>
    </div>
  )
}

function Objects() {
  const geometry = useDoc((s) => s.geometry)
  const hidden = useUi((s) => s.hiddenIds)
  const selection = useUi((s) => s.selection)
  const features = useDoc((s) => s.features)
  const plate = usePlateModel()
  const objects = useMemo(() => plateObjects(), [geometry, hidden]) // eslint-disable-line react-hooks/exhaustive-deps
  const profile = profileNow()
  void features
  if (!objects.length) return <div className="ws-card"><p className="sl-empty">Nothing to print yet. Make a solid body in the Solid workspace and it appears on the plate.</p></div>
  return (
    <div className="ws-card ws-objs" data-testid="objects">
      {objects.map((o) => {
        const part = plate.list.find((p) => p.id === o.id)
        const on = selection.some((r) => r.id === o.id)
        const own = Object.keys(profile.objects[o.id] ?? {}).length
        return (
          <div key={o.id} className="ws-obj" data-active={on} data-status={part?.status ?? 'ok'}>
            <button type="button" className="ws-obj-main" data-testid={`side-object-${o.id}`} onClick={() => useUi.getState().setSelection(on ? [] : [{ kind: 'body', id: o.id }])}>
              {part && part.status !== 'ok' ? <Warning size={15} weight="fill" className="ws-warn" /> : <Cube size={15} />}
              <span className="ws-obj-name">{o.name}</span>
              {part && <span className="ws-obj-size num">{part.size.map((v) => +v.toFixed(0)).join(' x ')}</span>}
            </button>
            <Tip label="Settings for this object" desc="Give this part its own infill, walls or supports." side="left">
              <button type="button" className="ws-obj-set" aria-label={`Settings for ${o.name}`} data-testid={`object-settings-${o.id}`} onClick={() => { useSlicer.getState().set({ objectId: o.id, objectView: null }); useSlicer.getState().openSheet('objects') }}>
                <Gear size={13} />{own > 0 && <span className="ws-badge">{own}</span>}
              </button>
            </Tip>
          </div>
        )
      })}
    </div>
  )
}

export function PrintSidebar({ sheet = false }: { sheet?: boolean }) {
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  useEffect(() => { void loadUserPresets() }, [])
  // read the presets now, and again when undo, redo or another document changes the profile
  useEffect(() => { syncResolvedFromDoc() }, [features, rollback])
  return (
    <aside className="panel ws-side" data-sheet={sheet} data-testid="print-sidebar" aria-label="Print setup">
      <div className="ws-side-scroll">
        <Section id="printer" title="Printer" icon={<Printer size={15} weight="duotone" />}><PrinterCard /></Section>
        <Section id="filaments" title="Filaments" icon={<Stack size={15} weight="duotone" />}><Filaments /></Section>
        <Section id="process" title="Process" icon={<Gear size={15} weight="duotone" />}><ProcessCard /></Section>
        <Section id="objects" title="Objects" icon={<Cube size={15} weight="duotone" />}><Objects /></Section>
      </div>
    </aside>
  )
}
