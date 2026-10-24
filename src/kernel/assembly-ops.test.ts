/** Interference and the STEP assembly writer on real OpenCascade + manifold. */
import { beforeAll, describe, expect, it } from 'vitest'
import { importSTEP } from 'replicad'
import { box, initOcc } from './occ'
import { initManifold } from './mesh'
import { bodyFromShape } from './store'
import { interference, writeStepAssembly } from './assembly-ops'
import { translation } from '@/assembly/matrix'
import { bbox } from './types'

beforeAll(async () => { await Promise.all([initOcc(), initManifold()]) })

const mk = (id: string, size: [number, number, number], at: [number, number, number] = [0, 0, 0]) => bodyFromShape(id, id, box(size, at))

describe('interference', () => {
  it('finds the overlapping volume of two boxes and its bounds', async () => {
    const a = mk('a', [10, 10, 10]), b = mk('b', [10, 10, 10])
    const r = await interference([
      { id: 'a', key: a.key, matrix: translation([0, 0, 0]), group: 'a' },
      { id: 'b', key: b.key, matrix: translation([6, 4, 0]), group: 'b' },
    ])
    expect(r.hits).toHaveLength(1)
    const h = r.hits[0]
    expect(h.volume).toBeCloseTo(4 * 6 * 10, 3) // 4 x 6 x 10 overlap (the boxes are 10 wide, 6 and 4 apart)
    expect(h.min.map((v) => Math.round(v * 1000) / 1000)).toEqual([1, -1, 0])
    expect(h.max.map((v) => Math.round(v * 1000) / 1000)).toEqual([5, 5, 10])
    expect(h.indices.length).toBeGreaterThan(0)
  })

  it('does not report parts that only touch, or that are far apart', async () => {
    const a = mk('a', [10, 10, 10]), b = mk('b', [10, 10, 10]), c = mk('c', [10, 10, 10])
    const r = await interference([
      { id: 'a', key: a.key, matrix: translation([0, 0, 0]), group: 'a' },
      { id: 'b', key: b.key, matrix: translation([10, 0, 0]), group: 'b' }, // shares a face with a
      { id: 'c', key: c.key, matrix: translation([100, 0, 0]), group: 'c' },
    ])
    expect(r.hits).toEqual([])
    expect(r.checked).toBe(1) // only a-b are close enough to need the boolean
  })

  it('skips bodies of the same component and checks instances against each other', async () => {
    const a = mk('a', [10, 10, 10])
    const same = await interference([
      { id: 'a1', key: a.key, matrix: translation([0, 0, 0]), group: 'g' },
      { id: 'a2', key: a.key, matrix: translation([5, 0, 0]), group: 'g' },
    ])
    expect(same.hits).toEqual([])
    const inst = await interference([
      { id: 'a1', key: a.key, matrix: translation([0, 0, 0]), group: 'o1' },
      { id: 'a2', key: a.key, matrix: translation([5, 0, 0]), group: 'o2' },
    ])
    expect(inst.hits).toHaveLength(1)
    expect(inst.hits[0].volume).toBeCloseTo(5 * 10 * 10, 3)
  })
})

describe('STEP assembly', () => {
  it('writes components as products and instances as occurrences, with their names and positions', async () => {
    const plate = mk('plate', [40, 40, 4])
    const peg = mk('peg', [4, 4, 12])
    const buf = await writeStepAssembly(
      [
        { id: 'root', name: 'Fixture', bodies: [], children: [
          { def: 'base', name: 'Base:1', matrix: translation([0, 0, 0]) },
          { def: 'pegc', name: 'Peg:1', matrix: translation([10, 10, 4]) },
          { def: 'pegc', name: 'Peg:2', matrix: translation([26, 10, 4]) },
        ] },
        { id: 'base', name: 'Base', bodies: [{ key: plate.key, name: 'Plate' }], children: [] },
        { id: 'pegc', name: 'Peg', bodies: [{ key: peg.key, name: 'Pin' }], children: [] },
      ],
      'root',
    )
    const text = new TextDecoder().decode(buf)
    expect(text).toContain('ISO-10303-21')
    for (const n of ['Fixture', 'Base', 'Peg']) expect(text).toContain(`'${n}'`)
    // three occurrences of components inside Fixture (plus the body occurrences inside Base and Peg)
    const usages = text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE/g) ?? []
    expect(usages.length).toBe(3 + 1 + 1)
    // only two product definitions for the pegs' geometry: the instances share one
    expect((text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length).toBe(2)

    // reading it back puts the pegs where the matrices said
    const shape = await importSTEP(new Blob([buf]))
    const m = shape.mesh({ tolerance: 0.1, angularTolerance: 0.3 })
    const bb = bbox(Float32Array.from(m.vertices))
    // box() is centred on x and y: the plate spans -20..20 and the pegs stand on its 4 mm top
    expect(bb.min.map((v) => Math.round(v))).toEqual([-20, -20, 0])
    expect(bb.max.map((v) => Math.round(v))).toEqual([28, 20, 16])
    expect(shape.faces.length).toBe(6 + 6 + 6)
  })

  it('refuses a component that contains itself', async () => {
    await expect(writeStepAssembly([{ id: 'r', name: 'R', bodies: [], children: [{ def: 'r', name: 'R:1', matrix: translation([0, 0, 0]) }] }], 'r')).rejects.toThrow(/contains itself/)
  })
})
