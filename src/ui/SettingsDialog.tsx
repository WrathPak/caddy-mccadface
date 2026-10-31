import { useState, type ReactNode } from 'react'
import { GearSix } from '@phosphor-icons/react'
import { create } from 'zustand'
import { useUi, type DisplayMode } from '@/store/ui'
import { canPickFolder, useProjects } from '@/projects/store'
import { useDiskAutosave } from '@/io/diskAutosave'
import { AUTOSAVE_CHOICES, AUTOSAVE_VERSION_CHOICES, PIXEL_RATIOS, WORKSPACES, useSettings, type PixelRatio, type ThemeMode } from '@/settings/settings'
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

/** Autosave to a folder on the computer, on top of the copy in the browser. Chrome and Edge only: other browsers get one line saying so. */
function AutosaveFolder() {
  const s = useSettings()
  const root = useProjects((p) => p.root)
  const access = useProjects((p) => p.access)
  const lastAt = useDiskAutosave((d) => d.lastAt)
  if (!canPickFolder()) {
    return (
      <Row id="autosave-folder" label="Autosave folder" help="This browser cannot save to a folder on your computer, so autosave keeps its copy in the browser only. Chrome and Edge can also keep copies in a folder.">
        <span className="set-help">Browser only</span>
      </Row>
    )
  }
  return (
    <>
      <Row id="disk-autosave" label="Keep copies in a folder" help="Keeps recent copies in an Autosave folder inside your projects folder, on top of the copy kept in this browser.">
        <Checkbox checked={s.diskAutosave} onChange={s.setDiskAutosave} ariaLabel="Keep copies in a folder" />
      </Row>
      {s.diskAutosave && (
        <>
          <Row id="autosave-folder" label="Autosave folder"
            help={`${root ? `Copies go in the Autosave folder inside "${root.name}", the same folder the Projects panel shows.` : 'No folder picked yet. Pick the folder you keep your projects in.'}${lastAt ? ` Last copy at ${new Date(lastAt).toLocaleTimeString()}.` : ''}`}>
            <span className="mono" data-testid="autosave-folder-name" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{root ? root.name : 'None'}</span>
            {root && access === 'prompt' && <button type="button" className="btn" data-testid="settings-reconnect" onClick={() => void useProjects.getState().reconnect()}>Reconnect</button>}
            <button type="button" className="btn" data-testid="autosave-change-folder" onClick={() => void useProjects.getState().chooseFolder()}>{root ? 'Change' : 'Pick folder'}</button>
          </Row>
          <Row id="autosave-versions" label="Copies to keep" help="How many recent copies of each document stay in the folder. Older ones are removed.">
            <Select value={String(s.autosaveVersions)} onChange={(v) => s.setAutosaveVersions(Number(v))}
              options={AUTOSAVE_VERSION_CHOICES.map((n) => ({ value: String(n), label: String(n) }))} />
          </Row>
        </>
      )}
    </>
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
      <Row id="autosave" label="Autosave" help="Keeps a recovery copy while you have unsaved changes, so a crash or a closed tab does not lose your work. It is not your saved file.">
        <Checkbox checked={s.autosave} onChange={s.setAutosave} ariaLabel="Autosave" />
      </Row>
      {s.autosave && (
        <Row id="autosave-interval" label="Autosave every" help="How often the recovery copy is refreshed.">
          <Select value={String(s.autosaveSeconds)} onChange={(v) => s.setAutosaveSeconds(Number(v))}
            options={AUTOSAVE_CHOICES.map((n) => ({ value: String(n), label: n < 60 ? `${n} seconds` : n === 60 ? '1 minute' : `${n / 60} minutes` }))} />
        </Row>
      )}
      {s.autosave && <AutosaveFolder />}
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
        <div className="set-help">{current.help} Middle-click twice fits everything. F6 fits all, F fits the selection. The wheel (or a pinch) zooms toward the cursor. On a touch screen one finger orbits, two fingers pan, pinch and twist, a double tap fits everything and a long press opens the menu.</div>
      </div>
      <Row id="inertia" label="Inertia" help="Keeps the view gliding briefly after you let go of an orbit or pan drag.">
        <Checkbox checked={nav.inertia} onChange={nav.setInertia} ariaLabel="Inertia" />
      </Row>
      <Row id="zoom" label="Zoom direction" help="Normal: scroll down zooms out, scroll up zooms in. Reverse flips it.">
        <Segmented value={nav.zoomDirection} onChange={(v) => nav.setZoomDirection(v as 'normal' | 'reverse')} options={[{ value: 'normal', label: 'Normal' }, { value: 'reverse', label: 'Reverse' }]} />
      </Row>
      <Row id="twist" label="Two-finger twist" help="On a touch screen, turning two fingers around each other rolls the view about your line of sight, at the same time as they pan and pinch. A small turn is ignored so a pinch never rolls by accident. Turn it off if you keep rolling the view by mistake.">
        <Checkbox checked={nav.touchTwist} onChange={nav.setTouchTwist} ariaLabel="Two-finger twist" />
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

const SELECTION_SWATCHES = ['#4fa3b8', '#e8b84a', '#e0684f', '#6cc06c', '#b07cd8', '#ffffff']

function Display() {
  const showOrigin = useUi((s) => s.showOrigin)
  const selColor = useSettings((s) => s.selectionColor)
  const setSelColor = useSettings((s) => s.setSelectionColor)
  const showGrid = useUi((s) => s.showGrid)
  const ssao = useUi((s) => s.ssao)
  const mode = useUi((s) => s.displayMode)
  const setMode = useUi((s) => s.setDisplayMode)
  const density = useSettings((s) => s.gridDensity)
  const setDensity = useSettings((s) => s.setGridDensity)
  const pixelRatio = useSettings((s) => s.pixelRatio)
  const setPixelRatio = useSettings((s) => s.setPixelRatio)
  return (
    <>
      <Row id="grid" label="Ground grid" help="Show the grid on the floor. It also has a button in the viewport toolbar.">
        <Checkbox checked={showGrid} onChange={(v) => useUi.setState({ showGrid: v })} ariaLabel="Ground grid" />
      </Row>
      <Row id="origin" label="Origin axes" help="Show the origin: the red, green and blue axes and the three planes through it. It also has a button in the viewport toolbar.">
        <Checkbox checked={showOrigin} onChange={(v) => useUi.setState({ showOrigin: v })} ariaLabel="Origin axes" />
      </Row>
      <Row id="grid-spacing" label="Grid spacing" help="How close together grid lines may get. Fine shows more lines, Coarse fewer. The grid still adapts as you zoom, and the sketch grid and snapping follow it.">
        <Segmented value={density} onChange={(v) => setDensity(v as GridDensity)} options={[{ value: 'fine', label: 'Fine' }, { value: 'normal', label: 'Normal' }, { value: 'coarse', label: 'Coarse' }]} />
      </Row>
      <Row id="selection-color" label="Selection color" help="The color of selected bodies, faces, edges and sketch lines. What the pointer is over (before you click) is drawn in a lighter shade of it. Default uses the accent color of the theme.">
        <div className="swatches" role="radiogroup" aria-label="Selection color" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" role="radio" aria-checked={selColor === ''} aria-label="Default" data-testid="sel-color-default" className="btn" onClick={() => setSelColor('')}>Default</button>
          {SELECTION_SWATCHES.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={selColor === c} aria-label={c} data-testid={'sel-color-' + c.slice(1)} onClick={() => setSelColor(c)}
              style={{ width: 20, height: 20, borderRadius: 4, background: c, border: selColor === c ? '2px solid var(--text)' : '1px solid var(--border)', cursor: 'pointer', padding: 0 }} />
          ))}
          <input type="color" aria-label="Custom selection color" data-testid="sel-color-custom" value={selColor || '#4fa3b8'} onChange={(e) => setSelColor(e.target.value)} style={{ width: 28, height: 22, padding: 0, border: 'none', background: 'none' }} />
        </div>
      </Row>
      <Row id="display" label="Display style" help="How solids are drawn. Shaded + edges draws dark outlines on the edges.">
        <Select value={mode} onChange={(v) => setMode(v as DisplayMode)} options={MODES} />
      </Row>
      <Row id="ao" label="Ambient occlusion" help="Soft shadows in creases and corners that make shapes easier to read. Turn it off if the view feels slow.">
        <Checkbox checked={ssao} onChange={(v) => useUi.setState({ ssao: v })} ariaLabel="Ambient occlusion" />
      </Row>
      <Row id="sharpness" label="Sharpness" help="How many pixels the 3D view draws. Auto keeps phones and tablets at 1.5x so orbiting stays smooth; pick a higher one for a crisper picture, or 1x to go faster.">
        <Select value={pixelRatio} onChange={(v) => setPixelRatio(v as PixelRatio)} options={PIXEL_RATIOS} />
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
        <button type="button" className="btn" data-testid="reset-settings" onClick={() => { s.resetAll(); const n = useNavSettings.getState(); n.setPreset('fusion'); n.setInertia(false); n.setZoomDirection('normal'); n.setOrbitSpeed(1); n.setTouchTwist(true) }}>Reset</button>
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
