import { useEffect } from 'react'
import { Ribbon } from '@/ui/Ribbon'
import { StatusBar } from '@/ui/StatusBar'
import { CommandPalette } from '@/ui/CommandPalette'
import { TooltipProvider } from '@/ui/Tooltip'
import { Layout } from './Layout'
import { MobileLayout } from './Mobile'
import { useDevice } from './device'
import { installShortcuts } from './shortcuts'
import { DocUi } from '@/ui/DocUi'
import { Toast } from '@/ui/Modal'
import { NoteDialog, PreviewBanner } from '@/history/HistoryUi'
import { initPlugins } from '@/api/pluginStore'
import { watchExternals } from '@/assembly/external'
import { HelpDialog } from '@/help/HelpDialog'
import { SettingsDialog } from '@/ui/SettingsDialog'
import { Tour } from '@/help/Tour'
import { useHelp } from '@/help/helpStore'
import { useSettings } from '@/settings/settings'

/** The intro tour runs once, on a first visit. Returning users (a saved layout exists) and the e2e fixture never see it by themselves. */
function useFirstRunTour() {
  useEffect(() => {
    // (the tour points at the desktop panels: the phone layout skips it)
    if ((window as unknown as { __e2eNoTour?: boolean }).__e2eNoTour || useSettings.getState().tourSeen || useDevice.getState().compact) return
    let returning = false
    try { returning = !!localStorage.getItem('caddy-layout-v1') } catch { /* storage unavailable */ }
    if (returning) return useSettings.getState().setTourSeen(true)
    const t = setTimeout(() => { if (!useSettings.getState().tourSeen) useHelp.getState().startTour() }, 700)
    return () => clearTimeout(t)
  }, [])
}

export function App() {
  useEffect(() => installShortcuts(), [])
  useEffect(() => watchExternals(), [])
  useEffect(() => { void initPlugins() }, [])
  useFirstRunTour()
  // the phone layout replaces the dock; crossing the line (rotate, resize) swaps one for the other, the document lives in the stores
  const compact = useDevice((s) => s.compact)
  return (
    <TooltipProvider>
      <div className={'app' + (compact ? ' m-app' : '')}>
        {compact ? (
          <MobileLayout />
        ) : (
          <>
            <Ribbon />
            <div style={{ minHeight: 0, position: 'relative' }}>
              <Layout />
              <PreviewBanner />
            </div>
            <StatusBar />
          </>
        )}
        <CommandPalette />
        <DocUi />
        <NoteDialog />
        <HelpDialog />
        <SettingsDialog />
        <Tour />
        <Toast />
      </div>
    </TooltipProvider>
  )
}
