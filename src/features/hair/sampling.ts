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
}

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
  let total = 0
  const dir = new Set<number>()
  for (let t = 0; t < T; t++) {
    const ia = idx[t * 3], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2]
    for (const [p, q] of [[ia, ib], [ib, ic], [ic, ia]]) {
      const key = p * nv + q
      if (dir.has(key)) throw new Error('The selected surface is non-manifold or has inconsistently oriented triangles (an edge is shared by more than two triangles or two triangles disagree on winding); repair the mesh or pick a cleaner region')
      dir.add(key)
    }
    const a = ia * 3, b = ib * 3, c = ic * 3
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z)
    area[t] = l / 2
    total += l / 2
    tn[t * 3] = x / (l || 1); tn[t * 3 + 1] = y / (l || 1); tn[t * 3 + 2] = z / (l || 1)
    for (const v of [a, b, c]) { vn[v] += x; vn[v + 1] += y; vn[v + 2] += z }
  }
  normalizeAll(vn)
  const boundary: [number, number][] = []
  for (const key of dir) {
    const a = Math.floor(key / nv), b = key % nv
    if (!dir.has(b * nv + a)) boundary.push([a, b])
  }
  return { pos, idx, vn, tn, area, total, boundary }
}

export function normalizeAll(a: Float32Array) {
  for (let i = 0; i < a.length; i += 3) {
    const l = Math.hypot(a[i], a[i + 1], a[i + 2]) || 1
    a[i] /= l; a[i + 1] /= l; a[i + 2] /= l
  }
}

export interface Roots { p: Float32Array; n: Float32Array; count: number; capped: boolean }

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

/** Interpolated smooth normal at point p of triangle t. */
function normalAt(s: Surf, t: number, p: V3): V3 {
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

/** Layer thickness actually used for strands. */
export const snappedThickness = (p: HairParams) =>
  p.snapThickness ? Math.max(p.layerHeight, Math.round(p.thickness / p.layerHeight) * p.layerHeight) : p.thickness

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
  const zOf = (k: number) => k * rowGap + half
  const rows = new Map<number, number[]>()
  for (let t = 0; t < s.idx.length / 3; t++) {
    const z = [0, 1, 2].map((k) => s.pos[s.idx[t * 3 + k] * 3 + 2])
    const lo = Math.min(...z), hi = Math.max(...z)
    for (let k = Math.floor((lo - half) / rowGap); zOf(k) <= hi; k++) {
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
  const target = Math.round((p[2] - half) / lh) * lh + half
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
  const outP: number[] = [], outN: number[] = []
  let count = 0
  pts.forEach((p, i) => {
    if (keep && !keep[i]) return
    const n = normalAt(s, tris[i], p)
    outP.push(p[0], p[1], p[2]); outN.push(n[0], n[1], n[2])
    count++
  })
  return { p: new Float32Array(outP), n: new Float32Array(outN), count, capped }
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
