/** Main-thread access to the kernel worker(s). Pool of 1 today; `getKernel()` is pool-ready. */
import * as Comlink from 'comlink'
import type { KernelApi } from './worker'
import { useUi } from '@/store/ui'

export type { KernelApi }
export type KernelClient = Comlink.Remote<KernelApi>

const POOL_SIZE = 1
const pool: KernelClient[] = []
let rr = 0
let pending = 0

function track<T extends object>(remote: T): T {
  return new Proxy(remote, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (typeof v !== 'function' || typeof prop !== 'string' || prop === 'then') return v
      return async (...args: unknown[]) => {
        if (pending++ === 0) useUi.getState().setStats({ kernelBusy: true })
        try {
          return await (v as (...a: unknown[]) => unknown).apply(target, args)
        } finally {
          if (--pending === 0) useUi.getState().setStats({ kernelBusy: false })
        }
      }
    },
  })
}

function spawn(): KernelClient {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  return track(Comlink.wrap<KernelApi>(w)) as KernelClient
}

/** Round-robin over the pool. Note: handles (Body.key) live in ONE worker; keep POOL_SIZE 1 until keys carry a worker id. */
export function getKernel(): KernelClient {
  if (pool.length === 0) for (let i = 0; i < POOL_SIZE; i++) pool.push(spawn())
  return pool[rr++ % pool.length]
}
