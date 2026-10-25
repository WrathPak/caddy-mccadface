import { describe, expect, it } from 'vitest'
import { defaultLimits, defaultValues } from './joints'
import { DEG, identity, originOf, point, translation, type Frame } from './matrix'
import { solveAssembly, type PlacedNode } from './solver'
import type { Joint, JointType, MotionLink } from './types'

const occ = (id: string, extra: Partial<PlacedNode> = {}): PlacedNode => ({ id, parent: null, transform: identity(), ...extra })
const frame = (x = 0, y = 0, z = 0): Frame => ({ origin: [x, y, z], z: [0, 0, 1], x: [1, 0, 0] })
let n = 0
function joint(type: JointType, a: string, b: string, fa = frame(), fb = frame(), extra: Partial<Joint> = {}): Joint {
  return {
    id: 'j' + ++n, name: type, type, a: { occ: a, frame: fa }, b: { occ: b, frame: fb }, flip: false, offset: [0, 0, 0], angle: 0,
    values: defaultValues(type), limits: defaultLimits(type), ...extra,
  }
}
const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)))

describe('joint solver', () => {
  it('leaves free components where the tree puts them', () => {
    const r = solveAssembly({ nodes: [occ('a', { transform: translation([5, 0, 0]) }), occ('b')], joints: [], links: [] })
    close(originOf(r.worlds.a), [5, 0, 0])
    close(originOf(r.worlds.b), [0, 0, 0])
  })

  it('a rigid joint snaps the second component onto the first origin', () => {
    const occs = [occ('a', { grounded: true }), occ('b', { transform: translation([50, 50, 50]) })]
    const j = joint('rigid', 'a', 'b', frame(10, 0, 0), frame(0, 0, 3))
    const r = solveAssembly({ nodes: occs, joints: [j], links: [] })
    // b's origin (0,0,3) must land on a's (10,0,0): b sits at (10,0,-3)
    close(originOf(r.worlds.b), [10, 0, -3])
    expect(r.overConstrained).toBe(false)
  })

  it('walks the joint backwards when the first component is the free one', () => {
    const occs = [occ('a'), occ('b', { grounded: true, transform: translation([0, 0, 7]) })]
    const j = joint('rigid', 'a', 'b', frame(0, 0, 0), frame(0, 0, 0))
    const r = solveAssembly({ nodes: occs, joints: [j], links: [] })
    close(originOf(r.worlds.a), [0, 0, 7])
  })

  it('revolute turns the second component about the joint axis', () => {
    const j = joint('revolute', 'a', 'b', frame(), frame(), { values: { angle: 90 } })
    const r = solveAssembly({ nodes: [occ('a', { grounded: true }), occ('b')], joints: [j], links: [] })
    // a point 10 along b's X ends up 10 along world Y
    close(point(r.worlds.b, [10, 0, 0]), [0, 10, 0])
  })

  it('slider, cylindrical, pin-slot, planar and ball produce their motions', () => {
    const run = (type: JointType, values: Record<string, number>) => {
      const j = joint(type, 'a', 'b', frame(), frame(), { values })
      return solveAssembly({ nodes: [occ('a', { grounded: true }), occ('b')], joints: [j], links: [] }).worlds.b
    }
    close(point(run('slider', { distance: 12 }), [0, 0, 0]), [0, 0, 12])
    close(point(run('cylindrical', { angle: 90, distance: 5 }), [1, 0, 0]), [0, 1, 5])
    close(point(run('pinSlot', { angle: 90, slide: 4 }), [0, 0, 0]), [4, 0, 0])
    close(point(run('planar', { x: 3, y: -2, angle: 180 }), [1, 0, 0]), [2, -2, 0])
    close(point(run('ball', { yaw: 90 }), [1, 0, 0]), [0, 1, 0])
    close(point(run('ball', { pitch: 90 }), [1, 0, 0]), [0, 0, -1])
  })

  it('flip reverses the axis and the offset moves the joint frame', () => {
    const flipped = joint('slider', 'a', 'b', frame(), frame(), { flip: true, values: { distance: 5 } })
    const w = solveAssembly({ nodes: [occ('a', { grounded: true }), occ('b')], joints: [flipped], links: [] }).worlds.b
    close(point(w, [0, 0, 0]), [0, 0, 5])
    close(point(w, [0, 0, 1]), [0, 0, 4]) // b's own Z now points the other way
    const off = joint('revolute', 'a', 'b', frame(), frame(), { offset: [10, 0, 0], angle: 90 })
    const w2 = solveAssembly({ nodes: [occ('a', { grounded: true }), occ('b')], joints: [off], links: [] }).worlds.b
    close(point(w2, [0, 0, 0]), [10, 0, 0])
    close(point(w2, [1, 0, 0]), [10, 1, 0])
  })

  it('limits clamp the value and the clamped value is reported', () => {
    const j = joint('slider', 'a', 'b', frame(), frame(), { values: { distance: 80 } })
    j.limits.distance = { enabled: true, min: 0, max: 30, rest: 10 }
    const r = solveAssembly({ nodes: [occ('a', { grounded: true }), occ('b')], joints: [j], links: [] })
    close(originOf(r.worlds.b), [0, 0, 30])
    expect(r.values[j.id].distance).toBe(30)
  })

  it('a drive override beats the stored value', () => {
    const j = joint('revolute', 'a', 'b', frame(), frame(), { values: { angle: 10 } })
    const r = solveAssembly({ nodes: [occ('a', { grounded: true }), occ('b')], joints: [j], links: [] }, { [j.id]: { angle: 180 } })
    close(point(r.worlds.b, [1, 0, 0]), [-1, 0, 0])
  })

  it('chains of joints compound, and children of a placed component follow it', () => {
    const occs = [occ('a', { grounded: true }), occ('b'), occ('c', { parent: 'b', transform: translation([0, 5, 0]) })]
    const j1 = joint('slider', 'a', 'b', frame(), frame(), { values: { distance: 20 } })
    const r = solveAssembly({ nodes: occs, joints: [j1], links: [] })
    close(originOf(r.worlds.c), [0, 5, 20])
  })

  it('a motion link makes one joint follow another by a ratio', () => {
    const occs = [occ('a', { grounded: true }), occ('b'), occ('c')]
    const j1 = joint('revolute', 'a', 'b', frame(), frame(), { values: { angle: 30 } })
    const j2 = joint('revolute', 'a', 'c', frame(20), frame(), { values: { angle: 0 } })
    const link: MotionLink = { id: 'l1', name: 'gear', a: { joint: j1.id, key: 'angle' }, b: { joint: j2.id, key: 'angle' }, ratio: -2 }
    const r = solveAssembly({ nodes: occs, joints: [j1, j2], links: [link] })
    expect(r.values[j2.id].angle).toBeCloseTo(-60, 9)
    close(point(r.worlds.c, [1, 0, 0]), [20 + Math.cos(-60 * DEG), Math.sin(-60 * DEG), 0])
  })

  it('links resolve in dependency order and a circular set of links is reported', () => {
    const occs = [occ('a', { grounded: true }), occ('b'), occ('c'), occ('d')]
    const j1 = joint('revolute', 'a', 'b', frame(), frame(), { values: { angle: 10 } })
    const j2 = joint('revolute', 'a', 'c', frame(), frame())
    const j3 = joint('revolute', 'a', 'd', frame(), frame())
    const mk = (id: string, a: Joint, b: Joint, ratio: number): MotionLink => ({ id, name: id, a: { joint: a.id, key: 'angle' }, b: { joint: b.id, key: 'angle' }, ratio })
    // declared out of order: j2 -> j3 first, j1 -> j2 second
    const ok = solveAssembly({ nodes: occs, joints: [j1, j2, j3], links: [mk('l2', j2, j3, 2), mk('l1', j1, j2, 3)] })
    expect(ok.values[j3.id].angle).toBeCloseTo(60, 9)
    const bad = solveAssembly({ nodes: occs, joints: [j1, j2, j3], links: [mk('l1', j2, j3, 1), mk('l2', j3, j2, 1)] })
    expect(Object.keys(bad.linkErrors).sort()).toEqual(['l1', 'l2'])
  })

  it('a consistent loop of rigid joints is fine, a conflicting one is over-constrained', () => {
    const occs = [occ('a', { grounded: true }), occ('b'), occ('c')]
    const ab = joint('rigid', 'a', 'b', frame(10), frame())
    const bc = joint('rigid', 'b', 'c', frame(5), frame())
    const ca = joint('rigid', 'c', 'a', frame(), frame(15)) // c's origin sits at a's (15,0,0): consistent with 10 + 5
    const good = solveAssembly({ nodes: occs, joints: [ab, bc, ca], links: [] })
    expect(good.overConstrained).toBe(false)
    expect(good.errors).toEqual({})
    const bad = joint('rigid', 'c', 'a', frame(), frame(16))
    const r = solveAssembly({ nodes: occs, joints: [ab, bc, bad], links: [] })
    expect(r.overConstrained).toBe(true)
    expect(Object.values(r.errors).some((m) => /over-constrained/i.test(m))).toBe(true)
    expect([ab.id, bc.id, bad.id].every((id) => !!r.errors[id])).toBe(true)
    // the set stays at its tree solution
    close(originOf(r.worlds.c), [16, 0, 0])
  })

  it('closes a four-bar linkage with the crank driven', () => {
    const occs = [occ('g', { grounded: true }), occ('crank'), occ('coupler'), occ('rocker')]
    const A = joint('revolute', 'g', 'crank', frame(0), frame(0))
    const B = joint('revolute', 'crank', 'coupler', frame(20), frame(0))
    const C = joint('revolute', 'coupler', 'rocker', frame(45), frame(0))
    const D = joint('revolute', 'rocker', 'g', frame(35), frame(40)) // closes the loop
    for (const deg of [60, 90, 120]) {
      const r = solveAssembly({ nodes: occs, joints: [A, B, C, D], links: [] }, { [A.id]: { angle: deg } })
      expect(r.overConstrained).toBe(false)
      const crankEnd = point(r.worlds.crank, [20, 0, 0])
      close(crankEnd, [20 * Math.cos(deg * DEG), 20 * Math.sin(deg * DEG), 0], 1e-4)
      close(point(r.worlds.coupler, [0, 0, 0]), crankEnd, 1e-4)
      // the rocker's far end reaches the ground pivot
      close(point(r.worlds.rocker, [35, 0, 0]), [40, 0, 0], 1e-3)
      // and the bar lengths are kept
      const cEnd = point(r.worlds.coupler, [45, 0, 0])
      close(point(r.worlds.rocker, [0, 0, 0]), cEnd, 1e-3)
    }
  })

  it('a four-bar whose bars cannot reach is reported, not mangled', () => {
    const occs = [occ('g', { grounded: true }), occ('crank'), occ('coupler'), occ('rocker')]
    const A = joint('revolute', 'g', 'crank', frame(0), frame(0))
    const B = joint('revolute', 'crank', 'coupler', frame(20), frame(0))
    const C = joint('revolute', 'coupler', 'rocker', frame(10), frame(0))
    const D = joint('revolute', 'rocker', 'g', frame(10), frame(200)) // far too far away
    const r = solveAssembly({ nodes: occs, joints: [A, B, C, D], links: [] }, { [A.id]: { angle: 30 } })
    expect(r.overConstrained).toBe(true)
    expect(Object.keys(r.errors).length).toBeGreaterThan(0)
  })

  it('rejects a joint inside its own component and one with a missing component', () => {
    const occs = [occ('p'), occ('q', { parent: 'p' })]
    const j = joint('rigid', 'p', 'q')
    const miss = joint('rigid', 'p', 'zzz')
    const r = solveAssembly({ nodes: occs, joints: [j, miss], links: [] })
    expect(r.errors[j.id]).toMatch(/inside it/)
    expect(r.errors[miss.id]).toMatch(/no longer exists/)
  })

  it('suppressed joints are ignored', () => {
    const j = joint('rigid', 'a', 'b', frame(10), frame(), { suppressed: true })
    const r = solveAssembly({ nodes: [occ('a', { grounded: true }), occ('b', { transform: translation([1, 2, 3]) })], joints: [j], links: [] })
    close(originOf(r.worlds.b), [1, 2, 3])
  })
})
