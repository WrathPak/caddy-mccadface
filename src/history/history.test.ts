import { describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { appendVersion, DEFAULT_SETTINGS, emptyHistory, hashOf, historyFiles, historySize, pruneHistory, readHistory, snapshotOf } from './pack'
import { diffDocs, parseSnapshot, type SnapDoc } from './diff'

const doc = (n: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'T', rollback: n, features: Array.from({ length: n }, (_, i) => ({ id: 'f' + (i + 1), type: 'box', name: 'Box' + (i + 1), params: { width: 10 + i, ...extra } })) })
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill)

describe('version history storage', () => {
  it('hashes bytes and text the same way every time', async () => {
    expect(await hashOf('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    const b = strToU8('abc')
    expect(await hashOf(b)).toBe(await hashOf('abc'))
    expect(await hashOf(b)).toBe(await hashOf(b)) // cached
  })

  it('every save appends a version, numbered in order, with its note and time', async () => {
    const h = emptyHistory()
    const a = await appendVersion(h, { docJson: doc(1), featureCount: 1, blobs: {}, note: '  first  ', now: 1000 })
    const b = await appendVersion(h, { docJson: doc(2), featureCount: 2, blobs: {}, now: 2000 })
    expect([a.n, b.n]).toEqual([1, 2])
    expect(a.note).toBe('first')
    expect(b.note).toBe('')
    expect(h.versions.map((v) => v.t)).toEqual([1000, 2000])
    expect(snapshotOf(h, 2)!.doc).toBe(doc(2))
    expect(snapshotOf(h, 9)).toBeNull()
  })

  it('stores identical content once (documents and blobs)', async () => {
    const h = emptyHistory()
    const big = bytes(5000)
    for (let i = 0; i < 4; i++) await appendVersion(h, { docJson: doc(1), featureCount: 1, blobs: { b1: big, b2: bytes(5000) }, now: i })
    expect(h.versions).toHaveLength(4)
    expect(h.docs.size).toBe(1)
    expect(h.blobs.size).toBe(1) // b1 and b2 hold the same bytes
    expect(historySize(h)).toBe(doc(1).length + 5000)
  })

  it('writes the history into a zip and reads it back, without repeating blobs the project already holds', async () => {
    const h = emptyHistory()
    const cur = bytes(3000, 7)
    const old = bytes(2000, 9)
    await appendVersion(h, { docJson: doc(1), featureCount: 1, blobs: { b_old: old }, note: 'with the old import', now: 1 })
    await appendVersion(h, { docJson: doc(2), featureCount: 2, blobs: { b_cur: cur }, now: 2 })
    const current = new Set([await hashOf(cur)])
    const files = historyFiles(h, current)
    expect(Object.keys(files).filter((k) => k.startsWith('history/blobs/'))).toEqual([`history/blobs/${await hashOf(old)}`])
    const zip = unzipSync(zipSync({ ...files, 'blobs/b_cur': cur, 'document.json': strToU8(doc(2)) }))
    const back = readHistory(Object.fromEntries(Object.entries(zip).filter(([k]) => k.startsWith('history/'))), { b_cur: zip['blobs/b_cur'] })
    expect(back.versions.map((v) => [v.n, v.note, v.features])).toEqual([[1, 'with the old import', 1], [2, '', 2]])
    expect(snapshotOf(back, 1)!.blobs.b_old).toEqual(old)
    expect(snapshotOf(back, 2)!.blobs.b_cur).toEqual(cur)
    expect(snapshotOf(back, 2)!.doc).toBe(doc(2))
  })

  it('reads a project without history, or with a damaged one, as empty', () => {
    expect(readHistory({}).versions).toEqual([])
    expect(readHistory({ 'history/index.json': strToU8('{not json') }).versions).toEqual([])
    // a version whose snapshot file is gone is dropped, the others stay
    const ok = JSON.stringify({ format: 1, versions: [{ n: 1, t: 1, note: '', features: 0, doc: 'aa', blobs: {} }, { n: 2, t: 2, note: '', features: 0, doc: 'bb', blobs: {} }] })
    const r = readHistory({ 'history/index.json': strToU8(ok), 'history/docs/bb.json': strToU8('{}') })
    expect(r.versions.map((v) => v.n)).toEqual([2])
  })

  describe('cap and prune', () => {
    it('keeps the newest versions and forgets what only they referenced', async () => {
      const h = emptyHistory()
      for (let i = 1; i <= 8; i++) await appendVersion(h, { docJson: doc(i), featureCount: i, blobs: { ['b' + i]: bytes(100, i) }, now: i })
      const dropped = pruneHistory(h, { maxVersions: 3, maxMB: 64 })
      expect(dropped).toBe(5)
      expect(h.versions.map((v) => v.n)).toEqual([6, 7, 8])
      expect(h.docs.size).toBe(3)
      expect(h.blobs.size).toBe(3)
      // numbers are never reused
      const next = await appendVersion(h, { docJson: doc(9), featureCount: 9, blobs: {}, now: 9 })
      expect(next.n).toBe(9)
    })

    it('drops the oldest until the stored size fits, and always keeps the newest version', async () => {
      const h = emptyHistory()
      const mb = 1024 * 1024
      for (let i = 1; i <= 5; i++) await appendVersion(h, { docJson: doc(1), featureCount: 1, blobs: { b: bytes(mb, i) }, now: i }) // 5 different 1 MB blobs
      pruneHistory(h, { maxVersions: 50, maxMB: 2.5 })
      expect(h.versions.map((v) => v.n)).toEqual([4, 5])
      pruneHistory(h, { maxVersions: 50, maxMB: 0 })
      expect(h.versions.map((v) => v.n)).toEqual([5])
    })

    it('blobs the project holds do not count against the cap', async () => {
      const h = emptyHistory()
      const mb = 1024 * 1024
      const live = bytes(mb, 3)
      for (let i = 1; i <= 4; i++) await appendVersion(h, { docJson: doc(i), featureCount: i, blobs: { live }, now: i })
      pruneHistory(h, { maxVersions: 50, maxMB: 0.5 }, new Set([await hashOf(live)]))
      expect(h.versions).toHaveLength(4)
    })

    it('has sensible defaults', () => {
      expect(DEFAULT_SETTINGS.maxVersions).toBeGreaterThanOrEqual(20)
      expect(DEFAULT_SETTINGS.maxMB).toBeGreaterThan(0)
    })
  })
})

describe('comparing two versions', () => {
  const snap = (text: string): SnapDoc => parseSnapshot(text)

  it('lists added, removed and changed features with what changed', () => {
    const a = snap(doc(2))
    const b = snap(JSON.stringify({ name: 'T', rollback: 2, features: [{ id: 'f1', type: 'box', name: 'Base', params: { width: 14 }, suppressed: true }, { id: 'f3', type: 'cylinder', name: 'Pin', params: { radius: 3 } }] }))
    const d = diffDocs(a, b)
    expect(d.same).toBe(false)
    expect(d.features.map((f) => [f.kind, f.id])).toEqual([['removed', 'f2'], ['changed', 'f1'], ['added', 'f3']])
    const changed = d.features.find((f) => f.id === 'f1')!
    expect(changed.changes.map((c) => c.key)).toEqual(['name', 'suppressed', 'width'])
    expect(changed.changes.find((c) => c.key === 'width')).toMatchObject({ from: 10, to: 14 })
  })

  it('finds parameter, configuration and rollback differences', () => {
    const a = snap(JSON.stringify({ features: [], userParams: [{ name: 'w', expr: '10' }, { name: 'gone', expr: '1' }], activeConfig: null, rollback: 0 }))
    const b = snap(JSON.stringify({ features: [], userParams: [{ name: 'w', expr: '12' }, { name: 'new', expr: '2' }], activeConfig: 'L', configs: [{ name: 'L', values: {} }], rollback: 0 }))
    const d = diffDocs(a, b)
    expect(d.parameters.map((p) => [p.key, p.from, p.to])).toEqual([['w', '10', '12'], ['gone', '1', undefined], ['new', undefined, '2']])
    expect(d.other.map((o) => o.key).sort()).toEqual(['activeConfig', 'configs'])
  })

  it('notices a feature that moved in the timeline', () => {
    const f = (id: string) => ({ id, type: 'box', name: id, params: {} })
    const d = diffDocs({ features: [f('a'), f('b'), f('c')] }, { features: [f('b'), f('c'), f('a')] })
    expect(d.features.map((x) => [x.kind, x.id])).toEqual([['moved', 'a']])
    expect(d.same).toBe(false)
  })

  it('says so when nothing differs', () => {
    expect(diffDocs(snap(doc(3)), snap(doc(3))).same).toBe(true)
  })
})
