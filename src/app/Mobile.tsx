/**
 * The phone layout (narrower than ~800 px, or a phone held sideways): a full-bleed viewport under a slim top bar and a scrolling
 * tool strip. The Browser slides in from the left, the Timeline from the bottom, the Inspector is a bottom sheet you pull between
 * peek, half and full. Everything a keyboard does on the desktop has a button here (undo, redo, delete, accept, cancel).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPE, type ReactNode } from 'react'
import * as D from '@radix-ui/react-dropdown-menu'
import {
  ArrowCounterClockwise, ArrowUUpLeft, ArrowUUpRight, CaretDown, CaretUp, Check, DotsThreeVertical, FilmStrip, FrameCorners, Pencil, Trash, TreeStructure, X,
} from '@phosphor-icons/react'
import { RIBBON_TABS } from '@/app/ribbon'
import { getCommand, runCommand } from '@/app/commands'
import { FileMenu, RibbonGroups, useRibbonTab } from '@/ui/Ribbon'
import { StatusBar } from '@/ui/StatusBar'
import { BrowserTree } from '@/ui/BrowserTree'
import { Inspector } from '@/ui/Inspector'
import { Timeline } from '@/ui/Timeline'
import { ErrorBoundary } from '@/ui/ErrorBoundary'
import { Viewport } from '@/viewport/Viewport'
import { PreviewBanner } from '@/history/HistoryUi'
import { useUi } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { editFeature } from '@/doc/editor'
import { missingRequired, schemaDefaults } from '@/ui/schema'
import { useSketch, finishSketch, cancelSketch, undoPoint, enterSketch, typedInfo, setTypedText, nextTypedField, acceptTyped, deleteSelection, undoSketch, redoSketch } from '@/sketch/store'
import { KbdToggle, useKbd } from '@/ui/kbd'
import { useSketchPick, beginFromSelection, stopPicking } from '@/sketch/create'
import { useSettingsDialog } from '@/ui/SettingsDialog'
import { useSettings } from '@/settings/settings'
import { useHelp } from '@/help/helpStore'
import { tapProps } from '@/ui/tapProps'
import { openPanel, panelDefs, renderPanel } from './panels'
import { useMobile, type InspectorSnap } from './mobileStore'
import { watchKeyboard } from './device'

// ---------------------------------------------------------------- small pieces

/** A button of the floating bars: on a touch screen it acts when the finger lifts (see tapProps), so the keyboard being up never eats the tap. */
function Act({ onClick, className = 'm-act', children, ...rest }: { onClick: () => void; className?: string; children: ReactNode; disabled?: boolean; 'data-testid'?: string; 'aria-label'?: string }) {
  return <button type="button" className={className} {...rest} {...tapProps(onClick)}>{children}</button>
}

function IconBtn({ icon: I, label, onClick, active, disabled, id }: { icon: typeof Check; label: string; onClick?: () => void; active?: boolean; disabled?: boolean; id?: string }) {
  return (
    <button type="button" className="m-btn" aria-label={label} data-active={active} data-testid={id} disabled={disabled} onClick={onClick}>
      <I size={20} weight="light" />
    </button>
  )
}

function WorkspaceMenu() {
  const { selected, tab } = useRibbonTab()
  const setWorkspace = useUi((s) => s.setWorkspace)
  return (
    <D.Root>
      <D.Trigger asChild>
        <button type="button" className="m-ws" aria-label="Workspace" data-testid="m-workspace">
          <span className={selected === 'sketch' ? 'sk' : undefined}>{tab.label}</span>
          <CaretDown size={10} weight="bold" />
        </button>
      </D.Trigger>
      <D.Portal>
        <D.Content className="menu m-menu" sideOffset={2} align="start" data-testid="m-workspace-menu">
          {RIBBON_TABS.filter((t) => !t.contextual).map((t) => (
            <D.Item key={t.id} className="menu-item" disabled={t.disabled} data-active={t.id === selected} onSelect={() => setWorkspace(t.id as 'solid')}>
              {t.label}
              {t.id === selected && <Check size={12} style={{ marginLeft: 'auto' }} />}
            </D.Item>
          ))}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

function Cmd({ id, label }: { id: string; label?: string }) {
  const c = getCommand(id)
  if (!c) return null
  return (
    <D.Item className="menu-item" onSelect={() => runCommand(id)}>
      <c.icon size={16} /> {label ?? c.label.replace(/^Display: /, '')}
    </D.Item>
  )
}

/** Everything the desktop keeps in the viewport toolbar, the Panels menu, the ? menu and the status bar corner. */
function MoreMenu() {
  const theme = useUi((s) => s.theme)
  const showGrid = useUi((s) => s.showGrid)
  const showOrigin = useUi((s) => s.showOrigin)
  const toggleTheme = useSettings((s) => s.toggleTheme)
  const showHelp = useHelp((s) => s.show)
  const startTour = useHelp((s) => s.startTour)
  return (
    <D.Root>
      <D.Trigger asChild>
        <button type="button" className="m-btn" aria-label="More" data-testid="m-more"><DotsThreeVertical size={20} weight="bold" /></button>
      </D.Trigger>
      <D.Portal>
        <D.Content className="menu m-menu" sideOffset={2} align="end" collisionPadding={6} data-testid="m-more-menu">
          <Cmd id="app.palette" label="Search commands" />
          <D.Separator className="menu-sep" />
          <D.Label className="menu-label">View</D.Label>
          <Cmd id="view.frame" />
          <Cmd id="view.home" />
          <Cmd id="view.top" />
          <Cmd id="view.front" />
          <Cmd id="view.right" />
          <Cmd id="view.ortho" label="Perspective / Orthographic" />
          <Cmd id="view.ssao" label="Ambient occlusion" />
          <D.Item className="menu-item" onSelect={() => useUi.setState({ showGrid: !showGrid })}>Grid {showGrid ? 'on' : 'off'}</D.Item>
          <D.Item className="menu-item" onSelect={() => useUi.setState({ showOrigin: !showOrigin })}>Origin {showOrigin ? 'on' : 'off'}</D.Item>
          <D.Separator className="menu-sep" />
          <D.Label className="menu-label">Display</D.Label>
          <Cmd id="view.shaded" />
          <Cmd id="view.shadedEdges" />
          <Cmd id="view.wireframe" />
          <Cmd id="view.xray" />
          <D.Separator className="menu-sep" />
          <D.Label className="menu-label">Panels</D.Label>
          {panelDefs().map((p) => (
            <D.Item key={p.id} className="menu-item" onSelect={() => openPanel(p.id)}>{p.title}</D.Item>
          ))}
          <D.Separator className="menu-sep" />
          <D.Item className="menu-item" onSelect={toggleTheme}>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</D.Item>
          <D.Item className="menu-item" onSelect={() => useSettingsDialog.getState().show()}>Settings</D.Item>
          <D.Item className="menu-item" onSelect={() => showHelp({ kind: 'start' })}>Getting started</D.Item>
          <D.Item className="menu-item" onSelect={() => showHelp({ kind: 'shortcuts' })}>Gestures and shortcuts</D.Item>
          <D.Item className="menu-item" onSelect={startTour}>Take the tour</D.Item>
          <D.Item className="menu-item" onSelect={() => showHelp({ kind: 'about' })}>About</D.Item>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

// ---------------------------------------------------------------- top bar

function TopBar() {
  const sketching = useSketch((s) => s.active)
  const docUndo = useDoc((s) => s.undoDepth)
  const docRedo = useDoc((s) => s.redoDepth)
  const skUndo = useSketch((s) => s.past.length)
  const skRedo = useSketch((s) => s.future.length)
  const left = useMobile((s) => s.left)
  const timeline = useMobile((s) => s.timeline)
  const { openLeft, closeLeft, setTimeline } = useMobile.getState()
  return (
    <div className="m-top" data-testid="m-top">
      <FileMenu />
      <WorkspaceMenu />
      <span className="grow" />
      <IconBtn icon={ArrowUUpLeft} label="Undo" id="m-undo" disabled={sketching ? skUndo === 0 : docUndo === 0} onClick={() => (sketching ? undoSketch() : runCommand('edit.undo'))} />
      <IconBtn icon={ArrowUUpRight} label="Redo" id="m-redo" disabled={sketching ? skRedo === 0 : docRedo === 0} onClick={() => (sketching ? redoSketch() : runCommand('edit.redo'))} />
      <span className="sep" />
      <IconBtn icon={TreeStructure} label="Browser" id="m-browser" active={left !== null} onClick={() => (left ? closeLeft() : openLeft())} />
      <IconBtn icon={FilmStrip} label="Timeline" id="m-timeline" active={timeline} onClick={() => setTimeline(!timeline)} />
      <MoreMenu />
    </div>
  )
}

// ---------------------------------------------------------------- sheets

function Scrim({ onClick, children }: { onClick: () => void; children?: ReactNode }) {
  return <div className="m-scrim" data-testid="m-scrim" onPointerDown={onClick}>{children}</div>
}

/** Browser plus the extra panels (History, Projects, Plugins, Script), slid in from the left. */
function LeftSheet() {
  const left = useMobile((s) => s.left)
  const { openLeft, closeLeft } = useMobile.getState()
  const swipe = useRef<{ x: number; y: number } | null>(null)
  if (!left) return null
  const tabs = [{ id: 'browser', title: 'Browser' }, ...panelDefs().map((p) => ({ id: p.id, title: p.title }))]
  return (
    <>
      <Scrim onClick={closeLeft} />
      <aside
        className="m-sheet-left" data-testid="m-sheet-browser" aria-label="Browser"
        onPointerDown={(e) => { if (e.pointerType === 'touch') swipe.current = { x: e.clientX, y: e.clientY } }}
        onPointerUp={(e) => {
          const s = swipe.current
          swipe.current = null
          if (s && e.clientX - s.x < -70 && Math.abs(e.clientY - s.y) < 40) closeLeft()
        }}
      >
        <div className="m-sheet-head">
          <div className="m-tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={left === t.id} className="m-tab" onClick={() => openLeft(t.id)}>{t.title}</button>
            ))}
          </div>
          <IconBtn icon={X} label="Close" id="m-close-left" onClick={closeLeft} />
        </div>
        <div className="m-sheet-body">
          {left === 'browser' ? <ErrorBoundary name="Browser"><BrowserTree /></ErrorBoundary> : renderPanel(left)}
        </div>
      </aside>
    </>
  )
}

/** Feature chips in a strip along the bottom, with buttons for the one that is selected (double click is hard to do with a finger). */
function TimelineSheet() {
  const open = useMobile((s) => s.timeline)
  const sel = useDoc((s) => s.selectedFeatureId)
  const feature = useDoc((s) => s.features.find((f) => f.id === s.selectedFeatureId))
  const toggleSuppress = useDoc((s) => s.toggleSuppress)
  const removeFeature = useDoc((s) => s.removeFeature)
  if (!open) return null
  const { setTimeline } = useMobile.getState()
  return (
    <aside className="m-sheet-bottom" data-testid="m-sheet-timeline" aria-label="Timeline">
      <div className="m-sheet-head">
        <span className="m-title">Timeline</span>
        {feature && <span className="m-sub">{feature.name}</span>}
        <span className="grow" />
        <button type="button" className="btn" disabled={!sel} data-testid="m-tl-edit" onClick={() => { if (sel) { editFeature(sel); setTimeline(false) } }}><Pencil size={13} /> Edit</button>
        <button type="button" className="btn" disabled={!sel} data-testid="m-tl-suppress" onClick={() => sel && toggleSuppress(sel)}>{feature?.suppressed ? 'Switch on' : 'Switch off'}</button>
        <button type="button" className="btn" disabled={!sel} data-testid="m-tl-delete" aria-label="Delete step" onClick={() => sel && removeFeature(sel)}><Trash size={13} /></button>
        <IconBtn icon={X} label="Close" id="m-close-timeline" onClick={() => setTimeline(false)} />
      </div>
      <div className="m-tl"><ErrorBoundary name="Timeline"><Timeline onEditFeature={(id) => { editFeature(id); setTimeline(false) }} /></ErrorBoundary></div>
    </aside>
  )
}

const PEEK = 136
const SNAPS: InspectorSnap[] = ['peek', 'half', 'full']

/** Pixels the sheet may use: the visible page, less the top bar so it never covers the way back. */
const availHeight = () => Math.max(240, (window.visualViewport?.height ?? window.innerHeight) - 48)
const snapPx = (s: InspectorSnap) => (s === 'peek' ? PEEK : s === 'half' ? Math.round(availHeight() * 0.5) : availHeight())

/** The feature dialog as a bottom sheet. Pull the handle to peek (see the model, OK / Cancel stay), half or full. */
function InspectorSheet() {
  const session = useUi((s) => s.inspector)
  const snap = useMobile((s) => s.snap)
  const [drag, setDrag] = useState<number | null>(null)
  const start = useRef<{ y: number; h: number; cur: number; lastY: number; lastT: number; v: number } | null>(null)
  const seen = useRef<object | null>(null)

  // a new dialog opens at half, or at peek while a required pick is still open (so the model stays in view for tapping)
  useLayoutEffect(() => {
    if (!session || seen.current === session) return
    seen.current = session
    let need = false
    try { need = missingRequired(session.schema, { ...schemaDefaults(session.schema), ...session.values }).length > 0 } catch { /* the form shows the problem */ }
    useMobile.getState().setSnap(need ? 'peek' : 'half')
  }, [session])
  useEffect(() => { if (!session) seen.current = null }, [session])

  if (!session) return null
  const { setSnap } = useMobile.getState()
  const height = drag ?? snapPx(snap)
  const down = (e: RPE) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { y: e.clientY, h: snapPx(snap), cur: snapPx(snap), lastY: e.clientY, lastT: performance.now(), v: 0 }
    setDrag(snapPx(snap))
  }
  const move = (e: RPE) => {
    const s = start.current
    if (!s) return
    const now = performance.now()
    s.v = (e.clientY - s.lastY) / Math.max(1, now - s.lastT)
    s.lastY = e.clientY; s.lastT = now
    s.cur = Math.max(PEEK - 20, Math.min(availHeight(), s.h - (e.clientY - s.y)))
    setDrag(s.cur)
  }
  const up = () => {
    const s = start.current
    start.current = null
    if (!s) return
    const h = s.cur
    // where it would come to rest: the release point plus a bit of the speed it was let go with, then the nearest of the three heights
    const rest = h - s.v * 150
    const target = SNAPS.reduce((a, b) => (Math.abs(snapPx(a) - rest) <= Math.abs(snapPx(b) - rest) ? a : b))
    setDrag(null)
    setSnap(target)
  }
  const step = (dir: 1 | -1) => setSnap(SNAPS[Math.max(0, Math.min(2, SNAPS.indexOf(snap) + dir))])
  return (
    <aside className="m-sheet-insp" data-testid="m-sheet-inspector" data-snap={drag !== null ? 'drag' : snap} style={{ ['--sheet-h' as string]: `${height}px` } as CSSProperties} aria-label="Inspector">
      <div className="m-grab" data-testid="m-grab" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <span className="m-grab-bar" />
        <span className="m-grab-btns" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className="m-mini" aria-label="Make the sheet taller" disabled={snap === 'full'} onClick={() => step(1)}><CaretUp size={14} weight="bold" /></button>
          <button type="button" className="m-mini" aria-label="Make the sheet shorter" disabled={snap === 'peek'} onClick={() => step(-1)}><CaretDown size={14} weight="bold" /></button>
        </span>
      </div>
      <div className="m-sheet-body"><ErrorBoundary name="Inspector"><Inspector /></ErrorBoundary></div>
    </aside>
  )
}

// ---------------------------------------------------------------- floating action bars

/** What the Delete / Esc keys do for a selection: buttons over the viewport while something is selected. */
function SelectionBar() {
  const n = useUi((s) => s.selection.length)
  const busy = useUi((s) => !!s.inspector || s.sketchMode)
  if (!n || busy) return null
  return (
    <div className="m-actions" data-testid="m-selbar">
      <span className="m-count">{n} selected</span>
      <Act data-testid="m-frame-sel" onClick={() => runCommand('view.frameSelection')}><FrameCorners size={16} /> Frame</Act>
      <Act className="m-act danger" data-testid="m-delete" onClick={() => runCommand('edit.delete')}><Trash size={16} /> Delete</Act>
      <Act data-testid="m-clear" aria-label="Clear selection" onClick={() => runCommand('edit.escape')}><X size={16} /> Clear</Act>
    </div>
  )
}

/** Number box for the value being typed while drawing (a length, an angle, a diameter): opens the numeric keypad. */
function TypedValue() {
  const kb = useKbd()
  const ref = useRef<HTMLInputElement>(null)
  const draft = useSketch((s) => s.draft)
  const offset = useSketch((s) => s.offset)
  const typed = useSketch((s) => s.typed)
  void draft; void offset; void typed
  const info = typedInfo()
  if (!info || (!draft && !offset)) return null
  return (
    <div className="m-typed">
      <label>
        <span>{info.label}{info.unit === 'deg' ? ' (deg)' : ''}</span>
        <input
          ref={ref} data-testid="m-typed-input" inputMode={kb.mode} enterKeyHint="done" spellCheck={false} placeholder="type a value" value={info.text}
          onChange={(e) => setTypedText(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); acceptTyped() } }}
        />
      </label>
      <KbdToggle mode={kb.mode} onToggle={() => kb.toggle(ref)} />
      {info.count > 1 && <Act aria-label="Next value" onClick={nextTypedField}>Next</Act>}
      <Act className="m-act primary" data-testid="m-typed-ok" onClick={acceptTyped}><Check size={16} /> Place</Act>
    </div>
  )
}

/** Create Sketch asks for a plane: the three origin planes are one tap away (a face of a body works too, by tapping it). */
function PlanePickBar() {
  const picking = useSketchPick((s) => s.picking)
  if (!picking) return null
  const go = (name: 'XY' | 'XZ' | 'YZ') => { if (beginFromSelection({ kind: 'plane', id: 'plane' + name })) stopPicking() }
  return (
    <div className="m-actions" data-testid="m-planebar">
      <span className="m-count">Sketch on</span>
      {(['XY', 'XZ', 'YZ'] as const).map((n) => <button key={n} type="button" className="m-act" data-testid={'m-plane-' + n} onClick={() => go(n)}>{n}</button>)}
      <span className="grow" />
      <button type="button" className="m-act" data-testid="m-plane-cancel" onClick={() => runCommand('edit.escape')}><X size={16} /> Cancel</button>
    </div>
  )
}

/** While sketching: the keys the keyboard has (Esc, Enter, Delete, undo) as buttons, and Cancel / Finish. */
function SketchActions() {
  const active = useSketch((s) => s.active)
  const hasSel = useSketch((s) => s.sel.length > 0)
  const inspector = useUi((s) => !!s.inspector)
  const info = useSketch((s) => s.info)
  const profiles = useSketch((s) => s.profiles.length)
  const hasDraft = useSketch((s) => !!s.draft || s.picks.length > 0 || !!s.offset)
  const dimEdit = useSketch((s) => s.dimEdit)
  if (!active || inspector) return null
  const state = info.ok ? (info.dof === 0 ? 'Fully constrained' : 'Under-constrained') : 'Conflict'
  return (
    <div className="m-sk" data-testid="m-sketch-actions">
      <TypedValue />
      <div className="m-sk-info">{state} · {profiles} profile{profiles === 1 ? '' : 's'}</div>
      <div className="m-actions">
        <Act data-testid="m-undo-point" onClick={undoPoint}><ArrowCounterClockwise size={16} /> Undo point</Act>
        <Act data-testid="m-sk-done" disabled={!!dimEdit} onClick={enterSketch}><Check size={16} /> {hasDraft ? 'End' : 'Done'}</Act>
        {hasSel && <Act className="m-act danger" data-testid="m-sk-delete" onClick={deleteSelection}><Trash size={16} /> Delete</Act>}
        <span className="grow" />
        <Act data-testid="m-sk-cancel" onClick={cancelSketch}><X size={16} /> Cancel</Act>
        <Act className="m-act primary" data-testid="m-sk-finish" onClick={finishSketch}><Check size={16} /> Finish</Act>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the layout

export function MobileLayout() {
  const { groups: all } = useRibbonTab()
  // (the File menu is in the top bar: its buttons would only push the tools out of the strip)
  const groups = all.filter((g) => g.label !== 'File')
  const inspector = useUi((s) => !!s.inspector)
  const sketching = useUi((s) => s.sketchMode)
  useEffect(() => watchKeyboard(), [])
  // a dialog or a sketch asks for the whole screen: the side sheets get out of its way
  useEffect(() => { if (inspector || sketching) useMobile.getState().closeAll() }, [inspector, sketching])
  return (
    <>
      <div className="m-head" data-testid="mobile-layout" data-inspector={inspector}>
        <TopBar />
        <div className="m-strip" data-testid="m-strip"><RibbonGroups groups={groups} /></div>
      </div>
      <div className="m-vp">
        <ErrorBoundary name="Viewport"><Viewport /></ErrorBoundary>
        <PreviewBanner />
        <SelectionBar />
        <SketchActions />
        <PlanePickBar />
      </div>
      <StatusBar />
      <LeftSheet />
      <TimelineSheet />
      <InspectorSheet />
    </>
  )
}
