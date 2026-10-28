import { useState, type ReactNode } from 'react'
import { GearSix } from '@phosphor-icons/react'
import { create } from 'zustand'
import { useUi, type DisplayMode } from '@/store/ui'
import { AUTOSAVE_CHOICES, WORKSPACES, useSettings, type ThemeMode } from '@/settings/settings'
import { useHelp } from '@/help/helpStore'
import { NAV_PRESETS, ORBIT_SPEEDS, useNavSettings } from '@/viewport/navSettings'
import type { GridDensity } from '@/viewport/gridMath'
import { Checkbox } from './Toggle'
import { Segmented } from './Segmented'
import { Select } from './Select'
import { SplitDialog, type NavItem } from './SplitDialog'
import { Tip } from './Tooltip'

type Section = 'general' | 'navigation' | 'display' | 'help'
const NAV: NavItem[] = [
  { id: 'general', label: 'General' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'display', label: 'Display' },
  { id: 'help', label: 'Help' },
]

export const useSettingsDialog = create<{ open: boolean; section: Section; show: (s?: Section) => void; setOpen: (o: boolean) => void; setSection: (s: Section) => void }>((set) => ({
  open: false,
  section: 'general',
  show: (section) => set((s) => ({ open: true, section: section ?? s.section })),
  setOpen: (open) => set({ open }),
  setSection: (section) => set({ section }),
}))

function Row({ label, help, children, id }: { label: string; help: string; children: ReactNode; id: string }) {
  return (
    <div className="set-row" data-testid={'set-' + id}>
      <div className="set-text">
        <div className="set-label">{label}</div>
        <div className="set-help">{help}</div>
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  )
}

function General() {
  const units = useUi((s) => s.units)
  const setUnits = useUi((s) => s.setUnits)
  const s = useSettings()
  return (
    <>
      <Row id="units" label="Units" help="The unit shown and typed in size fields. Files always store millimetres, so switching never changes your model.">
        <Segmented value={units} onChange={(v) => setUnits(v as 'mm' | 'in')} options={[{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }]} />
      </Row>
      <Row id="workspace" label="Start in" help="The workspace tab that is open when the app starts.">
        <Select value={s.defaultWorkspace} onChange={s.setDefaultWorkspace} options={WORKSPACES.map((w) => ({ value: w.id, label: w.label }))} />
      </Row>
      <Row id="theme" label="Theme" help="Dark is the default. System follows your computer's light or dark setting.">
        <Segmented value={s.themeMode} onChange={(v) => s.setThemeMode(v as ThemeMode)} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
      </Row>
      <Row id="autosave" label="Autosave" help="Keeps a recovery copy in this browser while you have unsaved changes, so a crash or a closed tab does not lose your work. It is not a saved file.">
        <Checkbox checked={s.autosave} onChange={s.setAutosave} ariaLabel="Autosave" />
      </Row>
      {s.autosave && (
        <Row id="autosave-interval" label="Autosave every" help="How often the recovery copy is refreshed.">
          <Select value={String(s.autosaveSeconds)} onChange={(v) => s.setAutosaveSeconds(Number(v))}
            options={AUTOSAVE_CHOICES.map((n) => ({ value: String(n), label: n < 60 ? `${n} seconds` : n === 60 ? '1 minute' : `${n / 60} minutes` }))} />
        </Row>
      )}
    </>
  )
}

function Navigation() {
  const nav = useNavSettings()
  const current = NAV_PRESETS.find((p) => p.id === nav.preset)!
  return (
    <>
      <div className="set-block">
        <div className="set-label">Mouse style</div>
        <div className="set-help">Which buttons and gestures orbit, pan and zoom the view. Pick the one you already know.</div>
        <div className="opt-list" role="radiogroup" aria-label="Navigation preset">
          {NAV_PRESETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={p.id === nav.preset} data-value={p.id} className="opt-row" onClick={() => nav.setPreset(p.id)}>
              <span className="opt-txt"><span className="opt-name">{p.label}</span></span>
            </button>
          ))}
        </div>
        <div className="set-help">{current.help} Middle-click twice fits everything. F6 fits all, F fits the selection. The wheel (or a pinch) zooms toward the cursor.</div>
      </div>
      <Row id="inertia" label="Inertia" help="Keeps the view gliding briefly after you let go of an orbit or pan drag.">
        <Checkbox checked={nav.inertia} onChange={nav.setInertia} ariaLabel="Inertia" />
      </Row>
      <Row id="zoom" label="Zoom direction" help="Normal: scroll down zooms out, scroll up zooms in. Reverse flips it.">
        <Segmented value={nav.zoomDirection} onChange={(v) => nav.setZoomDirection(v as 'normal' | 'reverse')} options={[{ value: 'normal', label: 'Normal' }, { value: 'reverse', label: 'Reverse' }]} />
      </Row>
      <Row id="orbit" label="Orbit speed" help="How far the view turns for each bit of mouse movement.">
        <Segmented value={String(nav.orbitSpeed)} onChange={(v) => nav.setOrbitSpeed(Number(v))} options={ORBIT_SPEEDS.map((n) => ({ value: String(n), label: n === 1 ? 'Normal' : `${n}x` }))} />
      </Row>
    </>
  )
}

const MODES: { value: DisplayMode; label: string }[] = [
  { value: 'shaded', label: 'Shaded' },
  { value: 'shadedEdges', label: 'Shaded + edges' },
  { value: 'wireframe', label: 'Wireframe' },
  { value: 'xray', label: 'X-ray' },
]

function Display() {
  const showGrid = useUi((s) => s.showGrid)
  const ssao = useUi((s) => s.ssao)
  const mode = useUi((s) => s.displayMode)
  const setMode = useUi((s) => s.setDisplayMode)
  const density = useSettings((s) => s.gridDensity)
  const setDensity = useSettings((s) => s.setGridDensity)
  return (
    <>
      <Row id="grid" label="Ground grid" help="Show the grid on the floor. It also has a button in the viewport toolbar.">
        <Checkbox checked={showGrid} onChange={(v) => useUi.setState({ showGrid: v })} ariaLabel="Ground grid" />
      </Row>
      <Row id="grid-spacing" label="Grid spacing" help="How close together grid lines may get. Fine shows more lines, Coarse fewer. The grid still adapts as you zoom, and the sketch grid and snapping follow it.">
        <Segmented value={density} onChange={(v) => setDensity(v as GridDensity)} options={[{ value: 'fine', label: 'Fine' }, { value: 'normal', label: 'Normal' }, { value: 'coarse', label: 'Coarse' }]} />
      </Row>
      <Row id="display" label="Display style" help="How solids are drawn. Shaded + edges draws dark outlines on the edges.">
        <Select value={mode} onChange={(v) => setMode(v as DisplayMode)} options={MODES} />
      </Row>
      <Row id="ao" label="Ambient occlusion" help="Soft shadows in creases and corners that make shapes easier to read. Turn it off if the view feels slow.">
        <Checkbox checked={ssao} onChange={(v) => useUi.setState({ ssao: v })} ariaLabel="Ambient occlusion" />
      </Row>
    </>
  )
}

function Help() {
  const s = useSettings()
  const [done, setDone] = useState(false)
  return (
    <>
      <Row id="tooltips" label="Show tooltips" help="A small card with the name, shortcut and a short explanation when you hover a button or field, or focus it with the keyboard. On a touch screen, press and hold.">
        <Checkbox checked={s.tooltips} onChange={s.setTooltips} ariaLabel="Show tooltips" />
      </Row>
      <Row id="beginner" label="Show beginner tips" help="Hints in the empty viewport about where to start, and a short description at the top of each tool's settings.">
        <Checkbox checked={s.beginnerTips} onChange={s.setBeginnerTips} ariaLabel="Show beginner tips" />
      </Row>
      <Row id="tour" label="Intro tour" help="The short walk through the screen that appears the first time you open the app.">
        <button type="button" className="btn" data-testid="reset-tour" onClick={() => { s.setTourSeen(false); setDone(true) }}>{done ? 'It will show on next start' : 'Reset the tour'}</button>
        <button type="button" className="btn" data-testid="replay-tour" onClick={() => { useSettingsDialog.getState().setOpen(false); useHelp.getState().startTour() }}>Play it now</button>
      </Row>
      <Row id="reset" label="Reset all settings" help="Put every setting in this window back to its default, including the mouse style.">
        <button type="button" className="btn" data-testid="reset-settings" onClick={() => { s.resetAll(); const n = useNavSettings.getState(); n.setPreset('fusion'); n.setInertia(false); n.setZoomDirection('normal'); n.setOrbitSpeed(1) }}>Reset</button>
      </Row>
    </>
  )
}

/** The Settings dialog, opened from the gear in the status bar (or the palette). */
export function SettingsDialog() {
  const { open, section, setOpen, setSection } = useSettingsDialog()
  return (
    <SplitDialog open={open} onOpenChange={setOpen} title="Settings" description="Units, theme, mouse navigation, display and help options." nav={NAV} active={section} onSelect={(id) => setSection(id as Section)} testId="settings-dialog">
      {section === 'general' && <General />}
      {section === 'navigation' && <Navigation />}
      {section === 'display' && <Display />}
      {section === 'help' && <Help />}
    </SplitDialog>
  )
}

/** Gear in the status bar. */
export function SettingsButton() {
  const show = useSettingsDialog((s) => s.show)
  return (
    <Tip label="Settings" desc="Units, theme, mouse navigation, display, autosave and help options." side="top">
      <button type="button" className="cell gear" aria-label="Settings" data-testid="settings-gear" onClick={() => show()}><GearSix size={13} /></button>
    </Tip>
  )
}
