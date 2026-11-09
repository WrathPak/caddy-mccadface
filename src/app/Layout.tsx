import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { SquaresFour } from '@phosphor-icons/react'
import { BrowserTree } from '@/ui/BrowserTree'
import { PrintSidebar } from '@/features/print/plate/Sidebar'
import { useUi } from '@/store/ui'
import { Inspector } from '@/ui/Inspector'
import { Timeline } from '@/ui/Timeline'
import { ViewToolbar } from '@/viewport/ViewToolbar'
import { ErrorBoundary } from '@/ui/ErrorBoundary'
import { setInsets } from '@/viewport/visible'
import { registerCommand } from './commands'
import { panelComponents, setPanelDock } from './panels'

/**
 * The viewport panel is a window onto the 3D view that runs behind the whole dock. It draws nothing and takes no clicks; it measures
 * itself and publishes how far its edges are from the window's (--in-t/r/b/l), so the view cube, toolbars and sketch bars that belong
 * in the visible area sit clear of the panels floating over the rest of the view.
 */
function ViewportHole() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement.style
    const set = (k: string, v: number) => root.setProperty(k, Math.max(0, Math.round(v)) + 'px')
    const measure = () => {
      const stage = document.querySelector('.stage')?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      const r = el.getBoundingClientRect()
      set('--in-l', r.left - stage.left)
      set('--in-t', r.top - stage.top)
      set('--in-r', stage.right - r.right)
      set('--in-b', stage.bottom - r.bottom)
      setInsets({ l: Math.max(0, r.left - stage.left), t: Math.max(0, r.top - stage.top), r: Math.max(0, stage.right - r.right), b: Math.max(0, stage.bottom - r.bottom) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const stage = document.querySelector('.stage')
    if (stage) ro.observe(stage)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      for (const k of ['--in-t', '--in-r', '--in-b', '--in-l']) root.removeProperty(k)
      setInsets({ l: 0, t: 0, r: 0, b: 0 })
    }
  }, [])
  return <div className="vp-hole" ref={ref} />
}

function BrowserOrPrint() {
  const printing = useUi((s) => s.workspace === 'print')
  return printing
    ? <ErrorBoundary name="Print setup"><PrintSidebar /></ErrorBoundary>
    : <ErrorBoundary name="Browser"><BrowserTree /></ErrorBoundary>
}

const baseComponents = {
  // the Print workspace swaps the Browser for its own setup sidebar (printer, filaments, process, objects)
  browser: (_: IDockviewPanelProps) => <BrowserOrPrint />,
  inspector: (_: IDockviewPanelProps) => <ErrorBoundary name="Inspector"><Inspector /></ErrorBoundary>,
  // one slim glass bar along the bottom: the view controls, then the feature timeline
  timeline: (_: IDockviewPanelProps) => <ErrorBoundary name="Timeline"><div className="panel bottom-dock"><ViewToolbar /><span className="dock-sep" /><Timeline /></div></ErrorBoundary>,
  viewport: (_: IDockviewPanelProps) => <ViewportHole />,
}

/** Fusion-like proportions: slim side panels, thin timeline strip. */
/** Slim side panels; on a narrow window they are narrower still, so the view between them keeps some width. */
const sideWidth = (inspector = false) => (typeof window !== 'undefined' && window.innerWidth < 1100 ? (inspector ? 268 : 232) : inspector ? 284 : 258)
const TIMELINE_H = 66
const LAYOUT_KEY = 'caddy-layout-v1'
const PANEL_IDS = ['viewport', 'browser', 'inspector', 'timeline']

let dock: DockviewApi | null = null

function applyChrome(api: DockviewApi) {
  const pin = (id: string, c: { minimumWidth?: number; maximumWidth?: number; minimumHeight?: number; maximumHeight?: number }) =>
    api.getPanel(id)?.group.api.setConstraints(c)
  pin('browser', { minimumWidth: 200, maximumWidth: 460 })
  pin('inspector', { minimumWidth: 220, maximumWidth: 460 })
  pin('timeline', { minimumHeight: 56, maximumHeight: 110 })
  // the viewport and the timeline are single-purpose: no tab strip
  for (const id of ['viewport', 'timeline']) {
    const g = api.getPanel(id)?.group
    if (g) g.header.hidden = true
  }
}

function buildDefault(api: DockviewApi) {
  const vp = api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport' })
  api.addPanel({ id: 'browser', component: 'browser', title: 'Browser', initialWidth: sideWidth(), position: { referencePanel: vp, direction: 'left' } })
  api.addPanel({ id: 'inspector', component: 'inspector', title: 'Inspector', initialWidth: sideWidth(true), position: { referencePanel: vp, direction: 'right' } })
  api.addPanel({ id: 'timeline', component: 'timeline', title: 'Timeline', initialHeight: TIMELINE_H, position: { referencePanel: vp, direction: 'below' } })
  applyChrome(api)
  const size = () => {
    api.getPanel('browser')?.api.setSize({ width: sideWidth() })
    api.getPanel('inspector')?.api.setSize({ width: sideWidth(true) })
    api.getPanel('timeline')?.api.setSize({ height: TIMELINE_H })
  }
  size()
  requestAnimationFrame(size)
}

function restore(api: DockviewApi): boolean {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return false
    api.fromJSON(JSON.parse(raw))
    if (!PANEL_IDS.every((id) => api.getPanel(id))) throw new Error('layout is missing panels')
    applyChrome(api)
    return true
  } catch (e) {
    console.warn('[layout] could not restore saved layout, using default', e)
    try { localStorage.removeItem(LAYOUT_KEY) } catch { /* storage unavailable */ }
    api.clear()
    return false
  }
}

export function resetLayout() {
  if (!dock) return
  try { localStorage.removeItem(LAYOUT_KEY) } catch { /* storage unavailable */ }
  dock.clear()
  buildDefault(dock)
}

registerCommand({ id: 'view.resetLayout', label: 'Reset Layout', icon: SquaresFour, category: 'View', run: resetLayout })

let saveTimer: ReturnType<typeof setTimeout> | undefined
let leaving = false

function onReady(e: DockviewReadyEvent) {
  dock = e.api
  setPanelDock(e.api)
  if (!restore(e.api)) buildDefault(e.api)
  e.api.onDidLayoutChange(() => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      // (the dock may have been taken down by then: the phone layout replaces it)
      if (dock !== e.api) return
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON())) } catch { /* storage unavailable */ }
    }, 300)
  })
}

export function Layout() {
  const components = useMemo(() => ({ ...baseComponents, ...panelComponents() }), [])
  // the setup sidebar of the Print workspace is wider than the Browser, and the tab says so
  const printing = useUi((s) => s.workspace === 'print')
  // nothing is shown in the Inspector column while Print has no dialog open: that width goes back to the view
  const inspecting = useUi((s) => !!s.inspector)
  useEffect(() => {
    const g = dock?.getPanel('inspector')?.group
    if (g) g.api.setVisible(!(printing && !inspecting))
    return () => { dock?.getPanel('inspector')?.group.api.setVisible(true) }
  }, [printing, inspecting])
  const widthBefore = useRef<number | null>(null)
  useEffect(() => {
    const p = dock?.getPanel('browser')
    if (!p) return
    if (printing) {
      widthBefore.current = p.api.width
      p.api.setTitle('Print')
      p.api.setSize({ width: Math.max(p.api.width, 340) })
    } else if (widthBefore.current !== null) {
      // back from Print: the Browser has the width it had (the saved layout stays as it was)
      p.api.setTitle('Browser')
      p.api.setSize({ width: widthBefore.current })
      widthBefore.current = null
    }
  }, [printing])
  // switching to the phone layout takes the dock down: forget it, and the layout it saved last stays for the way back
  // (development's StrictMode takes an effect down and sets it up again at once: only a take-down that stays counts)
  useEffect(() => {
    leaving = false
    return () => {
      leaving = true
      setTimeout(() => { if (leaving) { clearTimeout(saveTimer); dock = null; setPanelDock(null) } }, 0)
    }
  }, [])
  return <DockviewReact className="dockview-theme-caddy" components={components} onReady={onReady} />
}
