/** The Slice command: build the plate, resolve the presets, run the engine, keep the result in the shared slice store. */
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { placeObjects } from '../engine/convert'
import { MuonEngine, SliceError } from '../engine/muon'
import { resolveProfile, type Resolved } from '../engine/profiles'
import { useSlice } from '../engine/sliceStore'
import type { EngineObject, EngineWarning } from '../engine/types'
import { colorById } from '../palette'
import { showPreview } from '../preview/command'
import { buildPlate, type BuiltPlate } from '../plate'
import { bedOriginOf } from './bedOrigin'
import { plateProblem } from './plates'
import { withSlots, type SliceProfile } from './profile'

export const engine = new MuonEngine()

/** What a slice was made from: everything the export needs, so exporting never re-slices. */
export interface SliceSnapshot {
  name: string
  plate: BuiltPlate
  placed: EngineObject[]
  resolved: Resolved
  profile: SliceProfile
  usage: FilamentUsage[]
  /** the engine's time estimate is only trusted for Bambu printers (it overcounts mesh levelling on the others) */
  timeKnown: boolean
}

export interface FilamentUsage { slot: number; mm: number; cm3: number; g: number; cost: number }

const num = (s: string) => parseFloat(s) || 0

/** Per-filament usage from the lines Orca writes at the end of the G-code ("; filament used [g] = 3.67, 1.2"). */
export function parseFilamentUsage(gcode: string): FilamentUsage[] {
  const tail = gcode.slice(-12000)
  const line = (re: RegExp) => (re.exec(tail)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(num)
  const mm = line(/^; filament used \[mm\] = (.*)$/m)
  const cm3 = line(/^; filament used \[cm3\] = (.*)$/m)
  const g = line(/^; filament used \[g\] = (.*)$/m)
  const cost = line(/^; filament cost = (.*)$/m)
  return mm.map((v, i) => ({ slot: i + 1, mm: v, cm3: cm3[i] ?? 0, g: g[i] ?? 0, cost: cost[i] ?? 0 })).filter((u) => u.mm > 0 || u.g > 0)
}

/** Orca's warnings in plain words (the engine's own text when there is nothing better). */
export function plainWarning(w: EngineWarning): string {
  const m = w.message.replace(/\s+/g, ' ').trim()
  switch (w.kind) {
    case 'object_outside': return `${w.objects?.join(', ') || 'A part'} sticks out past the edge of the plate. Move it inside the plate.`
    case 'support_dropped': return m
    default: return m.endsWith('.') ? m : `${m}.`
  }
}

let token = 0
let running = false
const dec = new TextDecoder()

export async function runSlice(): Promise<void> {
  if (running) return
  running = true
  const mine = ++token
  const set = useSlice.setState
  set({ status: 'loading', progress: 0, message: 'Preparing the plate', download: null })
  try {
    const plate = await buildPlate()
    // a part off the bed would only make the engine fail later, with a less clear message
    if (plate.problems.length) throw new Error(plate.problems.join(' '))
    const profile = withSlots(plate.settings.profile, plate.colors)
    const colours = Array.from({ length: Math.max(plate.colors, profile.filaments.length) }, (_, i) => colorById(plate.settings.slotColors[i] ?? 'white').hex.toUpperCase())
    const resolved = await resolveProfile(profile, colours)
    // the engine refuses a filament its plate cannot take; say so before it does, with the way out
    const bad = resolved.plate ? plateProblem(resolved.plate.current, resolved.filaments, resolved.filamentNames) : null
    if (bad) throw new Error(bad)
    const placed = placeObjects(plate.plan.objects, plate.plan.placements)
    if (!engine.isReady) set({ message: 'Loading the slicer' })
    await engine.load((p) => { if (mine === token) set({ download: { loaded: p.loadedBytes, total: p.totalBytes }, progress: p.totalBytes ? Math.round((p.loadedBytes / p.totalBytes) * 100) : 0 }) })
    if (mine !== token) return
    set({ status: 'slicing', progress: 0, message: 'Slicing', download: null })
    const out = await engine.slice({ objects: placed }, resolved, (percent, message) => { if (mine === token) set({ progress: percent, message }) })
    if (mine !== token) return
    const text = dec.decode(out.gcode)
    const snapshot: SliceSnapshot = {
      name: plate.fileName.replace(/\.3mf$/, ''), plate, placed, resolved, profile, usage: parseFilamentUsage(text), timeKnown: profile.vendor === 'BBL',
    }
    set({ status: 'done', progress: 100, message: '', result: out, filamentColors: colours, bed: profile.bed, bedOrigin: bedOriginOf(plate.plan.objects, placed), stale: false, snapshot })
    trackStale()
    // a finished slice opens on its layers
    if (out.toolpaths?.extrusions.count) showPreview()
  } catch (e) {
    if (mine !== token) return
    const raw = e instanceof SliceError || e instanceof Error ? e.message : String(e)
    // Orca's path-conflict message, in words about the plate
    const clash = /conflicts? between object (.+?) and (.+?) \(/.exec(raw)
    const noPlate = /^(.+?) does not support filament (\d+)/m.exec(raw)
    const msg = noPlate ? `${noPlate[1]} can't print filament ${noPlate[2]}. Pick another plate.` : clash ? `${clash[1]} and ${clash[2]} overlap on the plate. Move them apart, or press Arrange.` : raw
    set({ status: 'error', message: msg })
  } finally {
    if (mine === token) running = false
  }
}

/** Stop the slice that is running. The engine is synchronous, so its worker ends and the next slice starts a fresh one. */
export function cancelSlice() {
  if (!running) return
  token++
  running = false
  engine.cancel()
  const had = useSlice.getState().result
  useSlice.setState({ status: had ? 'done' : 'idle', progress: 0, message: '', download: null })
}

let unsub: (() => void) | null = null

/** Mark the result out of date when the document changes after it was sliced. */
function trackStale() {
  unsub?.()
  const keyOf = () => {
    const d = useDoc.getState()
    return [d.features, d.rollback, d.assembly, d.bodyNames, useUi.getState().hiddenIds]
  }
  const start = keyOf()
  const check = () => {
    const now = keyOf()
    if (now.some((v, i) => v !== start[i])) {
      useSlice.setState({ stale: true })
      unsub?.()
      unsub = null
    }
  }
  const a = useDoc.subscribe(check)
  const b = useUi.subscribe(check)
  unsub = () => { a(); b() }
}
