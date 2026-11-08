/**
 * Wrap and Rebuild: turn any triangle soup (open, self-intersecting, flipped patches) into a watertight, manifold mesh by
 * way of a voxel grid. The surface is rasterised into voxels (thick enough to seal small gaps), the voxels are sorted into
 * outside / inside, a signed distance field is made from that, and marching tetrahedra pulls a new closed surface out of it.
 * The result follows the original to about half a voxel. Pure typed-array code, runs in Node and in the worker.
 */
import type { TopoMesh } from './types'

export interface VoxelOptions {
  /** voxel size in mm (raised when the grid would be too big) */
  voxel: number
  /** gaps in the surface up to this wide are sealed (mm) */
  gap: number
  /** Rebuild keeps closed cavities, Wrap fills them */
  keepCavities: boolean
}
export interface VoxelResult { mesh: TopoMesh; voxel: number; dims: [number, number, number] }

const MAX_VOXELS = 9_000_000

function ptTri2(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  // Ericson, Real-Time Collision Detection: closest point on triangle
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
  let qx: number, qy: number, qz: number
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz }
    else {
      const vc = d1 * d4 - d3 * d2
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz }
        else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w }
          else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w }
            else { const den = 1 / (va + vb + vc); const v = vb * den, w = vc * den; qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz
  return dx * dx + dy * dy + dz * dz
}

/** Squared distance (in voxel units) to the nearest voxel with `src` = 1, by the exact separable transform. */
function edt(src: Uint8Array, nx: number, ny: number, nz: number, target: 0 | 1): Float32Array {
  const N = nx * ny * nz
  const INF = 3e6
  const f = new Float32Array(N)
  for (let i = 0; i < N; i++) f[i] = src[i] === target ? 0 : INF
  const m = Math.max(nx, ny, nz)
  const v = new Int32Array(m), z = new Float64Array(m + 1), d = new Float64Array(m)
  const pass = (n: number, stride: number, outer: number[], outerStride: number[]) => {
    const [o1, o2] = outer, [s1, s2] = outerStride
    for (let a = 0; a < o1; a++) for (let b = 0; b < o2; b++) {
      const base = a * s1 + b * s2
      for (let i = 0; i < n; i++) d[i] = f[base + i * stride]
      let k = 0
      v[0] = 0; z[0] = -Infinity; z[1] = Infinity
      const cross = (q: number, pp: number) => (d[q] + q * q - (d[pp] + pp * pp)) / (2 * q - 2 * pp)
      for (let q = 1; q < n; q++) {
        let s = cross(q, v[k])
        while (s <= z[k]) { k--; s = cross(q, v[k]) }
        k++
        v[k] = q; z[k] = s; z[k + 1] = Infinity
      }
      k = 0
      for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++
        const p = v[k]
        f[base + q * stride] = (q - p) * (q - p) + d[p]
      }
    }
  }
  pass(nx, 1, [ny, nz], [nx, nx * ny])
  pass(ny, nx, [nx, nz], [1, nx * ny])
  pass(nz, nx * ny, [nx, ny], [1, nx])
  return f
}

export function voxelRebuild(topo: TopoMesh, o: VoxelOptions): VoxelResult {
  const p = topo.positions, ix = topo.indices
  const T = ix.length / 3
  if (!T) throw new Error('The mesh is empty')
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let d = 0; d < 3; d++) { if (p[i + d] < lo[d]) lo[d] = p[i + d]; if (p[i + d] > hi[d]) hi[d] = p[i + d] }
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
  let v = Math.max(o.voxel, 1e-4)
  const r0 = () => Math.max(0.87 * v, o.gap / 2)
  const dimsFor = (vv: number) => {
    const pad = Math.ceil((Math.max(0.87 * vv, o.gap / 2) + 2 * vv) / vv)
    return [0, 1, 2].map((d) => Math.ceil(ext[d] / vv) + 2 * pad + 1)
  }
  let dims = dimsFor(v)
  while (dims[0] * dims[1] * dims[2] > MAX_VOXELS) { v *= 1.15; dims = dimsFor(v) }
  const r = r0()
  const pad = Math.ceil((r + 2 * v) / v)
  const [nx, ny, nz] = dims
  const N = nx * ny * nz
  const org = [lo[0] - pad * v, lo[1] - pad * v, lo[2] - pad * v]
  const cen = (i: number, d: number) => org[d] + (i + 0.5) * v
  // 1. voxels within r of the surface
  const D = new Uint8Array(N)
  const r2 = r * r
  for (let t = 0; t < T; t++) {
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3
    const mn = [0, 1, 2].map((d) => Math.min(p[a + d], p[b + d], p[c + d]) - r), mx = [0, 1, 2].map((d) => Math.max(p[a + d], p[b + d], p[c + d]) + r)
    const i0 = [0, 1, 2].map((d) => Math.max(0, Math.floor((mn[d] - org[d]) / v - 0.5))), i1 = [0, 1, 2].map((d) => Math.min(dims[d] - 1, Math.ceil((mx[d] - org[d]) / v - 0.5)))
    for (let k = i0[2]; k <= i1[2]; k++) {
      const z = cen(k, 2)
      for (let j = i0[1]; j <= i1[1]; j++) {
        const y = cen(j, 1)
        const row = (k * ny + j) * nx
        for (let i = i0[0]; i <= i1[0]; i++) {
          if (D[row + i]) continue
          if (ptTri2(cen(i, 0), y, z, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]) <= r2) D[row + i] = 1
        }
      }
    }
  }
  // 2. regions of free voxels (6-connected); the one holding the corner is the outside
  const label = new Int32Array(N).fill(-1)
  const queue = new Int32Array(N)
  const sx = 1, sy = nx, sz = nx * ny
  const flood = (start: number, id: number, solidSurf: boolean) => {
    let h = 0, tl = 0
    queue[tl++] = start
    label[start] = id
    while (h < tl) {
      const q = queue[h++]
      const i = q % nx, j = ((q / nx) | 0) % ny, k = (q / (nx * ny)) | 0
      const nb = [i > 0 ? q - sx : -1, i < nx - 1 ? q + sx : -1, j > 0 ? q - sy : -1, j < ny - 1 ? q + sy : -1, k > 0 ? q - sz : -1, k < nz - 1 ? q + sz : -1]
      for (const u of nb) if (u >= 0 && label[u] < 0 && (D[u] === 1) === solidSurf) { label[u] = id; queue[tl++] = u }
    }
  }
  const S = new Uint8Array(N)
  if (!o.keepCavities) {
    flood(0, 0, false)
    for (let q = 0; q < N; q++) S[q] = label[q] === 0 ? 0 : 1
  } else {
    let regions = 0
    for (let q = 0; q < N; q++) if (label[q] < 0 && !D[q]) flood(q, regions++, false)
    // surface components (26-connected would be safer; 6 with the thickness of the layer is enough for a sealed shell)
    const surf = new Int32Array(N).fill(-1)
    let comps = 0
    for (let q0 = 0; q0 < N; q0++) {
      if (!D[q0] || surf[q0] >= 0) continue
      let h = 0, tl = 0
      queue[tl++] = q0; surf[q0] = comps
      while (h < tl) {
        const q = queue[h++]
        const i = q % nx, j = ((q / nx) | 0) % ny, k = (q / (nx * ny)) | 0
        for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const a = i + di, b = j + dj, c = k + dk
          if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue
          const u = (c * ny + b) * nx + a
          if (D[u] && surf[u] < 0) { surf[u] = comps; queue[tl++] = u }
        }
      }
      comps++
    }
    const adj = new Map<number, Set<number>>() // surface component -> regions
    const radj = new Map<number, Set<number>>()
    for (let q = 0; q < N; q++) {
      if (!D[q]) continue
      const i = q % nx, j = ((q / nx) | 0) % ny, k = (q / (nx * ny)) | 0
      const nb = [i > 0 ? q - sx : -1, i < nx - 1 ? q + sx : -1, j > 0 ? q - sy : -1, j < ny - 1 ? q + sy : -1, k > 0 ? q - sz : -1, k < nz - 1 ? q + sz : -1]
      for (const u of nb) {
        if (u < 0 || D[u]) continue
        const rg = label[u]
        ;(adj.get(surf[q]) ?? adj.set(surf[q], new Set()).get(surf[q])!).add(rg)
        ;(radj.get(rg) ?? radj.set(rg, new Set()).get(rg)!).add(surf[q])
      }
    }
    const parity = new Map<number, number>([[label[0], 0]])
    const seenS = new Set<number>()
    const work = [label[0]]
    while (work.length) {
      const rg = work.pop()!
      for (const s of radj.get(rg) ?? []) {
        if (seenS.has(s)) continue
        seenS.add(s)
        for (const r2g of adj.get(s) ?? []) if (!parity.has(r2g)) { parity.set(r2g, 1 - parity.get(rg)!); work.push(r2g) }
      }
    }
    for (let q = 0; q < N; q++) S[q] = D[q] ? 1 : (parity.get(label[q]) ?? 0)
  }
  let inner = 0
  for (let q = 0; q < N; q++) if (S[q] && !D[q]) inner++
  if (!inner) throw new Error('The surface has gaps wider than the grid seals, so there is no inside to find. Raise Gap to close, or use a larger voxel size')
  // 3. signed distance (positive inside S), measured from voxel boundaries
  const dIn = edt(S, nx, ny, nz, 0), dOut = edt(S, nx, ny, nz, 1)
  const phi = new Float32Array(N)
  for (let q = 0; q < N; q++) phi[q] = S[q] ? (Math.sqrt(dIn[q]) - 0.5) * v : -(Math.sqrt(dOut[q]) - 0.5) * v
  // 4. marching tetrahedra at phi = r (the layer of voxels added to seal gaps is taken off again)
  const iso = r
  const mesh = marchTets(phi, nx, ny, nz, iso, org, v)
  return { mesh, voxel: v, dims: [nx, ny, nz] }
}

/** Marching tetrahedra (six tets per cube, shared diagonal) over cells whose corners straddle the iso level. Watertight by construction. */
function marchTets(phi: Float32Array, nx: number, ny: number, nz: number, iso: number, org: number[], v: number): TopoMesh {
  const pos: number[] = []
  const tri: number[] = []
  const cache = new Map<number, number>()
  const N = nx * ny * nz
  const corner = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
  const tets = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]]
  const gi = new Int32Array(8)
  const val = new Float64Array(8)
  const gp = new Int32Array(24)
  const vertex = (a: number, b: number, ia: number, ib: number): number => {
    const lo = a < b ? a : b, hi = a < b ? b : a
    const key = lo * N + hi
    let id = cache.get(key)
    if (id === undefined) {
      const la = a < b ? ia : ib, lb = a < b ? ib : ia
      const va = phi[lo], vb = phi[hi]
      const t = (iso - va) / (vb - va)
      id = pos.length / 3
      pos.push(
        org[0] + (gp[la * 3] + 0.5 + (gp[lb * 3] - gp[la * 3]) * t) * v,
        org[1] + (gp[la * 3 + 1] + 0.5 + (gp[lb * 3 + 1] - gp[la * 3 + 1]) * t) * v,
        org[2] + (gp[la * 3 + 2] + 0.5 + (gp[lb * 3 + 2] - gp[la * 3 + 2]) * t) * v,
      )
      cache.set(key, id)
    }
    return id
  }
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let any = 0, all = 1
    for (let c = 0; c < 8; c++) {
      const a = i + corner[c][0], b = j + corner[c][1], d = k + corner[c][2]
      gi[c] = (d * ny + b) * nx + a
      gp[c * 3] = a; gp[c * 3 + 1] = b; gp[c * 3 + 2] = d
      val[c] = phi[gi[c]]
      if (val[c] > iso) any = 1; else all = 0
    }
    if (!any || all) continue
    for (const tt of tets) {
      const ins: number[] = [], out: number[] = []
      for (const c of tt) (val[c] > iso ? ins : out).push(c)
      if (!ins.length || !out.length) continue
      const emit = (a: number, b: number, c: number) => {
        // wind outward: the normal points from the inside corners to the outside ones
        const A = a * 3, B = b * 3, C = c * 3
        const ux = pos[B] - pos[A], uy = pos[B + 1] - pos[A + 1], uz = pos[B + 2] - pos[A + 2]
        const wx = pos[C] - pos[A], wy = pos[C + 1] - pos[A + 1], wz = pos[C + 2] - pos[A + 2]
        const nxv = uy * wz - uz * wy, nyv = uz * wx - ux * wz, nzv = ux * wy - uy * wx
        let rx = 0, ry = 0, rz = 0
        for (const o of out) { rx += gp[o * 3]; ry += gp[o * 3 + 1]; rz += gp[o * 3 + 2] }
        for (const q of ins) { rx -= gp[q * 3] * out.length / ins.length; ry -= gp[q * 3 + 1] * out.length / ins.length; rz -= gp[q * 3 + 2] * out.length / ins.length }
        if (nxv * rx + nyv * ry + nzv * rz >= 0) tri.push(a, b, c); else tri.push(a, c, b)
      }
      const e = (a: number, b: number) => vertex(gi[a], gi[b], a, b)
      if (ins.length === 1) { const a = ins[0]; emit(e(a, out[0]), e(a, out[1]), e(a, out[2])) }
      else if (out.length === 1) { const a = out[0]; emit(e(a, ins[0]), e(a, ins[1]), e(a, ins[2])) }
      else {
        const [a, b] = ins, [c, d] = out
        const ac = e(a, c), ad = e(a, d), bd = e(b, d), bc = e(b, c)
        emit(ac, ad, bd); emit(ac, bd, bc)
      }
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(tri) }
}
