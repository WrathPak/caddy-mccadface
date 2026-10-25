import { useEffect } from 'react'
import { Ribbon } from '@/ui/Ribbon'
import { StatusBar } from '@/ui/StatusBar'
import { CommandPalette } from '@/ui/CommandPalette'
import { TooltipProvider } from '@/ui/Tooltip'
import { Layout } from './Layout'
import { installShortcuts } from './shortcuts'
import { DocUi } from '@/ui/DocUi'
import { Toast } from '@/ui/Modal'
import { NoteDialog, PreviewBanner } from '@/history/HistoryUi'
import { initPlugins } from '@/api/pluginStore'
import { watchExternals } from '@/assembly/external'

export function App() {
  useEffect(() => installShortcuts(), [])
  useEffect(() => watchExternals(), [])
  useEffect(() => { void initPlugins() }, [])
  return (
    <TooltipProvider>
      <div className="app">
        <Ribbon />
        <div style={{ minHeight: 0, position: 'relative' }}>
          <Layout />
          <PreviewBanner />
        </div>
        <StatusBar />
        <CommandPalette />
        <DocUi />
        <NoteDialog />
        <Toast />
      </div>
    </TooltipProvider>
  )
}
