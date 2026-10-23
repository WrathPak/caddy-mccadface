import { describe, expect, it } from 'vitest'
import { parseStl, writeStl } from '../io/stl'
import { computeEdgeSigs, computeFaceSigs, type Body, type TopoMesh } from './types'
import { meshDisplay, segmentFaces, weld } from './meshutil'
import { faceSigs, refFromSelection, resolveFace } from '../doc/refs'
import { regionFromSelection, resolveRegionSet } from '../features/hair/region'

function cube(s = 10): TopoMesh {
  const positions = new Float32Array(24)
  for (let i = 0; i < 8; i++) positions.set([(i & 1) * s, ((i >> 1) & 1) * s, ((i >> 2) & 1) * s], i * 3)
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]] // outward winding
  const idx: number[] = []
  for (const q of quads) idx.push(q[0], q[1], q[2], q[0], q[2], q[3])
  return { positions, indices: Uint32Array.from(idx) }
}

function cylinder(r: number, h: number, segs: number): TopoMesh {
  const pos: number[] = []
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs
    pos.push(r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(a), r * Math.sin(a), h)
  }
  const bc = pos.length / 3; pos.push(0, 0, 0)
  const tc = pos.length / 3; pos.push(0, 0, h)
  const idx: number[] = []
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs
    const b0 = i * 2, t0 = i * 2 + 1, b1 = j * 2, t1 = j * 2 + 1
    idx.push(b0, b1, t1, b0, t1, t0, bc, b1, b0, tc, t0, t1)
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** Through the same path as an import: STL bytes -> parse -> weld -> display mesh. */
function imported(t: TopoMesh, crease?: number) {
  const parsed = parseStl(writeStl([t]))
  const welded = weld(parsed[0].positions)
  return { welded, mesh: meshDisplay(welded, crease) }
}

const bodyOf = (mesh: ReturnType<typeof meshDisplay>): Body => ({ id: 'b1', name: 'M', kind: 'mesh', key: 'k', featureId: 'f1', mesh })

describe('mesh body face segmentation', () => {
  it('a cube STL has 6 faces (2 triangles each) and 12 feature edges', () => {
    const { mesh } = imported(cube())
    expect(mesh.faceCount).toBe(6)
    expect(new Set(mesh.faceIds).size).toBe(6)
    const per = new Map<number, number>()
    for (const f of mesh.faceIds) per.set(f, (per.get(f) ?? 0) + 1)
    expect([...per.values()]).toEqual([2, 2, 2, 2, 2, 2])
    expect(mesh.edgeCount).toBe(12)
    expect(new Set(mesh.edgeIds).size).toBe(12)
    expect(computeFaceSigs(mesh)).toHaveLength(6)
    const e = computeEdgeSigs(mesh)
    expect(e).toHaveLength(12)
    for (const s of e) expect(s.length).toBeCloseTo(10, 4)
  })

  it('a cylinder STL has 3 faces (side, top, bottom) and 2 circular edges', () => {
    const { mesh } = imported(cylinder(10, 20, 64))
    expect(mesh.faceCount).toBe(3)
    expect(new Set(mesh.faceIds).size).toBe(3)
    expect(mesh.edgeCount).toBe(2)
    const e = computeEdgeSigs(mesh)
    for (const s of e) expect(s.length).toBeGreaterThan(2 * Math.PI * 10 * 0.99)
  })

  it('the crease angle is configurable', () => {
    // 12-sided prism: 30 deg between side faces
    const prism = cylinder(10, 20, 12)
    expect(imported(prism, 20).mesh.faceCount).toBe(14)
    expect(imported(prism, 45).mesh.faceCount).toBe(3)
  })

  it('open and non-manifold edges never connect faces', () => {
    const c = cube()
    const dup = { positions: c.positions, indices: Uint32Array.from([...c.indices, ...c.indices.slice(0, 3)]) }
    expect(segmentFaces(dup).faceCount).toBeGreaterThanOrEqual(6)
    const open = { positions: c.positions, indices: c.indices.slice(0, 33) } // one triangle missing
    expect(segmentFaces(open).faceCount).toBe(6)
    expect(meshDisplay(open).edgeCount).toBeGreaterThan(12) // the open boundary adds feature edges
  })

  it('face refs resolve on mesh bodies and survive regeneration', () => {
    const body = bodyOf(imported(cube()).mesh)
    const sigs = faceSigs(body)
    expect(sigs).toHaveLength(6)
    const ref = refFromSelection({ kind: 'face', id: 'b1', index: 3 }, [body])!
    expect(ref.kind).toBe('face')
    // regenerated body with different face numbering (reversed triangle order)
    const t = cube()
    const rev = new Uint32Array(t.indices.length)
    const T = t.indices.length / 3
    for (let i = 0; i < T; i++) rev.set(t.indices.subarray((T - 1 - i) * 3, (T - i) * 3), i * 3)
    const body2 = { ...bodyOf(meshDisplay({ positions: t.positions, indices: rev })), key: 'k2' }
    const res = resolveFace(ref as never, [body2])!
    expect(res).not.toBeNull()
    const a = sigs[3], b = faceSigs(body2)[res.index]
    expect(b.normal.map((x, i) => Math.abs(x - a.normal[i])).every((d) => d < 1e-4)).toBe(true)
  })

  it('hair "Use sel." on a mesh face selects only that face', () => {
    const body = bodyOf(imported(cube()).mesh)
    const region = regionFromSelection([{ kind: 'face', id: 'b1', index: 2 }], [body])
    const rs = resolveRegionSet(region, [body])!
    expect(rs.kind).toBe('mesh')
    expect(rs.set.size).toBe(2)
    for (const t of rs.set) expect(body.mesh.faceIds[t]).toBe(2)
    // two faces
    const two = resolveRegionSet(regionFromSelection([{ kind: 'face', id: 'b1', index: 0 }, { kind: 'face', id: 'b1', index: 5 }], [body]), [body])!
    expect(two.set.size).toBe(4)
    // whole body
    const whole = resolveRegionSet(regionFromSelection([{ kind: 'mesh', id: 'b1' }], [body]), [body])!
    expect(whole.set.size).toBe(12)
  })
})
