/** User presets: a name and the changed keys on top of a system preset, kept in this browser (idb-keyval) like Orca's "User presets". */
import { get, set } from 'idb-keyval'
import type { ConfigPatch, PresetScope } from '@muon3d/slicer-engine-protocol'
import { create } from 'zustand'
import type { UserRef } from './profile'

export interface UserPreset { id: string; type: PresetScope; name: string; vendor: string; /** the system preset it is built on */ inherits: string; keys: ConfigPatch }

const KEY = 'caddy.slicer.userPresets'

interface State { presets: UserPreset[]; loaded: boolean }
export const useUserPresets = create<State>(() => ({ presets: [], loaded: false }))

const persist = () => { void set(KEY, useUserPresets.getState().presets).catch(() => {}) }

export async function loadUserPresets() {
  if (useUserPresets.getState().loaded) return
  try {
    const p = await get<UserPreset[]>(KEY)
    useUserPresets.setState({ presets: Array.isArray(p) ? p : [], loaded: true })
  } catch {
    useUserPresets.setState({ loaded: true })
  }
}

export const refOf = (p: UserPreset): UserRef => ({ id: p.id, name: p.name, keys: p.keys })

/** Save (or replace, when the name exists for that type and printer vendor) a preset. */
export function saveUserPreset(type: PresetScope, name: string, vendor: string, inherits: string, keys: ConfigPatch): UserPreset {
  const list = useUserPresets.getState().presets
  const same = list.find((p) => p.type === type && p.name === name && p.vendor === vendor)
  const preset: UserPreset = { id: same?.id ?? `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, type, name, vendor, inherits, keys }
  useUserPresets.setState({ presets: same ? list.map((p) => (p === same ? preset : p)) : [...list, preset] })
  persist()
  return preset
}

export function renameUserPreset(id: string, name: string) {
  useUserPresets.setState((s) => ({ presets: s.presets.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)) }))
  persist()
}

export function deleteUserPreset(id: string) {
  useUserPresets.setState((s) => ({ presets: s.presets.filter((p) => p.id !== id) }))
  persist()
}
