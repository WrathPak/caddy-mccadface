/**
 * The Slice panel's logic: pick presets, edit settings through the engine's settings service, keep the document's profile
 * (and the quick values cached from it) in step, and save user presets. Edits run one at a time, in order.
 */
import type { ConfigPatch, PresetScope, SettingsInput, SettingsView } from '@muon3d/slicer-engine-protocol'
import { SettingsHost } from '../engine/muon'
import { machineGeometry, printerDefaults, resolveProfile, vendorOfMachine, loadProfileSet, type Resolved } from '../engine/profiles'
import { colorById } from '../palette'
import { computePaintMap, usedSlots } from '../paint'
import { currentSettings, writeProfile } from '../settings'
import { useDoc } from '@/doc/store'
import { compatiblePlate } from './plates'
import { applyWrites, withSlots, type SliceProfile, type UserRef } from './profile'
import { saveMode, useSlicer, type PresetScopeTab } from './store'
import { refOf, saveUserPreset, type UserPreset } from './userPresets'
import type { PanelMode } from './profile'

export const settingsHost = new SettingsHost()

/** Filament slots the plate uses (at least one). */
export function slotCount(): number {
  const d = useDoc.getState()
  const used = usedSlots(computePaintMap(d.features, d.rollback, d.geometry))
  // slots added in the Filaments list stay, painted or not
  return Math.max(1, ...used, currentSettings().profile.filaments.length)
}

export const slotColours = (): string[] => {
  const s = currentSettings()
  return Array.from({ length: Math.max(slotCount(), s.profile.filaments.length) }, (_, i) => colorById(s.slotColors[i] ?? 'white').hex.toUpperCase())
}

/** The document's profile with a filament entry for every slot of the plate. */
export const profileNow = (): SliceProfile => withSlots(currentSettings().profile, slotCount())

const firstNum = (v: string | string[] | undefined) => parseFloat(Array.isArray(v) ? v[0] : v ?? '')

/** The quick values the rest of the app reads, cached from the resolved presets. */
export function quickValues(r: Resolved) {
  const p = r.process
  const support = String(p.enable_support) === '1' ? (String(p.support_type).startsWith('tree') ? 'tree' : 'normal') : 'none'
  const brim = String(p.brim_type)
  return {
    layerHeight: firstNum(p.layer_height) || 0.2,
    firstLayerHeight: firstNum(p.initial_layer_print_height) || 0.2,
    wallLoops: firstNum(p.wall_loops) || 3,
    topLayers: firstNum(p.top_shell_layers) || 0,
    bottomLayers: firstNum(p.bottom_shell_layers) || 0,
    infill: firstNum(p.sparse_infill_density) || 0,
    infillPattern: String(Array.isArray(p.sparse_infill_pattern) ? p.sparse_infill_pattern[0] : p.sparse_infill_pattern ?? 'gyroid'),
    support,
    overhang: Math.min(85, Math.max(5, 90 - (firstNum(p.support_threshold_angle) || 45))),
    brim: brim === 'no_brim' ? 'none' : brim === 'outer_only' ? 'outer' : 'auto',
  }
}

let queue: Promise<unknown> = Promise.resolve()
/** Run `fn` after every earlier edit has finished; errors are reported in the panel, not thrown. */
function serial<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const next = queue.then(fn, fn).catch((e: unknown) => {
    useSlicer.getState().set({ error: e instanceof Error ? e.message : String(e) })
    return undefined
  })
  queue = next
  return next
}

let lastKey = ''
const keyOf = () => JSON.stringify([currentSettings().profile, currentSettings().slotColors])

/** The profile changed outside the panel (undo, redo, another document): read the presets again. */
export function syncFromDoc() {
  const k = keyOf()
  if (k === lastKey) return
  lastKey = k
  void refreshAll()
}

/** Resolve the presets, refresh the panel's state and write the profile (with the cached quick values) into the document. */
async function commit(next: SliceProfile, label: string) {
  const r = await resolveProfile(next, slotColours())
  const geo = next.machine !== currentSettings().profile.machine ? await machineGeometry(next.vendor, next.machine) : null
  // a plate the printer does not offer falls back to the printer's default
  const kept = { ...next, bedType: r.plate && next.bedType === r.plate.current ? next.bedType : '' }
  const profile = geo ? { ...kept, bed: geo.bed, height: geo.height, nozzle: geo.nozzle } : kept
  writeProfile(profile, quickValues(r), label)
  lastKey = keyOf()
  useSlicer.getState().set({ resolved: r, error: null })
  await loadViews()
}

// ---- views

function input(scope: PresetScope | 'object', r: Resolved, p: SliceProfile, objectId?: string | null): SettingsInput {
  const slot = Math.min(useSlicer.getState().slot, r.base.filaments.length - 1)
  return {
    presets: {
      machine: { hash: '', config: r.base.machine },
      process: { hash: '', config: r.base.process },
      filament: { hash: '', config: r.base.filaments[slot] },
    },
    overrides: { machine: p.overrides.machine, process: p.overrides.process, filament: p.overrides.filaments[slot] ?? {} },
    ...(scope === 'object' ? { object: p.objects[objectId ?? ''] ?? {} } : {}),
    env: { mode: useSlicer.getState().mode, vendor: p.vendor, filamentCount: r.filaments.length },
  }
}

let viewSeq = 0

/** Read the settings document of the open tab (and the object's, when the Objects tab is open). */
export function loadViews(): Promise<void> {
  const seq = ++viewSeq
  return (async () => {
    const st = useSlicer.getState()
    try {
      const p = profileNow()
      const r = st.resolved ?? (await resolveProfile(p, slotColours()))
      const client = await settingsHost.client()
      const scope: PresetScopeTab | null = st.tab === 'process' ? 'process' : st.tab === 'filament' ? 'filament' : st.tab === 'printer' ? 'machine' : st.tab === 'quick' ? 'process' : null
      let view: SettingsView | null = null
      let objectView: SettingsView | null = null
      if (scope) view = await client.view({ scope, ...fix(input(scope, r, p)), values: true, omit: scope === 'filament' ? ['filament_colour'] : [] } as never)
      if (st.tab === 'objects') objectView = await client.view({ scope: 'object', ...fix(input('object', r, p, st.objectId)), values: true } as never)
      if (seq !== viewSeq) return
      useSlicer.getState().set({ resolved: r, view, objectView, error: null })
    } catch (e) {
      if (seq === viewSeq) useSlicer.getState().set({ error: e instanceof Error ? e.message : String(e) })
    }
  })()
}

/** SettingsClient takes plain configs, not refs. */
function fix(i: SettingsInput) {
  return { ...i, presets: { machine: i.presets.machine.config, process: i.presets.process.config, filament: i.presets.filament.config } }
}

/** Resolve for the first time (or after the document was replaced) and read the open tab. */
export async function refreshAll() {
  lastKey = keyOf()
  await serial(async () => {
    const r = await resolveProfile(profileNow(), slotColours())
    useSlicer.getState().set({ resolved: r })
    await loadViews()
  })
}

/** Like syncFromDoc for the Print sidebar: presets only, no settings views (so the settings engine is not started for it). */
export function syncResolvedFromDoc() {
  const k = keyOf()
  if (k === lastKey && useSlicer.getState().resolved) return
  void refreshResolved()
}

/** Resolve the presets only (no settings views): what the Print sidebar needs to show them. */
export async function refreshResolved() {
  lastKey = keyOf()
  await serial(async () => {
    useSlicer.getState().set({ resolved: await resolveProfile(profileNow(), slotColours()) })
  })
}

// ---- picking presets

/** Choose a printer (and nozzle): its default process and filament; the person's process and filament overrides stay. */
export function setPrinter(machine: string) {
  return serial(async () => {
    const set = await loadProfileSet()
    const vendor = vendorOfMachine(set.index, machine)
    if (!vendor) throw new Error(`"${machine}" is not in the profile set`)
    const def = await printerDefaults(vendor, machine)
    const cur = profileNow()
    void def
    await commit({
      ...cur, vendor, machine, process: '', filaments: cur.filaments.map(() => ''),
      user: { filaments: cur.user.filaments.map(() => null) },
      overrides: { machine: {}, process: cur.overrides.process, filaments: cur.overrides.filaments },
    }, 'Choose printer')
  })
}

/** Choose the build plate (Orca's curr_bed_type). */
export function setBedType(plate: string) {
  return serial(async () => commit({ ...profileNow(), bedType: plate }, 'Choose build plate'))
}

/** Switch to a plate every filament of the plate can print on (the printer's default when it works). */
export function fixBedType() {
  return serial(async () => {
    const cur = profileNow()
    const r = useSlicer.getState().resolved ?? (await resolveProfile(cur, slotColours()))
    const to = r.plate ? compatiblePlate(r.plate, r.filaments) : null
    if (to) await commit({ ...cur, bedType: to }, 'Choose build plate')
  })
}

export function setProcess(name: string, user?: UserRef) {
  return serial(async () => {
    const cur = profileNow()
    await commit({ ...cur, process: name, user: { ...cur.user, process: user }, overrides: { ...cur.overrides, process: {} } }, 'Choose process preset')
  })
}

export function setFilament(slot: number, name: string, user?: UserRef) {
  return serial(async () => {
    const cur = profileNow()
    const filaments = cur.filaments.map((f, i) => (i === slot ? name : f))
    const users = cur.user.filaments.map((u, i) => (i === slot ? user ?? null : u))
    const ov = cur.overrides.filaments.map((o, i) => (i === slot ? {} : o))
    await commit({ ...cur, filaments, user: { ...cur.user, filaments: users }, overrides: { ...cur.overrides, filaments: ov } }, 'Choose filament preset')
  })
}

export function setMachineUser(user: UserRef | undefined) {
  return serial(async () => {
    const cur = profileNow()
    await commit({ ...cur, user: { ...cur.user, machine: user }, overrides: { ...cur.overrides, machine: {} } }, 'Choose printer preset')
  })
}

export function setMode(mode: PanelMode) {
  saveMode(mode)
  useSlicer.getState().set({ mode })
  return serial(loadViews)
}

// ---- editing settings

type Scope = PresetScope

function patchOf(p: SliceProfile, scope: Scope, slot: number): ConfigPatch {
  return scope === 'process' ? p.overrides.process : scope === 'machine' ? p.overrides.machine : p.overrides.filaments[slot] ?? {}
}
function withPatch(p: SliceProfile, scope: Scope, slot: number, patch: ConfigPatch): SliceProfile {
  if (scope === 'process') return { ...p, overrides: { ...p.overrides, process: patch } }
  if (scope === 'machine') return { ...p, overrides: { ...p.overrides, machine: patch } }
  return { ...p, overrides: { ...p.overrides, filaments: p.overrides.filaments.map((o, i) => (i === slot ? patch : o)) } }
}

/** The person changed a setting: the engine runs Orca's edit handlers and says what to write; its questions come back as prompts. */
export function editSetting(scope: Scope, key: string, value: string, index?: number) {
  return serial(async () => {
    const st = useSlicer.getState()
    const p = profileNow()
    const r = st.resolved ?? (await resolveProfile(p, slotColours()))
    const client = await settingsHost.client()
    const res = await client.edit({ scope, ...fix(input(scope, r, p)), edit: { set: key, value, ...(index !== undefined ? { index } : {}) } } as never)
    const slot = Math.min(st.slot, p.filaments.length - 1)
    await commit(withPatch(p, scope, slot, applyWrites(patchOf(p, scope, slot), res.writes)), 'Edit print setting')
    useSlicer.getState().set({ prompts: res.prompts, notices: res.notices })
  })
}

/** Put a setting back to what its preset says. */
export function resetSetting(scope: Scope, key: string) {
  return serial(async () => {
    const p = profileNow()
    const slot = Math.min(useSlicer.getState().slot, p.filaments.length - 1)
    await commit(withPatch(p, scope, slot, applyWrites(patchOf(p, scope, slot), { [key]: null })), 'Reset print setting')
  })
}

/** Apply values a fix or an answer carries (Orca's "Yes"). */
export function applyValues(scope: Scope, values: ConfigPatch) {
  return serial(async () => {
    const p = profileNow()
    const slot = Math.min(useSlicer.getState().slot, p.filaments.length - 1)
    await commit(withPatch(p, scope, slot, { ...patchOf(p, scope, slot), ...values }), 'Fix print setting')
    useSlicer.getState().set({ prompts: [] })
  })
}

export const dismissPrompts = () => useSlicer.getState().set({ prompts: [], notices: [] })

// ---- per-object settings

function withObject(p: SliceProfile, id: string, patch: ConfigPatch): SliceProfile {
  const objects = { ...p.objects }
  if (Object.keys(patch).length) objects[id] = patch
  else delete objects[id]
  return { ...p, objects }
}

export function editObject(id: string, key: string, value: string) {
  return serial(async () => {
    const p = profileNow()
    const r = useSlicer.getState().resolved ?? (await resolveProfile(p, slotColours()))
    const client = await settingsHost.client()
    const res = await client.edit({ scope: 'object', ...fix(input('object', r, p, id)), edit: { set: key, value } } as never)
    await commit(withObject(p, id, applyWrites(p.objects[id] ?? {}, res.writes)), 'Edit object setting')
    useSlicer.getState().set({ prompts: res.prompts, notices: res.notices })
  })
}

export function addObjectSetting(id: string, key: string) {
  return serial(async () => {
    const p = profileNow()
    const r = useSlicer.getState().resolved ?? (await resolveProfile(p, slotColours()))
    const client = await settingsHost.client()
    const res = await client.edit({ scope: 'object', ...fix(input('object', r, p, id)), edit: { add: key } } as never)
    await commit(withObject(p, id, applyWrites(p.objects[id] ?? {}, res.writes)), 'Add object setting')
  })
}

export function removeObjectSetting(id: string, key: string) {
  return serial(async () => {
    const p = profileNow()
    await commit(withObject(p, id, applyWrites(p.objects[id] ?? {}, { [key]: null })), 'Reset object setting')
  })
}

export function clearObject(id: string) {
  return serial(async () => commit(withObject(profileNow(), id, {}), 'Reset object settings'))
}

// ---- user presets

/** Save what the open preset plus its overrides add up to as a user preset, and select it with no overrides left. */
export function saveAsUserPreset(scope: Scope, name: string) {
  return serial(async () => {
    const p = profileNow()
    const slot = Math.min(useSlicer.getState().slot, p.filaments.length - 1)
    const r = useSlicer.getState().resolved ?? (await resolveProfile(p, slotColours()))
    const own = scope === 'process' ? p.user.process : scope === 'machine' ? p.user.machine : p.user.filaments[slot]
    const keys = { ...(own?.keys ?? {}), ...patchOf(p, scope, slot) }
    const inherits = scope === 'process' ? r.processName : scope === 'machine' ? p.machine : r.filamentNames[slot]
    const preset: UserPreset = saveUserPreset(scope, name.trim() || 'My preset', p.vendor, inherits, keys)
    const ref = refOf(preset)
    let next = withPatch(p, scope, slot, {})
    if (scope === 'process') next = { ...next, user: { ...next.user, process: ref } }
    else if (scope === 'machine') next = { ...next, user: { ...next.user, machine: ref } }
    else next = { ...next, user: { ...next.user, filaments: next.user.filaments.map((u, i) => (i === slot ? ref : u)) } }
    await commit(next, 'Save user preset')
  })
}
