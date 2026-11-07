import { describe, expect, it } from 'vitest'
import type { Imp } from '@/sketch/importers'
import type { Vec2 } from '@/sketch/types'
import { fitLoop } from './sectionFit'

const circle = (r: number, n: number): Vec2[] => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)])

describe('section outline fit', () => {
  it('a round outline is one circle', () => {
    const s = fitLoop(circle(10, 64), true, 0.05)
    expect(s).toHaveLength(1)
    expect(s[0].k).toBe('circle')
    expect((s[0] as { r: number }).r).toBeCloseTo(10, 1)
  })
  it('a rectangle with extra points on its sides is four lines', () => {
    const pts: Vec2[] = []
    for (let i = 0; i < 10; i++) pts.push([i * 4, 0])
    for (let i = 0; i < 6; i++) pts.push([40, i * 5])
    for (let i = 0; i < 10; i++) pts.push([40 - i * 4, 30])
    for (let i = 0; i < 6; i++) pts.push([0, 30 - i * 5])
    const s = fitLoop(pts, true, 0.05)
    expect(s.map((x) => x.k)).toEqual(['line', 'line', 'line', 'line'])
  })
  it('a stadium (two flat sides, two round ends) is lines and arcs that join up', () => {
    const pts: Vec2[] = []
    for (let i = 0; i <= 12; i++) pts.push([i * 2, -5])
    for (let i = 1; i < 24; i++) pts.push([24 + 5 * Math.sin((Math.PI * i) / 24), -5 * Math.cos((Math.PI * i) / 24)])
    for (let i = 0; i <= 12; i++) pts.push([24 - i * 2, 5])
    for (let i = 1; i < 24; i++) pts.push([-5 * Math.sin((Math.PI * i) / 24), 5 * Math.cos((Math.PI * i) / 24)])
    const s = fitLoop(pts, true, 0.05)
    expect(s.filter((x) => x.k === 'arc')).toHaveLength(2)
    expect(s.filter((x) => x.k === 'line')).toHaveLength(2)
    const ends = (x: Imp): [Vec2, Vec2] => x.k === 'line' ? [x.a, x.b] : x.k === 'arc' ? [[x.c[0] + x.r * Math.cos(x.a0), x.c[1] + x.r * Math.sin(x.a0)], [x.c[0] + x.r * Math.cos(x.a1), x.c[1] + x.r * Math.sin(x.a1)]] : [[0, 0], [0, 0]]
    // every end meets another end
    const all = s.flatMap(ends)
    for (const p of all) expect(all.filter((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3).length).toBe(2)
  })
  it('an open outline stays open', () => {
    const s = fitLoop([[0, 0], [5, 0], [10, 0], [10, 10]], false, 0.05)
    expect(s.map((x) => x.k)).toEqual(['line', 'line'])
  })
})
