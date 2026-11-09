/** SlicerEngine on the Muon3D engine: OrcaSlicer's libslic3r as WebAssembly in a worker, spoken to over protocol v2. */
import { EngineConnection, EngineRequestError, SettingsClient, workerTransport, type HostState } from '@muon3d/slicer-engine-protocol'
import { toProtocolObjects } from './convert'
import type { EnginePlate, EnginePresets, LoadProgress, SlicerEngine, SliceOutput } from './types'

const CLIENT = { name: 'caddy-mccadface', version: '0.1.0' }
/** `st` is the one variant that runs on a page without cross-origin isolation (GitHub Pages sends no such headers). */
const VARIANT = 'st'

interface Manifest { host: { file: string } }

export const engineBase = () => new URL(`${import.meta.env.BASE_URL}slicer/engine/`, location.href)

/** Start a host in a worker and say hello. The worker is the connection's: closing the connection ends it. */
export async function startHost(base: URL, required: string[], onState?: (s: HostState) => void, onClose?: () => void): Promise<EngineConnection> {
  const res = await fetch(new URL('manifest.json', base))
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
    worker.postMessage({ boot: new URL(manifest.host.file, base).href })
  }).catch((e) => { worker.terminate(); throw e })
  const conn = new EngineConnection(workerTransport(worker), { onState, onClose })
  try {
    await conn.open(CLIENT, { minMinor: 3, required })
  } catch (e) {
    conn.close()
    throw e
  }
  return conn
}

/**
 * The settings service on a host of its own (settings ops never load the wasm, and a running slice blocks its host, so the
 * panel keeps answering while a slice runs).
 */
export class SettingsHost {
  private ready: Promise<SettingsClient> | null = null
  private conn: EngineConnection | null = null

  private baseUrl: URL | undefined
  /** the engine folder, worked out on first use (module load has no page location in tests) */
  private get base() { return (this.baseUrl ??= engineBase()) }
  constructor() {}

  client(): Promise<SettingsClient> {
    this.ready ??= startHost(this.base, ['settings.view.v1'], undefined, () => this.reset())
      .then((c) => { this.conn = c; return new SettingsClient(c) })
      .catch((e) => { this.ready = null; throw e })
    return this.ready
  }

  private reset() { this.conn = null; this.ready = null }

  /** Replace the host (after a fault). */
  restart() { this.conn?.close(); this.reset() }
}

export class MuonEngine implements SlicerEngine {
  private conn: EngineConnection | null = null
  private ready: Promise<{ variant: string; initMs: number }> | null = null
  private progress: ((p: LoadProgress) => void) | undefined

  private baseUrl: URL | undefined
  /** the engine folder, worked out on first use (module load has no page location in tests) */
  private get base() { return (this.baseUrl ??= engineBase()) }
  constructor() {}

  load(onProgress?: (p: LoadProgress) => void): Promise<{ variant: string; initMs: number }> {
    if (onProgress) this.progress = onProgress
    this.ready ??= this.start().catch((e) => {
      this.cancel()
      throw e
    })
    return this.ready
  }

  get isReady() { return !!this.conn && this.ready !== null }

  private async start(): Promise<{ variant: string; initMs: number }> {
    const conn = await startHost(
      this.base, ['slice', 'paint.v1', 'slice.toolpathExtras'],
      (s: HostState) => { if (s.state === 'loading') this.progress?.({ loadedBytes: s.loadedBytes, totalBytes: s.totalBytes, done: !!s.done }) },
      () => { if (this.conn === conn) this.reset() },
    )
    this.conn = conn
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
    try {
      const r = await conn.request(
        'slice',
        { configs: presets, objects: toProtocolObjects(plate.objects) },
        { transfer: 'auto', onProgress: onProgress ? (p) => onProgress(p.percent, p.message) : undefined },
      )
      return { gcode: r.gcode, stats: r.stats, toolpaths: r.toolpaths, toolpathExtras: r.toolpathExtras ?? null, warnings: r.warnings, timings: r.timings, heapBytes: r.heapBytes }
    } catch (e) {
      // a crash or running out of memory leaves the host dead: replace it (Orca refusing a job, a negative code, leaves it fine)
      if (!(e instanceof EngineRequestError) || e.code === 1 || e.code === 2 || e.code === 6) this.cancel()
      if (e instanceof EngineRequestError) throw new SliceError(`${e.message}${e.objects?.length ? ` (${e.objects.join(', ')})` : ''}`, e.code)
      throw e
    }
  }

  cancel(): void {
    this.conn?.close()
    this.reset()
  }
}

/** The engine refused or failed a slice: Orca's own words, and its code. */
export class SliceError extends Error {
  constructor(message: string, readonly code: number) { super(message) }
}
