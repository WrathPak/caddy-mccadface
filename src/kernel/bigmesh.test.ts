import { describe, expect, it } from 'vitest'
import { BufferAttribute, BufferGeometry, Raycaster, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { buildLod, buildMeshBvh, IntMap, meshDisplayLarge, vertexNormals, weld } from './bigmesh'
import { meshDisplayAuto } from './meshutil'
import { topoVolume } from './meshutil'
import type { TopoMesh } from './types'
import { heightfield, soupOf } from './testMesh'

/** The previous string keyed weld, as the reference for the typed-array one. */
function weldReference(positions: ArrayLike<number>, indices?: ArrayLike<number>, eps = 1e-5): TopoMesh {
  const inv = 1 / eps
  const map = new Map<string, number>()
  const out: number[] = []
  const remap = (i: number) => {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    const k = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv)
    let id = map.get(k)
    if (id === undefined) { id = out.length / 3; map.set(k, id); out.push(x, y, z) }
    return id
  }
  const count = indices ? indices.length : positions.length / 3
  const tri: number[] = []
  for (let t = 0; t < count; t += 3) {
    const a = remap(indices ? indices[t] : t), b = remap(indices ? indices[t + 1] : t + 1), c = remap(indices ? indices[t + 2] : t + 2)
    if (a !== b && b !== c && a !== c) tri.push(a, b, c)
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(tri) }
}

describe('IntMap', () => {
  it('stores and finds big integer keys, growing as needed', () => {
    const m = new IntMap(4)
    for (let i = 0; i < 5000; i++) m.set(i * 4294967311 + 7, i)
    expect(m.size).toBe(5000)
    for (let i = 0; i < 5000; i += 97) expect(m.get(i * 4294967311 + 7)).toBe(i)
    expect(m.get(3)).toBe(-1)
    m.set(7, 1); m.set(7, 2)
    expect(m.get(7)).toBe(2)
  })
})

describe('weld', () => {
  it('gives the same mesh as the string keyed reference, indexed or soup', () => {
    const t = heightfield(40)
    const soup = soupOf(t)
    const a = weld(soup), b = weldReference(soup)
    expect(a.positions).toEqual(b.positions)
    expect(a.indices).toEqual(b.indices)
    const c = weld(t.positions, t.indices), d = weldReference(t.positions, t.indices)
    expect(c.positions).toEqual(d.positions)
    expect(c.indices).toEqual(d.indices)
    expect(a.positions.length / 3).toBe(41 * 41)
  })
  it('drops degenerate triangles and merges points within eps', () => {
    const p = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1e-7, 0])
    const w = weld(p)
    expect(w.indices.length).toBe(3) // second triangle collapses: two of its corners are the same point
  })
  it('welds a three million triangle soup without blowing up', () => {
    const soup = soupOf(heightfield(1000)) // 2M triangles
    const t0 = performance.now()
    const w = weld(soup)
    expect(w.positions.length / 3).toBe(1001 * 1001)
    expect(w.indices.length / 3).toBe(2_000_000)
    expect(performance.now() - t0).toBeLessThan(20_000)
  }, 60_000)
})

describe('large mesh display', () => {
  it('buildLod lands near the triangle budget and keeps the shape', () => {
    const t = heightfield(300) // 180k triangles
    const lod = buildLod(t.positions, t.indices, 20_000)
    const tris = lod.indices.length / 3
    expect(tris).toBeGreaterThan(8_000)
    expect(tris).toBeLessThan(40_000)
    expect(lod.normals.length).toBe(lod.positions.length)
    // every LOD vertex stays inside the original bounding box
    for (let i = 0; i < lod.positions.length; i += 3) {
      expect(lod.positions[i]).toBeGreaterThanOrEqual(-1e-3)
      expect(lod.positions[i]).toBeLessThanOrEqual(100.001)
      expect(Math.abs(lod.positions[i + 2])).toBeLessThanOrEqual(4.001)
    }
    for (const i of lod.indices) expect(i).toBeLessThan(lod.positions.length / 3)
  })

  it('a mesh over the limit gets the cheap display path with a LOD and a usable BVH', () => {
    const t = heightfield(450) // 405k triangles
    const m = meshDisplayAuto(t)
    expect(m.lod).toBeTruthy()
    expect(m.faceCount).toBe(1)
    expect(m.faceIds.length).toBe(405_000)
    expect(m.edges.length).toBe(0)
    expect(m.indices.length).toBe(t.indices.length)
    expect(m.bvh).toBeTruthy()
    // rebuild the BVH the way the viewport does and shoot a ray at it
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(m.positions, 3))
    g.setIndex(new BufferAttribute(m.indices, 1))
    const bvh = MeshBVH.deserialize({ version: 1, roots: m.bvh!.roots, index: m.indices, indirectBuffer: m.bvh!.indirect } as never, g, { setIndex: false })
    const ray = new Raycaster(new Vector3(50, 50, 100), new Vector3(0, 0, -1))
    const hit = bvh.raycastFirst(ray.ray, 2)
    expect(hit).toBeTruthy()
    expect(Math.abs(hit!.point.z)).toBeLessThan(4.01)
  })

  it('small meshes keep the full analysis (several faces, edges, no LOD)', () => {
    const t = heightfield(8)
    const m = meshDisplayAuto(t)
    expect(m.lod).toBeUndefined()
    expect(m.bvh).toBeUndefined()
  })

  it('meshDisplayLarge normals are unit and point up on a heightfield', () => {
    const t = heightfield(30)
    const m = meshDisplayLarge(t)
    const n = vertexNormals(t.positions, t.indices)
    expect(m.normals).toEqual(n)
    for (let i = 0; i < n.length; i += 3) {
      expect(Math.hypot(n[i], n[i + 1], n[i + 2])).toBeCloseTo(1, 4)
      expect(n[i + 2]).toBeGreaterThan(0)
    }
  })

  it('buildMeshBvh leaves the index buffer untouched', () => {
    const t = heightfield(60)
    const before = t.indices.slice()
    buildMeshBvh(t.positions, t.indices)
    expect(t.indices).toEqual(before)
    expect(topoVolume(t)).toBeDefined()
  })
})
