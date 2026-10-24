/**
 * Regeneration engine. Walks the timeline up to the rollback marker, reusing per-feature cached results
 * whose hash (feature params + everything upstream) is unchanged; so only the first dirty feature and
 * those after it recompute. Errors are recorded per feature and the state passes through unchanged.
 */
import { getKernel } from '@/kernel/client'
import type { Body } from '@/kernel/types'
import { getFeature } from './registry'
import { getScope, resolveParams } from './params'
import { RefError } from './refs'
import { setRegenHandler, useDoc, type FeatureStatus } from './store'
import type { FeatureCtx, FeatureResult, FeatureState } from './types'

interface CacheEntry { hash: string; bodies: Body[]; data?: unknown; error?: string; warning?: string; rebound?: string[]; lost?: string[] }
const cache = new Map<string, CacheEntry>()

function hash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36) + s.length.toString(36)
}

function merge(state: Body[], r: FeatureResult, featureId: string): Body[] {
  const out = state.filter((b) => !r.remove?.includes(b.id))
  for (const nb of r.bodies ?? []) {
    const i = out.findIndex((b) => b.id === nb.id)
    const prev = i >= 0 ? out[i] : undefined
    const b: Body = { ...nb, featureId: nb.featureId ?? prev?.featureId ?? featureId }
    if (i >= 0) out[i] = b
    else out.push(b)
  }
  return out
}

let running: Promise<void> | null = null
let again = false

/** Request a regeneration (coalesced). Resolves when the document is up to date. */
export function regenerate(): Promise<void> {
  again = true
  if (!running) {
    running = (async () => {
      useDoc.setState({ regenerating: true })
      try {
        while (again) {
          again = false
          await pass()
        }
      } finally {
        running = null
        useDoc.setState({ regenerating: false })
      }
    })()
  }
  return running
}

async function pass() {
  const { features, rollback, blobs } = useDoc.getState()
  const kernel = getKernel()
  const status: Record<string, FeatureStatus> = {}
  const stat = (e: CacheEntry | undefined): FeatureStatus =>
    e?.error ? { state: 'error', error: e.error, lostRefs: e.lost } : e?.warning ? { state: 'warning', warning: e.warning, reboundRefs: e.rebound } : { state: 'ok' }
  let state: Body[] = []
  let chain = ''
  const seen = new Set<string>()

  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    seen.add(f.id)
    if (f.suppressed) { status[f.id] = { state: 'suppressed' }; continue }
    const def = getFeature(f.type)
    if (i >= rollback) {
      const e = cache.get(f.id)
      status[f.id] = stat(e)
      continue
    }
    if (!def) { status[f.id] = { state: 'error', error: `Unknown feature type "${f.type}"` }; continue }

    let h: string
    let params
    try {
      params = resolveParams(def.schema, f.params)
      h = hash(chain + '|' + f.type + '|' + JSON.stringify(params) + (def.dependsOnParams ? '|' + JSON.stringify(Object.entries(getScope().values).map(([k, v]) => [k, String(v)])) : ''))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      cache.set(f.id, { hash: 'err:' + msg, bodies: state, error: msg })
      status[f.id] = { state: 'error', error: msg }
      continue
    }

    let entry = cache.get(f.id)
    if (!entry || entry.hash !== h) {
      const ctx: FeatureCtx = {
        feature: { id: f.id, type: f.type, name: f.name },
        bodies: state,
        body: (id) => state.find((b) => b.id === id),
        kernel,
        blob: (id) => blobs[id],
        newBodyId: (n) => (n ? `${f.id}.${n}` : f.id),
        dataOf: (id) => cache.get(id)?.data,
        featureById: (id) => features.find((x) => x.id === id),
      }
      try {
        const r = await def.compute(ctx, params)
        entry = { hash: h, bodies: merge(state, r, f.id), data: r.data, warning: r.warning, rebound: r.reboundRefs }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[regen] ${f.name}:`, e)
        entry = { hash: h, bodies: state, error: msg, lost: e instanceof RefError ? e.refs : undefined }
      }
      cache.set(f.id, entry)
      if (again) return // a newer edit arrived; restart from the top
    }
    chain = hash(chain + entry.hash)
    state = entry.bodies
    status[f.id] = stat(entry)
  }

  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id)
  const live = new Set<string>()
  for (const e of cache.values()) for (const b of e.bodies) live.add(b.key)
  for (const b of state) live.add(b.key)
  void kernel.gc([...live])

  const d = useDoc.getState()
  d.applyStatus(status)
  d.setGeometry(state)
}

/** Forget cached results (e.g. after loading a document). */
export function clearCache() {
  cache.clear()
}

setRegenHandler(() => void regenerate())
