/** Dev-only handle for the slicer spike: `window.__slicerSpike` slices the current plate with a named preset set (never in released builds). */
import { DEBUG_HANDLE } from '@/app/flags'
import { buildPlate } from '../plate'
import { colorById } from '../palette'
import { placeObjects } from './convert'
import { MuonEngine } from './muon'
import { resolvePresets, SPIKE_PRESETS, loadProfileSet } from './profiles'
import type { LoadProgress } from './types'

const engine = new MuonEngine()
const dec = new TextDecoder()

export interface SpikeRun {
  gcode: string
  gcodeBytes: number
  stats: Awaited<ReturnType<MuonEngine['slice']>>['stats']
  layerCount: number | null
  layerZ: number[]
  extrusionSegments: number
  travelSegments: number
  roles: { name: string; lengthMm: number }[]
  warnings: { kind: string; message: string }[]
  engineTimings: { load: number; slice: number; export: number; total: number }
  heapBytes: number | undefined
  /** wall-clock ms in the page */
  ms: { loadEngine: number; presets: number; slice: number }
  progressEvents: number
  filaments: number
}

async function run(key: keyof typeof SPIKE_PRESETS): Promise<SpikeRun> {
  const plate = await buildPlate()
  let t = performance.now()
  await engine.load()
  const loadEngine = performance.now() - t
  t = performance.now()
  const colours = Array.from({ length: plate.colors }, (_, i) => colorById(plate.settings.slotColors[i] ?? 'white').hex.toUpperCase())
  const presets = await resolvePresets(SPIKE_PRESETS[key], colours)
  const presetMs = performance.now() - t
  t = performance.now()
  let progressEvents = 0
  const out = await engine.slice({ objects: placeObjects(plate.plan.objects, plate.plan.placements) }, presets, () => { progressEvents++ })
  const slice = performance.now() - t
  const tp = out.toolpaths
  return {
    gcode: dec.decode(out.gcode),
    gcodeBytes: out.gcode.length,
    stats: out.stats,
    layerCount: tp?.layerCount ?? null,
    layerZ: tp ? Array.from(tp.layerZ) : [],
    extrusionSegments: tp?.extrusions.count ?? 0,
    travelSegments: tp?.travels.count ?? 0,
    roles: tp?.roles ?? [],
    warnings: out.warnings.map((w) => ({ kind: w.kind, message: w.message })),
    engineTimings: out.timings,
    heapBytes: out.heapBytes,
    ms: { loadEngine, presets: presetMs, slice },
    progressEvents,
    filaments: presets.filaments.length,
  }
}

if (DEBUG_HANDLE) {
  ;(window as unknown as { __slicerSpike: unknown }).__slicerSpike = {
    engine,
    run,
    loadProfileSet,
    /** download + start the engine, with progress events collected */
    async warmUp() {
      const events: LoadProgress[] = []
      const t = performance.now()
      const r = await engine.load((p) => events.push(p))
      return { ...r, ms: performance.now() - t, progress: events.length, lastProgress: events.at(-1) }
    },
  }
}
