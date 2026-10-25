import { beforeEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { setRegenHandler, useDoc } from '@/doc/store'
import { commitSavedHistory, loadProject, parseProject, serializeProject } from '@/io/project'
import { historyData, resetHistory, useHistory } from './store'
import { snapshotOf } from './pack'
import { diffDocs, parseSnapshot } from './diff'

setRegenHandler(() => {}) // no kernel in Node: the document is edited without rebuilding

const box = (w: number) => ({ width: w, depth: 10, height: 10, position: [0, 0, 0] as [number, number, number] })

beforeEach(() => {
  useDoc.getState().newDocument()
  resetHistory()
  useHistory.setState({ settings: { maxVersions: 50, maxMB: 64 } })
})

describe('saving and opening a project with its history', () => {
  it('a save appends a version only once the file is written, and opening the file brings the versions back', async () => {
    const d = useDoc.getState()
    d.addFeature('box', box(10))
    const first = await serializeProject(false, { append: true, note: 'first' })
    expect(historyData().versions).toHaveLength(0) // not written yet
    commitSavedHistory(first)
    expect(historyData().versions.map((v) => [v.n, v.note, v.features])).toEqual([[1, 'first', 1]])

    useDoc.getState().addFeature('box', box(20))
    const second = await serializeProject(false, { append: true })
    commitSavedHistory(second)
    expect(historyData().versions.map((v) => v.n)).toEqual([1, 2])
    expect(Object.keys(unzipSync(second)).filter((k) => k.startsWith('history/')).length).toBeGreaterThan(2)
    expect(Object.keys(unzipSync(first)).some((k) => k.startsWith('history/'))).toBe(true)

    // a fresh session: nothing in memory, open the second file
    useDoc.getState().newDocument()
    resetHistory()
    loadProject(second)
    expect(historyData().versions.map((v) => [v.n, v.note])).toEqual([[1, 'first'], [2, '']])
    expect(useDoc.getState().features).toHaveLength(2)
    // version 1 is the document with one box
    const snap = snapshotOf(historyData(), 1)!
    expect(parseSnapshot(snap.doc).features).toHaveLength(1)
    expect(diffDocs(parseSnapshot(snapshotOf(historyData(), 1)!.doc), parseSnapshot(snapshotOf(historyData(), 2)!.doc)).features.map((f) => f.kind)).toEqual(['added'])
  })

  it('a save that was cancelled leaves the history alone, and autosave never adds a version', async () => {
    useDoc.getState().addFeature('box', box(10))
    await serializeProject(false, { append: true }) // the picker was cancelled: commitSavedHistory is never called
    expect(historyData().versions).toHaveLength(0)
    const auto = await serializeProject(false) // autosave
    commitSavedHistory(auto) // nothing pending for an autosave
    expect(historyData().versions).toHaveLength(0)
    // a later successful save only adds its own version
    const real = await serializeProject(false, { append: true })
    commitSavedHistory(real)
    expect(historyData().versions.map((v) => v.n)).toEqual([1])
  })

  it('the autosave copy carries the history, so a recovered project keeps its versions', async () => {
    useDoc.getState().addFeature('box', box(10))
    commitSavedHistory(await serializeProject(false, { append: true }))
    useDoc.getState().addFeature('box', box(12))
    const autosave = await serializeProject(false)
    useDoc.getState().newDocument()
    resetHistory()
    loadProject(autosave)
    expect(historyData().versions).toHaveLength(1)
    expect(useDoc.getState().features).toHaveLength(2)
  })

  it('keeps an import source for as long as a version needs it, and drops it when the cap lets the version go', async () => {
    const bytes = new Uint8Array(40_000).map((_, i) => (i * 31 + (i >> 5)) & 255)
    const d = useDoc.getState()
    const blob = d.addBlob(bytes)
    d.addFeature('importMesh', { blob, format: 'stl', fileName: 'x.stl', scale: 1 }, 'x')
    commitSavedHistory(await serializeProject(false, { append: true, note: 'with the import' }))
    // the import is deleted from the document, and another version is saved
    useDoc.getState().removeFeature('f1')
    const file = await serializeProject(false, { append: true, note: 'import gone' })
    commitSavedHistory(file)
    const files = unzipSync(file)
    expect(Object.keys(files).some((k) => k.startsWith('blobs/'))).toBe(false) // not in the project any more
    expect(Object.keys(files).filter((k) => k.startsWith('history/blobs/'))).toHaveLength(1) // but version 1 still has it
    // reopen and read version 1 back with the source bytes
    useDoc.getState().newDocument()
    resetHistory()
    loadProject(file)
    const snap = snapshotOf(historyData(), 1)!
    expect(Object.values(snap.blobs)[0]).toEqual(bytes)
    expect(parseProject(file).data.features).toHaveLength(0)
    // a cap of one version lets it go
    useHistory.setState({ settings: { maxVersions: 1, maxMB: 64 } })
    const small = await serializeProject(false, { append: true })
    commitSavedHistory(small)
    expect(historyData().versions).toHaveLength(1)
    expect(Object.keys(unzipSync(small)).some((k) => k.startsWith('history/blobs/'))).toBe(false)
  })
})
