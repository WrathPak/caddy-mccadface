/** Hair root sampling on a triangle surface (pure; runs in the kernel worker). */
import { weld } from '../../kernel/meshutil'
import type { HairParams, V3 } from './schema'

/** Deterministic mulberry32 generator. */
export function rng(seed: number): () => number {
  let a = (seed | 0) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Surf {
  pos: Float32Array
  idx: Uint32Array
  /** area-weighted unit vertex normals */
  vn: Float32Array
  /** unit triangle normals */
  tn: Float32Array
  area: Float64Array
  total: number
  /** open boundary as directed edges (in triangle winding order) */
  boundary: [number, number][]
  /** smooth patch (faces joined by creases below CREASE_DEG are one patch) per triangle */
  patch: Int32Array
  patches: number
  /** per triangle corner: unit normal smoothed only within the triangle's own patch (9 floats per triangle) */
  cn: Float32Array
  /** edges between two different patches: [vertexA, vertexB, triangleA, triangleB] */
  seams: [number, number, number, number][]
}

/** Faces meeting at a sharper angle than this are separate patches (hard seams); flatter joins count as one smooth surface. */
export const CREASE_DEG = 40

/** Welded, validated surface with vertex normals. Throws a readable error on non-manifold / inconsistently wound input. */
export function prepSurface(positions: Float32Array, indices: Uint32Array): Surf {
  const w = weld(positions, indices)
  const pos = w.positions, idx = w.indices
  const T = idx.length / 3
  if (!T) throw new Error('The selected surface is empty')
  const nv = pos.length / 3
  const vn = new Float32Array(pos.length)
  const tn = new Float32Array(T * 3)
  const area = new Float64Array(T)
  const raw = new Float64Array(T * 3)
  let total = 0
  const dir = new Map<number, number>()
  for (let t = 0; t < T; t++) {
    const ia = idx[t * 3], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2]
    for (const [p, q] of [[ia, ib], [ib, ic], [ic, ia]]) {
      const key = p * nv + q
      if (dir.has(key)) throw new Error('The selected surface is non-manifold or has inconsistently oriented triangles (an edge is shared by more than two triangles or two triangles disagree on winding); repair the mesh or pick a cleaner region')
      dir.set(key, t)
    }
    const a = ia * 3, b = ib * 3, c = ic * 3
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z)
    area[t] = l / 2
    total += l / 2
    raw[t * 3] = x; raw[t * 3 + 1] = y; raw[t * 3 + 2] = z
    tn[t * 3] = x / (l || 1); tn[t * 3 + 1] = y / (l || 1); tn[t * 3 + 2] = z / (l || 1)
    for (const v of [a, b, c]) { vn[v] += x; vn[v + 1] += y; vn[v + 2] += z }
  }
  normalizeAll(vn)
  const boundary: [number, number][] = []
  const seams: [number, number, number, number][] = []
  const cosCrease = Math.cos((CREASE_DEG * Math.PI) / 180)
  const flat = (a: number, b: number) => tn[a * 3] * tn[b * 3] + tn[a * 3 + 1] * tn[b * 3 + 1] + tn[a * 3 + 2] * tn[b * 3 + 2] >= cosCrease
  // flood-fill smooth patches across edges flatter than the crease angle
  const patch = new Int32Array(T).fill(-1)
  let patches = 0
  const stack: number[] = []
  for (let t0 = 0; t0 < T; t0++) {
    if (patch[t0] >= 0) continue
    patch[t0] = patches
    stack.push(t0)
    while (stack.length) {
      const t = stack.pop()!
      for (let k = 0; k < 3; k++) {
        const p = idx[t * 3 + k], q = idx[t * 3 + ((k + 1) % 3)]
        const o = dir.get(q * nv + p)
        if (o === undefined || patch[o] >= 0 || !flat(t, o)) continue
        patch[o] = patches
        stack.push(o)
      }
    }
    patches++
  }
  for (const [key, t] of dir) {
    const a = Math.floor(key / nv), b = key % nv
    const o = dir.get(b * nv + a)
    if (o === undefined) boundary.push([a, b])
    else if (patch[o] !== patch[t] && t < o) seams.push([a, b, t, o])
  }
  const acc = new Map<number, [number, number, number]>()
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const key = patch[t] * nv + idx[t * 3 + k]
    const e = acc.get(key)
    if (e) { e[0] += raw[t * 3]; e[1] += raw[t * 3 + 1]; e[2] += raw[t * 3 + 2] } else acc.set(key, [raw[t * 3], raw[t * 3 + 1], raw[t * 3 + 2]])
  }
  const cn = new Float32Array(T * 9)
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const e = acc.get(patch[t] * nv + idx[t * 3 + k])!
    const l = Math.hypot(e[0], e[1], e[2]) || 1
    cn[t * 9 + k * 3] = e[0] / l; cn[t * 9 + k * 3 + 1] = e[1] / l; cn[t * 9 + k * 3 + 2] = e[2] / l
  }
  return { pos, idx, vn, tn, area, total, boundary, patch, patches, cn, seams }
}

export function normalizeAll(a: Float32Array) {
  for (let i = 0; i < a.length; i += 3) {
    const l = Math.hypot(a[i], a[i + 1], a[i + 2]) || 1
    a[i] /= l; a[i + 1] /= l; a[i + 2] /= l
  }
}

export interface Roots { p: Float32Array; n: Float32Array; /** triangle each root lies on */ tri: Uint32Array; count: number; capped: boolean }

export const MAX_STRANDS = 20000

function bary(s: Surf, t: number, p: V3): V3 {
  const a = s.idx[t * 3] * 3, b = s.idx[t * 3 + 1] * 3, c = s.idx[t * 3 + 2] * 3
  const v0: V3 = [s.pos[b] - s.pos[a], s.pos[b + 1] - s.pos[a + 1], s.pos[b + 2] - s.pos[a + 2]]
  const v1: V3 = [s.pos[c] - s.pos[a], s.pos[c + 1] - s.pos[a + 1], s.pos[c + 2] - s.pos[a + 2]]
  const v2: V3 = [p[0] - s.pos[a], p[1] - s.pos[a + 1], p[2] - s.pos[a + 2]]
  const d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2], d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2]
  const d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]
  const d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2], d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2]
  const den = d00 * d11 - d01 * d01 || 1
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den
  return [1 - v - w, v, w]
}

/** Normal at p smoothed only inside the triangle's own patch: flat faces stay flat, curved patches stay smooth, creases stay hard. */
export function patchNormalAt(s: Surf, t: number, p: V3): V3 {
  const [u, v, w] = bary(s, t, p)
  const c = s.cn
  const n: V3 = [
    c[t * 9] * u + c[t * 9 + 3] * v + c[t * 9 + 6] * w,
    c[t * 9 + 1] * u + c[t * 9 + 4] * v + c[t * 9 + 7] * w,
    c[t * 9 + 2] * u + c[t * 9 + 5] * v + c[t * 9 + 8] * w,
  ]
  const l = Math.hypot(n[0], n[1], n[2])
  return l < 1e-9 ? [s.tn[t * 3], s.tn[t * 3 + 1], s.tn[t * 3 + 2]] : [n[0] / l, n[1] / l, n[2] / l]
}

/** Interpolated smooth normal at point p of triangle t. */
export function normalAt(s: Surf, t: number, p: V3): V3 {
  const [u, v, w] = bary(s, t, p)
  const a = s.idx[t * 3] * 3, b = s.idx[t * 3 + 1] * 3, c = s.idx[t * 3 + 2] * 3
  const n: V3 = [
    s.vn[a] * u + s.vn[b] * v + s.vn[c] * w,
    s.vn[a + 1] * u + s.vn[b + 1] * v + s.vn[c + 1] * w,
    s.vn[a + 2] * u + s.vn[b + 2] * v + s.vn[c + 2] * w,
  ]
  const l = Math.hypot(n[0], n[1], n[2])
  return l < 1e-9 ? [s.tn[t * 3], s.tn[t * 3 + 1], s.tn[t * 3 + 2]] : [n[0] / l, n[1] / l, n[2] / l]
}

function triPoint(s: Surf, t: number, u: number, v: number): V3 {
  const a = s.idx[t * 3] * 3, b = s.idx[t * 3 + 1] * 3, c = s.idx[t * 3 + 2] * 3
  return [0, 1, 2].map((k) => s.pos[a + k] + (s.pos[b + k] - s.pos[a + k]) * u + (s.pos[c + k] - s.pos[a + k]) * v) as V3
}

/** Narrowest strand that slices reliably: well over one extrusion line (slicers drop thinner walls; 0.45 mm already fails for a 0.4 mm nozzle). */
export const MIN_WIDTH_FACTOR = 1.4
export const minWidth = (p: HairParams) => p.nozzle * MIN_WIDTH_FACTOR
/** Strand width actually used (never below the printable minimum). */
export const effWidth = (p: HairParams) => Math.max(p.width, minWidth(p))
/** Layer thickness actually used for strands: whole layers when snapping (always in print-aware mode). */
export const snappedThickness = (p: HairParams) =>
  p.snapThickness || p.printAware ? Math.max(p.layerHeight, Math.round(p.thickness / p.layerHeight) * p.layerHeight) : p.thickness
/** Z of the first strand band's underside: the bed (lowest point of the model) plus the first layer. Layers are counted from here. */
export const layerBase = (p: HairParams) => (p.bedZ ?? 0) + p.firstLayer

/**
 * Layer-aligned rows: contour lines of the surface at z = k * rowGap + thickness/2 (so each strand's underside sits on a layer boundary),
 * chained into polylines and walked at uniform spacing.
 */
function rowRoots(s: Surf, P: HairParams, dens: number, rand: () => number, pts: V3[], tris: number[]) {
  const nv = s.pos.length / 3
  const lh = P.layerHeight
  const half = snappedThickness(P) / 2
  const spacing = 1 / Math.sqrt(dens)
  const rowGap = Math.max(1, Math.round(spacing / lh)) * lh
  const base = layerBase(P)
  const zOf = (k: number) => base + k * rowGap + half
  const rows = new Map<number, number[]>()
  for (let t = 0; t < s.idx.length / 3; t++) {
    const z = [0, 1, 2].map((k) => s.pos[s.idx[t * 3 + k] * 3 + 2])
    const lo = Math.min(...z), hi = Math.max(...z)
    for (let k = Math.floor((lo - half - base) / rowGap); zOf(k) <= hi; k++) {
      if (zOf(k) > lo) { const l = rows.get(k); if (l) l.push(t); else rows.set(k, [t]) }
    }
  }
  for (const k of [...rows.keys()].sort((a, b) => a - b)) {
    const z = zOf(k)
    interface Seg { ka: number; kb: number; A: V3; B: V3; t: number; along: number }
    const segs: Seg[] = []
    const link = new Map<number, number[]>()
    for (const t of rows.get(k)!) {
      const hits: { key: number; p: V3 }[] = []
      for (let e = 0; e < 3; e++) {
        const a = s.idx[t * 3 + e], b = s.idx[t * 3 + ((e + 1) % 3)]
        const za = s.pos[a * 3 + 2], zb = s.pos[b * 3 + 2]
        if ((za < z) === (zb < z)) continue
        const f = (z - za) / (zb - za)
        hits.push({ key: Math.min(a, b) * nv + Math.max(a, b), p: [s.pos[a * 3] + (s.pos[b * 3] - s.pos[a * 3]) * f, s.pos[a * 3 + 1] + (s.pos[b * 3 + 1] - s.pos[a * 3 + 1]) * f, z] })
      }
      if (hits.length !== 2) continue
      // steepness of the surface along z: distance along the surface per unit of height
      const g = Math.max(0.15, Math.sqrt(Math.max(0, 1 - s.tn[t * 3 + 2] ** 2)))
      const id = segs.length
      segs.push({ ka: hits[0].key, kb: hits[1].key, A: hits[0].p, B: hits[1].p, t, along: g / (dens * rowGap) })
      for (const key of [hits[0].key, hits[1].key]) { const l = link.get(key); if (l) l.push(id); else link.set(key, [id]) }
    }
    const used = new Uint8Array(segs.length)
    const walk = (start: number, fromKey: number) => {
      let ph = rand()
      let seg = start, key = fromKey
      while (seg >= 0 && !used[seg]) {
        used[seg] = 1
        const S = segs[seg]
        const fwd = S.ka === key
        const [A, B] = fwd ? [S.A, S.B] : [S.B, S.A]
        const L = Math.hypot(B[0] - A[0], B[1] - A[1])
        const rate = 1 / Math.max(0.05, S.along)
        let d = 0
        for (;;) {
          const need = (1 - ph) / rate
          if (d + need > L) { ph += (L - d) * rate; break }
          d += need; ph = 0
          if (pts.length >= MAX_STRANDS) return
          const f = L > 0 ? d / L : 0
          pts.push([A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, z]); tris.push(S.t)
        }
        key = fwd ? S.kb : S.ka
        seg = (link.get(key) ?? []).find((x) => x !== seg && !used[x]) ?? -1
      }
    }
    for (const key of [...link.keys()].sort((a, b) => a - b)) if (link.get(key)!.length === 1 && !used[link.get(key)![0]]) walk(link.get(key)![0], key)
    for (let i = 0; i < segs.length; i++) if (!used[i]) walk(i, segs[i].ka)
    if (pts.length >= MAX_STRANDS) break
  }
}

/** Move a root along its triangle so its height is a layer-aligned strand centre (underside on a layer boundary). */
function snapToLayer(s: Surf, P: HairParams, p: V3, t: number): V3 {
  const lh = P.layerHeight, half = snappedThickness(P) / 2
  const nz = s.tn[t * 3 + 2]
  const nrm: V3 = [s.tn[t * 3], s.tn[t * 3 + 1], nz]
  const g: V3 = [-nz * nrm[0], -nz * nrm[1], 1 - nz * nz] // z projected onto the triangle plane
  const gl2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2]
  if (gl2 < 0.0625) return p // plane within ~14 deg of horizontal: height cannot be controlled by sliding along it
  const base = layerBase(P)
  const target = base + Math.round((p[2] - half - base) / lh) * lh + half
  const k = (target - p[2]) / gl2
  return [p[0] + g[0] * k, p[1] + g[1] * k, target]
}

/** Area-weighted root sampling (Poisson dart throwing / triangle grid / layer-aligned rows). */
export function sampleRoots(s: Surf, P: HairParams): Roots {
  const rand = rng(P.seed * 1013 + 7)
  const dens0 = P.densityMode === 'density' ? P.density / 100 : 1 / (P.spacing * P.spacing)
  const dens = Math.min(dens0, MAX_STRANDS / Math.max(s.total, 1e-6))
  const capped = dens < dens0
  const spacing = 1 / Math.sqrt(dens)
  const pts: V3[] = [], tris: number[] = []

  if (P.distribution === 'rows') {
    rowRoots(s, P, dens, rand, pts, tris)
  } else if (P.distribution === 'grid') {
    for (let t = 0; t < s.idx.length / 3; t++) {
      const n = s.area[t] * dens
      // k*k points per triangle; k is rounded stochastically so the expected count equals n
      const k0 = Math.floor(Math.sqrt(n))
      const k = rand() < (n - k0 * k0) / ((k0 + 1) ** 2 - k0 * k0) ? k0 + 1 : k0
      if (k === 1) { let u = rand(), v = rand(); if (u + v > 1) { u = 1 - u; v = 1 - v } pts.push(triPoint(s, t, u, v)); tris.push(t); continue }
      for (let i = 0; i < k; i++) {
        for (let j = 0; i + j < k; j++) {
          pts.push(triPoint(s, t, (i + 1 / 3) / k, (j + 1 / 3) / k)); tris.push(t)
          if (i + j < k - 1) { pts.push(triPoint(s, t, (i + 2 / 3) / k, (j + 2 / 3) / k)); tris.push(t) }
        }
      }
    }
  } else {
    // Poisson-disk by dart throwing on a spatial hash
    const target = Math.min(MAX_STRANDS, Math.round(s.total * dens))
    const r = spacing * 0.7, r2 = r * r
    const cum = new Float64Array(s.area.length)
    let acc = 0
    for (let t = 0; t < cum.length; t++) cum[t] = acc += s.area[t]
    const grid = new Map<string, number[]>()
    const key = (x: number, y: number, z: number) => x + ',' + y + ',' + z
    for (let tries = 0; pts.length < target && tries < target * 30; tries++) {
      const f = rand() * acc
      let lo = 0, hi = cum.length - 1
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < f) lo = m + 1; else hi = m }
      let u = rand(), v = rand()
      if (u + v > 1) { u = 1 - u; v = 1 - v }
      const p = triPoint(s, lo, u, v)
      const cx = Math.floor(p[0] / r), cy = Math.floor(p[1] / r), cz = Math.floor(p[2] / r)
      let ok = true
      for (let dx = -1; dx <= 1 && ok; dx++) for (let dy = -1; dy <= 1 && ok; dy++) for (let dz = -1; dz <= 1 && ok; dz++) {
        const list = grid.get(key(cx + dx, cy + dy, cz + dz))
        if (!list) continue
        for (const q of list) {
          const o = pts[q]
          if ((o[0] - p[0]) ** 2 + (o[1] - p[1]) ** 2 + (o[2] - p[2]) ** 2 < r2) { ok = false; break }
        }
      }
      if (!ok) continue
      const k = key(cx, cy, cz)
      const l = grid.get(k)
      if (l) l.push(pts.length); else grid.set(k, [pts.length])
      pts.push(p); tris.push(lo)
    }
  }

  // print-aware: layer-align the root heights for every pattern (rows already are)
  if (P.printAware && P.distribution !== 'rows') for (let i = 0; i < pts.length; i++) pts[i] = snapToLayer(s, P, pts[i], tris[i])

  // edge margin: distance to the region's open boundary
  const keep = P.edgeMargin > 0 ? farFromBoundary(s, pts, P.edgeMargin) : null
  const outP: number[] = [], outN: number[] = [], outT: number[] = []
  let count = 0
  pts.forEach((p, i) => {
    if (keep && !keep[i]) return
    const n = normalAt(s, tris[i], p)
    outP.push(p[0], p[1], p[2]); outN.push(n[0], n[1], n[2]); outT.push(tris[i])
    count++
  })
  return { p: new Float32Array(outP), n: new Float32Array(outN), tri: Uint32Array.from(outT), count, capped }
}

function farFromBoundary(s: Surf, pts: V3[], margin: number): Uint8Array {
  const edges = s.boundary
  const ok = new Uint8Array(pts.length).fill(1)
  if (!edges.length) return ok
  const cell = Math.max(margin * 2, 1)
  const grid = new Map<string, number[]>()
  const k3 = (x: number, y: number, z: number) => x + ',' + y + ',' + z
  edges.forEach(([a, b], i) => {
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(s.pos[a * 3 + k], s.pos[b * 3 + k]) - margin) / cell))
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(s.pos[a * 3 + k], s.pos[b * 3 + k]) + margin) / cell))
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = k3(x, y, z)
      const l = grid.get(k)
      if (l) l.push(i); else grid.set(k, [i])
    }
  })
  const m2 = margin * margin
  pts.forEach((p, i) => {
    const l = grid.get(k3(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)))
    if (!l) return
    for (const e of l) {
      const [a, b] = edges[e]
      const ax = s.pos[a * 3], ay = s.pos[a * 3 + 1], az = s.pos[a * 3 + 2]
      const dx = s.pos[b * 3] - ax, dy = s.pos[b * 3 + 1] - ay, dz = s.pos[b * 3 + 2] - az
      const L2 = dx * dx + dy * dy + dz * dz || 1
      const f = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / L2))
      if ((p[0] - ax - dx * f) ** 2 + (p[1] - ay - dy * f) ** 2 + (p[2] - az - dz * f) ** 2 < m2) { ok[i] = 0; return }
    }
  })
  return ok
}

/** Uniform-grid index over line segments for "nearest edge within r" queries. */
export class SegIndex {
  private grid = new Map<string, number[]>()
  private cell: number
  constructor(private pos: Float32Array, private segs: ArrayLike<readonly [number, number]>, private maxR: number) {
    this.cell = Math.max(maxR, 0.5)
    const c = this.cell
    for (let i = 0; i < segs.length; i++) {
      const [a, b] = segs[i]
      const lo = [0, 1, 2].map((k) => Math.floor((Math.min(pos[a * 3 + k], pos[b * 3 + k]) - maxR) / c))
      const hi = [0, 1, 2].map((k) => Math.floor((Math.max(pos[a * 3 + k], pos[b * 3 + k]) + maxR) / c))
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const key = x + ',' + y + ',' + z
        const l = this.grid.get(key)
        if (l) l.push(i); else this.grid.set(key, [i])
      }
    }
  }
  /** Calls fn(segment index, distance, parameter along the segment) for every candidate within maxR of p (distance may exceed maxR). */
  each(p: V3, fn: (i: number, d: number, f: number) => void) {
    const c = this.cell
    const l = this.grid.get(Math.floor(p[0] / c) + ',' + Math.floor(p[1] / c) + ',' + Math.floor(p[2] / c))
    if (!l) return
    const { pos } = this
    for (const i of l) {
      const [a, b] = this.segs[i]
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2]
      const dx = pos[b * 3] - ax, dy = pos[b * 3 + 1] - ay, dz = pos[b * 3 + 2] - az
      const L2 = dx * dx + dy * dy + dz * dz || 1
      const f = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / L2))
      fn(i, Math.hypot(p[0] - ax - dx * f, p[1] - ay - dy * f, p[2] - az - dz * f), f)
    }
  }
  /** Distance to the nearest segment, or Infinity when none lies within maxR. */
  nearest(p: V3): number {
    let best = Infinity
    this.each(p, (_i, d) => { if (d < best) best = d })
    return best <= this.maxR ? best : Infinity
  }
}

/**
 * Surface normal for a root in Blend mode: the patch normal, tilted towards each neighbouring patch across a nearby seam.
 * At the seam the normal is halfway between the two faces; it relaxes to the face normal at `dist` from the seam
 * (dist 0: no blending, a hard transition).
 */
export function blendedNormal(s: Surf, seams: SegIndex, t: number, p: V3, base: V3, dist: number): V3 {
  if (dist <= 1e-9) return base
  const pull = new Map<number, { d: number; n: V3 }>()
  seams.each(p, (i, d) => {
    const [, , ta, tb] = s.seams[i]
    const other = s.patch[ta] === s.patch[t] ? tb : s.patch[tb] === s.patch[t] ? ta : -1
    if (other < 0 || d >= dist) return
    const q = s.patch[other]
    const e = pull.get(q)
    if (!e || d < e.d) pull.set(q, { d, n: [s.tn[other * 3], s.tn[other * 3 + 1], s.tn[other * 3 + 2]] })
  })
  let n: V3 = base
  for (const { d, n: nb } of pull.values()) {
    const w = 0.5 * (1 - d / dist)
    n = [n[0] + (nb[0] - base[0]) * w, n[1] + (nb[1] - base[1]) * w, n[2] + (nb[2] - base[2]) * w]
  }
  const l = Math.hypot(n[0], n[1], n[2])
  return l < 1e-9 ? base : [n[0] / l, n[1] / l, n[2] / l]
}
