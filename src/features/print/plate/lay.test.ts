import { describe, expect, it } from 'vitest'
import type { Body } from '@/kernel/types'
import { autoOrient } from '../orient'
import { faceRegion } from './faceRegion'
import { laidDown, place, rectBed, transformPositions } from './model'

/** A closed axis-aligned box as triangles; each side is cut as a fan of 4 triangles round its centre (like a B-rep tessellation). */
function boxMesh(x0: number, y0: number, z0: number, w: number, d: number, h: number, fan = true) {
  const pos: number[] = [], idx: number[] = [], face: number[] = []
  const quad = (a: number[], b: number[], c: number[], e: number[], id: number) => {
    const base = pos.length / 3
    pos.push(...a, ...b, ...c, ...e)
    if (fan) {
      const m = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2]
      pos.push(...m)
      idx.push(base, base + 1, base + 4, base + 1, base + 2, base + 4, base + 2, base + 3, base + 4, base + 3, base, base + 4)
      face.push(id, id, id, id)
    } else { idx.push(base, base + 1, base + 2, base, base + 2, base + 3); face.push(id, id) }
  }
  const [x1, y1, z1] = [x0 + w, y0 + d, z0 + h]
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], 0) // bottom (-z)
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 1) // top
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 2) // -y
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], 3) // +x
  quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], 4) // +y
  quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], 5) // -x
  return { positions: pos, indices: idx, faceIds: face }
}

function join(...parts: ReturnType<typeof boxMesh>[]) {
  const positions: number[] = [], indices: number[] = [], faceIds: number[] = []
  let f = 0
  for (const p of parts) {
    const off = positions.length / 3
    positions.push(...p.positions)
    for (const i of p.indices) indices.push(i + off)
    for (const i of p.faceIds) faceIds.push(i + f)
    f += 6
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), faceIds: new Uint32Array(faceIds), faceCount: f }
}

const asBody = (m: ReturnType<typeof join>): Body => ({ id: 'b', key: 'b', name: 'b', mesh: { ...m, normals: new Float32Array(m.positions.length), edges: new Float32Array(0) } }) as unknown as Body
const bed = rectBed(250, 250, 250)

describe('lay on face', () => {
  it('puts a side face on the bed without turning the part about the vertical', () => {
    const body = asBody(join(boxMesh(0, 0, 0, 40, 20, 10)))
    // the +X side (model normal (1,0,0))
    const e = laidDown(body, { r: [0, 0, 0], x: 100, y: 120 }, [1, 0, 0], bed)
    const p = place(body, e, bed)
    const out = transformPositions(body.mesh.positions, p.m)
    for (let i = 0; i < out.length; i += 3) if (Math.abs(body.mesh.positions[i] - 40) < 1e-6) expect(out[i + 2]).toBeCloseTo(0, 3)
    // model Y stays along a world axis (no yaw): its image has no component off the Y axis
    const ay = [p.m[4], p.m[5], p.m[6]]
    expect(Math.abs(ay[1])).toBeCloseTo(1, 4)
    // the footprint centre stays where it was
    expect(e.x).toBeCloseTo(100, 2)
    expect(e.y).toBeCloseTo(120, 2)
  })

  it('composes with an existing rotation and keeps the centre on the bed', () => {
    const body = asBody(join(boxMesh(0, 0, 0, 40, 20, 10)))
    const first = laidDown(body, { r: [0, 0, 25], x: 5, y: 5 }, [0, 0, 1], bed)
    // model +Z (top) is already up; laying it on its +Z face flips it, yaw stays 25 degrees
    const p = place(body, first, bed)
    expect(p.m[10]).toBeCloseTo(-1, 4)
    expect(Math.hypot(p.m[0], p.m[1])).toBeCloseTo(1, 4)
    expect(first.x).toBeGreaterThanOrEqual(p.size[0] / 2 - 1e-2)
  })
})

describe('face regions', () => {
  it('returns every triangle of a planar B-rep face, whichever one is clicked', () => {
    const m = join(boxMesh(0, 0, 0, 40, 20, 10))
    const r = faceRegion(m, 5) // a triangle of the top fan (face 1)
    expect(r?.tris.sort((a, b) => a - b)).toEqual([4, 5, 6, 7])
    expect(r?.normal[2]).toBeCloseTo(1, 6)
  })

  it('flood-fills a plain mesh by coplanar connected triangles', () => {
    const m = { ...join(boxMesh(0, 0, 0, 40, 20, 10)), faceIds: new Uint32Array(24), faceCount: undefined }
    const r = faceRegion(m, 5)
    expect(r?.tris).toHaveLength(4)
    expect(r?.area).toBeCloseTo(800, 3)
  })
})

describe('auto orient rests flat', () => {
  const lowest = (m: ReturnType<typeof join>, down: [number, number, number]) => {
    const h = (i: number) => -(m.positions[i] * down[0] + m.positions[i + 1] * down[1] + m.positions[i + 2] * down[2])
    let min = Infinity
    for (let i = 0; i < m.positions.length; i += 3) min = Math.min(min, h(i))
    const low: number[] = []
    for (let i = 0; i < m.positions.length; i += 3) if (h(i) < min + 0.01) low.push(i)
    return low.length
  }

  it('a tilted box ends up on one of its faces', () => {
    // a box turned 20 degrees about X and Y: only a real face is a legal bottom
    const raw = boxMesh(0, 0, 0, 40, 30, 12, false)
    const c = Math.cos(0.35), s = Math.sin(0.35)
    const p = raw.positions
    for (let i = 0; i < p.length; i += 3) { const y = p[i + 1], z = p[i + 2]; p[i + 1] = y * c - z * s; p[i + 2] = y * s + z * c }
    const m = join(raw)
    const res = autoOrient(m, { angle: 45, goal: 'support' })
    expect(res.ranked.length).toBeGreaterThan(0)
    expect(lowest(m, res.ranked[0].down)).toBeGreaterThanOrEqual(4)
  })

  it('an L bracket rests on a flat face', () => {
    const m = join(boxMesh(0, 0, 0, 60, 30, 6, false), boxMesh(0, 0, 6, 6, 30, 30, false))
    const res = autoOrient(m, { angle: 45, goal: 'support' })
    const best = res.ranked[0]
    expect(best.contactArea).toBeGreaterThan(50)
    expect(lowest(m, best.down)).toBeGreaterThanOrEqual(4)
  })
})
