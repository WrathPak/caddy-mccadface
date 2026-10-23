import { beforeAll, describe, expect, it } from 'vitest'
import { box, initOcc } from '../kernel/occ'
import { bodyFromShape } from '../kernel/store'
import { edgeSigs, encodeRef, faceSigs, refFromSelection } from '../doc/refs'
import type { Body } from '../kernel/types'
import { measureText } from './measure'

let a: Body, b: Body, bodies: Body[]
beforeAll(async () => {
  await initOcc()
  a = bodyFromShape('a', 'A', box([20, 20, 20], [0, 0, 0]))
  b = bodyFromShape('b', 'B', box([20, 20, 20], [50, 0, 0]))
  bodies = [a, b]
})

const face = (body: Body, pred: (n: number[], c: number[]) => boolean) => {
  const i = faceSigs(body).findIndex((s) => pred(s.normal, s.centroid))
  return encodeRef(refFromSelection({ kind: 'face', id: body.id, index: i }, bodies)!)
}
const edge = (body: Body, pred: (d: number[], m: number[]) => boolean) => {
  const i = edgeSigs(body).findIndex((s) => pred(s.direction, s.midpoint))
  return encodeRef(refFromSelection({ kind: 'edge', id: body.id, index: i }, bodies)!)
}
const num = (text: string, label: string) => parseFloat(new RegExp(label + '\\s+(-?[\\d.]+)').exec(text)![1])

describe('measure', () => {
  it('single entities: face area, edge length, body volume and size', () => {
    expect(measureText([face(a, (n) => n[2] > 0.99)], bodies)).toContain('Area      400')
    expect(measureText([edge(a, (d) => Math.abs(d[0]) > 0.99)], bodies)).toContain('Length    20')
    const t = measureText([encodeRef({ kind: 'body', bodyId: 'a' })], bodies)
    expect(t).toContain('Volume    8000')
    expect(t).toContain('20 x 20 x 20')
  })

  it('two parallel faces: plane distance, center distance, 0 degrees', () => {
    const t = measureText([face(a, (n) => n[0] > 0.99), face(b, (n) => n[0] < -0.99)], bodies)
    expect(num(t, 'Plane distance')).toBeCloseTo(30, 3)
    expect(num(t, 'Center distance')).toBeCloseTo(30, 3) // the two face centers
    expect(num(t, 'Angle')).toBeCloseTo(0, 2)
  })

  it('two edges: angle between the lines; face against edge: line to plane angle', () => {
    const ex = edge(a, (d) => Math.abs(d[0]) > 0.99)
    const ey = edge(b, (d) => Math.abs(d[1]) > 0.99)
    expect(num(measureText([ex, ey], bodies), 'Angle')).toBeCloseTo(90, 2)
    expect(num(measureText([ex, edge(b, (d) => Math.abs(d[0]) > 0.99)], bodies), 'Angle')).toBeCloseTo(0, 2)
    // an edge along X against the top face (plane Z): parallel to it
    expect(num(measureText([face(a, (n) => n[2] > 0.99), ex], bodies), 'Angle')).toBeCloseTo(0, 2)
    // an edge along Z against the same face: perpendicular
    expect(num(measureText([face(a, (n) => n[2] > 0.99), edge(a, (d) => Math.abs(d[2]) > 0.99)], bodies), 'Angle')).toBeCloseTo(90, 2)
  })

  it('asks for a pick, and reports entities that no longer exist', () => {
    expect(measureText([], bodies)).toContain('Pick')
    expect(measureText([encodeRef({ kind: 'body', bodyId: 'zzz' })], bodies)).toContain('no longer exists')
  })
})
