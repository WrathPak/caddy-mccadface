import { describe, expect, it } from 'vitest'
import { dragFree, dragJoint, planDrag } from './drag'
import { defaultLimits, defaultValues } from './joints'
import { identity, originOf, point, translation, type Frame } from './matrix'
import { solveAssembly, type PlacedNode } from './solver'
import type { Joint, JointType } from './types'

const occ = (id: string, extra: Partial<PlacedNode> = {}): PlacedNode => ({ id, parent: null, transform: identity(), ...extra })
const frame = (x = 0, y = 0, z = 0): Frame => ({ origin: [x, y, z], z: [0, 0, 1], x: [1, 0, 0] })
let n = 0
const joint = (type: JointType, a: string, b: string, fa = frame(), fb = frame(), extra: Partial<Joint> = {}): Joint => ({
  id: 'j' + ++n, name: type, type, a: { occ: a, frame: fa }, b: { occ: b, frame: fb }, flip: false, offset: [0, 0, 0], angle: 0,
  values: defaultValues(type), limits: defaultLimits(type), ...extra,
})
const A = (nodes: PlacedNode[], joints: Joint[]) => ({ nodes, joints, links: [] })

describe('dragging a component', () => {
  it('a hinged arm turns to follow the pointer', () => {
    const j = joint('revolute', 'base', 'arm')
    const a = A([occ('base', { grounded: true }), occ('arm')], [j])
    const solve = solveAssembly(a)
    const plan = planDrag(a, solve, 'arm', [30, 0, 0])
    expect(plan.kind).toBe('joint')
    if (plan.kind !== 'joint') return
    const drive = dragJoint(a, plan, [0, 30, 0])
    expect(drive[j.id].angle).toBeCloseTo(90, 2)
    // the pointer is off the circle the arm can reach: it ends up pointing at it
    const drive2 = dragJoint(a, plan, [50, 50, 0])
    expect(Math.abs(drive2[j.id].angle - 45)).toBeLessThan(0.2)
    const w = solveAssembly(a, drive2).worlds.arm
    expect(Math.abs(point(w, [30, 0, 0])[0] - 30 * Math.SQRT1_2)).toBeLessThan(0.1)
  })

  it('a slider only moves along its axis and stops at its limits', () => {
    const j = joint('slider', 'base', 'carriage')
    j.limits.distance = { enabled: true, min: 0, max: 25, rest: 0 }
    const a = A([occ('base', { grounded: true }), occ('carriage')], [j])
    const plan = planDrag(a, solveAssembly(a), 'carriage', [0, 0, 0])
    if (plan.kind !== 'joint') throw new Error('expected a joint plan')
    expect(dragJoint(a, plan, [40, 40, 10])[j.id].distance).toBeCloseTo(10, 3)
    expect(dragJoint(a, plan, [0, 0, 99])[j.id].distance).toBeCloseTo(25, 3)
    expect(dragJoint(a, plan, [0, 0, -9])[j.id].distance).toBeCloseTo(0, 3)
  })

  it('moves a component that sits inside another one through that one\'s joint', () => {
    const j = joint('revolute', 'base', 'arm')
    const a = A([occ('base', { grounded: true }), occ('arm'), occ('tip', { parent: 'arm', transform: translation([20, 0, 0]) })], [j])
    const plan = planDrag(a, solveAssembly(a), 'tip', [20, 0, 0])
    expect(plan.kind === 'joint' && plan.unit).toBe('arm')
    if (plan.kind !== 'joint') return
    expect(dragJoint(a, plan, [0, 20, 0])[j.id].angle).toBeCloseTo(90, 2)
  })

  it('a ball joint follows the pointer with its three rotations', () => {
    const j = joint('ball', 'base', 'arm')
    const a = A([occ('base', { grounded: true }), occ('arm')], [j])
    const plan = planDrag(a, solveAssembly(a), 'arm', [10, 0, 0])
    if (plan.kind !== 'joint') throw new Error('expected a joint plan')
    const drive = dragJoint(a, plan, [0, 0, 10])
    const w = solveAssembly(a, drive).worlds.arm
    const p = point(w, [10, 0, 0])
    expect(Math.hypot(p[0], p[1], p[2] - 10)).toBeLessThan(1e-2)
  })

  it('grounded and rigidly held components do not move, with a reason', () => {
    const a = A([occ('base', { grounded: true }), occ('plate')], [joint('rigid', 'base', 'plate')])
    const s = solveAssembly(a)
    const g = planDrag(a, s, 'base', [0, 0, 0])
    expect(g).toMatchObject({ kind: 'blocked' })
    expect((g as { reason: string }).reason).toMatch(/grounded/)
    expect((planDrag(a, s, 'plate', [0, 0, 0]) as { reason: string }).reason).toMatch(/rigid/i)
  })

  it('a component without a joint moves freely, and carries its children', () => {
    const a = A([occ('p'), occ('c', { parent: 'p', transform: translation([5, 0, 0]) })], [])
    const s = solveAssembly(a)
    const plan = planDrag(a, s, 'p', [1, 1, 0])
    if (plan.kind !== 'free') throw new Error('expected a free plan')
    const t = dragFree(plan, [11, 1, 4])
    expect(originOf(t)).toEqual([10, 0, 4])
    const moved = solveAssembly({ ...a, nodes: a.nodes.map((o) => (o.id === 'p' ? { ...o, transform: t } : o)) })
    expect(originOf(moved.worlds.c)).toEqual([15, 0, 4])
  })

  it('a link-driven joint cannot be dragged on its own', () => {
    const j1 = joint('revolute', 'base', 'a'), j2 = joint('revolute', 'base', 'b')
    const a = { nodes: [occ('base', { grounded: true }), occ('a'), occ('b')], joints: [j1, j2], links: [{ id: 'l', name: 'l', a: { joint: j1.id, key: 'angle' }, b: { joint: j2.id, key: 'angle' }, ratio: 2 }] }
    const plan = planDrag(a, solveAssembly(a), 'b', [10, 0, 0])
    expect((plan as { reason: string }).reason).toMatch(/motion link/)
    expect(planDrag(a, solveAssembly(a), 'a', [10, 0, 0]).kind).toBe('joint')
  })
})
