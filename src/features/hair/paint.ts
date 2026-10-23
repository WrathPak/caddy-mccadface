/** Hair face-selection state and algorithms: click, screen-space brush, angle-bounded flood fill. */
import { Vector3, type Camera } from 'three'
import { create } from 'zustand'
import type { Body } from '@/kernel/types'
import { encodeRegion } from './region'

export type PaintMode = 'off' | 'click' | 'brush' | 'flood'

interface PaintState {
  /** toolbar visible (hair dialog / select-faces tool open) */
  visible: boolean
  mode: PaintMode
  /** brush radius in screen pixels */
  radius: number
  /** flood-fill angle threshold in degrees */
  angle: number
  bodyId: string | null
  kind: 'mesh' | 'brep' | null
  sel: Set<number>
  rev: number
  /** receives the encoded region whenever a stroke ends */
  sink: ((region: string[]) => void) | null
}

export const useHairPaint = create<PaintState>(() => ({
  visible: false, mode: 'off', radius: 28, angle: 30, bodyId: null, kind: null, sel: new Set(), rev: 0, sink: null,
}))

export const setPaint = (p: Partial<PaintState>) => useHairPaint.setState(p)

/** Replace the selection (does not call the sink). */
export function loadSelection(bodyId: string | null, kind: 'mesh' | 'brep' | null, sel: Set<number>) {
  useHairPaint.setState((s) => ({ bodyId, kind, sel, rev: s.rev + 1 }))
}

export function commitSelection(bodies: Body[]) {
  const s = useHairPaint.getState()
  const body = bodies.find((b) => b.id === s.bodyId)
  if (body) s.sink?.(encodeRegion(body, s.sel))
}

export function clearSelection(bodies: Body[]) {
  loadSelection(null, null, new Set())
  useHairPaint.getState().sink?.([])
  void bodies
}

// ---------------------------------------------------------------- topology per mesh

export interface Topo {
  T: number
  cen: Float32Array
  nrm: Float32Array
  /** neighbour triangle per edge (-1 = open) */
  adj: Int32Array
  grid: Map<string, number[]>
  cell: number
}

const topoCache = new WeakMap<Body['mesh'], Topo>()

export function topoOf(body: Body): Topo {
  let t = topoCache.get(body.mesh)
  if (t) return t
  const { positions: p, indices: idx } = body.mesh
  const T = idx.length / 3
  const cen = new Float32Array(T * 3), nrm = new Float32Array(T * 3)
  const vid = new Map<string, number>()
  const weld = new Int32Array(idx.length)
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let t3 = 0; t3 < T; t3++) {
    const a = idx[t3 * 3] * 3, b = idx[t3 * 3 + 1] * 3, c = idx[t3 * 3 + 2] * 3
    for (let k = 0; k < 3; k++) {
      cen[t3 * 3 + k] = (p[a + k] + p[b + k] + p[c + k]) / 3
      min[k] = Math.min(min[k], cen[t3 * 3 + k]); max[k] = Math.max(max[k], cen[t3 * 3 + k])
    }
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z) || 1
    nrm[t3 * 3] = x / l; nrm[t3 * 3 + 1] = y / l; nrm[t3 * 3 + 2] = z / l
    for (let k = 0; k < 3; k++) {
      const v = idx[t3 * 3 + k] * 3
      const key = Math.round(p[v] * 1e4) + ',' + Math.round(p[v + 1] * 1e4) + ',' + Math.round(p[v + 2] * 1e4)
      let id = vid.get(key)
      if (id === undefined) vid.set(key, (id = vid.size))
      weld[t3 * 3 + k] = id
    }
  }
  const V = vid.size + 1
  const adj = new Int32Array(T * 3).fill(-1)
  const edge = new Map<number, number>()
  for (let t3 = 0; t3 < T; t3++) {
    for (let k = 0; k < 3; k++) {
      const a = weld[t3 * 3 + k], b = weld[t3 * 3 + ((k + 1) % 3)]
      const key = a < b ? a * V + b : b * V + a
      const o = edge.get(key)
      if (o === undefined) edge.set(key, t3 * 3 + k)
      else { adj[t3 * 3 + k] = Math.floor(o / 3); adj[o] = t3 }
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1
  const cell = diag / 48
  const grid = new Map<string, number[]>()
  for (let t3 = 0; t3 < T; t3++) {
    const k = cellKey(cen[t3 * 3], cen[t3 * 3 + 1], cen[t3 * 3 + 2], cell)
    const l = grid.get(k)
    if (l) l.push(t3); else grid.set(k, [t3])
  }
  t = { T, cen, nrm, adj, grid, cell }
  topoCache.set(body.mesh, t)
  return t
}

const cellKey = (x: number, y: number, z: number, c: number) => Math.floor(x / c) + ',' + Math.floor(y / c) + ',' + Math.floor(z / c)

/** Triangles within `r` (world) of `p`. */
function nearTris(t: Topo, p: Vector3, r: number): number[] {
  const out: number[] = []
  const n = Math.ceil(r / t.cell)
  const cx = Math.floor(p.x / t.cell), cy = Math.floor(p.y / t.cell), cz = Math.floor(p.z / t.cell)
  const r2 = r * r
  for (let x = cx - n; x <= cx + n; x++) for (let y = cy - n; y <= cy + n; y++) for (let z = cz - n; z <= cz + n; z++) {
    const l = t.grid.get(x + ',' + y + ',' + z)
    if (!l) continue
    for (const tri of l) {
      const dx = t.cen[tri * 3] - p.x, dy = t.cen[tri * 3 + 1] - p.y, dz = t.cen[tri * 3 + 2] - p.z
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(tri)
    }
  }
  return out
}

/** Triangles under a screen-space brush (front-facing, within the pixel radius of the cursor). */
export function brushTris(body: Body, hit: Vector3, camera: Camera, w: number, h: number, mx: number, my: number, radiusPx: number): number[] {
  const t = topoOf(body)
  const cam = camera as Camera & { isOrthographicCamera?: boolean; zoom: number; top: number; bottom: number; fov: number }
  const dist = camera.position.distanceTo(hit)
  const perPx = cam.isOrthographicCamera ? (cam.top - cam.bottom) / cam.zoom / h : (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / h
  const rw = radiusPx * perPx * 1.6
  const out: number[] = []
  const v = new Vector3()
  for (const tri of nearTris(t, hit, rw)) {
    v.set(t.cen[tri * 3], t.cen[tri * 3 + 1], t.cen[tri * 3 + 2])
    const facing = (camera.position.x - v.x) * t.nrm[tri * 3] + (camera.position.y - v.y) * t.nrm[tri * 3 + 1] + (camera.position.z - v.z) * t.nrm[tri * 3 + 2]
    if (facing <= 0) continue
    v.project(camera)
    const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h
    if ((sx - mx) ** 2 + (sy - my) ** 2 <= radiusPx * radiusPx) out.push(tri)
  }
  return out
}

/** Flood fill from a triangle across edges whose dihedral angle stays under `angleDeg`. B-rep faces always fill whole. */
export function floodTris(body: Body, seed: number, angleDeg: number, brep: boolean): number[] {
  const t = topoOf(body)
  const cosT = Math.cos((angleDeg * Math.PI) / 180)
  const fid = body.mesh.faceIds
  const seen = new Uint8Array(t.T)
  const out = [seed]
  seen[seed] = 1
  for (let i = 0; i < out.length; i++) {
    const a = out[i]
    for (let k = 0; k < 3; k++) {
      const b = t.adj[a * 3 + k]
      if (b < 0 || seen[b]) continue
      const same = brep && fid[a] === fid[b]
      const d = t.nrm[a * 3] * t.nrm[b * 3] + t.nrm[a * 3 + 1] * t.nrm[b * 3 + 1] + t.nrm[a * 3 + 2] * t.nrm[b * 3 + 2]
      if (same || d >= cosT) { seen[b] = 1; out.push(b) }
    }
  }
  return out
}

/** Apply triangles to the selection (mesh: triangle ids; B-rep: their face ids). */
export function applyTris(body: Body, tris: number[], erase: boolean) {
  const s = useHairPaint.getState()
  const brep = body.kind === 'brep'
  const keep = s.bodyId === body.id ? new Set(s.sel) : new Set<number>()
  for (const t of tris) {
    const id = brep ? body.mesh.faceIds[t] : t
    if (erase) keep.delete(id); else keep.add(id)
  }
  loadSelection(body.id, brep ? 'brep' : 'mesh', keep)
}

/** Triangle indices to highlight for the current selection. */
export function selectedIndices(body: Body, sel: Set<number>): Uint32Array {
  const m = body.mesh
  const out: number[] = []
  if (body.kind === 'mesh') for (const t of sel) { out.push(m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]) }
  else for (let t = 0; t < m.faceIds.length; t++) if (sel.has(m.faceIds[t])) out.push(m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2])
  return Uint32Array.from(out)
}
