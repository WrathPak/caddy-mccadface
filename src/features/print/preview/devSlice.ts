/** Dev and e2e only: slice the plate with the A1 defaults and put the result (with the extras the typed path drops) in the slice store. */
import { buildPlate } from '../plate'
import { colorById } from '../palette'
import { placeObjects, toProtocolObjects } from '../engine/convert'
import { resolveProfile } from '../engine/profiles'
import { MuonEngine } from '../engine/muon'
import { useSlice } from '../engine/sliceStore'
import { emptyProfile } from '../slice/profile'

interface Conn { request: (op: string, params: unknown, opts: unknown) => Promise<Record<string, unknown>> }

let engine: MuonEngine | null = null

export async function devSlice(opts: { bedOrigin?: boolean } = {}, processPatch: Record<string, string> = {}) {
  engine ??= new MuonEngine()
  await engine.load()
  const plate = await buildPlate()
  const hex = Array.from({ length: plate.colors }, (_, i) => colorById(plate.settings.slotColors[i] ?? 'white').hex)
  const profile = emptyProfile()
  profile.filaments = hex.map(() => '')
  profile.overrides.filaments = hex.map(() => ({}))
  const presets = await resolveProfile(profile, hex.map((h) => h.toUpperCase()))
  Object.assign(presets.process, processPatch)
  const objects = placeObjects(plate.plan.objects, plate.plan.placements)
  const t = performance.now()
  const conn = (engine as unknown as { conn: Conn }).conn
  const r = await conn.request('slice', { configs: { machine: presets.machine, process: presets.process, filaments: presets.filaments }, objects: toProtocolObjects(objects) }, { transfer: 'auto' })
  const ms = performance.now() - t
  const off = plate.plan.placements[0].offset
  useSlice.setState({
    status: 'done', progress: 100, message: '',
    result: r as never,
    filamentColors: hex, bed: profile.bed, stale: false, preview: false,
    bedOrigin: opts.bedOrigin ? [-off[0], -off[1], -off[2]] : null,
  } as never)
  return { ms, layers: (r.toolpaths as { layerCount: number }).layerCount, segments: (r.toolpaths as { extrusions: { count: number } }).extrusions.count }
}

/** A synthetic plate of about `segments` extrusion segments (concentric rings, several features) for the performance numbers. */
export function devFake(segments = 1_500_000, layers = 300) {
  const per = Math.floor(segments / layers)
  const n = per * layers
  const positions = new Float32Array(n * 6)
  const layerStart = new Uint32Array(layers + 1)
  const roleIndex = new Uint8Array(n)
  const rings = 6
  for (let l = 0; l < layers; l++) {
    layerStart[l] = l * per
    for (let i = 0; i < per; i++) {
      const s = l * per + i
      const ring = i % rings
      const a0 = (Math.floor(i / rings) / (per / rings)) * Math.PI * 2, a1 = ((Math.floor(i / rings) + 1) / (per / rings)) * Math.PI * 2
      const r = 20 + ring * 2.2 + Math.sin(l * 0.1) * 3
      const z = 0.2 * (l + 1)
      positions.set([128 + Math.cos(a0) * r, 128 + Math.sin(a0) * r, z, 128 + Math.cos(a1) * r, 128 + Math.sin(a1) * r, z], s * 6)
      roleIndex[s] = ring === 0 ? 0 : ring === 1 ? 1 : 2 + (ring % 3)
    }
  }
  layerStart[layers] = n
  const roles = ['Outer wall', 'Inner wall', 'Sparse infill', 'Internal solid infill', 'Top surface'].map((name) => ({ name, lengthMm: n / 5 }))
  const toolpaths = {
    format: 1, layerCount: layers, layerZ: Float32Array.from({ length: layers }, (_, l) => 0.2 * (l + 1)),
    extrusions: { positions, layerStart, count: n, roleIndex, width: new Uint8Array(n).fill(45), height: new Uint8Array(n).fill(20) },
    travels: { positions: new Float32Array(0), layerStart: new Uint32Array(layers + 1), count: 0 },
    roles, lineWidth: 0.45, bounds: null,
  }
  useSlice.setState({ status: 'done', result: { gcode: new Uint8Array(0), stats: {}, toolpaths, warnings: [], timings: {} } as never, filamentColors: ['#cccccc'], bed: [256, 256], stale: false, preview: false, bedOrigin: [-128, -128, 0] } as never)
  return { segments: n, layers }
}
