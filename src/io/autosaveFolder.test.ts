import { describe, expect, it } from 'vitest'
import { MemDir } from '@/projects/memfs'
import { AUTOSAVE_DIR, newestCopy, parseSlot, slotName, sweepSwapFiles, writeAutosave } from './autosaveFolder'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = async (dir: MemDir, name: string) => new TextDecoder().decode(new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer()))
const autosaveDir = async (root: MemDir) => (await root.getDirectoryHandle(AUTOSAVE_DIR)) as MemDir

describe('autosave folder', () => {
  it('names slots and reads them back', () => {
    expect(slotName('Box', 0)).toBe('Box.caddy')
    expect(slotName('Box', 2)).toBe('Box~2.caddy')
    expect(parseSlot('Box~2.caddy')).toEqual({ base: 'Box', k: 2 })
    expect(parseSlot('v1.2.caddy')).toEqual({ base: 'v1.2', k: 0 })
    expect(parseSlot('notes.txt')).toBeNull()
  })

  it('writes <doc name>.caddy into an Autosave folder of the projects folder', async () => {
    const root = new MemDir('Projects')
    const file = await writeAutosave(root, 'Bracket', bytes('one'), 3)
    expect(file).toBe('Bracket.caddy')
    expect(root.names()).toEqual([]) // nothing in the projects folder itself
    expect((await autosaveDir(root)).names()).toEqual(['Bracket.caddy'])
    expect(await text(await autosaveDir(root), 'Bracket.caddy')).toBe('one')
  })

  it('keeps the last N copies and prunes older ones', async () => {
    const root = new MemDir('Projects')
    for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) await writeAutosave(root, 'Bracket', bytes(v), 3)
    const dir = await autosaveDir(root)
    expect(dir.names()).toEqual(['Bracket.caddy', 'Bracket~1.caddy', 'Bracket~2.caddy'])
    expect(await text(dir, 'Bracket.caddy')).toBe('v5')
    expect(await text(dir, 'Bracket~1.caddy')).toBe('v4')
    expect(await text(dir, 'Bracket~2.caddy')).toBe('v3')
  })

  it('lowering the number to keep trims what is already there, and a raised one fills up again', async () => {
    const root = new MemDir('Projects')
    for (const v of ['a', 'b', 'c', 'd']) await writeAutosave(root, 'Doc', bytes(v), 4)
    const dir = await autosaveDir(root)
    expect(dir.names()).toHaveLength(4)
    await writeAutosave(root, 'Doc', bytes('e'), 2)
    expect(dir.names()).toEqual(['Doc.caddy', 'Doc~1.caddy'])
    expect(await text(dir, 'Doc~1.caddy')).toBe('d')
    await writeAutosave(root, 'Doc', bytes('f'), 1)
    expect(dir.names()).toEqual(['Doc.caddy'])
  })

  it('keeps documents apart and cleans unsafe names', async () => {
    const root = new MemDir('Projects')
    await writeAutosave(root, 'A', bytes('a'), 2)
    await writeAutosave(root, 'B', bytes('b'), 2)
    await writeAutosave(root, 'a/b:c?', bytes('x'), 2)
    await writeAutosave(root, '   ', bytes('y'), 2)
    expect((await autosaveDir(root)).names()).toEqual(['A.caddy', 'B.caddy', 'Untitled.caddy', 'abc.caddy'])
  })

  it('never replaces the persons own saved file, even one saved into the Autosave folder', async () => {
    const root = new MemDir('Projects')
    await writeAutosave(root, 'Gear', bytes('first autosave'), 3)
    const dir = await autosaveDir(root)
    const own = await dir.getFileHandle('Gear.caddy') // the person opened it from the Projects panel and saves back to it
    const isProtected = async (f: unknown) => f === own
    await writeAutosave(root, 'Gear', bytes('their edit, autosaved'), 3, { isProtected })
    expect(await text(dir, 'Gear.caddy')).toBe('first autosave')
    expect(await text(dir, 'Gear (autosave).caddy')).toBe('their edit, autosaved')
    // and it keeps going to the side file afterwards
    await writeAutosave(root, 'Gear', bytes('more'), 3, { isProtected })
    expect(await text(dir, 'Gear.caddy')).toBe('first autosave')
    expect(await text(dir, 'Gear (autosave).caddy')).toBe('more')
    expect(await text(dir, 'Gear (autosave)~1.caddy')).toBe('their edit, autosaved')
  })

  it('a failed write leaves no half file and no empty new file, and the old copy stays whole', async () => {
    const root = new MemDir('Projects')
    await writeAutosave(root, 'Doc', bytes('good'), 2)
    const dir = await autosaveDir(root)
    const real = dir.getFileHandle.bind(dir)
    let aborted = 0
    dir.getFileHandle = (async (name: string, o?: { create?: boolean }) => {
      const h = await real(name, o)
      return { ...h, kind: 'file', name: h.name, getFile: () => h.getFile(), createWritable: async () => ({
        write: async () => { throw new Error('disk full') },
        close: async () => {},
        abort: async () => { aborted++ },
      }) }
    }) as unknown as typeof dir.getFileHandle
    await expect(writeAutosave(root, 'Doc', bytes('new'), 2)).rejects.toThrow('disk full')
    expect(aborted).toBeGreaterThan(0)
    dir.getFileHandle = real
    expect(await text(dir, 'Doc.caddy')).toBe('good')
    // the rotation copy that failed did not leave an empty ~1 file
    expect(dir.names()).toEqual(['Doc.caddy'])
    // a brand new document that fails leaves nothing at all
    dir.getFileHandle = (async (name: string, o?: { create?: boolean }) => {
      const h = await real(name, o)
      return { ...h, kind: 'file', name: h.name, getFile: () => h.getFile(), createWritable: async () => ({ write: async () => { throw new Error('nope') }, close: async () => {} }) }
    }) as unknown as typeof dir.getFileHandle
    await expect(writeAutosave(root, 'Other', bytes('x'), 2)).rejects.toThrow('nope')
    dir.getFileHandle = real
    expect(dir.names()).toEqual(['Doc.caddy'])
  })

  it('finds the newest current copy, ignoring older versions and other files', async () => {
    const root = new MemDir('Projects')
    expect(await newestCopy(root)).toBeNull()
    const dir = await root.getDirectoryHandle(AUTOSAVE_DIR, { create: true })
    dir.add('Old.caddy', 'old', 1000).add('New.caddy', 'new', 5000).add('New~1.caddy', 'newer-looking version', 9000).add('x.txt', 'z', 9999)
    const c = await newestCopy(root)
    expect(c).toMatchObject({ name: 'New', file: 'New.caddy', savedAt: 5000 })
    expect(new TextDecoder().decode(c!.bytes)).toBe('new')
  })

  it('sweeps swap files a crashed tab left behind, and nothing else', async () => {
    const root = new MemDir('Projects')
    const dir = await root.getDirectoryHandle(AUTOSAVE_DIR, { create: true })
    dir.add('Doc.caddy', 'a').add('Doc.caddy.crswap', 'half')
    expect(await sweepSwapFiles(root)).toBe(1)
    expect(dir.names()).toEqual(['Doc.caddy'])
    expect(await sweepSwapFiles(new MemDir('Empty'))).toBe(0)
  })
})
