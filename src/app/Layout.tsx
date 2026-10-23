import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { SquaresFour } from '@phosphor-icons/react'
import { BrowserTree } from '@/ui/BrowserTree'
import { Inspector } from '@/ui/Inspector'
import { Timeline } from '@/ui/Timeline'
import { ErrorBoundary } from '@/ui/ErrorBoundary'
import { Viewport } from '@/viewport/Viewport'
import { registerCommand } from './commands'

const components = {
  browser: (_: IDockviewPanelProps) => <ErrorBoundary name="Browser"><BrowserTree /></ErrorBoundary>,
  inspector: (_: IDockviewPanelProps) => <ErrorBoundary name="Inspector"><Inspector /></ErrorBoundary>,
  timeline: (_: IDockviewPanelProps) => <ErrorBoundary name="Timeline"><Timeline /></ErrorBoundary>,
  viewport: (_: IDockviewPanelProps) => <ErrorBoundary name="Viewport"><Viewport /></ErrorBoundary>,
}

/** Fusion-like proportions: slim side panels, thin timeline strip. */
const SIDE_W = 264
const TIMELINE_H = 76
const LAYOUT_KEY = 'caddy-layout-v1'
const PANEL_IDS = ['viewport', 'browser', 'inspector', 'timeline']

let dock: DockviewApi | null = null

function applyChrome(api: DockviewApi) {
  const pin = (id: string, c: { minimumWidth?: number; maximumWidth?: number; minimumHeight?: number; maximumHeight?: number }) =>
    api.getPanel(id)?.group.api.setConstraints(c)
  pin('browser', { minimumWidth: 200, maximumWidth: 480 })
  pin('inspector', { minimumWidth: 220, maximumWidth: 480 })
  pin('timeline', { minimumHeight: 56, maximumHeight: 120 })
  // the viewport and the timeline are single-purpose: no tab strip
  for (const id of ['viewport', 'timeline']) {
    const g = api.getPanel(id)?.group
    if (g) g.header.hidden = true
  }
}

function buildDefault(api: DockviewApi) {
  const vp = api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport' })
  api.addPanel({ id: 'browser', component: 'browser', title: 'Browser', initialWidth: SIDE_W, position: { referencePanel: vp, direction: 'left' } })
  api.addPanel({ id: 'inspector', component: 'inspector', title: 'Inspector', initialWidth: SIDE_W, position: { referencePanel: vp, direction: 'right' } })
  api.addPanel({ id: 'timeline', component: 'timeline', title: 'Timeline', initialHeight: TIMELINE_H, position: { referencePanel: vp, direction: 'below' } })
  applyChrome(api)
  const size = () => {
    api.getPanel('browser')?.api.setSize({ width: SIDE_W })
    api.getPanel('inspector')?.api.setSize({ width: SIDE_W })
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

function onReady(e: DockviewReadyEvent) {
  dock = e.api
  if (!restore(e.api)) buildDefault(e.api)
  let t: ReturnType<typeof setTimeout> | undefined
  e.api.onDidLayoutChange(() => {
    clearTimeout(t)
    t = setTimeout(() => {
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON())) } catch { /* storage unavailable */ }
    }, 300)
  })
}

export function Layout() {
  return <DockviewReact className="dockview-theme-caddy" components={components} onReady={onReady} />
}
