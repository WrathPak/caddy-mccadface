/**
 * Surface texture: subdivide the selected faces to the detail of the pattern, then move every vertex of the region along its
 * normal by the pattern height. The result is a closed triangle mesh (still watertight: no vertex is duplicated or removed).
 */
import { CREASE_DEG, type Surf } from '../../features/hair/sampling'
import type { V3 } from '../../features/hair/schema'
import { dot, norm } from '../../features/hair/vec'
import { circumference, fitPatch, uvOf, type PatchMap } from '../generators/param'
import type { TopoMesh } from '../types'
import { imageHeight, patternById, type HeightImage, type PatternId } from './patterns'
import { edgeKey, estimateTriangles, subdivideRegion } from './subdivide'

export interface TextureInput {
  /** the whole target body as a closed, welded triangle mesh */
  positions: Float32Array
  indices: Uint32Array
  /** 1 for the triangles of the selected faces */
  region: Uint8Array
  pattern: { id: PatternId } | { image: HeightImage; mirror: boolean }
  /** size of one tile along u, mm */
  scale: number
  /** pattern height, mm */
  depth: number
  direction: 'out' | 'in' | 'both'
  /** degrees; on round faces only quarter turns apply so the pattern closes around */
  rotation: number
  offsetU: number
  offsetV: number
  /** distance over which the texture fades out toward the edge of the selection, mm */
  blend: number
  projection: 'triplanar' | 'uv'
  /** edge length of the refined mesh, mm; 0 picks one from the pattern */
  detail: number
  /** previews make the mesh this many times coarser (1 = as asked) */
  coarsen?: number
  /** largest number of triangles the result may have */
  maxTris: number
}

export interface TextureResult {
  mesh: TopoMesh
  /** 1 for the triangles that belong to the textured region */
  region: Uint8Array
  stats: {
    triangles: number
    edgeLength: number
    /** the detail had to be coarsened to fit the triangle budget */
    limited: boolean
    /** how many smooth patches used a plane / cylinder map, and how many fell back to triplanar */
    mapped: number
    fellBack: number
    /** tiles around the round faces (after snapping the scale), 0 when none */
    tilesAround: number
  }
  warnings: string[]
}

const triArea = (p: ArrayLike<number>, a: number, b: number, c: number) => {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx] as V3
}

const smoothstep = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t) }

/** Smallest binary heap for Dijkstra. */
class Heap {
  private d: number[] = []
  private v: number[] = []
  get size() { return this.d.length }
  push(dist: number, vert: number) {
    let i = this.d.length
    this.d.push(dist); this.v.push(vert)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.d[p] <= this.d[i]) break
      ;[this.d[p], this.d[i]] = [this.d[i], this.d[p]]; [this.v[p], this.v[i]] = [this.v[i], this.v[p]]
      i = p
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.d[0], this.v[0]]
    const ld = this.d.pop()!, lv = this.v.pop()!
    if (this.d.length) {
      this.d[0] = ld; this.v[0] = lv
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < this.d.length && this.d[l] < this.d[m]) m = l
        if (r < this.d.length && this.d[r] < this.d[m]) m = r
        if (m === i) break
        ;[this.d[m], this.d[i]] = [this.d[i], this.d[m]]; [this.v[m], this.v[i]] = [this.v[i], this.v[m]]
        i = m
      }
    }
    return top
  }
}

export function applyTexture(a: TextureInput): TextureResult {
  const warnings: string[] = []
  const T = a.indices.length / 3
  if (a.region.length !== T) throw new Error('The selection does not match the body')
  let regionArea = 0, regionTris = 0
  for (let t = 0; t < T; t++) if (a.region[t]) { const n = triArea(a.positions, a.indices[t * 3], a.indices[t * 3 + 1], a.indices[t * 3 + 2]); regionArea += Math.hypot(...n) / 2; regionTris++ }
  if (!regionTris) throw new Error('Select the faces to texture')
  const def = 'id' in a.pattern ? patternById(a.pattern.id) : null
  const aspect = def?.aspect ?? 1
  const scale = Math.max(0.05, a.scale)

  // detail: what was asked for, or a fraction of the pattern's smallest feature; then whatever fits the triangle budget
  let L = (a.detail > 0 ? a.detail : Math.max(0.1, scale * (def?.feature ?? 0.1))) * (a.coarsen ?? 1)
  const rest = T - regionTris
  let limited = false
  while (estimateTriangles(regionArea, L) + rest > a.maxTris && L < 1e4) { L *= 1.15; limited = true }
  if (limited) warnings.push(`The selected area is large for this detail, so the mesh detail was raised to ${L.toFixed(2)} mm to keep the model under ${Math.round(a.maxTris / 1000)}k triangles`)

  const sub = subdivideRegion({ positions: a.positions, indices: a.indices }, a.region, L, a.maxTris)
  const mesh = sub.mesh
  const region = sub.region
  const idx = mesh.indices
  const nT = idx.length / 3, nV = mesh.positions.length / 3
  const pos = mesh.positions

  // triangle normals, and smooth patches of the region (faces joined by creases flatter than CREASE_DEG)
  const tn = new Float32Array(nT * 3)
  const area = new Float64Array(nT)
  for (let t = 0; t < nT; t++) {
    const n = triArea(pos, idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2])
    const l = Math.hypot(...n) || 1
    area[t] = l / 2
    tn[t * 3] = n[0] / l; tn[t * 3 + 1] = n[1] / l; tn[t * 3 + 2] = n[2] / l
  }
  const edgeTris = new Map<number, [number, number]>()
  for (let t = 0; t < nT; t++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(idx[t * 3 + k], idx[t * 3 + (k + 1) % 3])
      const e = edgeTris.get(key)
      if (!e) edgeTris.set(key, [t, -1]); else e[1] = t
    }
  }
  const cosCrease = Math.cos((CREASE_DEG * Math.PI) / 180)
  const patch = new Int32Array(nT).fill(-1)
  const patches: number[][] = []
  const stack: number[] = []
  for (let t0 = 0; t0 < nT; t0++) {
    if (!region[t0] || patch[t0] >= 0) continue
    const id = patches.length
    const list: number[] = []
    patch[t0] = id; stack.push(t0)
    while (stack.length) {
      const t = stack.pop()!
      list.push(t)
      for (let k = 0; k < 3; k++) {
        const e = edgeTris.get(edgeKey(idx[t * 3 + k], idx[t * 3 + (k + 1) % 3]))!
        const o = e[0] === t ? e[1] : e[0]
        if (o < 0 || !region[o] || patch[o] >= 0) continue
        if (tn[t * 3] * tn[o * 3] + tn[t * 3 + 1] * tn[o * 3 + 1] + tn[t * 3 + 2] * tn[o * 3 + 2] < cosCrease) continue
        patch[o] = id; stack.push(o)
      }
    }
    patches.push(list)
  }

  // maps per patch
  const fake = { pos, idx, tn, area } as unknown as Surf
  const maps: (PatchMap | null)[] = []
  let mapped = 0, fellBack = 0, tilesAround = 0
  const rot = ((a.rotation % 360) + 360) % 360
  const quarter = Math.round(rot / 90) * 90
  for (const list of patches) {
    const m = a.projection === 'uv' ? fitPatch(fake, list, [0, 0, -1]) : null
    maps.push(m)
    if (a.projection === 'uv') { if (m) mapped++; else fellBack++ }
  }
  if (a.projection === 'uv' && fellBack) warnings.push(`${fellBack} curved ${fellBack === 1 ? 'patch is' : 'patches are'} neither flat nor round, so triplanar mapping is used there`)

  // snap the midpoints that subdivision added to the fitted cylinders so round faces stay round
  const owner = new Int32Array(nV).fill(-1)
  const mixed = new Uint8Array(nV)
  for (let t = 0; t < nT; t++) {
    if (!region[t]) continue
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k]
      if (owner[v] < 0) owner[v] = patch[t]
      else if (owner[v] !== patch[t]) mixed[v] = 1
    }
  }
  for (let v = 0; v < nV; v++) {
    const m = owner[v] >= 0 && !mixed[v] ? maps[owner[v]] : null
    if (m?.kind !== 'cylinder') continue
    const q: V3 = [pos[v * 3] - m.o[0], pos[v * 3 + 1] - m.o[1], pos[v * 3 + 2] - m.o[2]]
    const ax = dot(q, m.a)
    const rad: V3 = [q[0] - m.a[0] * ax, q[1] - m.a[1] * ax, q[2] - m.a[2] * ax]
    const rl = Math.hypot(...rad)
    if (rl < 1e-9) continue
    const k = m.r / rl
    pos[v * 3] = m.o[0] + m.a[0] * ax + rad[0] * k
    pos[v * 3 + 1] = m.o[1] + m.a[1] * ax + rad[1] * k
    pos[v * 3 + 2] = m.o[2] + m.a[2] * ax + rad[2] * k
  }

  // vertex normals from the region's triangles only
  const vn = new Float32Array(nV * 3)
  for (let t = 0; t < nT; t++) {
    if (!region[t]) continue
    const n = triArea(pos, idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2])
    for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k] * 3; vn[v] += n[0]; vn[v + 1] += n[1]; vn[v + 2] += n[2] }
  }

  // distance from the boundary of the region along the mesh, for the fade
  const fade = new Float32Array(nV).fill(1)
  if (a.blend > 0) {
    const dist = new Float64Array(nV).fill(Infinity)
    const touch = new Uint8Array(nV) // 1 region, 2 other
    for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) touch[idx[t * 3 + k]] |= region[t] ? 1 : 2
    const adj: number[][] = Array.from({ length: nV }, () => [])
    for (let t = 0; t < nT; t++) {
      if (!region[t]) continue
      for (let k = 0; k < 3; k++) { const p = idx[t * 3 + k], q = idx[t * 3 + (k + 1) % 3]; adj[p].push(q); adj[q].push(p) }
    }
    const heap = new Heap()
    for (let v = 0; v < nV; v++) if (touch[v] === 3) { dist[v] = 0; heap.push(0, v) }
    while (heap.size) {
      const [d, v] = heap.pop()
      if (d > dist[v] || d >= a.blend) continue
      for (const w of adj[v]) {
        const nd = d + Math.hypot(pos[w * 3] - pos[v * 3], pos[w * 3 + 1] - pos[v * 3 + 1], pos[w * 3 + 2] - pos[v * 3 + 2])
        if (nd < dist[w]) { dist[w] = nd; heap.push(nd, w) }
      }
    }
    for (let v = 0; v < nV; v++) fade[v] = Number.isFinite(dist[v]) ? smoothstep(dist[v] / a.blend) : 1
  }


  // height function over tile coordinates
  const height = 'id' in a.pattern ? patternById(a.pattern.id).height : imageHeight(a.pattern.image, a.pattern.mirror)
  const vAspect = 'image' in a.pattern ? a.pattern.image.h / a.pattern.image.w : aspect
  const rr = (rot * Math.PI) / 180
  const cr = Math.cos(rr), sr = Math.sin(rr)
  /** pattern height at a point of a plane, millimetres */
  const sample = (x: number, y: number) => {
    const xr = x * cr + y * sr + a.offsetU, yr = -x * sr + y * cr + a.offsetV
    return height(xr / scale, yr / (scale * vAspect))
  }
  // round patches: a whole number of tiles around, and only quarter turns so the pattern closes
  const cq = (quarter * Math.PI) / 180
  const qc = Math.round(Math.cos(cq)), qs = Math.round(Math.sin(cq))
  const swap = quarter % 180 !== 0
  const cyl = new Map<number, { su: number; sv: number }>()
  maps.forEach((m, id) => {
    if (m?.kind !== 'cylinder') return
    const C = circumference(m)
    // which pattern axis runs round the circumference
    const wrapAxisIsU = m.around ? swap : !swap
    const size = wrapAxisIsU ? scale : scale * vAspect
    const tiles = Math.max(1, Math.round(C / size))
    tilesAround = Math.max(tilesAround, tiles)
    cyl.set(id, wrapAxisIsU ? { su: C / tiles, sv: scale * vAspect } : { su: scale, sv: C / tiles })
  })
  if (cyl.size && rot !== quarter) warnings.push('On round faces the rotation is limited to quarter turns so the pattern closes around the part')
  const out = Float32Array.from(pos)
  const wlow = 0.05
  for (let v = 0; v < nV; v++) {
    if (owner[v] < 0) continue
    const f = fade[v]
    if (f <= 0) continue
    const n = norm([vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]])
    if (!n.some(Boolean)) continue
    const p: V3 = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]
    const m = maps[owner[v]]
    let h: number
    if (m) {
      const [u0, v0] = uvOf(m, p)
      if (m.kind === 'planar') h = sample(u0, v0)
      else {
        const c = cyl.get(owner[v])!
        const xr = u0 * qc + v0 * qs, yr = -u0 * qs + v0 * qc
        h = height((xr + a.offsetU) / c.su, (yr + a.offsetV) / c.sv)
      }
    } else {
      // triplanar: blend the three axis projections by how much the normal faces each axis
      const wx = Math.abs(n[0]) ** 4, wy = Math.abs(n[1]) ** 4, wz = Math.abs(n[2]) ** 4
      const ws = wx + wy + wz
      const fx = wx / ws > wlow ? wx / ws : 0, fy = wy / ws > wlow ? wy / ws : 0, fz = wz / ws > wlow ? wz / ws : 0
      h = 0
      if (fx) h += fx * sample(p[1], p[2])
      if (fy) h += fy * sample(p[0], p[2])
      if (fz) h += fz * sample(p[0], p[1])
      h /= fx + fy + fz || 1
    }
    const level = a.direction === 'out' ? h : a.direction === 'in' ? h - 1 : h - 0.5
    const d = a.depth * level * f
    out[v * 3] = p[0] + n[0] * d
    out[v * 3 + 1] = p[1] + n[1] * d
    out[v * 3 + 2] = p[2] + n[2] * d
  }
  return { mesh: { positions: out, indices: idx }, region, stats: { triangles: nT, edgeLength: sub.edgeLength, limited: sub.limited, mapped, fellBack, tilesAround }, warnings }
}
