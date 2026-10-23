/** Navigation preferences: which mouse / trackpad gestures orbit, pan and zoom. Persisted in localStorage. */
import { create } from 'zustand'

export type NavPreset = 'fusion' | 'solidworks' | 'blender' | 'touchpad'

export const NAV_PRESETS: { id: NavPreset; label: string; help: string }[] = [
  { id: 'fusion', label: 'Fusion', help: 'Middle mouse button pans, Shift + middle button orbits, wheel zooms.' },
  { id: 'solidworks', label: 'SolidWorks / Onshape', help: 'Middle mouse button orbits, Ctrl + middle button pans, wheel zooms.' },
  { id: 'blender', label: 'Blender', help: 'Middle mouse button orbits, Shift + middle button pans, Ctrl + middle button zooms, wheel zooms.' },
  { id: 'touchpad', label: 'Touchpad', help: 'Two-finger scroll pans, Shift + two-finger scroll orbits, pinch zooms. Alt + drag orbits, Alt + Shift + drag pans.' },
]

const KEY = 'caddy.nav'

interface Saved { preset: NavPreset; inertia: boolean }
const DEFAULTS: Saved = { preset: 'fusion', inertia: false }

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const v = JSON.parse(raw) as Partial<Saved>
    return {
      preset: NAV_PRESETS.some((p) => p.id === v.preset) ? (v.preset as NavPreset) : DEFAULTS.preset,
      inertia: v.inertia === true,
    }
  } catch {
    return DEFAULTS
  }
}

interface NavSettings extends Saved {
  setPreset: (p: NavPreset) => void
  setInertia: (on: boolean) => void
}

export const useNavSettings = create<NavSettings>((set, get) => {
  const save = () => {
    const { preset, inertia } = get()
    try { localStorage.setItem(KEY, JSON.stringify({ preset, inertia })) } catch { /* private mode / blocked storage: the setting just lasts for this session */ }
  }
  return {
    ...load(),
    setPreset: (preset) => { set({ preset }); save() },
    setInertia: (inertia) => { set({ inertia }); save() },
  }
})

export type NavAction = 'orbit' | 'pan' | 'zoom' | null

/** What a pointer drag does under a preset (middle button, or Alt + left button on the touchpad preset). */
export function dragAction(preset: NavPreset, e: { button: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean }): NavAction {
  if (e.button === 0) {
    if (preset === 'touchpad' && e.altKey) return e.shiftKey ? 'pan' : 'orbit'
    return null
  }
  if (e.button !== 1) return null
  switch (preset) {
    case 'solidworks': return e.ctrlKey ? 'pan' : e.shiftKey ? 'zoom' : 'orbit'
    case 'blender': return e.ctrlKey ? 'zoom' : e.shiftKey ? 'pan' : 'orbit'
    default: return e.ctrlKey ? 'zoom' : e.shiftKey ? 'orbit' : 'pan'
  }
}

/** What a wheel / trackpad scroll event does. Pinch gestures arrive as wheel events with ctrlKey set. */
export function wheelAction(preset: NavPreset, e: { ctrlKey: boolean; shiftKey: boolean }): 'zoom' | 'pan' | 'orbit' {
  if (e.ctrlKey) return 'zoom'
  if (preset !== 'touchpad') return 'zoom'
  return e.shiftKey ? 'orbit' : 'pan'
}
