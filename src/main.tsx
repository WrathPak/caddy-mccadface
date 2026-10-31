import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './app/global.css'
import './app/mobile.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './app/commands'
import './app/docCommands'
import './help/commands'
import { startSettings } from './settings/settings'
import { startDevice } from './app/device'
import { App } from './app/App'
import { installDebugHandle } from './app/debug'
import { DEBUG_HANDLE } from './app/flags'
import { markUpdateReady, setUpdater, watchForTakeover, watchForUpdates } from './app/updates'

// the service worker would cache across e2e runs and is pointless in dev.
// A new version waits (registerType 'prompt'): the status bar offers it, and nothing reloads or swaps the page until that is clicked
if (import.meta.env.PROD && !DEBUG_HANDLE) {
  setUpdater(registerSW({
    immediate: true,
    onNeedRefresh: markUpdateReady,
    onRegisteredSW: (_url, reg) => { if (reg) watchForUpdates(reg) },
  }))
  watchForTakeover()
}
if (DEBUG_HANDLE) installDebugHandle()
document.documentElement.dataset.theme = 'dark'
startDevice()
startSettings()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
