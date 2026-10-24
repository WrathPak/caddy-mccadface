/** Where generator instances go: random / grid roots (shared with hair) and an aligned lattice that follows a flow direction. */
import { patchNormalAt, rng, sampleRoots, SegIndex, type Surf } from '../../features/hair/sampling'
import { hairSchema, type HairParams, type V3 } from '../../features/hair/schema'
import { cross, dot, mul, norm, sub } from '../../features/hair/vec'
import { schemaDefaults } from '../../ui/schema'
import { circumference, dirsOf, fitPatch, planarMap, uvOf, type PatchMap } from './param'

/** Hair parameters with the schema defaults filled in, so the shared samplers can be driven from other tools. */
export function hairParams(over: Partial<HairParams>): HairParams {
  return { ...(schemaDefaults(hairSchema) as unknown as HairParams), ...over }
}

export interface Root { p: V3; n: V3; tri: number }
export interface FlowRoot extends Root {
  /** unit tangent the instance points along (the flow) and the unit tangent across it */
  flow: V3
  side: V3
  /** row / column of the lattice cell (for variation that must not depend on the traversal order) */
  cell: [number, number]
}

export const MAX_INSTANCES = 20000

export interface RandomLayout {
  distribution: 'poisson' | 'grid'
  /** instances per cm2 */
  density: number
  seed: number
  edgeMargin: number
}

/** Random (Poisson disk) or triangle-grid roots with smooth-patch normals. */
export function randomRoots(s: Surf, o: RandomLayout): { roots: Root[]; capped: boolean } {
  const P = hairParams({ distribution: o.distribution, densityMode: 'density', density: o.density, seed: o.seed, edgeMargin: o.edgeMargin, printAware: false })
  const r = sampleRoots(s, P)
  const roots: Root[] = []
  for (let i = 0; i < r.count; i++) {
    const p: V3 = [r.p[i * 3], r.p[i * 3 + 1], r.p[i * 3 + 2]]
    roots.push({ p, n: patchNormalAt(s, r.tri[i], p), tri: r.tri[i] })
  }
  return { roots, capped: r.capped }
}

/** Distance index over the open boundary and the creases of the region: instances must keep their footprint clear of these. */
export function edgeIndex(s: Surf, reach: number): SegIndex | null {
  const segs: (readonly [number, number])[] = s.boundary.map((e) => [e[0], e[1]] as const)
  for (const e of s.seams) segs.push([e[0], e[1]])
  return segs.length ? new SegIndex(s.pos, segs, reach) : null
}

export interface LatticeLayout {
  /** cell size across (u) and along (v) the flow, mm */
  du: number
  dv: number
  flow: V3
  /** shift every other row by half a cell */
  stagger: boolean
  /** random shift of each cell as a fraction of the cell size (0 = perfectly regular) */
  jitter: number
  seed: number
}

/**
 * Lattice of cells laid on the surface so rows run across the flow. Each smooth patch gets its own plane / cylinder map; a round
 * patch gets a whole number of cells around it so the pattern closes without a seam.
 */
export function latticeRoots(s: Surf, o: LatticeLayout): { roots: FlowRoot[]; capped: boolean; round: number; projected: number } {
  const byPatch = new Map<number, number[]>()
  for (let t = 0; t < s.idx.length / 3; t++) {
    const l = byPatch.get(s.patch[t])
    if (l) l.push(t); else byPatch.set(s.patch[t], [t])
  }
  const roots: FlowRoot[] = []
  let capped = false, round = 0, projected = 0
  for (const tris of byPatch.values()) {
    const fit = fitPatch(s, tris, o.flow)
    const map: PatchMap = fit ?? planarMap(s, tris, o.flow)
    if (!fit) projected++
    if (fit?.kind === 'cylinder') round++
    let du = o.du, dv = o.dv
    // whole number of cells around a cylinder (an even number of rows when the rows themselves run round)
    const C = map.kind === 'cylinder' ? circumference(map) : 0
    let wrapN = 0
    if (map.kind === 'cylinder') {
      if (map.around) { wrapN = Math.max(2, 2 * Math.round(C / (2 * dv))); dv = C / wrapN } else { wrapN = Math.max(3, Math.round(C / du)); du = C / wrapN }
    }
    const seen = new Set<string>()
    for (const t of tris) {
      const uv: [number, number][] = [0, 1, 2].map((k) => {
        const vi = s.idx[t * 3 + k] * 3
        return uvOf(map, [s.pos[vi], s.pos[vi + 1], s.pos[vi + 2]])
      })
      if (wrapN) {
        const w = map.around ? 1 : 0
        for (let k = 1; k < 3; k++) uv[k][w] += Math.round((uv[0][w] - uv[k][w]) / C) * C
      }
      const umin = Math.min(uv[0][0], uv[1][0], uv[2][0]), umax = Math.max(uv[0][0], uv[1][0], uv[2][0])
      const vmin = Math.min(uv[0][1], uv[1][1], uv[2][1]), vmax = Math.max(uv[0][1], uv[1][1], uv[2][1])
      const x0 = uv[0][0], y0 = uv[0][1]
      const d1x = uv[1][0] - x0, d1y = uv[1][1] - y0, d2x = uv[2][0] - x0, d2y = uv[2][1] - y0
      const det = d1x * d2y - d1y * d2x
      if (Math.abs(det) < 1e-12) continue
      for (let j = Math.floor(vmin / dv) - 1; j <= Math.ceil(vmax / dv) + 1; j++) {
        const off = o.stagger && (j & 1) ? 0.5 : 0
        for (let i = Math.floor(umin / du - off) - 1; i <= Math.ceil(umax / du - off) + 1; i++) {
          const jr = o.jitter > 0 ? cellJitter(o.seed, i, j, wrapN, map.around) : [0, 0]
          const u = (i + off + jr[0] * o.jitter) * du, v = (j + jr[1] * o.jitter) * dv
          const a = ((u - x0) * d2y - (v - y0) * d2x) / det, b = ((v - y0) * d1x - (u - x0) * d1y) / det
          if (a < -1e-9 || b < -1e-9 || a + b > 1 + 1e-9) continue
          const key = wrapN ? (map.around ? `${i},${((j % wrapN) + wrapN) % wrapN}` : `${((i % wrapN) + wrapN) % wrapN},${j}`) : `${i},${j}`
          if (seen.has(key)) continue
          seen.add(key)
          const ia = s.idx[t * 3] * 3, ib = s.idx[t * 3 + 1] * 3, ic = s.idx[t * 3 + 2] * 3
          const p: V3 = [0, 1, 2].map((c) => s.pos[ia + c] + (s.pos[ib + c] - s.pos[ia + c]) * a + (s.pos[ic + c] - s.pos[ia + c]) * b) as V3
          const n = patchNormalAt(s, t, p)
          const { dv: dir } = dirsOf(map, p)
          let flow = sub(dir, mul(n, dot(dir, n)))
          flow = norm(flow)
          if (!flow.some(Boolean)) continue
          if (roots.length >= MAX_INSTANCES) { capped = true; break }
          roots.push({ p, n, tri: t, flow, side: cross(n, flow), cell: [i, j] })
        }
        if (capped) break
      }
      if (capped) break
    }
    if (capped) break
  }
  return { roots, capped, round, projected }
}

/** Deterministic pseudo random shift in [-0.5, 0.5]^2 of a lattice cell. */
function cellJitter(seed: number, i: number, j: number, wrapN: number, around: boolean): [number, number] {
  const ii = wrapN && !around ? ((i % wrapN) + wrapN) % wrapN : i
  const jj = wrapN && around ? ((j % wrapN) + wrapN) % wrapN : j
  const r = rng(Math.imul(ii, 73856093) ^ Math.imul(jj, 19349663) ^ Math.imul(seed + 1, 83492791))
  return [r() - 0.5, r() - 0.5]
}
