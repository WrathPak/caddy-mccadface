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
import { markOfflineReady, startInstall } from './app/install'
import { newVersionWaiting, setUpdater, watchForTakeover, watchForUpdates } from './app/updates'

// the service worker would cache across e2e runs and is pointless in dev.
// A new version waits (registerType 'prompt'): the status bar offers it, and nothing reloads or swaps the page until that is clicked
if (import.meta.env.PROD && !DEBUG_HANDLE) {
  let reg: ServiceWorkerRegistration | undefined
  const updateSW = registerSW({
    immediate: true,
    onOfflineReady: markOfflineReady,
    onNeedRefresh: () => newVersionWaiting({ controlled: !!navigator.serviceWorker.controller }),
    onRegisteredSW: (_url, r) => { reg = r; if (r) watchForUpdates(r) },
  })
  setUpdater(async (reload = true) => {
    const waiting = reg?.waiting
    await updateSW(reload)
    if (!reload) return
    // the plugin only reloads on 'controlling', which a page the old worker never controlled (a hard refresh) does not get:
    // reload here once the new worker is active, so a click always lands on the new version
    await new Promise<void>((res) => {
      if (!waiting || waiting.state === 'activated') return res()
      const t = setTimeout(res, 4000)
      waiting.addEventListener('statechange', () => { if (waiting.state === 'activated') { clearTimeout(t); res() } })
    })
    window.location.reload()
  })
  watchForTakeover()
}
startInstall()
if (DEBUG_HANDLE) installDebugHandle()
document.documentElement.dataset.theme = 'dark'
startDevice()
startSettings()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
