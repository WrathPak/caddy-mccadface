/** SlicerEngine on the Muon3D engine: OrcaSlicer's libslic3r as WebAssembly in a worker, spoken to over protocol v2. */
import { EngineConnection, EngineRequestError, workerTransport, type HostState } from '@muon3d/slicer-engine-protocol'
import { toProtocolObjects } from './convert'
import type { EnginePlate, EnginePresets, LoadProgress, SlicerEngine, SliceOutput } from './types'

const CLIENT = { name: 'caddy-mccadface', version: '0.1.0' }
/** `st` is the one variant that runs on a page without cross-origin isolation (GitHub Pages sends no such headers). */
const VARIANT = 'st'

interface Manifest { host: { file: string } }

export class MuonEngine implements SlicerEngine {
  private conn: EngineConnection | null = null
  private ready: Promise<{ variant: string; initMs: number }> | null = null
  private progress: ((p: LoadProgress) => void) | undefined

  constructor(private readonly base = new URL(`${import.meta.env.BASE_URL}slicer/engine/`, location.href)) {}

  load(onProgress?: (p: LoadProgress) => void): Promise<{ variant: string; initMs: number }> {
    if (onProgress) this.progress = onProgress
    this.ready ??= this.start().catch((e) => {
      this.ready = null
      throw e
    })
    return this.ready
  }

  private async start(): Promise<{ variant: string; initMs: number }> {
    const res = await fetch(new URL('manifest.json', this.base))
    if (!res.ok) throw new Error(`The slicer engine is not installed (manifest.json: HTTP ${res.status}). Run: node scripts/fetch-slicer.mjs`)
    const manifest = (await res.json()) as Manifest
    const worker = new Worker(new URL('./hostBoot.ts', import.meta.url), { type: 'module', name: 'muon3d-slicer-engine' })
    await new Promise<void>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        const m = e.data as { booted?: boolean; error?: string } | null
        if (m?.booted === undefined) return
        worker.removeEventListener('message', onMessage)
        if (m.booted) resolve()
        else reject(new Error(`The slicer engine host failed to start: ${m.error}`))
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', (e) => reject(new Error(`The slicer engine host failed to start: ${e.message}`)), { once: true })
      worker.postMessage({ boot: new URL(manifest.host.file, this.base).href })
    })
    const conn = new EngineConnection(workerTransport(worker), {
      onState: (s: HostState) => {
        if (s.state === 'loading') this.progress?.({ loadedBytes: s.loadedBytes, totalBytes: s.totalBytes, done: !!s.done })
      },
      onClose: () => {
        if (this.conn === conn) this.reset()
      },
    })
    this.conn = conn
    await conn.open(CLIENT, { minMinor: 3, required: ['slice', 'paint.v1', 'slice.toolpathExtras'] })
    return conn.request('load', { variant: VARIANT })
  }

  private reset() {
    this.conn = null
    this.ready = null
  }

  async slice(plate: EnginePlate, presets: EnginePresets, onProgress?: (percent: number, message: string) => void): Promise<SliceOutput> {
    await this.load()
    const conn = this.conn
    if (!conn) throw new Error('The slicer engine stopped')
    const filaments = Math.max(...plate.objects.map((o) => (o.slots ? o.slots.reduce((m, s) => Math.max(m, s), 1) : 1)))
    if (filaments > presets.filaments.length) throw new Error(`The plate uses ${filaments} filaments but ${presets.filaments.length} are chosen`)
    try {
      const r = await conn.request(
        'slice',
        { configs: presets, objects: toProtocolObjects(plate.objects) },
        { transfer: 'auto', onProgress: onProgress ? (p) => onProgress(p.percent, p.message) : undefined },
      )
      return { gcode: r.gcode, stats: r.stats, toolpaths: r.toolpaths, warnings: r.warnings, timings: r.timings, heapBytes: r.heapBytes }
    } catch (e) {
      if (e instanceof EngineRequestError) throw new Error(`${e.message}${e.objects?.length ? ` (${e.objects.join(', ')})` : ''} [engine code ${e.code}]`)
      throw e
    }
  }

  cancel(): void {
    this.conn?.close()
    this.reset()
  }
}
