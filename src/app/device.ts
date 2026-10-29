/**
 * What kind of screen this is. `compact` picks the phone layout (no dockview, sheets instead of side panels); `coarse` is a
 * touch screen, which gets the bigger tap sizes and the finger tools. Both follow the screen live (rotate, resize, plug in a mouse).
 */
import { create } from 'zustand'

/** Narrower than this, or a phone held sideways (short and touch): the phone layout. */
export const COMPACT_QUERY = '(max-width: 800px), (max-height: 520px) and (pointer: coarse)'
const COARSE_QUERY = '(pointer: coarse)'

const mq = (q: string) => {
  try { return typeof window !== 'undefined' && !!window.matchMedia?.(q).matches } catch { return false }
}

interface Device { compact: boolean; coarse: boolean }
export const useDevice = create<Device>(() => ({ compact: mq(COMPACT_QUERY), coarse: mq(COARSE_QUERY) }))

export const isCoarse = () => useDevice.getState().coarse
export const isCompact = () => useDevice.getState().compact

function apply() {
  const next = { compact: mq(COMPACT_QUERY), coarse: mq(COARSE_QUERY) }
  const cur = useDevice.getState()
  if (cur.compact !== next.compact || cur.coarse !== next.coarse) useDevice.setState(next)
  const root = document.documentElement
  root.dataset.compact = String(next.compact)
  root.dataset.coarse = String(next.coarse)
}

let started = false
/** Listen to the screen. Call once at startup. */
export function startDevice() {
  if (started || typeof window === 'undefined') return
  started = true
  apply()
  try {
    for (const q of [COMPACT_QUERY, COARSE_QUERY]) window.matchMedia(q).addEventListener('change', apply)
  } catch { /* no matchMedia: the desktop layout stays */ }
  window.addEventListener('resize', apply)
}

/**
 * Keep `--kb` (the height the on-screen keyboard covers) and `--vvh` up to date. Chrome resizes the page for the keyboard, iOS
 * Safari only shrinks the visual viewport; the Inspector sheet sits above `--kb` so OK / Cancel stay reachable on both.
 */
export function watchKeyboard() {
  const vv = window.visualViewport
  if (!vv) return () => {}
  const root = document.documentElement
  const set = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
    root.style.setProperty('--kb', kb > 60 ? `${kb}px` : '0px')
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
  }
  set()
  vv.addEventListener('resize', set)
  vv.addEventListener('scroll', set)
  return () => { vv.removeEventListener('resize', set); vv.removeEventListener('scroll', set) }
}
