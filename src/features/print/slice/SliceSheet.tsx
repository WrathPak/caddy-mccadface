/** The Slice panel: a frosted sheet with the quick settings, Orca's Process, Filament and Printer tabs, and the per-object settings. */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { MagnifyingGlass, Scissors, WarningCircle, X, Info } from '@phosphor-icons/react'
import type { SettingIssue } from '@muon3d/slicer-engine-protocol'
import { useDoc } from '@/doc/store'
import { Segmented } from '@/ui/Segmented'
import { runSlice } from './run'
import { applyValues, dismissPrompts, editSetting, loadViews, profileNow, refreshAll, resetSetting, saveAsUserPreset, setFilament, setMachineUser, setMode, setProcess, slotCount, syncFromDoc } from './controller'
import { ObjectsTab } from './ObjectsTab'
import { PresetPicker, SavePreset, usePresetNames } from './Pickers'
import { QuickTab } from './QuickTab'
import { SettingsPane } from './SettingsPane'
import { useSlicer, type PresetScopeTab, type SheetTab } from './store'
import { loadUserPresets, refOf } from './userPresets'
import type { PanelMode } from './profile'
import './slice.css'

const TABS: { id: SheetTab; label: string }[] = [
  { id: 'quick', label: 'Quick' }, { id: 'process', label: 'Process' }, { id: 'filament', label: 'Filament' }, { id: 'printer', label: 'Printer' }, { id: 'objects', label: 'Objects' },
]
const SCOPE: Record<'process' | 'filament' | 'printer', PresetScopeTab> = { process: 'process', filament: 'filament', printer: 'machine' }

function Issues({ issues }: { issues: SettingIssue[] }) {
  const list = issues.filter((i) => i.severity !== 'info')
  if (!list.length) return null
  return (
    <div className="sl-issues" data-testid="issues">
      {list.map((i) => (
        <div key={i.id + i.key} className="sl-issue" data-severity={i.severity}>
          <WarningCircle size={16} weight="fill" />
          <span className="sl-issue-text">{i.message}</span>
          {i.fix && <button type="button" className="btn" data-testid="issue-fix" onClick={() => void applyValues(i.scope, i.fix!)}>{i.fixLabel ?? 'Fix'}</button>}
          {i.alternative && <button type="button" className="btn" onClick={() => void applyValues(i.scope, i.alternative!.values)}>{i.alternative.label}</button>}
        </div>
      ))}
    </div>
  )
}

function Notes() {
  const { prompts, notices, error } = useSlicer()
  if (!prompts.length && !notices.length && !error) return null
  return (
    <div className="sl-issues">
      {error && (
        <div className="sl-issue" data-severity="error" data-testid="slicer-error">
          <WarningCircle size={16} weight="fill" /><span className="sl-issue-text">{error}</span>
          <button type="button" className="btn" onClick={() => { useSlicer.getState().set({ error: null }); void refreshAll() }}>Try again</button>
        </div>
      )}
      {prompts.map((p) => (
        <div key={p.id + p.key} className="sl-issue" data-severity="info" data-testid="prompt">
          <Info size={16} weight="fill" /><span className="sl-issue-text">{p.message}</span>
          {p.choices.map((c, i) => (
            <button key={c.label} type="button" className={'btn' + (i === 0 ? '' : ' ghost')} onClick={() => { if (Object.keys(c.values).length) void applyValues(p.scope, c.values); else dismissPrompts() }}>{c.label}</button>
          ))}
        </div>
      ))}
      {notices.length > 0 && (
        <div className="sl-issue" data-severity="info">
          <Info size={16} weight="fill" /><span className="sl-issue-text">{notices.join(' ')}</span>
          <button type="button" className="sl-iconbtn" aria-label="Dismiss" onClick={dismissPrompts}><X size={12} /></button>
        </div>
      )}
    </div>
  )
}

/** Preset row of a preset tab: the preset, save as, and reset all. */
function PresetBar({ tab }: { tab: 'process' | 'filament' | 'printer' }) {
  const resolved = useSlicer((s) => s.resolved)
  const slot = useSlicer((s) => s.slot)
  const features = useDoc((s) => s.features)
  const profile = profileNow()
  void features
  const type = tab === 'printer' ? 'machine' : tab
  const n = slotCount()
  const names = usePresetNames(tab === 'printer' ? 'process' : tab, profile.vendor, profile.machine, tab === 'filament' ? resolved?.processName : undefined)
  const patch = tab === 'process' ? profile.overrides.process : tab === 'printer' ? profile.overrides.machine : profile.overrides.filaments[slot] ?? {}
  const count = Object.keys(patch).length
  if (!resolved) return null
  const name = tab === 'process' ? resolved.processName : tab === 'filament' ? resolved.filamentNames[slot] : profile.machine
  const user = tab === 'process' ? profile.user.process : tab === 'filament' ? profile.user.filaments[slot] : profile.user.machine
  return (
    <div className="sl-presetbar">
      {tab === 'filament' && n > 1 && (
        <Segmented value={String(slot)} onChange={(v) => { useSlicer.getState().set({ slot: +v, view: null }); void loadViews() }} options={Array.from({ length: n }, (_, i) => ({ value: String(i), label: `Filament ${i + 1}` }))} />
      )}
      <PresetPicker
        type={type} label={tab === 'printer' ? 'Printer preset' : tab === 'process' ? 'Process preset' : 'Filament preset'} vendor={profile.vendor} name={name ?? ''} userName={user?.name}
        names={tab === 'printer' ? [profile.machine] : names} modified={count > 0}
        onPick={(nm) => { if (tab === 'process') void setProcess(nm); else if (tab === 'filament') void setFilament(slot, nm); else void setMachineUser(undefined) }}
        onPickUser={(u) => { if (tab === 'process') void setProcess(u.inherits, refOf(u)); else if (tab === 'filament') void setFilament(slot, u.inherits, refOf(u)); else void setMachineUser(refOf(u)) }}
      />
      <div className="sl-presetbtns">
        <SavePreset disabled={count === 0} onSave={(nm) => void saveAsUserPreset(type, nm)} />
        <button type="button" className="btn" disabled={count === 0} data-testid="reset-all" onClick={() => Object.keys(patch).forEach((k) => void resetSetting(type, k))}>Reset {count > 0 ? count : ''} change{count === 1 ? '' : 's'}</button>
      </div>
    </div>
  )
}

export function SliceSheet() {
  const { sheetOpen, tab, mode, search, view, page, closeSheet } = useSlicer()
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const profile = profileNow()
  void features; void rollback

  useEffect(() => {
    if (!sheetOpen) return
    void loadUserPresets()
    void refreshAll()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeSheet() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [sheetOpen, closeSheet])
  // undo, redo and a replaced document change the profile from outside: read the presets again
  useEffect(() => { if (sheetOpen) syncFromDoc() }, [sheetOpen, features, rollback])
  useEffect(() => { if (sheetOpen) void loadViews() }, [sheetOpen, tab, useSlicer.getState().slot, useSlicer.getState().objectId])

  if (!sheetOpen) return null
  const scoped = tab === 'process' || tab === 'filament' || tab === 'printer'
  const scope = scoped ? SCOPE[tab] : null
  const slot = useSlicer.getState().slot
  const overrides = scope === 'process' ? profile.overrides.process : scope === 'machine' ? profile.overrides.machine : profile.overrides.filaments[slot] ?? {}
  const issues = tab === 'objects' ? useSlicer.getState().objectView?.issues ?? [] : view?.issues ?? []

  return createPortal(
    <div className="sl-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) closeSheet() }} data-testid="slice-sheet-scrim">
      <div className="sl-sheet" role="dialog" aria-modal="true" aria-label="Slice settings" data-testid="slice-sheet" onKeyDown={(e) => e.stopPropagation()}>
        <header className="sl-head">
          <div className="sl-title"><Scissors size={18} weight="duotone" /><div><h2>Slice</h2><span>{profile.machine.replace(/ nozzle$/, ' nozzle')}</span></div></div>
          <div className="sl-tabs" role="tablist">
            {TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-testid={`tab-${t.id}`} onClick={() => useSlicer.getState().set({ tab: t.id, search: '' })}>{t.label}</button>)}
          </div>
          <button type="button" className="sl-close" aria-label="Close" data-testid="slice-close" onClick={closeSheet}><X size={16} /></button>
        </header>
        {(scoped || tab === 'objects') && (
          <div className="sl-toolbar">
            <Segmented value={mode} onChange={(m) => void setMode(m as PanelMode)} options={[{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }, { value: 'expert', label: 'Expert' }]} />
            {scoped && <label className="sl-search sl-searchbar"><MagnifyingGlass size={13} /><input placeholder="Search settings" value={search} data-testid="settings-search" onChange={(e) => useSlicer.getState().set({ search: e.target.value })} /></label>}
          </div>
        )}
        <Notes />
        <Issues issues={issues} />
        <div className="sl-body">
          {tab === 'quick' && <QuickTab profile={profile} />}
          {scoped && (
            <div className="sl-scoped">
              <PresetBar tab={tab} />
              {view
                ? <SettingsPane
                    view={view} overrides={overrides} search={search} page={page[scope!] || view.tab?.pages[0]?.id || ''}
                    onPage={(id) => useSlicer.getState().set({ page: { ...page, [scope!]: id }, search: '' })}
                    onEdit={(k, t, i) => void editSetting(scope!, k, t, i)} onReset={(k) => void resetSetting(scope!, k)}
                  />
                : <p className="sl-empty">Loading settings ...</p>}
            </div>
          )}
          {tab === 'objects' && <ObjectsTab profile={profile} />}
        </div>
        <footer className="sl-foot">
          <span className="sl-hint">Settings are saved in the document. Changes you make show a dot you can click to undo them.</span>
          <button type="button" className="btn primary" data-testid="slice-go" onClick={() => { closeSheet(); void runSlice() }}><Scissors size={15} /> Slice</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
