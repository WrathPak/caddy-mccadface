import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { parse3mfFast } from './threemfFast'
import { write3mf } from './threemf'
import { heightfield } from '../kernel/testMesh'
import { weld } from '../kernel/bigmesh'

const pack = (model: string) =>
  zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    '3D/3dmodel.model': strToU8(model),
  })

const tri = '<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles>'

describe('fast 3MF reader', () => {
  it('round-trips what the app writes (several objects)', () => {
    const a = heightfield(6), b = heightfield(3, 10)
    const bytes = write3mf([{ name: 'A & B', mesh: a }, { name: 'second', mesh: b }])
    const parts = parse3mfFast(bytes)
    expect(parts.map((p) => p.name)).toEqual(['A & B', 'second'])
    expect(parts[0].indices!.length / 3).toBe(72)
    expect(parts[1].indices!.length / 3).toBe(18)
    const w = weld(parts[0].positions, parts[0].indices)
    expect(w.positions.length).toBe(a.positions.length)
    expect(parts[0].positions[3]).toBeCloseTo(a.positions[3], 5)
  })

  it('applies the build transform and the model unit', () => {
    const bytes = pack(
      `<?xml version="1.0"?><model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh>${tri}</mesh></object></resources>` +
        `<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></build></model>`,
    )
    const [p] = parse3mfFast(bytes)
    expect([...p.positions.slice(0, 3)].map((v) => +v.toFixed(4))).toEqual([254, 508, 762])
    expect([...p.positions.slice(3, 6)].map((v) => +v.toFixed(4))).toEqual([279.4, 508, 762])
  })

  it('flattens component objects with their transforms and ignores unbuilt objects', () => {
    const bytes = pack(
      `<model unit="millimeter"><resources>` +
        `<object id="1"><mesh>${tri}</mesh></object>` +
        `<object id="2"><components><component objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 0"/><component objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object>` +
        `<object id="3"><mesh>${tri}</mesh></object>` +
        `</resources><build><item objectid="2"/></build></model>`,
    )
    const parts = parse3mfFast(bytes)
    expect(parts).toHaveLength(2)
    expect(parts[0].positions[3]).toBe(2) // scaled copy
    expect(parts[1].positions[0]).toBe(5) // shifted copy
  })

  it('reads attributes with single quotes, reordered attributes and exponents', () => {
    const bytes = pack(
      `<model><resources><object name='thing' id='7'><mesh><vertices><vertex z='3e0' y="-2.5" x="1e1"/><vertex x="0" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v3="2" v2="1" v1="0"/></triangles></mesh></object></resources><build><item objectid='7'/></build></model>`,
    )
    const [p] = parse3mfFast(bytes)
    expect(p.name).toBe('thing')
    expect([...p.positions.slice(0, 3)]).toEqual([10, -2.5, 3])
    expect([...p.indices!]).toEqual([0, 1, 2])
  })

  it('rejects files that are not 3MF or have no mesh', () => {
    expect(() => parse3mfFast(zipSync({ 'a.txt': strToU8('hi') }))).toThrow(/3MF/)
    expect(() => parse3mfFast(pack('<model><resources/><build/></model>'))).toThrow(/No mesh/)
    expect(() => parse3mfFast(pack(`<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices><triangles><triangle v1="0" v2="4" v3="0"/></triangles></mesh></object></resources></model>`))).toThrow(/vertex that does not exist/)
  })
})
