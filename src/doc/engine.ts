/**
 * Regeneration engine. Walks the timeline up to the rollback marker, reusing per-feature cached results
 * whose hash (feature params + everything upstream) is unchanged; so only the first dirty feature and
 * those after it recompute. Errors are recorded per feature and the state passes through unchanged.
 *
 * Linked / embedded components (other .caddy files) run the same walk over their own timeline, with their own parameters and
 * their own cache, after the document's own pass (see runExternals).
 */
import { getKernel } from '@/kernel/client'
import type { Body } from '@/kernel/types'
import { expandInstances } from '@/assembly/instances'
import { useAssemblyRuntime } from '@/assembly/runtime'
import { placeAssembly } from '@/assembly/instances'
import { isIdentity } from '@/assembly/matrix'
import type { ExternalRef } from '@/assembly/types'
import { parseProject } from '@/io/projectParse'
import { getFeature } from './registry'
import { effectiveParams, evalScope, getScope, resolveParams, swapScope, type Scope } from './params'
import { RefError } from './refs'
import { setRegenHandler, useDoc, type FeatureStatus } from './store'
import type { DocData, Feature, FeatureCtx, FeatureResult } from './types'

interface CacheEntry { hash: string; bodies: Body[]; data?: unknown; error?: string; warning?: string; rebound?: string[]; lost?: string[]; upgrades?: Record<string, string> }

/** Names written back into legacy (signature-only) refs; applied after the pass. */
type Upgrades = Record<string, string>
const cache = new Map<string, CacheEntry>()
/** Bodies before / after every feature of the last pass (features like Pattern repeat the effect of earlier ones). */
let around = new Map<string, { before: Body[]; after: Body[] }>()
/** The state around a feature as of the last regeneration. */
export const stateAround = (id: string) => around.get(id)

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

/** Bodies a feature creates belong to the feature's component; bodies it modifies keep their owner. */
function merge(state: Body[], r: FeatureResult, featureId: string, component: string | undefined): Body[] {
  const out = state.filter((b) => !r.remove?.includes(b.id))
  for (const nb of r.bodies ?? []) {
    const i = out.findIndex((b) => b.id === nb.id)
    const prev = i >= 0 ? out[i] : undefined
    const owner = nb.component ?? prev?.component ?? component
    const b: Body = { ...nb, featureId: nb.featureId ?? prev?.featureId ?? featureId, ...(owner ? { component: owner } : {}) }
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

interface Chain {
  features: Feature[]
  rollback: number
  blobs: Record<string, Uint8Array>
  cache: Map<string, CacheEntry>
  scope: Scope
}
interface ChainOut {
  state: Body[]
  status: Record<string, FeatureStatus>
  around: Map<string, { before: Body[]; after: Body[] }>
  seen: Set<string>
}

/** Run one timeline. Returns null when a newer edit arrived while it ran (the caller restarts). */
async function runChain(c: Chain): Promise<ChainOut | null> {
  const { features, rollback, blobs, cache: cch, scope } = c
  const kernel = getKernel()
  const status: Record<string, FeatureStatus> = {}
  const stat = (e: CacheEntry | undefined): FeatureStatus =>
    e?.error ? { state: 'error', error: e.error, lostRefs: e.lost } : e?.warning ? { state: 'warning', warning: e.warning, reboundRefs: e.rebound } : { state: 'ok' }
  let state: Body[] = []
  const nextAround = new Map<string, { before: Body[]; after: Body[] }>()
  let chain = ''
  const seen = new Set<string>()

  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    seen.add(f.id)
    if (f.suppressed) { status[f.id] = { state: 'suppressed' }; continue }
    const def = getFeature(f.type)
    if (i >= rollback) {
      const e = cch.get(f.id)
      status[f.id] = stat(e)
      continue
    }
    if (!def) { status[f.id] = { state: 'error', error: `Unknown feature type "${f.type}"` }; continue }

    let h: string
    let params
    try {
      params = resolveParams(def.schema, f.params, scope)
      h = hash(chain + '|' + f.type + '|' + (f.component ?? '') + '|' + JSON.stringify(params) + (def.dependsOnParams ? '|' + JSON.stringify(Object.entries(scope.values).map(([k, v]) => [k, String(v)])) : ''))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      cch.set(f.id, { hash: 'err:' + msg, bodies: state, error: msg })
      status[f.id] = { state: 'error', error: msg }
      continue
    }

    let entry = cch.get(f.id)
    if (!entry || entry.hash !== h) {
      const ctx: FeatureCtx = {
        feature: { id: f.id, type: f.type, name: f.name },
        bodies: state,
        body: (id) => state.find((b) => b.id === id),
        kernel,
        blob: (id) => blobs[id],
        newBodyId: (n) => (n ? `${f.id}.${n}` : f.id),
        dataOf: (id) => cch.get(id)?.data,
        featureById: (id) => features.find((x) => x.id === id),
        stateAround: (id) => nextAround.get(id),
      }
      try {
        const r = await def.compute(ctx, params)
        entry = { hash: h, bodies: merge(state, r, f.id, f.component), data: r.data, warning: r.warning, rebound: r.reboundRefs, upgrades: r.upgrades }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[regen] ${f.name}:`, e)
        entry = { hash: h, bodies: state, error: msg, lost: e instanceof RefError ? e.refs : undefined }
      }
      cch.set(f.id, entry)
      if (again) return null // a newer edit arrived; restart from the top
    }
    chain = hash(chain + entry.hash)
    nextAround.set(f.id, { before: state, after: entry.bodies })
    state = entry.bodies
    status[f.id] = stat(entry)
  }
  return { state, status, around: nextAround, seen }
}

interface ExtEntry { blob: string; hash: string; cache: Map<string, CacheEntry>; parsed?: { data: DocData; blobs: Record<string, Uint8Array> } }
const extCache = new Map<string, ExtEntry>()

/** The bodies of a linked file as bodies of this document: one per body per occurrence in the file, each carrying its pose. */
function flattenExternal(ref: ExternalRef, data: DocData, state: Body[], placement = placeAssembly(data.assembly)): Body[] {
  return expandInstances(data.assembly, state, placement.worlds).map((i) => ({
    ...i.body,
    id: `${ref.id}/${i.occ ? i.occ + '/' : ''}${i.body.id}`,
    featureId: `${ref.id}/${i.body.featureId ?? i.body.id}`,
    name: data.bodyNames[i.body.id] ?? i.body.name,
    component: 'ext:' + ref.id,
    placement: isIdentity(i.world) ? undefined : i.world,
  }))
}

/** Evaluate every linked / embedded component that a component of the document uses. null: a newer edit arrived. */
async function runExternals(refs: ExternalRef[], used: Set<string>, blobs: Record<string, Uint8Array>): Promise<{ bodies: Body[]; live: Set<string> } | null> {
  const bodies: Body[] = []
  const live = new Set<string>()
  const errors: Record<string, string> = {}
  for (const ref of refs) {
    if (!used.has(ref.id)) continue
    const bytes = blobs[ref.blob]
    if (!bytes) { errors[ref.id] = 'The component file is missing from this document'; continue }
    let entry = extCache.get(ref.id)
    if (!entry || entry.hash !== ref.hash || entry.blob !== ref.blob) {
      entry = { blob: ref.blob, hash: ref.hash, cache: new Map() }
      extCache.set(ref.id, entry)
    }
    try {
      const parsed = (entry.parsed ??= parseProject(bytes))
      const scope = evalScope(effectiveParams(parsed.data.userParams, parsed.data.configs, parsed.data.activeConfig))
      const prev = swapScope(scope)
      let out: ChainOut | null
      try {
        out = await runChain({ features: parsed.data.features, rollback: parsed.data.rollback, blobs: parsed.blobs, cache: entry.cache, scope })
      } finally {
        swapScope(prev)
      }
      if (!out) return null
      for (const id of [...entry.cache.keys()]) if (!out.seen.has(id)) entry.cache.delete(id)
      for (const e of entry.cache.values()) for (const b of e.bodies) live.add(b.key)
      const bad = parsed.data.features.find((f) => out!.status[f.id]?.state === 'error')
      if (bad) errors[ref.id] = `${bad.name}: ${out.status[bad.id].error}`
      bodies.push(...flattenExternal(ref, parsed.data, out.state))
    } catch (e) {
      errors[ref.id] = e instanceof Error ? e.message : String(e)
    }
  }
  for (const id of [...extCache.keys()]) if (!refs.some((r) => r.id === id)) extCache.delete(id)
  useAssemblyRuntime.getState().setExtErrors(errors)
  return { bodies, live }
}

async function pass() {
  const d0 = useDoc.getState()
  const kernel = getKernel()
  const upgrades: Upgrades = {}
  const out = await runChain({ features: d0.features, rollback: d0.rollback, blobs: d0.blobs, cache, scope: getScope() })
  if (!out) return
  const used = new Set(d0.assembly.components.map((c) => c.external).filter((x): x is string => !!x))
  const ext = await runExternals(d0.assembly.externals, used, d0.blobs)
  if (!ext) return

  around = out.around
  for (const id of [...cache.keys()]) if (!out.seen.has(id)) cache.delete(id)
  const live = new Set<string>(ext.live)
  for (const e of cache.values()) for (const b of e.bodies) live.add(b.key)
  for (const b of out.state) live.add(b.key)
  for (const b of ext.bodies) live.add(b.key)
  void kernel.gc([...live])

  const d = useDoc.getState()
  d.applyStatus(out.status)
  d.setGeometry(ext.bodies.length ? [...out.state, ...ext.bodies] : out.state)
  for (const e of cache.values()) Object.assign(upgrades, e.upgrades)
  if (Object.keys(upgrades).length && writeUpgrades(upgrades)) again = true // the upgraded features re-run once with their names
}

/** Rewrite legacy refs in the feature params (plain strings, string lists, and inside a sketch's JSON) with their named versions. */
function writeUpgrades(map: Upgrades): boolean {
  const pairs = Object.entries(map).map(([from, to]) => ({ from, to, esc: [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)] }))
  const fix = (v: string): string => {
    let out = v
    for (const p of pairs) {
      if (out === p.from) return p.to
      if (out.includes(p.esc[0])) out = out.split(p.esc[0]).join(p.esc[1])
    }
    return out
  }
  let changed = false
  const features = useDoc.getState().features.map((f) => {
    let touched = false
    const params = Object.fromEntries(
      Object.entries(f.params).map(([k, v]) => {
        const n = typeof v === 'string' ? fix(v) : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).map(fix) : v
        if (JSON.stringify(n) !== JSON.stringify(v)) touched = true
        return [k, n]
      }),
    )
    if (!touched) return f
    changed = true
    return { ...f, params }
  })
  // silent: not an edit of the user's, so no undo step and the document is not marked dirty
  if (changed) useDoc.setState({ features })
  return changed
}

/** Forget cached results (e.g. after loading a document). */
export function clearCache() {
  cache.clear()
  extCache.clear()
}

setRegenHandler(() => void regenerate())
