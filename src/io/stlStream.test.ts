import { describe, expect, it } from 'vitest'
import { isBinaryStl, parseStlSoup } from './stlStream'
import { writeStl, parseStl } from './stl'
import { heightfield } from '../kernel/testMesh'

const sample = () => heightfield(12) // 288 triangles

describe('streaming STL parse', () => {
  it('reads a binary STL the same way for any chunk size (records split across chunks)', async () => {
    const t = sample()
    const bytes = writeStl([t])
    const ref = parseStl(bytes)[0].positions
    expect(await isBinaryStl(bytes)).toBe(true)
    for (const chunk of [50, 7, 83, 1000, 4 << 20]) {
      const soup = await parseStlSoup(bytes, undefined, chunk)
      expect(soup.length).toBe(ref.length)
      expect(soup).toEqual(ref)
    }
  })

  it('streams a Blob', async () => {
    const bytes = writeStl([sample()])
    const soup = await parseStlSoup(new Blob([bytes as BlobPart]))
    expect(soup.length).toBe(288 * 9)
  })

  it('reports progress up to 1', async () => {
    const bytes = writeStl([sample()])
    const seen: number[] = []
    await parseStlSoup(bytes, (f) => seen.push(f), 1000)
    expect(seen.length).toBeGreaterThan(3)
    expect(seen[seen.length - 1]).toBe(1)
  })

  it('reads ASCII STL, also split mid-line', async () => {
    const lines = ['solid test']
    const tris = [[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 1], [1.5e0, 0, 1], [0, -2.25, 1]]]
    for (const t of tris) {
      lines.push('  facet normal 0 0 1', '    outer loop')
      for (const v of t) lines.push(`      vertex ${v.join(' ')}`)
      lines.push('    endloop', '  endfacet')
    }
    lines.push('endsolid test')
    const bytes = new TextEncoder().encode(lines.join('\r\n') + '\r\n')
    expect(await isBinaryStl(bytes)).toBe(false)
    for (const chunk of [5, 31, 4096]) {
      const soup = await parseStlSoup(bytes, undefined, chunk)
      expect([...soup]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1.5, 0, 1, 0, -2.25, 1])
    }
  })

  it('a binary file whose header starts with "solid" is still binary', async () => {
    const bytes = writeStl([sample()])
    new TextEncoder().encodeInto('solid exported by something', bytes.subarray(0, 80))
    expect(await isBinaryStl(bytes)).toBe(true)
    expect((await parseStlSoup(bytes)).length).toBe(288 * 9)
  })

  it('rejects an empty or cut off file', async () => {
    await expect(parseStlSoup(new Uint8Array(10))).rejects.toThrow(/No triangles/)
    const bytes = new TextEncoder().encode('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\nendsolid x\n')
    await expect(parseStlSoup(bytes)).rejects.toThrow(/cut off/)
  })
})
