/** What the Joint, As-built Joint dialogs and the motion study do with their values, on real OpenCascade bodies. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/kernel/client', async () => {
  const { api } = await import('@/kernel/api')
  return { getKernel: () => api as never }
})

import { initOcc } from '@/kernel/occ'
import { clearCache, regenerate } from '@/doc/engine'
import { encodeRef } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import '@/features/basic'
import { activateOcc, instanceOf, newComponent, setGrounded } from './actions'
import { asBuiltFromValues, jointFromValues, jointSchema, valuesOfJoint } from './jointDialog'
import { explodeOffsets, placeAssembly } from './instances'
import { originOf, point } from './matrix'
import { sampleTrack, studyDrive, studyLength, withKeyframe } from './motion'
import { useAssemblyRuntime } from './runtime'
import { nearestSnaps } from './snapPick'
import { persistentName, resolveSnap, snapPoints, snapSpec } from './snaps'
import { selectedInstances } from './selection'
import { useUi, type SelectionRef } from '@/store/ui'
import { schemaDefaults, type ParamValues } from '@/ui/schema'

beforeAll(async () => { await initOcc() })
beforeEach(async () => {
  clearCache()
  useAssemblyRuntime.setState({ drive: {} })
  useUi.setState({ selection: [] })
  useDoc.getState().newDocument()
  await regenerate()
})

const doc = () => useDoc.getState()
const box = (w: number, d: number, h: number, position = [0, 0, 0]) => ({ width: w, depth: d, height: h, position })
async function addBox(p: ReturnType<typeof box>) {
  const id = doc().addFeature('box', p as never)
  await regenerate()
  return id
}
const body = (id: string) => doc().geometry.find((b) => b.id === id)!

/** Two components, a 20 x 20 x 10 base and a 6 cube that sits at x = 30 in its own space. */
async function pair() {
  const base = newComponent('Base')
  const baseId = await addBox(box(20, 20, 10))
  activateOcc(null)
  const arm = newComponent('Arm')
  const armId = await addBox(box(6, 6, 6, [30, 0, 0]))
  activateOcc(null)
  const top = snapPoints(body(baseId)).find((p) => p.kind === 'face' && p.z[2] > 0.99)!
  const bottom = snapPoints(body(armId)).find((p) => p.kind === 'face' && p.z[2] < -0.99)!
  const side = snapPoints(body(armId)).find((p) => p.kind === 'face' && p.z[0] > 0.99)!
  const ref = (id: string, p: ReturnType<typeof snapPoints>[number], path: string) => JSON.stringify({ kind: 'snap', bodyId: id, path, spec: snapSpec(body(id), p, path) })
  return { base, arm, baseId, armId, top, bottom, side, ref }
}

const dialogValues = (extra: ParamValues = {}): ParamValues => ({ ...schemaDefaults(jointSchema()), ...extra })

describe('joint dialog values', () => {
  it('turns two picked snap points into a joint with their frames, and an origin without a component is refused', async () => {
    const p = await pair()
    const v = dialogValues({ origin1: [p.ref(p.baseId, p.top, p.base.path)], origin2: [p.ref(p.armId, p.bottom, p.arm.path)], type: 'revolute', flip: true, v_angle: 30 })
    const r = jointFromValues(v, doc().geometry, doc().assembly)
    if ('error' in r) throw new Error(r.error)
    expect(r.joint).toMatchObject({ type: 'revolute', flip: true, values: { angle: 30 }, a: { occ: p.base.path }, b: { occ: p.arm.path } })
    expect(r.joint.a.frame.origin).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(10, 6)])
    expect(r.joint.a.snap?.kind).toBe('face')
    // a body that is not in a component cannot be joined
    const loose = await addBox(box(5, 5, 5, [90, 0, 0]))
    const pt = snapPoints(body(loose)).find((q) => q.kind === 'face')!
    const bad = jointFromValues(dialogValues({ origin1: [p.ref(p.baseId, p.top, p.base.path)], origin2: [JSON.stringify({ kind: 'snap', bodyId: loose, spec: snapSpec(body(loose), pt) })] }), doc().geometry, doc().assembly)
    expect('error' in bad && bad.error).toMatch(/make the body a component first/i)
  })

  it('checks that the origins are on different components, the limits make sense, and keeps picked values on an edit', async () => {
    const p = await pair()
    const same = jointFromValues(dialogValues({ origin1: [p.ref(p.baseId, p.top, p.base.path)], origin2: [p.ref(p.baseId, p.top, p.base.path)] }), doc().geometry, doc().assembly)
    expect('error' in same && same.error).toMatch(/different components/)
    const backwards = jointFromValues(dialogValues({ origin1: [p.ref(p.baseId, p.top, p.base.path)], origin2: [p.ref(p.armId, p.bottom, p.arm.path)], type: 'slider', lim_distance: true, min_distance: 10, max_distance: 5 }), doc().geometry, doc().assembly)
    expect('error' in backwards && backwards.error).toMatch(/minimum is above the maximum/)
    const ok = jointFromValues(dialogValues({ origin1: [p.ref(p.baseId, p.top, p.base.path)], origin2: [p.ref(p.armId, p.bottom, p.arm.path)], type: 'slider', lim_distance: true, min_distance: 0, max_distance: 40, rest_distance: 5 }), doc().geometry, doc().assembly)
    if ('error' in ok) throw new Error(ok.error)
    expect(ok.joint.limits.distance).toEqual({ enabled: true, min: 0, max: 40, rest: 5 })
    // editing: the values round-trip, and leaving the origins alone keeps the joint's own
    const back = valuesOfJoint(ok.joint)
    expect(back).toMatchObject({ type: 'slider', lim_distance: true, max_distance: 40, rest_distance: 5 })
    const edited = jointFromValues({ ...back, origin1: [], origin2: [], flip: true }, doc().geometry, doc().assembly, { ...ok.joint, id: 'j9', name: 'Mine' })
    if ('error' in edited) throw new Error(edited.error)
    expect(edited.joint).toMatchObject({ id: 'j9', name: 'Mine', flip: true })
    expect(edited.joint.a).toEqual(ok.joint.a)
  })
})

describe('as-built joint', () => {
  it('keeps both components where they are and puts the origin at one place in the world', async () => {
    const p = await pair()
    setGrounded(p.base.path, true)
    const worlds = () => placeAssembly(doc().assembly, {}, null, 0, doc().geometry).worlds
    const before = worlds()
    const r = asBuiltFromValues({ comp1: [encodeRef({ kind: 'component', bodyId: '', path: p.base.path })], comp2: [encodeRef({ kind: 'component', bodyId: '', path: p.arm.path })], origin: [p.ref(p.baseId, p.top, p.base.path)], type: 'revolute' }, doc().geometry, doc().assembly)
    if ('error' in r) throw new Error(r.error)
    expect(r.joint.asBuilt).toBe(true)
    doc().commit('add', (d) => ({ ...d, assembly: { ...d.assembly, joints: [{ ...r.joint, id: 'j1' }] } }))
    expect(worlds()).toEqual(before)
    // both frames are the same place in the world
    const a = point(before.o1, r.joint.a.frame.origin), b = point(before.o2, r.joint.b.frame.origin)
    expect(a).toEqual(b.map((x) => expect.closeTo(x, 6)))
    expect(a[2]).toBeCloseTo(10, 6) // the base's top face
    // and it turns about that origin
    const turned = placeAssembly({ ...doc().assembly, joints: [{ ...doc().assembly.joints[0], values: { angle: 90 } }] }, {}, null, 0, doc().geometry).worlds
    expect(originOf(turned.o2)[2]).toBeCloseTo(originOf(before.o2)[2], 6)
    const probe = point(turned.o2, [30, 0, 3])
    expect(probe[0]).toBeCloseTo(0, 6)
    expect(probe[1]).toBeCloseTo(30, 6)
  })

  it('asks for two different components and an origin', async () => {
    const p = await pair()
    const comp = (path: string) => [encodeRef({ kind: 'component', bodyId: '', path })]
    const origin = [p.ref(p.baseId, p.top, p.base.path)]
    expect('error' in asBuiltFromValues({ comp1: comp(p.base.path), comp2: comp(p.base.path), origin, type: 'rigid' }, doc().geometry, doc().assembly)).toBe(true)
    expect('error' in asBuiltFromValues({ comp1: comp(p.base.path), comp2: [], origin, type: 'rigid' }, doc().geometry, doc().assembly)).toBe(true)
    expect('error' in asBuiltFromValues({ comp1: comp(p.base.path), comp2: comp(p.arm.path), origin: [], type: 'rigid' }, doc().geometry, doc().assembly)).toBe(true)
  })
})

describe('snap picking and references', () => {
  it('picks the nearest snap point, preferring vertices and circle centers when it is close', async () => {
    const id = await addBox(box(20, 20, 10))
    const pts = snapPoints(body(id))
    const hit = (at: [number, number, number]) => pts[nearestSnaps(pts, at)!.nearest]
    expect(hit([0.4, 0.2, 10])).toMatchObject({ kind: 'face', pos: [expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(10, 6)] })
    expect(hit([9.6, 9.7, 10]).kind).toBe('vertex')
    expect(hit([9.5, 0.3, 10]).kind).toBe('edgeMid')
    // half way between the centre and a corner several points are candidates, the picked one among them
    const near = nearestSnaps(pts, [5, 5, 10])!
    expect(near.near).toContain(near.nearest)
    expect(near.near.length).toBeGreaterThan(3)
    expect(near.near.length).toBeLessThanOrEqual(14)
    expect(nearestSnaps([], [0, 0, 0])).toBeNull()
  })

  it('every instance has its own persistent name, and all of them resolve to the same geometry', async () => {
    const { base, baseId, top } = await pair()
    const second = instanceOf(base.path, 40)!
    const s1 = snapSpec(body(baseId), top, base.path), s2 = snapSpec(body(baseId), top, second)
    expect(persistentName(s1)).not.toBe(persistentName(s2))
    expect(persistentName(s1).startsWith(base.path + '/')).toBe(true)
    expect(persistentName(s2).startsWith(second + '/')).toBe(true)
    expect(persistentName(s1).split('/').pop()).toBe(persistentName(s2).split('/').pop())
    const r1 = resolveSnap(s1, doc().geometry)!, r2 = resolveSnap(s2, doc().geometry)!
    expect(r1.frame).toEqual(r2.frame)
  })

  it('the selection says which instances it points at', async () => {
    const p = await pair()
    const sel: SelectionRef[] = [{ kind: 'component', id: p.arm.path }, { kind: 'body', id: p.baseId, path: p.base.path }, { kind: 'face', id: p.baseId, index: 0, path: p.base.path }, { kind: 'body', id: 'nope', path: 'ghost' }, { kind: 'body', id: 'root-body' }]
    expect(selectedInstances(sel)).toEqual([p.arm.path, p.base.path])
  })
})

describe('motion study and explode steps', () => {
  it('interpolates keyframes in a straight line and holds the ends', () => {
    const frames = [{ t: 4, v: 90 }, { t: 0, v: 0 }, { t: 2, v: 30 }]
    expect(sampleTrack(frames, -1)).toBe(0)
    expect(sampleTrack(frames, 1)).toBeCloseTo(15, 9)
    expect(sampleTrack(frames, 2)).toBe(30)
    expect(sampleTrack(frames, 3)).toBeCloseTo(60, 9)
    expect(sampleTrack(frames, 9)).toBe(90)
    expect(sampleTrack([], 1)).toBe(0)
    const study = { duration: 4, loop: false, tracks: [{ joint: 'j1', key: 'angle', frames }, { joint: 'j2', key: 'distance', frames: [{ t: 0, v: 5 }] }, { joint: 'j3', key: 'x', frames: [] }] }
    expect(studyDrive(study, 3)).toEqual({ j1: { angle: 60 }, j2: { distance: 5 } })
    expect(studyLength(study)).toBe(4)
    expect(studyLength({ duration: 1, tracks: [{ joint: 'a', key: 'b', frames: [{ t: 6, v: 0 }] }] })).toBe(6)
  })

  it('adds a keyframe or moves the one at the same time', () => {
    let t = withKeyframe(undefined, 'j1', 'angle', 2, 30)
    t = withKeyframe(t, 'j1', 'angle', 0, 0)
    t = withKeyframe(t, 'j1', 'angle', 2, 45)
    expect(t.frames).toEqual([{ t: 0, v: 0 }, { t: 2, v: 45 }])
  })

  it('plays explode steps one after the other, and children follow their parent', () => {
    const nodes = [
      { id: 'a', parent: null, transform: [] as number[] }, { id: 'b', parent: null, transform: [] as number[] }, { id: 'a/c', parent: 'a', transform: [] as number[] },
    ]
    const steps = [
      { id: 's1', name: '1', occs: ['a'], direction: [0, 0, 2] as [number, number, number], distance: 10, trail: true },
      { id: 's2', name: '2', occs: ['b'], direction: [1, 0, 0] as [number, number, number], distance: 20, trail: true },
    ]
    expect(explodeOffsets(nodes, steps, 0)).toEqual({})
    expect(explodeOffsets(nodes, steps, 0.25)).toEqual({ a: [0, 0, 5], 'a/c': [0, 0, 5] })
    expect(explodeOffsets(nodes, steps, 0.5)).toEqual({ a: [0, 0, 10], 'a/c': [0, 0, 10] })
    expect(explodeOffsets(nodes, steps, 0.75)).toEqual({ a: [0, 0, 10], 'a/c': [0, 0, 10], b: [10, 0, 0] })
    expect(explodeOffsets(nodes, steps, 1)).toEqual({ a: [0, 0, 10], 'a/c': [0, 0, 10], b: [20, 0, 0] })
  })
})
