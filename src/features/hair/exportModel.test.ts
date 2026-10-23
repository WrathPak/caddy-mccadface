/**
 * Not a real test: builds the hair test model for scripts/slice-check.mjs through the app's own pipeline (generateHair, the boolean
 * stage, the STL writer) and writes it, with a sidecar describing the intended geometry, to $HAIR_STL_OUT. Skipped unless that
 * variable is set.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSolids, generateHair } from '../../kernel/hair-core'
import { fromManifold, initManifold } from '../../kernel/mesh'
import { writeStl } from '../../io/stl'
import { hairSchema, type HairParams, type V3 } from './schema'

const out = process.env.HAIR_STL_OUT

function defaults(over: Partial<HairParams>): HairParams {
  const d: Record<string, unknown> = {}
  const walk = (ps: typeof hairSchema.params) => { for (const p of ps) { if (p.type === 'group') walk(p.children); else d[p.key] = p.default } }
  walk(hairSchema.params)
  return { ...(d as unknown as HairParams), ...over }
}

describe.skipIf(!out)('export hair model for the slicer check', () => {
  it('writes model.stl and model.json', async () => {
    const W = await initManifold()
    const lo: V3 = [-30, 0, 0], hi: V3 = [0, 30, 24.6]
    const body = W.Manifold.cube([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]).translate(lo)
    const mesh = body.getMesh()
    const pos = Float32Array.from(mesh.vertProperties), idx = Uint32Array.from(mesh.triVerts)
    const faceN = (t: number): V3 => {
      const p = (k: number) => [pos[idx[t * 3 + k] * 3], pos[idx[t * 3 + k] * 3 + 1], pos[idx[t * 3 + k] * 3 + 2]]
      const a = p(0), b = p(1), c = p(2)
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]].map((x) => x / Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])) as V3
    }
    const sel: number[] = [], rest: number[] = []
    for (let t = 0; t < idx.length / 3; t++) {
      const n = faceN(t)
      ;(n[0] > 0.99 || n[1] < -0.99 ? sel : rest).push(t)
    }
    const soup = (ts: number[]) => {
      const p: number[] = []
      for (const t of ts) for (let k = 0; k < 3; k++) p.push(pos[idx[t * 3 + k] * 3], pos[idx[t * 3 + k] * 3 + 1], pos[idx[t * 3 + k] * 3 + 2])
      return { positions: Float32Array.from(p), indices: Uint32Array.from({ length: p.length / 3 }, (_, i) => i) }
    }
    const region = soup(sel), others = soup(rest)
    const over = JSON.parse(process.env.HAIR_PARAMS ?? '{}') as Partial<HairParams>
    const p = defaults({ length: 12, density: 8, ...over })
    const g = generateHair({ p, axis: { o: [0, 0, 0], d: [0, 0, 1] }, positions: region.positions, indices: region.indices, obstacle: others, sides: 8 })
    const solids: unknown[] = []
    const own = <T extends { delete(): void }>(m: T) => { solids.push(m); return m }
    const s = buildSolids(W, g, p, { positions: pos, indices: idx }, own as never)
    expect(s.merged!.decompose().length).toBe(1)
    const topo = fromManifold(s.merged!)
    fs.mkdirSync(out!, { recursive: true })
    fs.writeFileSync(path.join(out!, 'model.stl'), writeStl([topo]))
    const strands = g.strands.map((st) => {
      const n = st.scale.length
      const at = (i: number): V3 => [st.pts[i * 3], st.pts[i * 3 + 1], st.pts[i * 3 + 2]]
      return { root: st.root, contact: st.contact, tip: st.tip, z: at(n - 1)[2] }
    })
    let wlo = Infinity
    for (let i = 2; i < g.wall!.mesh.positions.length; i += 3) wlo = Math.min(wlo, g.wall!.mesh.positions[i])
    const side = (k: number) => k
    void side
    fs.writeFileSync(path.join(out!, 'model.json'), JSON.stringify({
      body: { min: lo, max: hi },
      params: { width: Math.max(p.width, p.nozzle * 1.4), thickness: Math.max(p.layerHeight, Math.round(p.thickness / p.layerHeight) * p.layerHeight), layerHeight: p.layerHeight, firstLayer: p.firstLayer, nozzle: p.nozzle, length: p.length, wallThickness: p.wallThickness },
      bedZ: g.bedZ, wallMinZ: wlo, strands, dropped: g.dropped, edgeRejected: g.edgeRejected,
    }))
    for (const m of solids) (m as { delete(): void }).delete()
    body.delete()
  })
})
