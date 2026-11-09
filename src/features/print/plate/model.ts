/**
 * Plate placement: where each body sits on the printer's bed. Pure maths, no React. A placement is separate from the CAD model:
 * a rotation (Euler degrees, the convention of the Move feature) about the body's own bounding-box centre, then the part is set
 * on the bed (lowest point at z = 0) with the centre of its footprint at (x, y). Bodies with no stored placement are auto-arranged.
 */
import { composeTransform, type Body, type Vec3 } from '@/kernel/types'
import { eulerFromMatrix, rotationBetween } from '@/kernel/print-geom'

export type Vec2 = [number, number]

export interface PlaceEntry { r: Vec3; x: number; y: number }
export type PlateStore = Record<string, PlaceEntry>

/** The printable area: a polygon (rectangles and odd beds alike), the box around it and the build height. */
export interface BedShape { poly: Vec2[]; lo: Vec2; hi: Vec2; height: number }

export function rectBed(w: number, d: number, height: number): BedShape {
  return { poly: [[0, 0], [w, 0], [w, d], [0, d]], lo: [0, 0], hi: [w, d], height }
}

export function bedFromPoly(poly: Vec2[], height: number): BedShape {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1])
  return { poly, lo: [Math.min(...xs), Math.min(...ys)], hi: [Math.max(...xs), Math.max(...ys)], height }
}

export const bedCentre = (b: BedShape): Vec2 => [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2]

function inPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Whether a rectangle (centre, size) lies inside the bed. */
export function rectInBed(bed: BedShape, cx: number, cy: number, w: number, d: number, tol = 0.05): boolean {
  if (cx - w / 2 < bed.lo[0] - tol || cx + w / 2 > bed.hi[0] + tol || cy - d / 2 < bed.lo[1] - tol || cy + d / 2 > bed.hi[1] + tol) return false
  // a rectangular bed is the box itself; for other shapes every corner has to be inside (the polygon is slightly grown by the tolerance)
  if (bed.poly.length === 4 && bed.poly.every((p) => p[0] === bed.lo[0] || p[0] === bed.hi[0])) return true
  const e = tol
  return ([[cx - w / 2 + e, cy - d / 2 + e], [cx + w / 2 - e, cy - d / 2 + e], [cx + w / 2 - e, cy + d / 2 - e], [cx - w / 2 + e, cy + d / 2 - e]] as Vec2[]).every((c) => inPoly(c, bed.poly))
}

// ---- footprints

interface Cached { centre: Vec3; key: string; lo: Vec3; hi: Vec3 }
const cache = new WeakMap<Float32Array, Cached>()

const rkey = (r: Vec3) => r.map((v) => v.toFixed(4)).join(',')

function centreOf(body: Body): Vec3 {
  const b = body.mesh.bounds
  if (b) return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
  const p = body.mesh.positions
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < lo[k]) lo[k] = p[i + k]; if (p[i + k] > hi[k]) hi[k] = p[i + k] }
  return p.length ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] : [0, 0, 0]
}

/** The rotation of an entry about the body's centre, column-major, with no translation yet. */
export function rotationAbout(centre: Vec3, r: Vec3): number[] {
  return composeTransform({ pivot: centre, translate: [0, 0, 0], rotate: r, scale: 1 })
}

/** The box of the body after the rotation `r` about its centre (before it is set on the bed). Cached per mesh and rotation. */
export function rotatedBox(body: Body, r: Vec3): { centre: Vec3; lo: Vec3; hi: Vec3; rot: number[] } {
  const arr = body.mesh.positions
  let c = cache.get(arr)
  if (!c) { c = { centre: centreOf(body), key: '', lo: [0, 0, 0], hi: [0, 0, 0] }; cache.set(arr, c) }
  const rot = rotationAbout(c.centre, r)
  const k = rkey(r)
  if (c.key !== k) {
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i], y = arr[i + 1], z = arr[i + 2]
      const px = rot[0] * x + rot[4] * y + rot[8] * z + rot[12]
      const py = rot[1] * x + rot[5] * y + rot[9] * z + rot[13]
      const pz = rot[2] * x + rot[6] * y + rot[10] * z + rot[14]
      if (px < lo[0]) lo[0] = px; if (px > hi[0]) hi[0] = px
      if (py < lo[1]) lo[1] = py; if (py > hi[1]) hi[1] = py
      if (pz < lo[2]) lo[2] = pz; if (pz > hi[2]) hi[2] = pz
    }
    if (!arr.length) { lo.fill(0); hi.fill(0) }
    c.key = k; c.lo = lo; c.hi = hi
  }
  return { centre: c.centre, lo: c.lo, hi: c.hi, rot }
}

export type PlaceStatus = 'ok' | 'outside' | 'tall'

export interface Placed {
  id: string
  entry: PlaceEntry
  /** CAD space to the bed, column-major */
  m: number[]
  /** the part on the bed: x/y box and the height */
  lo: Vec3
  hi: Vec3
  size: Vec3
  status: PlaceStatus
}

/** The placed part for an entry. */
export function place(body: Body, entry: PlaceEntry, bed: BedShape): Placed {
  const { lo, hi, rot } = rotatedBox(body, entry.r)
  const w = hi[0] - lo[0], d = hi[1] - lo[1], h = hi[2] - lo[2]
  const m = rot.slice()
  m[12] += entry.x - (lo[0] + hi[0]) / 2
  m[13] += entry.y - (lo[1] + hi[1]) / 2
  m[14] += -lo[2]
  const status: PlaceStatus = h > bed.height + 0.01 ? 'tall' : rectInBed(bed, entry.x, entry.y, w, d) ? 'ok' : 'outside'
  return { id: body.id, entry, m, lo: [entry.x - w / 2, entry.y - d / 2, 0], hi: [entry.x + w / 2, entry.y + d / 2, h], size: [w, d, h], status }
}

/** Apply a column-major matrix to a flat position array (a fresh array). */
export function transformPositions(p: Float32Array, m: number[]): Float32Array {
  const out = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2]
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12]
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
  }
  return out
}

/**
 * A (finer) print mesh of a body, set where the placement puts the part: turned like the body on screen, then centred on (x, y) and
 * set on the bed by its own box, so the slicer sees it exactly flat on the plate whatever the tessellation.
 */
export function placeMesh(positions: Float32Array, rot: number[], x: number, y: number): Float32Array {
  const out = transformPositions(positions, rot)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < out.length; i += 3) for (let k = 0; k < 3; k++) { if (out[i + k] < lo[k]) lo[k] = out[i + k]; if (out[i + k] > hi[k]) hi[k] = out[i + k] }
  if (!out.length) return out
  const dx = x - (lo[0] + hi[0]) / 2, dy = y - (lo[1] + hi[1]) / 2, dz = -lo[2]
  for (let i = 0; i < out.length; i += 3) { out[i] += dx; out[i + 1] += dy; out[i + 2] += dz }
  return out
}

// ---- arranging

export interface Rect { cx: number; cy: number; w: number; d: number }
export const GAP = 6

const hit = (a: Rect, b: Rect, gap: number) => Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + gap && Math.abs(a.cy - b.cy) < (a.d + b.d) / 2 + gap

/**
 * The free place on the bed nearest its centre for a w x d footprint, or one just off the right edge (flagged as outside) when
 * the bed is full.
 */
export function findSpot(bed: BedShape, w: number, d: number, taken: Rect[], gap = GAP, near?: Vec2): Vec2 {
  const [bx, by] = near ?? bedCentre(bed)
  const span = Math.max(bed.hi[0] - bed.lo[0], bed.hi[1] - bed.lo[1])
  const step = Math.max(2, Math.min(w, d) / 4, span / 70)
  let best: Vec2 | null = null, bestD = Infinity
  for (let y = bed.lo[1] + d / 2; y <= bed.hi[1] - d / 2 + 1e-6; y += step) {
    for (let x = bed.lo[0] + w / 2; x <= bed.hi[0] - w / 2 + 1e-6; x += step) {
      const dist = (x - bx) ** 2 + (y - by) ** 2
      if (dist >= bestD || !rectInBed(bed, x, y, w, d)) continue
      const r: Rect = { cx: x, cy: y, w, d }
      if (taken.some((t) => hit(r, t, gap))) continue
      best = [x, y]; bestD = dist
    }
  }
  if (best) return best
  // no room: park it off the right edge, below the others already parked there
  const off = taken.filter((t) => t.cx - t.w / 2 >= bed.hi[0]).reduce((m, t) => Math.max(m, t.cy + t.d / 2 + gap), bed.lo[1])
  return [bed.hi[0] + gap + w / 2, off + d / 2]
}

/** Pairs of parts whose footprints overlap (the slicer cannot print two parts through each other). */
export function overlapsOf(list: Placed[]): [string, string][] {
  const out: [string, string][] = []
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j]
    if (hit({ cx: a.entry.x, cy: a.entry.y, w: a.size[0], d: a.size[1] }, { cx: b.entry.x, cy: b.entry.y, w: b.size[0], d: b.size[1] }, 0)) out.push([a.id, b.id])
  }
  return out
}

/**
 * After a part was turned its footprint changed: when it now overlaps a neighbour or leaves the bed, move it to the free spot
 * nearest where it was. Returns the entries with the moved ones changed.
 */
export function settleEntries(bodies: Body[], entries: PlateStore, ids: string[], bed: BedShape): PlateStore {
  const next: PlateStore = { ...entries }
  for (const id of ids) {
    const b = bodies.find((x) => x.id === id), e = next[id]
    if (!b || !e) continue
    const { lo, hi } = rotatedBox(b, e.r)
    const w = hi[0] - lo[0], d = hi[1] - lo[1]
    const others: Rect[] = bodies.filter((o) => o.id !== id && next[o.id]).map((o) => {
      const q = rotatedBox(o, next[o.id].r)
      return { cx: next[o.id].x, cy: next[o.id].y, w: q.hi[0] - q.lo[0], d: q.hi[1] - q.lo[1] }
    })
    const mine: Rect = { cx: e.x, cy: e.y, w, d }
    if (!others.some((o) => hit(mine, o, 0)) && rectInBed(bed, e.x, e.y, w, d)) continue
    const [x, y] = findSpot(bed, w, d, others, GAP, [e.x, e.y])
    next[id] = { ...e, x: +x.toFixed(3), y: +y.toFixed(3) }
  }
  return next
}

export interface PlateResult {
  list: Placed[]
  /** entries as they stand (stored ones plus the ones arranged for new bodies) */
  entries: PlateStore
}

/** Place every body: stored entries as they are, bodies without one arranged into free spots. */
export function resolvePlate(bodies: Body[], store: PlateStore, bed: BedShape): PlateResult {
  const entries: PlateStore = {}
  const taken: Rect[] = []
  const placed = new Map<string, Placed>()
  for (const b of bodies) {
    const e = store[b.id]
    if (!e) continue
    entries[b.id] = e
    const p = place(b, e, bed)
    placed.set(b.id, p)
    taken.push({ cx: e.x, cy: e.y, w: p.size[0], d: p.size[1] })
  }
  for (const b of bodies) {
    if (placed.has(b.id)) continue
    const r: Vec3 = [0, 0, 0]
    const { lo, hi } = rotatedBox(b, r)
    const w = hi[0] - lo[0], d = hi[1] - lo[1]
    const [x, y] = findSpot(bed, w, d, taken)
    const e: PlaceEntry = { r, x, y }
    entries[b.id] = e
    taken.push({ cx: x, cy: y, w, d })
    placed.set(b.id, place(b, e, bed))
  }
  return { list: bodies.map((b) => placed.get(b.id)!), entries }
}

/** Lay every body out again, largest first, each in the free spot nearest the bed's centre; rotations stay. */
export function arrangeAll(bodies: Body[], store: PlateStore, bed: BedShape): PlateStore {
  const sized = bodies.map((b) => {
    const r = store[b.id]?.r ?? ([0, 0, 0] as Vec3)
    const { lo, hi } = rotatedBox(b, r)
    return { id: b.id, r, w: hi[0] - lo[0], d: hi[1] - lo[1] }
  }).sort((a, b) => b.w * b.d - a.w * a.d)
  const taken: Rect[] = []
  const out: PlateStore = {}
  for (const s of sized) {
    const [x, y] = findSpot(bed, s.w, s.d, taken)
    out[s.id] = { r: s.r, x, y }
    taken.push({ cx: x, cy: y, w: s.w, d: s.d })
  }
  return out
}

// ---- storage format (the document keeps it as JSON text in the print settings)

const r4 = (n: number) => +n.toFixed(4)

export function serializePlate(store: PlateStore): string {
  const keys = Object.keys(store)
  if (!keys.length) return ''
  const o: Record<string, [number, number, number, number, number]> = {}
  for (const k of keys) { const e = store[k]; o[k] = [r4(e.r[0]), r4(e.r[1]), r4(e.r[2]), r4(e.x), r4(e.y)] }
  return JSON.stringify({ v: 1, p: o })
}

export function parsePlate(text: unknown): PlateStore {
  if (typeof text !== 'string' || !text) return {}
  try {
    const j = JSON.parse(text) as { p?: Record<string, number[]> }
    const out: PlateStore = {}
    for (const [id, a] of Object.entries(j.p ?? {})) {
      if (Array.isArray(a) && a.length === 5 && a.every((n) => typeof n === 'number' && isFinite(n))) out[id] = { r: [a[0], a[1], a[2]], x: a[3], y: a[4] }
    }
    return out
  } catch { return {} }
}

// ---- rotation helpers (Euler degrees in the Move convention R = Rz Ry Rx)

/** Row-major 3x3 of the Euler rotation. */
export function eulerMatrix(r: Vec3): number[] {
  const m = composeTransform({ pivot: [0, 0, 0], translate: [0, 0, 0], rotate: r, scale: 1 })
  return [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]
}

export function mul3(a: number[], b: number[]): number[] {
  const o = new Array<number>(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return o
}

/**
 * The rotation that lays a part down on the direction `down` (a model-space direction, e.g. a face's outward normal), keeping the
 * current rotation `r`: the shortest turn that takes the part's current world direction of `down` to straight down, composed with
 * `r`. No yaw is added beyond what that turn needs. Returns Euler degrees (Move convention).
 */
export function layDirectionDown(r: Vec3, down: Vec3): Vec3 {
  const l = Math.hypot(down[0], down[1], down[2]) || 1
  const d = [down[0] / l, down[1] / l, down[2] / l]
  const R = eulerMatrix(r)
  const w: Vec3 = [R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2], R[6] * d[0] + R[7] * d[1] + R[8] * d[2]]
  const Q = rotationBetween(w, [0, 0, -1])
  return eulerFromMatrix(mul3(Q, R)).map((v) => +v.toFixed(4)) as Vec3
}

/** Move a footprint centre the least that puts the (w x d) box inside the bed's bounding box (centred when it is bigger). */
export function clampToBed(bed: BedShape, w: number, d: number, x: number, y: number): Vec2 {
  const c = (v: number, lo: number, hi: number, size: number) => (hi - lo < size ? (lo + hi) / 2 : Math.min(hi - size / 2, Math.max(lo + size / 2, v)))
  return [+c(x, bed.lo[0], bed.hi[0], w).toFixed(3), +c(y, bed.lo[1], bed.hi[1], d).toFixed(3)]
}

/** The entry after laying `body` down on its model direction `down`: shortest turn, same footprint centre (kept on the bed). */
export function laidDown(body: Body, entry: PlaceEntry, down: Vec3, bed: BedShape): PlaceEntry {
  const r = layDirectionDown(entry.r, down)
  const { lo, hi } = rotatedBox(body, r)
  const [x, y] = clampToBed(bed, hi[0] - lo[0], hi[1] - lo[1], entry.x, entry.y)
  return { r, x, y }
}
