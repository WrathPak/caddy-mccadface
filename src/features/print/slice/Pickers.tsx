/** Printer and preset pickers: searchable, grouped lists in a popover, with nozzle choices and the user presets. */
import { useEffect, useMemo, useState } from 'react'
import * as P from '@radix-ui/react-popover'
import { CaretDown, Check, FloppyDisk, MagnifyingGlass, PencilSimple, Trash, UserCircle } from '@phosphor-icons/react'
import type { PresetScope } from '@muon3d/slicer-engine-protocol'
import { buildCatalog, listFilaments, listProcesses, loadProfileSet, type CatalogModel, type CatalogVendor } from '../engine/profiles'
import { deleteUserPreset, renameUserPreset, useUserPresets, type UserPreset } from './userPresets'
import { printerLabel } from './profile'

let catalogPromise: Promise<CatalogVendor[]> | null = null
export function useCatalog(): CatalogVendor[] | null {
  const [c, setC] = useState<CatalogVendor[] | null>(null)
  useEffect(() => {
    catalogPromise ??= loadProfileSet().then((s) => buildCatalog(s.index)).catch((e) => { catalogPromise = null; throw e })
    let live = true
    catalogPromise.then((v) => { if (live) setC(v) }, () => {})
    return () => { live = false }
  }, [])
  return c
}

/** The printer: current model and nozzle on the button; a searchable list grouped Bambu Lab, Prusa, other vendors. */
export function PrinterPicker({ machine, onPick }: { machine: string; onPick: (machine: string) => void }) {
  const catalog = useCatalog()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ BBL: true, Prusa: true })
  const current = useMemo(() => {
    for (const v of catalog ?? []) for (const m of v.models) { const n = m.nozzles.find((x) => x.machine === machine); if (n) return { vendor: v, model: m, nozzle: n.nozzle } }
    return null
  }, [catalog, machine])
  const query = q.trim().toLowerCase()
  const pick = (m: CatalogModel) => {
    const same = m.nozzles.find((n) => n.nozzle === current?.nozzle) ?? m.nozzles.find((n) => n.nozzle === '0.4') ?? m.nozzles[0]
    setOpen(false)
    onPick(same.machine)
  }
  return (
    <div className="sl-picker">
      <P.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ('') }}>
        <P.Trigger asChild>
          <button type="button" className="sel sl-trigger" data-testid="printer-picker">
            <span className="sl-trig-main"><span className="sl-trig-top">{current ? current.vendor.name : 'Printer'}</span><span className="sl-trig-name">{current?.model.model ?? printerLabel(machine)}</span></span>
            <CaretDown size={10} />
          </button>
        </P.Trigger>
        <P.Portal>
          <P.Content className="menu sl-pop" sideOffset={4} align="start" collisionPadding={12} data-testid="printer-list">
            <label className="sl-search"><MagnifyingGlass size={13} /><input autoFocus placeholder="Search printers" value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <div className="sl-list">
              {!catalog && <p className="sl-empty">Loading printers ...</p>}
              {catalog?.map((v) => {
                const models = query ? v.models.filter((m) => (v.name + ' ' + m.model).toLowerCase().includes(query)) : v.models
                if (!models.length) return null
                const grouped = v.group !== 'Other vendors'
                const isOpen = grouped || !!query || expanded[v.id]
                return (
                  <div key={v.id} className="sl-vendor">
                    {(v.id === 'BBL' || v.id === 'Prusa' || v === catalog.find((x) => x.group === 'Other vendors')) && (
                      <div className="sl-grouphead">{v.group}</div>
                    )}
                    {!grouped && <button type="button" className="sl-vendorhead" onClick={() => setExpanded((e) => ({ ...e, [v.id]: !e[v.id] }))} data-open={isOpen} aria-expanded={isOpen}>
                      <CaretDown size={9} style={{ transform: isOpen ? undefined : 'rotate(-90deg)' }} /> {v.name}
                      <span className="sl-count">{models.length}</span>
                    </button>}
                    {isOpen ? models.slice(0, query ? 60 : 400).map((m) => (
                      <button type="button" key={m.model} className="sl-item" data-active={current?.model.model === m.model && current.vendor.id === v.id} onClick={() => pick(m)}>
                        <span>{m.model}</span>{current?.model.model === m.model && current.vendor.id === v.id && <Check size={11} />}
                      </button>
                    )) : null}
                  </div>
                )
              })}
            </div>
          </P.Content>
        </P.Portal>
      </P.Root>
      {current && current.model.nozzles.length > 1 && (
        <div className="seg sl-nozzles" role="radiogroup" aria-label="Nozzle diameter in mm" title="Nozzle diameter in mm">
          {current.model.nozzles.map((n) => (
            <button key={n.machine} type="button" role="radio" aria-checked={n.machine === machine} data-testid={`nozzle-${n.nozzle}`} onClick={() => onPick(n.machine)}>{n.nozzle}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The presets of a type that suit the printer (and the process, for filaments). */
export function usePresetNames(type: 'process' | 'filament', vendor: string, machine: string, process?: string): string[] | null {
  const [names, setNames] = useState<string[] | null>(null)
  useEffect(() => {
    let live = true
    setNames(null)
    const run = type === 'process' ? listProcesses(vendor, machine) : listFilaments(vendor, machine, process)
    run.then((l) => { if (live) setNames(l.map((x) => x.name)) }, () => { if (live) setNames([]) })
    return () => { live = false }
  }, [type, vendor, machine, process])
  return names
}

/** A preset button with the modified marker; the list has the person's user presets first, then Orca's system presets. */
export function PresetPicker({ type, vendor, name, userName, modified, names, onPick, onPickUser, label }: {
  type: PresetScope; vendor: string; name: string; userName?: string; modified: boolean; names: string[] | null
  onPick: (n: string) => void; onPickUser: (p: UserPreset) => void; label: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const all = useUserPresets((s) => s.presets)
  const user = all.filter((p) => p.type === type && p.vendor === vendor)
  const query = q.trim().toLowerCase()
  const shownUser = user.filter((p) => !query || p.name.toLowerCase().includes(query))
  const shown = (names ?? []).filter((n) => !query || n.toLowerCase().includes(query))
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const title = userName ?? name
  return (
    <div className="sl-picker">
      <span className="sl-fieldlabel">{label}</span>
      <P.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setQ(''); setEditing(null) } }}>
        <P.Trigger asChild>
          <button type="button" className="sel sl-trigger" data-testid={`preset-${type}`} data-modified={modified}>
            <span className="sl-trig-main"><span className="sl-trig-name">{title || '...'}</span></span>
            {modified && <span className="sl-modtag">modified</span>}
            <CaretDown size={10} />
          </button>
        </P.Trigger>
        <P.Portal>
          <P.Content className="menu sl-pop" sideOffset={4} align="start" collisionPadding={12} data-testid={`preset-list-${type}`}>
            <label className="sl-search"><MagnifyingGlass size={13} /><input autoFocus placeholder={`Search ${label.toLowerCase()} presets`} value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <div className="sl-list">
              {!!shownUser.length && <div className="sl-grouphead">User presets</div>}
              {shownUser.map((p) => (
                <div key={p.id} className="sl-item sl-user" data-active={userName === p.name}>
                  {editing === p.id ? (
                    <input className="sl-rename" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => { renameUserPreset(p.id, draft); setEditing(null) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                  ) : (
                    <button type="button" className="sl-userpick" onClick={() => { setOpen(false); onPickUser(p) }}><UserCircle size={14} /> <span>{p.name}</span><em>{p.inherits}</em></button>
                  )}
                  <button type="button" className="sl-iconbtn" aria-label={`Rename ${p.name}`} onClick={() => { setEditing(p.id); setDraft(p.name) }}><PencilSimple size={12} /></button>
                  <button type="button" className="sl-iconbtn" aria-label={`Delete ${p.name}`} onClick={() => deleteUserPreset(p.id)}><Trash size={12} /></button>
                </div>
              ))}
              <div className="sl-grouphead">{type === 'machine' ? 'Printer' : 'System presets'}</div>
              {names === null && <p className="sl-empty">Loading ...</p>}
              {shown.map((n) => (
                <button type="button" key={n} className="sl-item" data-active={!userName && n === name} onClick={() => { setOpen(false); onPick(n) }}>
                  <span>{n}</span>{!userName && n === name && <Check size={11} />}
                </button>
              ))}
              {names && !shown.length && !shownUser.length && <p className="sl-empty">Nothing matches.</p>}
            </div>
          </P.Content>
        </P.Portal>
      </P.Root>
    </div>
  )
}

/** "Save as preset": a name box in a popover. */
export function SavePreset({ onSave, disabled }: { onSave: (name: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Trigger asChild>
        <button type="button" className="btn sl-save" disabled={disabled} data-testid="save-preset"><FloppyDisk size={14} /> Save as preset</button>
      </P.Trigger>
      <P.Portal>
        <P.Content className="menu sl-pop sl-savepop" sideOffset={6} align="start" collisionPadding={12}>
          <p className="sl-hint">Saves your changes as a preset you can pick again in any document. It is kept in this browser.</p>
          <input className="sl-input" autoFocus placeholder="Preset name" value={name} data-testid="preset-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { onSave(name); setOpen(false); setName('') } }} />
          <button type="button" className="btn primary" disabled={!name.trim()} data-testid="preset-save-ok" onClick={() => { onSave(name); setOpen(false); setName('') }}>Save</button>
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}
