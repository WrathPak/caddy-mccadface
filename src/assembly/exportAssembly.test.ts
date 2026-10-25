/** Assembly export on real OpenCascade: the STEP structure, the 3MF objects and the print plate, all from a built document. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/kernel/client', async () => {
  const { api } = await import('@/kernel/api')
  return { getKernel: () => api as never }
})

import { strFromU8, unzipSync } from 'fflate'
import { importSTEP } from 'replicad'
import { initOcc } from '@/kernel/occ'
import { initManifold } from '@/kernel/mesh'
import { api } from '@/kernel/api'
import { clearCache, regenerate } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { write3mf } from '@/io/threemf'
import { buildPlate } from '@/features/print/plate'
import '@/features/basic'
import { activateOcc, addJoint, instanceOf, newComponent, newJointDefaults, setGrounded } from './actions'
import { assemblyObjects, buildStepDefs, exportAssemblyStep } from './exportAssembly'
import { placeAssembly } from './instances'
import { useAssemblyRuntime } from './runtime'
import { bbox } from '@/kernel/types'

beforeAll(async () => { await Promise.all([initOcc(), initManifold()]) })
beforeEach(async () => {
  clearCache()
  useAssemblyRuntime.setState({ drive: {}, explode: 0 })
  useUi.setState({ hiddenIds: {}, selection: [] })
  useDoc.getState().newDocument()
  await regenerate()
})

const doc = () => useDoc.getState()
async function addBox(w: number, d: number, h: number, name: string, position = [0, 0, 0]) {
  const id = doc().addFeature('box', { width: w, depth: d, height: h, position } as never, name)
  await regenerate()
  return id
}

/** A base plate with a bolt component placed twice (one instance copied) plus a loose body in the root. */
async function build() {
  const loose = await addBox(8, 8, 8, 'Loose', [100, 0, 0])
  const base = newComponent('Base')
  await addBox(60, 20, 4, 'Plate')
  activateOcc(null)
  const bolt = newComponent('Bolt')
  await addBox(4, 4, 16, 'Shaft')
  activateOcc(null)
  const second = instanceOf(bolt.occ, 25)!
  return { loose, base, bolt, second }
}

describe('STEP assembly structure', () => {
  it('names the root after the document and every instance after its Browser node', async () => {
    await build()
    const worlds = placeAssembly(doc().assembly).worlds
    const { defs, root, skipped } = buildStepDefs({ assembly: doc().assembly, geometry: doc().geometry, bodyNames: doc().bodyNames, docName: 'Fixture', worlds })
    expect(skipped).toEqual([])
    const r = defs.find((d) => d.id === root)!
    expect(r.name).toBe('Fixture')
    expect(r.children.map((c) => c.name).sort()).toEqual(['Base', 'Bolt:1', 'Bolt:2', 'Loose'])
    // the two bolts are the same part, placed 25 apart
    const bolts = r.children.filter((c) => c.name.startsWith('Bolt'))
    expect(bolts[0].def).toBe(bolts[1].def)
    expect(Math.abs(bolts[1].matrix[12] - bolts[0].matrix[12])).toBeCloseTo(25, 9)
    expect(defs.filter((d) => d.solid)).toHaveLength(3) // Loose, Plate and Shaft: one solid each
  })

  it('writes a STEP file with the structure and reads back at the right positions', async () => {
    const { bolt } = await build()
    // pin the bolt to the plate: its axis at the plate's top, joint origins at their centers
    const plateOcc = doc().assembly.occurrences.find((o) => o.component !== bolt.def && o.name === 'Base')!
    setGrounded(plateOcc.id, true)
    const { bytes, parts, skipped } = await exportAssemblyStep()
    expect(parts).toBe(3)
    expect(skipped).toEqual([])
    const text = new TextDecoder().decode(bytes)
    for (const n of ["'Untitled'", "'Bolt:1'", "'Bolt:2'", "'Base'", "'Shaft'", "'Plate'", "'Loose'"]) expect(text).toContain(n)
    expect((text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE/g) ?? []).length).toBeGreaterThanOrEqual(4)
    const shape = await importSTEP(new Blob([bytes]))
    const m = shape.mesh({ tolerance: 0.1, angularTolerance: 0.3 })
    const bb = bbox(Float32Array.from(m.vertices))
    expect(bb.max[0]).toBeCloseTo(104, 3) // the loose box ends at 100 + 4
    expect(bb.min[0]).toBeCloseTo(-30, 3) // the plate is 60 wide, centred
  })

  it('instances of a component are occurrences of one shared product, checked in the STEP text and by reading it back', async () => {
    const c = newComponent('Pair')
    await addBox(10, 10, 4, 'Left')
    await addBox(10, 10, 4, 'Right', [20, 0, 0])
    activateOcc(null)
    instanceOf(c.occ, 50)
    instanceOf(c.occ, 100)
    const { bytes } = await exportAssemblyStep()
    const text = new TextDecoder().decode(bytes)
    const products = [...text.matchAll(/\bPRODUCT\('([^']*)'/g)].map((m) => m[1])
    // the document, ONE Pair, and its two solids: three instances do not make three Pair products
    expect(products.filter((n) => n === 'Pair')).toHaveLength(1)
    expect(products.sort()).toEqual(['Left', 'Pair', 'Right', 'Untitled'])
    // three occurrences of Pair in the document, and two parts in Pair
    expect((text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE/g) ?? []).length).toBe(3 + 2)
    for (const n of ["'Pair:1'", "'Pair:2'", "'Pair:3'"]) expect(text).toContain(n)
    // read back, every instance is where it was placed: Left spans -5..5 in the first Pair, Right ends at 25 + 100 in the last
    const shape = await importSTEP(new Blob([bytes]))
    const m = shape.mesh({ tolerance: 0.1, angularTolerance: 0.3 })
    const bb = bbox(Float32Array.from(m.vertices))
    expect(bb.min[0]).toBeCloseTo(-5, 3)
    expect(bb.max[0]).toBeCloseTo(125, 3)
    expect(shape.faces.length).toBe(6 * 2 * 3)
  })

  it('instances whose insides are placed differently get a product each', async () => {
    const c = newComponent('Arm')
    await addBox(10, 10, 4, 'Base')
    newComponent('Tip') // inside Arm
    await addBox(4, 4, 4, 'Cap', [0, 0, 4])
    activateOcc(null)
    const second = instanceOf(c.occ, 50)!
    // move the Tip of the second instance only (a joint inside one instance would do the same)
    const tip = doc().assembly.occurrences.find((o) => o.component === 'c2')!
    const worlds = placeAssembly(doc().assembly).worlds
    const moved = { ...worlds, [second + '/' + tip.id]: [...worlds[second + '/' + tip.id].slice(0, 12), 0, 30, 4, 1] }
    const { defs } = buildStepDefs({ assembly: doc().assembly, geometry: doc().geometry, bodyNames: {}, docName: 'D', worlds: moved })
    expect(defs.filter((d) => d.name === 'Arm')).toHaveLength(2)
    const same = buildStepDefs({ assembly: doc().assembly, geometry: doc().geometry, bodyNames: {}, docName: 'D', worlds })
    expect(same.defs.filter((d) => d.name === 'Arm')).toHaveLength(1)
  })

  it('leaves out hidden components and says which mesh bodies it skipped', async () => {
    const { second } = await build()
    const worlds = placeAssembly(doc().assembly).worlds
    const out = buildStepDefs({ assembly: doc().assembly, geometry: doc().geometry, bodyNames: doc().bodyNames, docName: 'D', worlds, hidden: { [second]: true } })
    expect(out.defs.find((d) => d.id === 'root')!.children.map((c) => c.name)).not.toContain('Bolt:2')
    const meshy = { ...doc().geometry[0], kind: 'mesh' as const }
    const skipped = buildStepDefs({ assembly: doc().assembly, geometry: [meshy, ...doc().geometry.slice(1)], bodyNames: {}, docName: 'D', worlds })
    expect(skipped.skipped).toHaveLength(1)
  })
})

describe('3MF and print plate', () => {
  it('gives one object per component instance at its current position', async () => {
    await build()
    const objects = await assemblyObjects()
    expect(objects.map((o) => o.name).sort()).toEqual(['Base', 'Bolt:1', 'Bolt:2', 'Loose'])
    const x = (n: string) => { const o = objects.find((q) => q.name === n)!; return bbox(o.mesh.positions) }
    expect(x('Bolt:2').min[0] - x('Bolt:1').min[0]).toBeCloseTo(25, 4)
    expect(x('Loose').min[0]).toBeCloseTo(96, 4)
    const files = unzipSync(write3mf(objects))
    const model = strFromU8(files['3D/3dmodel.model'])
    expect((model.match(/<object /g) ?? []).length).toBe(4)
    expect(model).toContain('name="Bolt:2"')
    expect((model.match(/<item /g) ?? []).length).toBe(4)
  })

  it('follows a joint: a turned component is exported turned', async () => {
    const base = newComponent('Base')
    await addBox(20, 20, 4, 'Plate')
    activateOcc(null)
    const arm = newComponent('Arm')
    await addBox(40, 4, 4, 'Bar', [20, 0, 0]) // runs from x = 0 to 40
    activateOcc(null)
    setGrounded(base.occ, true)
    addJoint({ name: 'Hinge', type: 'revolute', a: { occ: base.path, frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } }, b: { occ: arm.path, frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } }, flip: false, offset: [0, 0, 0], angle: 0, ...newJointDefaults('revolute'), values: { angle: 90 } })
    const objects = await assemblyObjects()
    const bar = bbox(objects.find((o) => o.name === 'Arm')!.mesh.positions)
    expect(bar.min[0]).toBeCloseTo(-2, 4)
    expect(bar.max[0]).toBeCloseTo(2, 4)
    expect(bar.max[1]).toBeCloseTo(40, 4) // the bar now points along +Y
  })

  it('the print plate takes the same objects, one per instance, and keeps their colors', async () => {
    await build()
    const plate = await buildPlate()
    expect(plate.count).toBe(4)
    const files = unzipSync(plate.bytes)
    const settings = strFromU8(files['Metadata/model_settings.config'])
    expect((settings.match(/<model_instance>/g) ?? []).length).toBe(4)
    for (const n of ['Base', 'Bolt:1', 'Bolt:2', 'Loose']) expect(settings).toContain(`value="${n}"`)
    void api
  })
})
