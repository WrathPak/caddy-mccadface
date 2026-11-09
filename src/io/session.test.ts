import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the engine would start the kernel worker; the snapshot code only needs the stores
vi.mock('@/doc/engine', () => ({ regenerate: vi.fn(async () => {}), clearCache: vi.fn(), stateAround: () => undefined }))

import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { docSig } from '@/doc/sig'
import { emptyAssembly } from '@/assembly/types'
import { getPoseData, setPoseData } from '@/viewport/pose'
import type { Body, MeshData } from '@/kernel/types'
import type { DocData } from '@/doc/types'
import { gateClosed } from '@/app/startGate'
import {
  Interner, STALE_MS, SESSION_VERSION, applyRecord, buildRecord, createWriter, geoIndexOf, ghostBodies, meshBytes, newTabId, packData, pruneSessions, readSession, readTabId,
  sessionOffForTests, setSessionHooks, staleTabs, unpackData, usable, type Kv, type SessionRecord,
} from './session'
import { setEditRollback, getEditRollback } from '@/doc/store'

/** A Map standing in for IndexedDB; counts what was written. */
function memKv() {
  const m = new Map<string, unknown>()
  const writes: string[] = []
  const kv: Kv = {
    get: async <T,>(k: string) => m.get(k) as T | undefined,
    getMany: async <T,>(ks: string[]) => ks.map((k) => m.get(k) as T | undefined),
    set: async (k, v) => { writes.push(k); m.set(k, structuredClone(v)) },
    // like IndexedDB, a write clones what it is given: later changes to the originals do not reach it
    setMany: async (es) => { for (const [k, v] of es) { writes.push(k); m.set(k, structuredClone(v)) } },
    delMany: async (ks) => { for (const k of ks) m.delete(k) },
    keys: async () => [...m.keys()],
  }
  return { kv, m, writes }
}

const doc = (n: number): DocData => ({
  name: 'Part', rollback: n, userParams: [{ name: 'w', expr: '20' }], bodyNames: {}, configs: [], activeConfig: null, assembly: emptyAssembly(),
  features: Array.from({ length: n }, (_, i) => ({ id: 'f' + (i + 1), type: 'box', name: 'Box' + (i + 1), state: 'ok' as const, suppressed: false, params: { width: 10 + i, depth: 5, height: 5, position: [0, 0, 0] } })),
})

const body = (key: string, id = 'f1'): Body => ({
  id, name: id, kind: 'brep', key, featureId: id,
  mesh: { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array(3), faceIds: new Uint32Array(1), edges: new Float32Array(6) } as MeshData,
})

let handle: unknown = null
let restoredWith: [unknown, string] | null = null
beforeEach(() => {
  handle = null
  restoredWith = null
  setSessionHooks({ getHandle: () => handle as never, restored: (h, name) => { restoredWith = [h, name] } })
  useDoc.getState().loadDocument(doc(3), { b1: new Uint8Array([1, 2, 3]) })
  useDoc.setState({ geometry: [], ghost: null, geometrySig: null, regenerating: false })
  useUi.setState({ workspace: 'solid', selection: [] })
  setEditRollback(null)
})
afterEach(() => { vi.useRealTimers() })

describe('tab id', () => {
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }
  it('is kept by the tab and made once', () => {
    const s = store()
    expect(readTabId(s)).toBeNull()
    const id = newTabId(s, () => 'abc')
    expect(id).toBe('abc')
    expect(readTabId(s)).toBe('abc')
    // another tab has its own storage, so its own id
    expect(readTabId(store())).toBeNull()
  })
  it('copes with no storage at all', () => {
    expect(readTabId(null)).toBeNull()
    expect(newTabId(null, () => 'x')).toBe('x')
    expect(readTabId({ getItem: () => { throw new Error('blocked') }, setItem: () => {} })).toBeNull()
  })
})

describe('packing', () => {
  it('keeps the document through a round trip, and stores every shared feature once', () => {
    const it = new Interner()
    const d = doc(40)
    // an undo stack of 200 documents that differ by one feature each
    const stack = Array.from({ length: 200 }, (_, i) => ({ ...d, features: d.features.map((f, k) => (k === i % 40 ? { ...f, params: { ...f.params, width: i } } : f)) }))
    const packed = stack.map((x) => packData(x, it))
    expect(it.table.length).toBeLessThan(40 + 200 + 10) // not 200 x 40
    const back = packed.map((p) => unpackData(p, it.table))
    expect(back).toEqual(stack)
    // the unchanged features are the same object in every copy again
    expect(back[3].features[39]).toBe(back[4].features[39])
  })
})

describe('the record', () => {
  it('holds what the stores hold, and puts it back', async () => {
    const d = useDoc.getState()
    d.commit('Edit', (x) => ({ ...x, features: x.features.map((f, i) => (i === 1 ? { ...f, params: { ...f.params, width: 99 } } : f)) }))
    d.setRollback(2)
    useDoc.setState({ name: 'Bracket', selectedFeatureId: 'f2' })
    useUi.setState({ workspace: 'mesh', displayMode: 'wireframe', projection: 'perspective', selection: [{ kind: 'face', id: 'f1', index: 2 }], hiddenIds: { f3: true } })
    setPoseData({ target: [1, 2, 3], q: [0, 0, 0, 1], dist: 77 })
    setEditRollback(3)
    handle = { name: 'part.caddy' }
    const rec = buildRecord('tab1', 1000)!
    expect(rec.v).toBe(SESSION_VERSION)
    expect(rec.dirty).toBe(true)
    expect(rec.editRollback).toBe(3)

    // the page goes away: everything starts from nothing
    const stacks = useDoc.getState().takeStacks()
    expect(stacks.past.length).toBe(1)
    const clone = structuredClone(rec)
    useDoc.getState().newDocument()
    useUi.setState({ workspace: 'solid', displayMode: 'shadedEdges', projection: 'orthographic', selection: [], hiddenIds: {} })
    setPoseData(null)
    setEditRollback(null)
    expect(useDoc.getState().features.length).toBe(0)

    applyRecord(clone, { b1: new Uint8Array([1, 2, 3]) }, undefined)
    const s = useDoc.getState()
    expect(s.features.map((f) => f.id)).toEqual(['f1', 'f2', 'f3'])
    expect(s.features[1].params.width).toBe(99)
    expect(s.rollback).toBe(2)
    expect(s.name).toBe('Bracket')
    expect(s.dirty).toBe(true)
    expect(s.selectedFeatureId).toBe('f2')
    expect(s.undoDepth).toBe(1)
    expect(Object.keys(s.blobs)).toEqual(['b1'])
    expect(useUi.getState().workspace).toBe('mesh')
    expect(useUi.getState().displayMode).toBe('wireframe')
    expect(useUi.getState().projection).toBe('perspective')
    expect(useUi.getState().selection).toEqual([{ kind: 'face', id: 'f1', index: 2 }])
    expect(useUi.getState().hiddenIds).toEqual({ f3: true })
    expect(getPoseData()).toEqual({ target: [1, 2, 3], q: [0, 0, 0, 1], dist: 77 })
    expect(getEditRollback()).toBe(3)
    expect(restoredWith).toEqual([{ name: 'part.caddy' }, 'Bracket'])
    // the undo step that was there still undoes
    useDoc.getState().undo()
    expect(useDoc.getState().features[1].params.width).toBe(11)
    expect(useDoc.getState().redoDepth).toBe(1)
  })

  it('does not snapshot while a past version is on show', () => {
    useDoc.getState().setReadOnly(true)
    expect(buildRecord('t')).toBeNull()
    useDoc.getState().setReadOnly(false)
    expect(buildRecord('t')).not.toBeNull()
  })

  it('is not usable when something it points at is missing', () => {
    const rec = buildRecord('t')!
    expect(usable(rec, [new Uint8Array(1)])).toBe(true)
    expect(usable(rec, [undefined])).toBe(false)
    expect(usable(rec, [])).toBe(false)
    expect(usable({ ...rec, v: SESSION_VERSION + 1 }, [new Uint8Array(1)])).toBe(false)
    expect(usable(undefined, [])).toBe(false)
  })
})

describe('the writer', () => {
  it('writes the blobs once, the record every time, and reads back whole', async () => {
    const { kv, writes } = memKv()
    const w = createWriter(kv, 'tab1')
    await w.flush()
    await w.flush()
    expect(writes.filter((k) => k === 'blob:tab1:b1').length).toBe(1)
    expect(writes.filter((k) => k === 'rec:tab1').length).toBe(2)
    const got = await readSession(kv, 'tab1')
    expect(got?.record.doc.name).toBe('Part')
    expect(Object.keys(got!.blobs)).toEqual(['b1'])
    expect(await readSession(kv, 'another-tab')).toBeNull()
  })

  it('a record whose blob is gone is not restored', async () => {
    const { kv, m } = memKv()
    await createWriter(kv, 'tab1').flush()
    m.delete('blob:tab1:b1')
    expect(await readSession(kv, 'tab1')).toBeNull()
  })

  it('writes soon after a change, once for a burst, and at the latest after the max wait', async () => {
    vi.useFakeTimers()
    const { kv, writes } = memKv()
    let now = 0
    const w = createWriter(kv, 't', { now: () => now, delay: 300, maxWait: 1000 })
    const recs = () => writes.filter((k) => k === 'rec:t').length
    for (let i = 0; i < 5; i++) { now += 100; w.touch(); await vi.advanceTimersByTimeAsync(100) }
    expect(recs()).toBe(0) // still being changed
    await vi.advanceTimersByTimeAsync(400)
    expect(recs()).toBe(1) // one write for the burst
    // a change that never stops is still written every maxWait
    for (let i = 0; i < 30; i++) { now += 100; w.touch(); await vi.advanceTimersByTimeAsync(100) }
    expect(recs()).toBeGreaterThanOrEqual(3)
    w.stop()
  })

  it('keeps going when the handle cannot be stored', async () => {
    const { kv, m } = memKv()
    const real = kv.setMany
    kv.setMany = async (es) => { if (es.some(([k, v]) => k.startsWith('rec:') && (v as SessionRecord).handle)) throw new DOMException('no', 'DataCloneError'); return real(es) }
    handle = { name: 'x.caddy', odd: () => 1 }
    await createWriter(kv, 'tab1').flush()
    expect((m.get('rec:tab1') as SessionRecord).handle).toBeNull()
  })

  it('drops the blobs and bodies that are no longer there', async () => {
    const { kv, m } = memKv()
    const w = createWriter(kv, 'tab1')
    useDoc.setState({ geometry: [body('k1')], geometrySig: docSig(useDoc.getState()), regenerating: false })
    await w.flush()
    expect(m.has('mesh:tab1:k1')).toBe(true)
    useDoc.setState({ geometry: [body('k2')], geometrySig: docSig(useDoc.getState()) })
    await w.flush()
    expect(m.has('mesh:tab1:k1')).toBe(false)
    expect(m.has('mesh:tab1:k2')).toBe(true)
    useDoc.getState().loadDocument(doc(1), {})
    await w.flush()
    expect(m.has('blob:tab1:b1')).toBe(false)
  })
})

describe('the bodies kept for the next load', () => {
  it('are offered only for the document they were made from', async () => {
    const { kv } = memKv()
    const w = createWriter(kv, 'tab1')
    useDoc.setState({ geometry: [body('k1', 'f3')], geometrySig: docSig(useDoc.getState()), regenerating: false })
    await w.flush()
    const got = await readSession(kv, 'tab1')
    expect(got?.ghost?.map((b) => b.id)).toEqual(['f3'])
    expect(got?.ghost?.[0].key).toBe('ghost:k1')
    expect(got?.ghost?.[0].mesh.positions.length).toBe(9)

    // an edit whose regeneration has not finished: the old bodies must not be written as if they fit the new document
    useDoc.getState().commit('Edit', (x) => ({ ...x, features: x.features.map((f, i) => (i === 0 ? { ...f, params: { ...f.params, width: 50 } } : f)) }))
    useDoc.setState({ regenerating: true })
    await w.flush()
    // (the earlier bodies are still stored, but they belong to the old document and are refused on the way back)
    const stale = await readSession(kv, 'tab1')
    expect(stale?.record.doc.features.length).toBe(3)
    expect(stale?.ghost).toBeNull()
  })

  it('are not written when the document is too big to be worth it', async () => {
    const { kv, m } = memKv()
    const w = createWriter(kv, 'tab1')
    const big = body('k1')
    big.mesh.positions = new Float32Array(20 * 1024 * 1024) as never // 80 MB
    useDoc.setState({ geometry: [big], geometrySig: docSig(useDoc.getState()), regenerating: false })
    expect(meshBytes([big])).toBeGreaterThan(64 * 1024 * 1024)
    await w.flush()
    expect(m.has('geo:tab1')).toBe(false)
  })

  it('round trip through the index', () => {
    const b = body('k9', 'f2')
    const idx = geoIndexOf([b], 'sig')
    expect(idx.bodies[0]).not.toHaveProperty('mesh')
    expect(ghostBodies(idx, [b.mesh])?.[0]).toMatchObject({ id: 'f2', key: 'ghost:k9' })
    expect(ghostBodies(idx, [undefined])).toBeNull()
    expect(ghostBodies({ sig: 's', bodies: [] }, [])).toBeNull()
  })

  it('show in place of the geometry until the first one arrives, and hold the gate for tools', () => {
    const rec = buildRecord('t')!
    applyRecord(structuredClone(rec), { b1: new Uint8Array(1) }, undefined, [body('ghost:k1', 'f1')])
    const s = useDoc.getState()
    expect(s.ghost?.length).toBe(1)
    expect(s.geometry.length).toBe(0)
    expect(s.bodies.map((b) => b.id)).toEqual(['f1']) // the Browser lists them
    expect(gateClosed()).toBe(true)
    s.setGeometry([body('real', 'f1')])
    expect(useDoc.getState().ghost).toBeNull()
    expect(gateClosed()).toBe(false)
  })

  it('the signature follows the parameters, not the names or the status', () => {
    const d = useDoc.getState()
    const base = docSig(d)
    expect(docSig({ ...d, features: d.features.map((f) => ({ ...f, name: 'Renamed', state: 'error' as const })) })).toBe(base)
    expect(docSig({ ...d, features: d.features.map((f, i) => (i === 2 ? { ...f, params: { ...f.params, width: 1 } } : f)) })).not.toBe(base)
    expect(docSig({ ...d, rollback: 1 })).not.toBe(base)
    expect(docSig({ ...d, userParams: [{ name: 'w', expr: '21' }] })).not.toBe(base)
    expect(docSig({ ...d, blobs: { ...d.blobs, b2: new Uint8Array(1) } })).not.toBe(base)
    expect(docSig(d, 'another-build')).not.toBe(base)
  })
})

describe('cleaning up', () => {
  it('finds the tabs gone for a day, never the open ones', () => {
    const now = 10 * STALE_MS
    expect(staleTabs({ a: now - 1000, b: now - 2 * STALE_MS, c: now - 3 * STALE_MS }, now, new Set(['c']))).toEqual(['b'])
  })

  it('removes every key of a stale tab and none of the others', async () => {
    const { kv, m } = memKv()
    const now = 5 * STALE_MS
    for (const [tab, at] of [['old', now - 2 * STALE_MS], ['new', now - 1000], ['open', now - 4 * STALE_MS]] as const) {
      m.set(`at:${tab}`, at); m.set(`rec:${tab}`, {}); m.set(`hist:${tab}`, {}); m.set(`blob:${tab}:b1`, 1); m.set(`geo:${tab}`, {}); m.set(`mesh:${tab}:k1`, {})
    }
    m.set('rec:orphan', {}) // a write that never got its time stamp
    const gone = await pruneSessions(kv, now, new Set(['open']))
    expect(gone.sort()).toEqual(['old', 'orphan'])
    const left = [...m.keys()].map((k) => k.split(':')[1])
    expect(new Set(left)).toEqual(new Set(['new', 'open']))
  })
})

describe('tests switch it off', () => {
  const set = (w: Record<string, unknown> | undefined) => { (globalThis as { window?: unknown }).window = w }
  afterEach(() => set(undefined))
  it('by the e2e fixture flags, unless a spec opts in', () => {
    set({ __e2eNoAutosave: true })
    expect(sessionOffForTests()).toBe(true)
    set({ __e2eNoAutosave: false }) // a spec that tests autosave still reloads pages and expects the recovery prompt
    expect(sessionOffForTests()).toBe(true)
    set({ __e2eNoAutosave: true, __e2eSession: true })
    expect(sessionOffForTests()).toBe(false)
    set({})
    expect(sessionOffForTests()).toBe(false) // a real visit
  })
})
