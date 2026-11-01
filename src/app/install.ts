/**
 * Installing the app (the PWA): its own window and icon, and it opens with no network at all.
 *
 * Chrome and Edge fire `beforeinstallprompt` when the app can be installed. The event is kept, the browser's own mini bar is held
 * back, and our Install button (Settings, the command, the one-time card) shows the browser's install dialog from it.
 * Safari and Firefox never fire it: there the install is done from the browser's own menu, and `installHow` says where.
 *
 * Offline works whether or not the app is installed: the service worker keeps every file of the app once it has loaded.
 */
import { create } from 'zustand'

/** Chrome's event: not in the TS DOM lib yet. */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface InstallState {
  /** The browser can install the app right now, from our button. */
  prompt: InstallPromptEvent | null
  /** Running as the installed app (its own window), or installed during this visit. */
  installed: boolean
  /** Every file of the app is cached by the service worker: it opens and works with no network. */
  offlineReady: boolean
}
export const useInstall = create<InstallState>(() => ({ prompt: null, installed: false, offlineReady: false }))

function standalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches || window.matchMedia?.('(display-mode: window-controls-overlay)').matches
}

/** Called once, before React: the event can fire as soon as the page has loaded. */
export function startInstall() {
  useInstall.setState((s) => ({ installed: standalone(), offlineReady: s.offlineReady || !!navigator.serviceWorker?.controller }))
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    useInstall.setState({ prompt: e as InstallPromptEvent })
  })
  window.addEventListener('appinstalled', () => useInstall.setState({ installed: true, prompt: null }))
}

/** The service worker cached everything (vite-plugin-pwa's onOfflineReady), or a stand-in in the specs. */
export function markOfflineReady() { useInstall.setState({ offlineReady: true }) }

/** Show the browser's install dialog. Resolves true when the person installed it. */
export async function installApp(): Promise<boolean> {
  const p = useInstall.getState().prompt
  if (!p) return false
  // the event can only be used once, whatever the answer
  useInstall.setState({ prompt: null })
  await p.prompt()
  const { outcome } = await p.userChoice
  if (outcome === 'accepted') useInstall.setState({ installed: true })
  return outcome === 'accepted'
}

/** Where the install lives in a browser that has no install event, or null when the browser cannot install at all. */
export function installHow(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string | null {
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
  if (ios) return 'In Safari, tap Share, then Add to Home Screen.'
  if (/Firefox\//.test(ua)) return /Android/.test(ua) ? 'Open the Firefox menu, then Install.' : null
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'In Safari, open the File menu, then Add to Dock.'
  if (/Edg\//.test(ua)) return 'Open the Edge menu (...), then Apps, then Install this site as an app.'
  if (/Chrome\//.test(ua)) return 'Use the install icon at the right end of the address bar, or the Chrome menu, then Cast, save and share, then Install page as app.'
  return null
}
