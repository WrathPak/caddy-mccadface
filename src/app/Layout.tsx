import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { BrowserTree } from '@/ui/BrowserTree'
import { Inspector } from '@/ui/Inspector'
import { Timeline } from '@/ui/Timeline'
import { Viewport } from '@/viewport/Viewport'

const components = {
  browser: (_: IDockviewPanelProps) => <BrowserTree />,
  inspector: (_: IDockviewPanelProps) => <Inspector />,
  timeline: (_: IDockviewPanelProps) => <Timeline />,
  viewport: (_: IDockviewPanelProps) => <Viewport />,
}

function onReady(e: DockviewReadyEvent) {
  const vp = e.api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport' })
  const browser = e.api.addPanel({ id: 'browser', component: 'browser', title: 'Browser', position: { referencePanel: vp, direction: 'left' } })
  const inspector = e.api.addPanel({ id: 'inspector', component: 'inspector', title: 'Inspector', position: { referencePanel: vp, direction: 'right' } })
  const timeline = e.api.addPanel({ id: 'timeline', component: 'timeline', title: 'Timeline', position: { referencePanel: vp, direction: 'below' } })
  browser.api.setSize({ width: 232 })
  inspector.api.setSize({ width: 280 })
  timeline.api.setSize({ height: 58 })
  vp.group.header.hidden = true
}

export function Layout() {
  return <DockviewReact className="dockview-theme-weeb" components={components} onReady={onReady} />
}
