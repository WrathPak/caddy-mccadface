import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './app/global.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './app/commands'
import './app/docCommands'
import { App } from './app/App'
import { installDebugHandle } from './app/debug'

// the service worker would cache across e2e runs and is pointless in dev
if (import.meta.env.PROD) registerSW({ immediate: true })
if (import.meta.env.DEV) installDebugHandle()
document.documentElement.dataset.theme = 'dark'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
