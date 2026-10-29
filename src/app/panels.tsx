/** Extra dockable panels (History, Projects, Plugins, Script): registered here, opened with openPanel(id) from a command. */
import type { DockviewApi, IDockviewPanelProps } from 'dockview-react'
import type { FC, ReactNode } from 'react'
import { ErrorBoundary } from '@/ui/ErrorBoundary'
import { isCompact } from './device'
import { useMobile } from './mobileStore'

export interface PanelDef {
  id: string
  title: string
  render: () => ReactNode
  /** open as a floating window of this size instead of a tab beside the Browser */
  floating?: { width: number; height: number }
}

const defs = new Map<string, PanelDef>()
let dock: DockviewApi | null = null

export function registerPanel(def: PanelDef) {
  defs.set(def.id, def)
}
export const setPanelDock = (api: DockviewApi | null) => { dock = api }

/** Dockview components for every registered panel. */
export function panelComponents(): Record<string, FC<IDockviewPanelProps>> {
  const out: Record<string, FC<IDockviewPanelProps>> = {}
  for (const d of defs.values()) out[d.id] = () => <ErrorBoundary name={d.title}>{d.render()}</ErrorBoundary>
  return out
}

/** Show the panel: bring it forward when it is open, otherwise add it. */
export function openPanel(id: string) {
  const def = defs.get(id)
  if (!def) return
  // the phone layout has no dock: the panel opens in the left sheet beside the Browser
  if (isCompact() || !dock) return useMobile.getState().openLeft(id)
  const existing = dock.getPanel(id)
  if (existing) {
    existing.api.setActive()
    return
  }
  if (def.floating) {
    const w = def.floating.width, h = def.floating.height
    dock.addPanel({ id, component: id, title: def.title, floating: { width: w, height: h, x: Math.max(40, (dock.width - w) / 2), y: Math.max(40, (dock.height - h) / 3) } })
  } else {
    const ref = dock.getPanel('browser')
    dock.addPanel({ id, component: id, title: def.title, ...(ref ? { position: { referencePanel: ref } } : {}) })
  }
}

export const isPanelOpen = (id: string) => (dock ? !!dock.getPanel(id) : useMobile.getState().left === id)

/** The registered extra panels, for the phone layout's left sheet. */
export const panelDefs = () => [...defs.values()]
export const renderPanel = (id: string) => {
  const d = defs.get(id)
  return d ? <ErrorBoundary name={d.title}>{d.render()}</ErrorBoundary> : null
}
