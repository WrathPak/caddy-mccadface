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

export function App() {
  useEffect(() => installShortcuts(), [])
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
