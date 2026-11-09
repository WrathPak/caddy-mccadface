/**
 * Imported first by main.tsx. When this tab was working on a model (see io/session.ts), the kernel worker is started and its WASM
 * compiled while the rest of the app is still being evaluated: a reload then does not wait for the kernel after the page is up.
 * Nothing happens for a tab with no model, so an empty page does not pay for a kernel it may never use.
 */
import { getKernel } from './client'
import { WARM_KEY } from './warm'

try {
  if (sessionStorage.getItem(WARM_KEY) === '1') void getKernel().init().catch(() => {})
} catch { /* no sessionStorage, or no worker: the kernel starts when it is first needed */ }
