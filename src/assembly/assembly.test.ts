/**
 * The component tree end to end: real features, the real regeneration engine and real OpenCascade, in Node.
 * Components, instances, joints snapped to geometry, saving / opening (including documents from before assemblies),
 * and linked / embedded components.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/kernel/client', async () => {
  const { api } = await import('@/kernel/api')
  return { getKernel: () => api as never }
})

import { makeCylinder } from 'replicad'
import { initOcc } from '@/kernel/occ'
import { bodyFromShape } from '@/kernel/store'
import { clearCache, regenerate } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import { decodeRef } from '@/doc/refs'
import { serializeProject } from '@/io/project'
import { parseProject } from '@/io/projectParse'
import { strToU8, zipSync } from 'fflate'
import '@/features/basic'
import {
  activateOcc, addJoint, componentsFromBodies, deleteJoint, deleteOccurrence, instanceOf, newComponent, newJointDefaults, renameComponent, setGrounded,
} from './actions'
import { applyExternalUpdate, checkExternals, dismissExternalUpdate, insertExternal, setExternalSource } from './external'
import { expandInstances, placeAssembly } from './instances'
import { originOf, point } from './matrix'
import { useAssemblyRuntime } from './runtime'
import { persistentName, resolveSnap, snapFrame, snapPoints, snapSpec } from './snaps'
import { ROOT } from './types'

beforeAll(async () => { await initOcc() })
beforeEach(async () => {
  clearCache()
  setExternalSource('e1', null)
  useAssemblyRuntime.setState({ extChanged: {}, extErrors: {}, drive: {} })
  useDoc.getState().newDocument()
  await regenerate()
})

const doc = () => useDoc.getState()
const box = (w: number, d: number, h: number, position = [0, 0, 0]) => ({ width: w, depth: d, height: h, position })
async function addBox(p: ReturnType<typeof box>, name?: string) {
  const id = doc().addFeature('box', p as never, name)
  await regenerate()
  return id
}

describe('components', () => {
  it('a new document is a single root component and nothing else', () => {
    expect(doc().assembly.components.map((c) => c.id)).toEqual([ROOT])
    expect(doc().assembly.occurrences).toEqual([])
    expect(doc().activeOcc).toBeNull()
  })

  it('features go into the active component, and so do the bodies they make', async () => {
    const rootBox = await addBox(box(10, 10, 10))
    const { def, occ } = newComponent('Arm')
    expect(doc().activeOcc).toBe(occ)
    const armBox = await addBox(box(20, 5, 5))
    const f = (id: string) => doc().features.find((x) => x.id === id)!
    expect(f(rootBox).component).toBeUndefined()
    expect(f(armBox).component).toBe(def)
    const bodies = Object.fromEntries(doc().geometry.map((b) => [b.id, b.component]))
    expect(bodies[rootBox]).toBeUndefined()
    expect(bodies[armBox]).toBe(def)
    activateOcc(null)
    const another = await addBox(box(3, 3, 3))
    expect(f(another).component).toBeUndefined()
  })

  it('Create Components from Bodies moves each body and its feature into a component of its own', async () => {
    const a = await addBox(box(10, 10, 10), 'Left')
    const b = await addBox(box(10, 10, 10, [30, 0, 0]), 'Right')
    const made = componentsFromBodies([a, b])
    expect(made).toHaveLength(2)
    const asm = doc().assembly
    expect(asm.components.filter((c) => c.id !== ROOT).map((c) => c.name)).toEqual(['Left', 'Right'])
    expect(asm.bodyOwner[a]).toBe(asm.occurrences[0].component)
    expect(doc().features.find((f) => f.id === a)!.component).toBe(asm.occurrences[0].component)
    // the bodies stay where they were, now one instance each
    const inst = expandInstances(asm, doc().geometry, placeAssembly(asm).worlds)
    expect(inst.map((i) => [i.body.id, i.occ])).toEqual([[a, asm.occurrences[0].id], [b, asm.occurrences[1].id]])
    expect(doc().geometry.length).toBe(2)
  })

  it('instances share the geometry of their component', async () => {
    const { occ } = newComponent('Bolt')
    await addBox(box(4, 4, 20))
    const second = instanceOf(occ, 25)!
    const asm = doc().assembly
    expect(asm.components.filter((c) => c.id !== ROOT)).toHaveLength(1)
    const inst = expandInstances(asm, doc().geometry, placeAssembly(asm).worlds)
    expect(inst).toHaveLength(2)
    expect(inst[0].body).toBe(inst[1].body) // the very same body object
    expect(point(inst[1].world, [0, 0, 0])[0] - point(inst[0].world, [0, 0, 0])[0]).toBeCloseTo(25, 9)
    expect(second).not.toBe(occ)
    // editing the component changes both instances (one body, regenerated once)
    doc().updateFeature(doc().features[0].id, box(4, 4, 40) as never)
    await regenerate()
    expect(doc().geometry).toHaveLength(1)
    const p = doc().geometry[0].mesh.positions
    expect(Math.max(...Array.from({ length: p.length / 3 }, (_, i) => p[i * 3 + 2]))).toBeCloseTo(40, 6)
  })

  it('renaming a component keeps its identity; deleting the last instance removes its features', async () => {
    const { def, occ } = newComponent('Part')
    await addBox(box(5, 5, 5))
    renameComponent(def, 'Housing')
    expect(doc().assembly.components.find((c) => c.id === def)!.name).toBe('Housing')
    const second = instanceOf(occ)!
    deleteOccurrence(second)
    expect(doc().features).toHaveLength(1) // another instance remains
    deleteOccurrence(occ)
    expect(doc().features).toHaveLength(0)
    expect(doc().assembly.components.map((c) => c.id)).toEqual([ROOT])
    await regenerate()
    expect(doc().geometry).toHaveLength(0)
    doc().undo()
    await regenerate()
    expect(doc().geometry).toHaveLength(1)
    expect(doc().assembly.occurrences.map((o) => o.id)).toContain(occ)
  })

  it('nested components place their children inside the parent', async () => {
    const outer = newComponent('Outer')
    const inner = newComponent('Inner') // created while Outer is active: a child of it
    expect(doc().assembly.occurrences.find((o) => o.id === inner.occ)!.parent).toBe(outer.def)
    expect(inner.path).toBe(`${outer.occ}/${inner.occ}`)
    await addBox(box(2, 2, 2))
    doc().commit('move outer', (d) => ({ ...d, assembly: { ...d.assembly, occurrences: d.assembly.occurrences.map((o) => (o.id === outer.occ ? { ...o, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 50, 0, 0, 1] } : o)) } }))
    const asm = doc().assembly
    const inst = expandInstances(asm, doc().geometry, placeAssembly(asm).worlds)
    expect(inst).toHaveLength(1)
    expect(originOf(inst[0].world)[0]).toBe(50)
    expect(inst[0].path).toBe(`${outer.occ}/${inner.occ}`)
  })

  it('an instance of a component brings everything inside it, as instances too', async () => {
    const outer = newComponent('Outer')
    await addBox(box(10, 10, 2))
    newComponent('Pin') // inside Outer
    await addBox(box(2, 2, 8, [3, 0, 2]))
    activateOcc(null)
    const copy = instanceOf(outer.occ, 40)!
    const asm = doc().assembly
    const inst = expandInstances(asm, doc().geometry, placeAssembly(asm).worlds)
    expect(inst.map((i) => i.path).sort()).toEqual([outer.occ, `${outer.occ}/o2`, copy, `${copy}/o2`].sort())
    const pins = inst.filter((i) => i.path.endsWith('/o2'))
    expect(pins[0].body).toBe(pins[1].body)
    expect(Math.abs(originOf(pins[1].world)[0] - originOf(pins[0].world)[0])).toBe(40)
    // deleting the copy removes only its instances
    deleteOccurrence(copy)
    expect(expandInstances(doc().assembly, doc().geometry, placeAssembly(doc().assembly).worlds)).toHaveLength(2)
    // deleting the pin from the component removes it from every instance and drops its feature
    deleteOccurrence(`${outer.occ}/o2`)
    expect(doc().features).toHaveLength(1)
  })
})

describe('documents', () => {
  it('a document saved before assemblies opens as a single root component, unchanged', async () => {
    const legacy = zipSync({
      'document.json': strToU8(JSON.stringify({
        format: 1, app: 'CADdy McCADFace', name: 'Old', rollback: 1, userParams: [], bodyNames: {}, configs: [], activeConfig: null,
        features: [{ id: 'f1', type: 'box', name: 'Box1', suppressed: false, params: box(12, 12, 12) }],
      })),
    })
    const { data, blobs } = parseProject(legacy)
    expect(data.assembly.components.map((c) => c.id)).toEqual([ROOT])
    expect(data.features[0].component).toBeUndefined()
    clearCache()
    doc().loadDocument(data, blobs)
    await regenerate()
    expect(doc().geometry).toHaveLength(1)
    expect(doc().geometry[0].component).toBeUndefined()
    // saving it again keeps the document readable and the same
    const again = parseProject(await serializeProject(false))
    expect(again.data.features.map((f) => [f.id, f.type, f.params])).toEqual(data.features.map((f) => [f.id, f.type, f.params]))
  })

  it('saves and reopens the component tree, instances, joints and links', async () => {
    const base = newComponent('Base')
    await addBox(box(40, 40, 5))
    activateOcc(null) // a new component made while Base is active would be inside it
    const arm = newComponent('Arm')
    await addBox(box(4, 4, 30))
    instanceOf(arm.occ, 10)
    setGrounded(base.occ, true)
    addJoint({ name: 'Hinge', type: 'revolute', a: { occ: base.occ, frame: { origin: [0, 0, 5], z: [0, 0, 1], x: [1, 0, 0] } }, b: { occ: arm.occ, frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } }, flip: false, offset: [0, 0, 0], angle: 0, ...newJointDefaults('revolute') })
    const before = doc().assembly
    const bytes = await serializeProject(false)
    clearCache()
    const { data, blobs } = parseProject(bytes)
    expect(data.assembly).toEqual(JSON.parse(JSON.stringify(before)))
    expect(data.features.map((f) => f.component)).toEqual([base.def, arm.def])
    doc().loadDocument(data, blobs)
    await regenerate()
    expect(doc().assembly.joints).toHaveLength(1)
    expect(doc().geometry.map((b) => b.component)).toEqual([base.def, arm.def])
    expect(doc().activeOcc).toBeNull()
  })

  it('removing a joint leaves the parts where the joint had put them', async () => {
    const a = newComponent('A')
    await addBox(box(10, 10, 10))
    activateOcc(null)
    const b = newComponent('B')
    await addBox(box(10, 10, 10))
    setGrounded(a.occ, true)
    const j = addJoint({ name: 'Weld', type: 'rigid', a: { occ: a.occ, frame: { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] } }, b: { occ: b.occ, frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } }, flip: false, offset: [0, 0, 0], angle: 0, ...newJointDefaults('rigid') })
    expect(originOf(placeAssembly(doc().assembly).worlds[b.occ])).toEqual([0, 0, 10])
    deleteJoint(j)
    expect(doc().assembly.joints).toHaveLength(0)
    expect(originOf(placeAssembly(doc().assembly).worlds[b.occ])).toEqual([0, 0, 10])
  })
})

describe('joint origins snapped to geometry', () => {
  it('offers face centers, edge midpoints, circle centers and vertices of a body', async () => {
    const id = await addBox(box(20, 10, 6))
    const b = doc().geometry.find((x) => x.id === id)!
    const pts = snapPoints(b)
    const count = (k: string) => pts.filter((p) => p.kind === k).length
    expect(count('face')).toBe(6)
    expect(count('edgeMid')).toBe(12)
    expect(count('vertex')).toBe(8)
    const top = pts.find((p) => p.kind === 'face' && p.z[2] > 0.99)!
    expect(top.pos[0]).toBeCloseTo(0, 6)
    expect(top.pos[2]).toBeCloseTo(6, 6)
    const xedge = pts.find((p) => p.kind === 'edgeMid' && Math.abs(p.z[0]) > 0.99 && p.pos[1] > 4 && p.pos[2] > 5)!
    expect(xedge.pos).toEqual([expect.closeTo(0, 6), expect.closeTo(5, 6), expect.closeTo(6, 6)])
    for (const p of pts) {
      expect(Math.hypot(...p.z)).toBeCloseTo(1, 6)
      expect(Math.abs(p.z[0] * p.x[0] + p.z[1] * p.x[1] + p.z[2] * p.x[2])).toBeLessThan(1e-6)
    }
  })

  it('finds the center of a round hole or boss and gives it the face normal as its axis', async () => {
    const b = bodyFromShape('cyl', 'cyl', makeCylinder(8, 12) as never)
    const pts = snapPoints(b)
    const circles = pts.filter((p) => p.kind === 'circle')
    expect(circles).toHaveLength(2)
    const top = circles.find((p) => p.pos[2] > 6)!
    expect(top.pos[0]).toBeCloseTo(0, 5)
    expect(top.pos[1]).toBeCloseTo(0, 5)
    expect(top.pos[2]).toBeCloseTo(12, 5)
    expect(top.z[2]).toBeCloseTo(1, 5) // outward from the top face
    expect(circles.find((p) => p.pos[2] < 6)!.z[2]).toBeCloseTo(-1, 5)
  })

  it('a snap follows its face when the model changes upstream, and carries the component path in its persistent name', async () => {
    const { occ } = newComponent('Block')
    const id = await addBox(box(20, 20, 10))
    const b0 = doc().geometry.find((x) => x.id === id)!
    const top0 = snapPoints(b0).find((p) => p.kind === 'face' && p.z[2] > 0.99)!
    const spec = snapSpec(b0, top0, occ)
    expect(decodeRef(spec.ref)).toMatchObject({ kind: 'face', path: occ })
    const name0 = persistentName(spec)
    expect(name0.startsWith(occ + '/')).toBe(true)

    doc().updateFeature(id, box(20, 20, 35) as never)
    await regenerate()
    const hit = resolveSnap(spec, doc().geometry)!
    expect(hit.frame.origin[2]).toBeCloseTo(35, 6)
    expect(hit.frame.z[2]).toBeCloseTo(1, 6)
    expect(persistentName(spec)).toBe(name0)
  })
})

describe('joint origins follow the model', () => {
  async function plateAndArm() {
    const base = newComponent('Base')
    const baseBox = await addBox(box(20, 20, 10))
    activateOcc(null)
    const arm = newComponent('Arm')
    const armBox = await addBox(box(6, 6, 6, [30, 0, 0]))
    activateOcc(null)
    setGrounded(base.occ, true)
    const bodyOf = (id: string) => doc().geometry.find((b) => b.id === id)!
    const top = snapPoints(bodyOf(baseBox)).find((p) => p.kind === 'face' && p.z[2] > 0.99)!
    const bottom = snapPoints(bodyOf(armBox)).find((p) => p.kind === 'face' && p.z[2] < -0.99)!
    const id = addJoint({
      name: 'Rest', type: 'rigid', flip: true, offset: [0, 0, 0], angle: 0, ...newJointDefaults('rigid'),
      a: { occ: base.path, frame: snapFrame(top), snap: snapSpec(bodyOf(baseBox), top, base.path) },
      b: { occ: arm.path, frame: snapFrame(bottom), snap: snapSpec(bodyOf(armBox), bottom, arm.path) },
    })
    return { base, arm, baseBox, armBox, id }
  }
  const armZ = (geometry = doc().geometry) => placeAssembly(doc().assembly, {}, null, 0, geometry).worlds.o2[14]

  it('the arm rests on the base, and keeps resting on it when the base is made taller', async () => {
    const { baseBox } = await plateAndArm()
    expect(armZ()).toBeCloseTo(10, 6)
    doc().updateFeature(baseBox, box(20, 20, 25) as never)
    await regenerate()
    expect(armZ()).toBeCloseTo(25, 6)
    // the frames written in the joint are the ones from when it was made: only the live resolution moves it
    expect(placeAssembly(doc().assembly).worlds.o2[14]).toBeCloseTo(10, 6)
  })

  it('a joint origin whose face is gone keeps its last frame and says so', async () => {
    const { baseBox, id } = await plateAndArm()
    doc().removeFeature(baseBox)
    await regenerate()
    const p = placeAssembly(doc().assembly, {}, null, 0, doc().geometry)
    expect(p.frameErrors[id]).toMatch(/lost the face/)
    expect(armZ()).toBeCloseTo(10, 6)
  })
})

/** A small project file: a box 'w' wide with its own parameter. */
async function projectBytes(name: string, w: number, h = 10) {
  clearCache()
  doc().newDocument()
  doc().setUserParams([{ name: 'w', expr: String(w) }])
  doc().addFeature('box', { width: 'w', depth: 10, height: h, position: [0, 0, 0] } as never, 'Plate')
  await regenerate()
  doc().commit('rename', (d) => ({ ...d, name }))
  return serializeProject(false)
}

describe('linked and embedded components', () => {
  it('inserts another .caddy as a component evaluated with its own parameters', async () => {
    const bytes = await projectBytes('Bracket', 30)
    clearCache()
    doc().newDocument()
    doc().setUserParams([{ name: 'w', expr: '5' }]) // the host has a parameter of the same name: it must not leak in
    await regenerate()
    const r = await insertExternal(bytes, 'bracket.caddy', { linked: true, stamp: 1000 })
    expect(r.def).toBe('ext:e1')
    expect(doc().assembly.externals[0]).toMatchObject({ fileName: 'bracket.caddy', linked: true })
    const asm = doc().assembly
    const inst = expandInstances(asm, doc().geometry, placeAssembly(asm).worlds)
    expect(inst).toHaveLength(1)
    const p = inst[0].body.mesh.positions
    const xs = Array.from({ length: p.length / 3 }, (_, i) => p[i * 3])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30, 6)
    expect(inst[0].body.component).toBe('ext:e1')
    // instances of a linked component share it too
    instanceOf(r.occ, 40)
    expect(expandInstances(doc().assembly, doc().geometry, placeAssembly(doc().assembly).worlds)).toHaveLength(2)
    expect(doc().geometry).toHaveLength(1)
    // and it is saved with the document, so it opens without the other file
    const saved = await serializeProject(false)
    clearCache()
    const re = parseProject(saved)
    doc().loadDocument(re.data, re.blobs)
    await regenerate()
    expect(doc().geometry).toHaveLength(1)
    expect(doc().geometry[0].component).toBe('ext:e1')
  })

  it('shows an update notice when the linked file changes, and takes the new version on request', async () => {
    const v1 = await projectBytes('Bracket', 30)
    clearCache()
    doc().newDocument()
    await regenerate()
    let current = { bytes: v1, stamp: 1000 }
    await insertExternal(v1, 'bracket.caddy', { linked: true, stamp: 1000, source: { read: async () => current } })
    expect(await checkExternals()).toEqual([])
    expect(useAssemblyRuntime.getState().extChanged).toEqual({})

    const v2 = await projectBytes('Bracket', 55) // writing the new version used the document, so build the host again
    clearCache()
    doc().newDocument()
    await regenerate()
    await insertExternal(v1, 'bracket.caddy', { linked: true, stamp: 1000, source: { read: async () => current } })
    current = { bytes: v2, stamp: 2000 }
    expect(await checkExternals()).toEqual(['e1'])
    expect(useAssemblyRuntime.getState().extChanged.e1).toMatchObject({ fileName: 'bracket.caddy', stamp: 2000 })
    const widthNow = () => {
      const p = doc().geometry[0].mesh.positions
      const xs = Array.from({ length: p.length / 3 }, (_, i) => p[i * 3])
      return Math.max(...xs) - Math.min(...xs)
    }
    expect(widthNow()).toBeCloseTo(30, 6) // nothing changes until the user accepts
    await applyExternalUpdate('e1')
    expect(widthNow()).toBeCloseTo(55, 6)
    expect(useAssemblyRuntime.getState().extChanged).toEqual({})
    expect(doc().assembly.externals[0].stamp).toBe(2000)
  })

  it('a file that was touched but not changed raises no notice, and dismissing keeps the document copy', async () => {
    const v1 = await projectBytes('Bracket', 30)
    clearCache()
    doc().newDocument()
    await regenerate()
    let current = { bytes: v1, stamp: 1000 }
    await insertExternal(v1, 'b.caddy', { linked: true, stamp: 1000, source: { read: async () => current } })
    current = { bytes: v1, stamp: 5000 }
    expect(await checkExternals()).toEqual([])
    const v2 = await projectBytes('Bracket', 12)
    doc().newDocument()
    await regenerate()
    await insertExternal(v1, 'b.caddy', { linked: true, stamp: 1000, source: { read: async () => current } })
    current = { bytes: v2, stamp: 6000 }
    expect(await checkExternals()).toEqual(['e1'])
    dismissExternalUpdate('e1')
    expect(useAssemblyRuntime.getState().extChanged).toEqual({})
    expect(await checkExternals()).toEqual([]) // same version of the file: no nagging
  })

  it('an embedded copy keeps its content and is never checked', async () => {
    const bytes = await projectBytes('Bracket', 22)
    clearCache()
    doc().newDocument()
    await regenerate()
    await insertExternal(bytes, 'copy.caddy', { linked: false })
    expect(doc().assembly.externals[0].linked).toBe(false)
    expect(await checkExternals()).toEqual([])
    expect(doc().geometry).toHaveLength(1)
  })

  it('a file that is not a project is refused with a readable message', async () => {
    await expect(insertExternal(new Uint8Array([1, 2, 3]), 'junk.caddy', { linked: true })).rejects.toBeTruthy()
    expect(doc().assembly.externals).toHaveLength(0)
  })
})
