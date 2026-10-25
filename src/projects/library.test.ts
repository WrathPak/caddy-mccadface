import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { MemDir } from './memfs'
import { cleanName, createFolder, createProject, duplicateProject, emptyProjectBytes, filterNodes, flatten, listTrash, renameProject, restoreFromTrash, scanLibrary, TRASH, trashProject, uniqueName } from './library'
import { readThumbnail, readZipEntry } from './zipThumb'
import { parseProject } from '@/io/project'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8])
const withThumb = (extra: Record<string, Uint8Array> = {}) => zipSync({ 'document.json': strToU8('{"name":"x","features":[]}'), 'thumbnail.png': png, ...extra })

for (const withMove of [true, false]) {
  describe(`project folder (${withMove ? 'with' : 'without'} native move)`, () => {
    const mk = () => new MemDir('Projects', withMove)

    it('lists projects in folders, skipping the trash and hidden folders, folders first', async () => {
      const root = mk()
      root.add('b.caddy', withThumb(), 2000).add('A.caddy', withThumb(), 1000).add('notes.txt', 'x')
      const sub = await root.getDirectoryHandle('Brackets', { create: true })
      sub.add('hinge.caddy', withThumb(), 3000)
      await root.getDirectoryHandle('.caddy-trash', { create: true })
      ;(await root.getDirectoryHandle('.git', { create: true })).add('x.caddy', 'x')
      await root.getDirectoryHandle('Empty', { create: true })
      const tree = await scanLibrary(root)
      expect(tree.children.map((c) => [c.kind, c.name])).toEqual([['dir', 'Brackets'], ['dir', 'Empty'], ['file', 'A.caddy'], ['file', 'b.caddy']])
      const all = flatten(tree)
      expect(all.map((f) => f.name).sort()).toEqual(['A.caddy', 'b.caddy', 'hinge.caddy'])
      expect(all.find((f) => f.name === 'hinge.caddy')!.path).toEqual(['Brackets'])
      expect(all.find((f) => f.name === 'A.caddy')!.modified).toBe(1000)
    })

    it('searches name and folder, newest first', async () => {
      const root = mk()
      root.add('Gear box.caddy', 'x', 1).add('Lid.caddy', 'x', 3)
      ;(await root.getDirectoryHandle('Gears', { create: true })).add('Small.caddy', 'x', 2)
      const all = flatten(await scanLibrary(root))
      expect(filterNodes(all, 'gear').map((f) => f.name)).toEqual(['Small.caddy', 'Gear box.caddy'])
      expect(filterNodes(all, 'GEAR small').map((f) => f.name)).toEqual(['Small.caddy'])
      expect(filterNodes(all, '   ')).toHaveLength(3)
      expect(filterNodes(all, 'nothing')).toEqual([])
    })

    it('makes new projects with free names, and what it makes opens', async () => {
      const root = mk()
      const a = await createProject(root)
      const b = await createProject(root)
      expect([a.name, b.name]).toEqual(['Untitled.caddy', 'Untitled 2.caddy'])
      const bytes = new Uint8Array(await (await a.getFile()).arrayBuffer())
      expect(parseProject(bytes).data.features).toEqual([])
      expect(parseProject(emptyProjectBytes('Hello')).data.name).toBe('Hello')
      expect(await uniqueName(root, 'Untitled')).toBe('Untitled 3.caddy')
    })

    it('cleans names so they are safe on every file system', () => {
      expect(cleanName('  a/b:c*d?  ')).toBe('abcd')
      expect(cleanName('...hidden')).toBe('hidden')
      expect(cleanName('trailing. ')).toBe('trailing')
      expect(cleanName('///')).toBe('')
    })

    it('duplicates with a copy name and the same bytes', async () => {
      const root = mk()
      root.add('Part.caddy', withThumb())
      const src = await root.getFileHandle('Part.caddy')
      const copy = await duplicateProject(root, src)
      const again = await duplicateProject(root, src)
      expect([copy.name, again.name]).toEqual(['Part copy.caddy', 'Part copy 2.caddy'])
      expect(new Uint8Array(await (await copy.getFile()).arrayBuffer())).toEqual(withThumb())
      expect(root.names()).toEqual(['Part copy 2.caddy', 'Part copy.caddy', 'Part.caddy'])
    })

    it('renames, keeping the content, and refuses a name that is taken', async () => {
      const root = mk()
      root.add('Old.caddy', withThumb()).add('Taken.caddy', 'x')
      const f = await renameProject(root, await root.getFileHandle('Old.caddy'), 'New: name')
      expect(f.name).toBe('New name.caddy')
      expect(root.names()).toEqual(['New name.caddy', 'Taken.caddy'])
      expect(new Uint8Array(await (await f.getFile()).arrayBuffer())).toEqual(withThumb())
      await expect(renameProject(root, f, 'Taken')).rejects.toThrow(/already there/)
      await expect(renameProject(root, f, '///')).rejects.toThrow(/name/)
    })

    it('delete moves the file into .caddy-trash, never removes it, and it can come back', async () => {
      const root = mk()
      root.add('Keep me.caddy', withThumb())
      const sub = await root.getDirectoryHandle('Sub', { create: true })
      sub.add('Keep me.caddy', 'other')
      const f = await root.getFileHandle('Keep me.caddy')
      const name = await trashProject(root, root, f)
      expect(name).toBe('Keep me.caddy')
      expect(root.names()).toEqual([])
      const again = await trashProject(root, sub, await sub.getFileHandle('Keep me.caddy'))
      expect(again).toBe('Keep me 2.caddy') // a second file of the same name does not overwrite the first
      const trash = await listTrash(root)
      expect(trash.map((t) => t.name).sort()).toEqual(['Keep me 2.caddy', 'Keep me.caddy'])
      expect(root.dirs.get(TRASH)!.names()).toHaveLength(2)
      // the trashed folder is not listed as a project folder
      expect(flatten(await scanLibrary(root))).toEqual([])
      const back = await restoreFromTrash(root, 'Keep me.caddy')
      expect(back.name).toBe('Keep me.caddy')
      expect(new Uint8Array(await (await back.getFile()).arrayBuffer())).toEqual(withThumb())
      expect((await listTrash(root)).map((t) => t.name)).toEqual(['Keep me 2.caddy'])
    })

    it('creates folders and refuses duplicates and hidden names', async () => {
      const root = mk()
      const d = await createFolder(root, 'Brackets')
      expect(d.name).toBe('Brackets')
      await expect(createFolder(root, 'Brackets')).rejects.toThrow(/already/)
      await expect(createFolder(root, '.secret')).rejects.toThrow()
    })
  })
}

describe('thumbnails straight from the zip', () => {
  it('reads thumbnail.png without the rest of the file, stored or compressed', async () => {
    let seed = 12345
    const big = new Uint8Array(300_000).map(() => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 255) // does not compress
    const bytes = withThumb({ 'blobs/big': big })
    let touched = 0
    const blob = new Blob([bytes as BlobPart])
    // count how much of the file is actually read
    const spy: Blob = Object.create(blob, {
      slice: { value: (a?: number, b?: number) => { touched += (b ?? blob.size) - (a ?? 0); return blob.slice(a, b) } },
      size: { value: blob.size },
    })
    const t = await readThumbnail(spy)
    expect(t).toBeTruthy()
    expect(new Uint8Array(await t!.arrayBuffer())).toEqual(png)
    expect(touched).toBeLessThan(bytes.length / 2)
    // a compressed entry
    const z = zipSync({ 'thumbnail.png': [new Uint8Array(5000).fill(5), { level: 9 }] })
    expect(await readZipEntry(new Blob([z as BlobPart]), 'thumbnail.png')).toEqual(new Uint8Array(5000).fill(5))
  })

  it('returns null when there is no thumbnail or the file is not a zip', async () => {
    expect(await readThumbnail(new Blob([zipSync({ 'document.json': strToU8('{}') }) as BlobPart]))).toBeNull()
    expect(await readThumbnail(new Blob(['not a zip file at all, just text']))).toBeNull()
    expect(await readThumbnail(new Blob([]))).toBeNull()
  })
})
