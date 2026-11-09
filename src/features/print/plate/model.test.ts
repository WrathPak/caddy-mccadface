import { describe, expect, it } from 'vitest'
import type { Body } from '@/kernel/types'
import { arrangeAll, parsePlate, place, rectBed, resolvePlate, serializePlate, transformPositions } from './model'

/** An axis-aligned block from (0,0,0) to (w,d,h) as a body (corners only: the placement only needs the vertices). */
function block(id: string, w: number, d: number, h: number): Body {
  const positions = new Float32Array([0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h])
  return { id, key: id, name: id, mesh: { positions, normals: new Float32Array(24), indices: new Uint32Array(0), faceIds: new Uint32Array(0) } } as unknown as Body
}

const bed = rectBed(160, 160, 80)

describe('plate placement', () => {
  it('stands a part on the bed by its own box, turned or not', () => {
    const b = block('a', 20, 20, 60)
    const up = place(b, { r: [0, 0, 0], x: 80, y: 80 }, bed)
    expect(up.size).toEqual([20, 20, 60])
    expect(up.status).toBe('ok')
    // on its side: 60 long, 20 tall, still resting on z = 0 and centred where it was put
    const side = place(b, { r: [90, 0, 0], x: 80, y: 80 }, bed)
    expect(side.size[2]).toBeCloseTo(20, 4)
    expect(side.size[1]).toBeCloseTo(60, 4)
    const moved = transformPositions(b.mesh.positions, side.m)
    let min = Infinity
    for (let i = 2; i < moved.length; i += 3) min = Math.min(min, moved[i])
    expect(min).toBeCloseTo(0, 4)
  })

  it('flags a part that is too tall or off the bed', () => {
    const b = block('a', 20, 20, 90)
    expect(place(b, { r: [0, 0, 0], x: 80, y: 80 }, bed).status).toBe('tall')
    expect(place(block('c', 20, 20, 10), { r: [0, 0, 0], x: 155, y: 80 }, bed).status).toBe('outside')
  })

  it('arranges bodies without a placement into free spots, away from stored ones', () => {
    const a = block('a', 30, 30, 10), b = block('b', 30, 30, 10), c = block('c', 30, 30, 10)
    const { list } = resolvePlate([a, b, c], { a: { r: [0, 0, 0], x: 80, y: 80 } }, bed)
    expect(list.every((p) => p.status === 'ok')).toBe(true)
    for (const [i, p] of list.entries()) for (const q of list.slice(i + 1)) {
      const apart = Math.abs(p.entry.x - q.entry.x) >= 30 || Math.abs(p.entry.y - q.entry.y) >= 30
      expect(apart).toBe(true)
    }
    expect(arrangeAll([a, b, c], {}, bed)).toHaveProperty('c')
  })

  it('round-trips through the document text', () => {
    const store = { a: { r: [0, 90, 12.5] as [number, number, number], x: 10.25, y: 20 } }
    expect(parsePlate(serializePlate(store))).toEqual(store)
    expect(parsePlate('not json')).toEqual({})
    expect(serializePlate({})).toBe('')
  })
})
