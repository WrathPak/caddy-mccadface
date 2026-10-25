/**
 * Compute pool: up to `navigator.hardwareConcurrency - 1` workers for independent, stateless jobs.
 *
 * Why the pool does not run B-rep ops: OpenCascade shapes are WASM heap objects that live in one worker, and a Body.key is
 * only meaningful there. Spreading ops over several OCC workers would mean copying or re-building shapes between them
 * (slow, and it would change the persistent face names). So the kernel worker (client.ts) stays the single owner of every
 * handle, and this pool takes the work that is pure data in / data out: parsing and welding big files, decimating,
 * manifold booleans on raw triangle meshes. Those run in parallel, each on whichever worker is free.
 */
import * as Comlink from 'comlink'
import type { ComputeApi } from './compute'

export type ComputeClient = Comlink.Remote<ComputeApi>

export interface PoolOptions<W> {
  /** how many workers at most */
  size: number
  /** make one worker's client */
  spawn: () => { client: W; terminate: () => void }
}

interface Slot<W> { client: W; terminate: () => void; busy: boolean }

/** A work queue over up to `size` lazily created workers. Generic over the client type so it can be tested without real workers. */
export class Pool<W> {
  private slots: Slot<W>[] = []
  private waiting: ((s: Slot<W>) => void)[] = []
  /** the most jobs that ever ran at the same time */
  peak = 0
  private running = 0
  constructor(private opts: PoolOptions<W>) {}

  get size() {
    return this.opts.size
  }

  private acquire(): Promise<Slot<W>> {
    const free = this.slots.find((s) => !s.busy)
    if (free) { free.busy = true; return Promise.resolve(free) }
    if (this.slots.length < this.opts.size) {
      const s: Slot<W> = { ...this.opts.spawn(), busy: true }
      this.slots.push(s)
      return Promise.resolve(s)
    }
    return new Promise((r) => this.waiting.push(r))
  }

  private release(s: Slot<W>) {
    const next = this.waiting.shift()
    if (next) next(s)
    else s.busy = false
  }

  /** Run one job on a free worker (queued when all are busy). */
  async run<T>(job: (w: W) => Promise<T>): Promise<T> {
    const s = await this.acquire()
    this.peak = Math.max(this.peak, ++this.running)
    try {
      return await job(s.client)
    } finally {
      this.running--
      this.release(s)
    }
  }

  /** Run `job` for every item, as many at a time as there are workers; results keep the order of `items`. */
  map<I, T>(items: I[], job: (w: W, item: I, index: number) => Promise<T>): Promise<T[]> {
    return Promise.all(items.map((it, i) => this.run((w) => job(w, it, i))))
  }

  dispose() {
    for (const s of this.slots) s.terminate()
    this.slots = []
  }
}

/** Pool size: leave one core for the main thread, at least 1, at most 8. */
export function poolSize(cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4): number {
  return Math.max(1, Math.min(8, cores - 1))
}

let compute: Pool<ComputeClient> | null = null

/** The shared compute pool (workers start on first use). */
export function getComputePool(): Pool<ComputeClient> {
  return (compute ??= new Pool<ComputeClient>({
    size: poolSize(),
    spawn: () => {
      const w = new Worker(new URL('./compute-worker.ts', import.meta.url), { type: 'module' })
      return { client: Comlink.wrap<ComputeApi>(w), terminate: () => w.terminate() }
    },
  }))
}
