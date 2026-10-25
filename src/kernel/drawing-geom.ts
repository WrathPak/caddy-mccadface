/** Pure geometry for drawings (view bases, projection, hatching, clipping, circle fits). No WASM: both threads and the tests use it. */
import { cross3, dot3, mul3, sub3, unit3 } from './print-geom'
import type { Vec3 } from './types'

export type V2 = [number, number]
/** flat [x0, y0, x1, y1, ...] */
export type Poly2 = number[]

/** Axes of the view plane: x to the right, y up, z towards the viewer. */
export function viewBasis(eye: Vec3, right: Vec3): { x: Vec3; y: Vec3; z: Vec3 } {
  const z = unit3(eye)
  const x = unit3(sub3(right, mul3(z, dot3(right, z))))
  const y = cross3(z, x)
  return { x, y, z }
}

export function project(p: Vec3, b: { x: Vec3; y: Vec3 }): V2 {
  return [dot3(p, b.x), dot3(p, b.y)]
}

/** Standard views: (eye, right). Screen right = up x eye for each. */
export const ORIENTATIONS: Record<string, { label: string; eye: Vec3; right: Vec3 }> = {
  front: { label: 'Front', eye: [0, -1, 0], right: [1, 0, 0] },
  back: { label: 'Back', eye: [0, 1, 0], right: [-1, 0, 0] },
  top: { label: 'Top', eye: [0, 0, 1], right: [1, 0, 0] },
  bottom: { label: 'Bottom', eye: [0, 0, -1], right: [1, 0, 0] },
  right: { label: 'Right', eye: [1, 0, 0], right: [0, 1, 0] },
  left: { label: 'Left', eye: [-1, 0, 0], right: [0, -1, 0] },
  iso: { label: 'Isometric', eye: unit3([1, -1, 1]), right: unit3([1, 1, 0]) },
}

export type Side = 'right' | 'left' | 'above' | 'below'

/**
 * The (eye, right) of a view projected from a parent view and placed on the given side of it.
 * Third angle: the view placed above is seen from above, the one on the right is seen from the right.
 * First angle is the opposite: the view placed above is seen from below, the one on the right is seen from the left.
 */
export function projectedOrientation(eye: Vec3, right: Vec3, side: Side, projection: 'first' | 'third'): { eye: Vec3; right: Vec3 } {
  const up = cross3(unit3(eye), unit3(right)) // y axis of the parent
  const e = unit3(eye), r = unit3(right)
  const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]]
  const third = projection === 'third'
  switch (side) {
    case 'above': return third ? { eye: up, right: r } : { eye: neg(up), right: r }
    case 'below': return third ? { eye: neg(up), right: r } : { eye: up, right: r }
    case 'right': return third ? { eye: r, right: neg(e) } : { eye: neg(r), right: e }
    case 'left': return third ? { eye: neg(r), right: e } : { eye: r, right: neg(e) }
  }
}

/** Section plane for a cut line drawn in a parent view: origin on the line, normal pointing at the section view's eye. */
export function sectionPlane(eye: Vec3, right: Vec3, a: V2, b: V2, flip: boolean): { origin: Vec3; normal: Vec3; secEye: Vec3; secRight: Vec3 } {
  const bs = viewBasis(eye, right)
  const at = (p: V2): Vec3 => [bs.x[0] * p[0] + bs.y[0] * p[1], bs.x[1] * p[0] + bs.y[1] * p[1], bs.x[2] * p[0] + bs.y[2] * p[1]]
  const pa = at(a), pb = at(b)
  const dir = unit3(sub3(pb, pa))
  // the plane holds the cut line and the viewing direction; its normal is the line crossed with the viewing direction
  let n = unit3(cross3(dir, bs.z))
  if (flip) n = [-n[0], -n[1], -n[2]]
  // the section view keeps the parent's "up" so it reads the same way up. A cut across the view's own up direction
  // (a horizontal cut line) is seen from above or below, like a top or bottom view: the model's front stays towards the parent.
  const along = dot3(n, bs.y)
  const up: Vec3 = along > 0.9 ? [-bs.z[0], -bs.z[1], -bs.z[2]] : along < -0.9 ? bs.z : bs.y
  const secRight = unit3(cross3(up, n))
  return { origin: pa, normal: n, secEye: n, secRight }
}

// ---------------------------------------------------------------- 2D helpers

/**
 * Join polylines that share end points into longer ones (the edges of a wire come in no particular order or direction).
 * A closed result repeats its first point at the end.
 */
export function chainPolylines(parts: Poly2[], tol = 1e-5): Poly2[] {
  const rest = parts.filter((p) => p.length >= 4).map((p) => p.slice())
  const out: Poly2[] = []
  const rev = (p: Poly2): Poly2 => {
    const r: number[] = []
    for (let i = p.length - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1])
    return r
  }
  const same = (a: number, b: number, c: number, d: number) => Math.hypot(a - c, b - d) <= tol
  while (rest.length) {
    let cur = rest.pop()!
    let grew = true
    while (grew) {
      grew = false
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i]
        const L = cur.length, M = p.length
        if (same(cur[L - 2], cur[L - 1], p[0], p[1])) cur = cur.concat(p.slice(2))
        else if (same(cur[L - 2], cur[L - 1], p[M - 2], p[M - 1])) cur = cur.concat(rev(p).slice(2))
        else if (same(cur[0], cur[1], p[M - 2], p[M - 1])) cur = p.concat(cur.slice(2))
        else if (same(cur[0], cur[1], p[0], p[1])) cur = rev(p).concat(cur.slice(2))
        else continue
        rest.splice(i, 1)
        grew = true
        break
      }
    }
    out.push(cur)
  }
  return out
}

export function polyBounds(polys: Poly2[]): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of polys) {
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i]
      if (p[i] > x1) x1 = p[i]
      if (p[i + 1] < y0) y0 = p[i + 1]
      if (p[i + 1] > y1) y1 = p[i + 1]
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null
}

/** Distance from a point to the nearest segment of the polylines. */
export function nearestOnPolys(px: number, py: number, polys: Poly2[]): number {
  let best = Infinity
  for (const p of polys) {
    for (let i = 2; i < p.length; i += 2) {
      const ax = p[i - 2], ay = p[i - 1], dx = p[i] - ax, dy = p[i + 1] - ay
      const l2 = dx * dx + dy * dy
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
      const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
      if (d < best) best = d
    }
  }
  return best
}

/** The parts of a polyline that lie inside a circle (cut where it crosses the circle). */
export function clipPolyToCircle(p: Poly2, c: V2, r: number): Poly2[] {
  const out: Poly2[] = []
  let cur: number[] = []
  const inside = (x: number, y: number) => Math.hypot(x - c[0], y - c[1]) <= r + 1e-9
  const flush = () => { if (cur.length >= 4) out.push(cur); cur = [] }
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3]
    const dx = bx - ax, dy = by - ay
    const fx = ax - c[0], fy = ay - c[1]
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r
    const disc = B * B - 4 * A * C
    let t0 = 0, t1 = 1
    if (A < 1e-18) { if (!inside(ax, ay)) { flush(); continue } }
    else if (disc < 0) { flush(); continue }
    else {
      const s = Math.sqrt(disc)
      const u0 = (-B - s) / (2 * A), u1 = (-B + s) / (2 * A)
      t0 = Math.max(0, u0); t1 = Math.min(1, u1)
      if (t0 > t1) { flush(); continue }
    }
    const sx = ax + dx * t0, sy = ay + dy * t0, ex = ax + dx * t1, ey = ay + dy * t1
    if (t0 > 1e-12) flush()
    if (!cur.length) cur.push(sx, sy)
    cur.push(ex, ey)
    if (t1 < 1 - 1e-12) flush()
  }
  flush()
  return out
}

/**
 * Hatch lines for a face made of loops (outer first, holes after): parallel lines at `angle` degrees, `spacing` apart,
 * clipped to the face by the even-odd rule. Returns segments as [x0, y0, x1, y1].
 */
export function hatchLines(loops: Poly2[], spacing: number, angleDeg: number, phase = 0): Poly2[] {
  const a = (angleDeg * Math.PI) / 180
  const dx = Math.cos(a), dy = Math.sin(a)
  const nx = -dy, ny = dx // normal of the hatch direction
  let lo = Infinity, hi = -Infinity
  for (const l of loops) for (let i = 0; i < l.length; i += 2) {
    const d = l[i] * nx + l[i + 1] * ny
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  const out: Poly2[] = []
  if (!Number.isFinite(lo) || spacing <= 0) return out
  const first = Math.ceil((lo - phase) / spacing) * spacing + phase
  for (let d = first + spacing * 1e-6; d < hi; d += spacing) {
    // intersections of the line {p : p.n = d} with every loop edge, as the parameter along the line direction
    const ts: number[] = []
    for (const l of loops) {
      const n = l.length / 2
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const ax = l[i * 2], ay = l[i * 2 + 1], bx = l[j * 2], by = l[j * 2 + 1]
        const da = ax * nx + ay * ny - d, db = bx * nx + by * ny - d
        if ((da < 0 && db >= 0) || (db < 0 && da >= 0)) {
          const t = da / (da - db)
          ts.push((ax + (bx - ax) * t) * dx + (ay + (by - ay) * t) * dy)
        }
      }
    }
    ts.sort((p, q) => p - q)
    for (let k = 0; k + 1 < ts.length; k += 2) {
      if (ts[k + 1] - ts[k] < 1e-9) continue
      out.push([d * nx + ts[k] * dx, d * ny + ts[k] * dy, d * nx + ts[k + 1] * dx, d * ny + ts[k + 1] * dy])
    }
  }
  return out
}

// ---------------------------------------------------------------- circles from tessellated edges

export interface Circle3 { center: Vec3; normal: Vec3; radius: number; /** swept angle, radians (2 pi for a full circle) */ sweep: number }

/**
 * Fit a circle (or arc) to the points of one edge. Returns null when the points are not on a circle (a straight edge,
 * a spline). `pts` are 3D points in order along the edge.
 */
export function fitCircle(pts: Vec3[]): Circle3 | null {
  if (pts.length < 4) return null
  const p0 = pts[0]
  let fi = 0, fd = 0
  pts.forEach((p, i) => { const d = Math.hypot(...sub3(p, p0)); if (d > fd) { fd = d; fi = i } })
  if (fd < 1e-6) return null
  // for a closed loop the farthest point is opposite the start; take a third point a quarter of the way round
  const pa = pts[fi]
  let ci = 0, cd = 0
  const ab = unit3(sub3(pa, p0))
  pts.forEach((p, i) => {
    const v = sub3(p, p0)
    const d = Math.hypot(...sub3(v, mul3(ab, dot3(v, ab))))
    if (d > cd) { cd = d; ci = i }
  })
  if (cd < 1e-4 * fd) return null // collinear
  const pb = pts[ci]
  // circumcircle of p0, pa, pb
  const u = sub3(pa, p0), v = sub3(pb, p0)
  const w = cross3(u, v)
  const w2 = dot3(w, w)
  if (w2 < 1e-18) return null
  const a = mul3(cross3(w, u), dot3(v, v) / (2 * w2))
  const b = mul3(cross3(v, w), dot3(u, u) / (2 * w2))
  const centre: Vec3 = [p0[0] + a[0] + b[0], p0[1] + a[1] + b[1], p0[2] + a[2] + b[2]]
  const radius = Math.hypot(...sub3(p0, centre))
  const normal = unit3(w)
  for (const p of pts) {
    const rr = Math.hypot(...sub3(p, centre))
    if (Math.abs(rr - radius) > 0.01 * radius + 1e-4) return null
    if (Math.abs(dot3(sub3(p, centre), normal)) > 0.01 * radius + 1e-4) return null
  }
  // swept angle: sum of the angles between consecutive radius vectors
  let sweep = 0
  for (let i = 1; i < pts.length; i++) {
    const r0 = unit3(sub3(pts[i - 1], centre)), r1 = unit3(sub3(pts[i], centre))
    sweep += Math.atan2(dot3(cross3(r0, r1), normal), dot3(r0, r1))
  }
  return { center: centre, normal, radius, sweep: Math.abs(sweep) }
}

/** Point of the circle that is furthest in the 2D direction `d` once the circle is projected with `basis`. */
export function circleExtreme(c: Circle3, basis: { x: Vec3; y: Vec3 }, d: V2): Vec3 {
  const ref: Vec3 = Math.abs(c.normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const u = unit3(cross3(c.normal, ref)), w = cross3(c.normal, u)
  const U: V2 = project(u, basis), W: V2 = project(w, basis)
  const th = Math.atan2(d[0] * W[0] + d[1] * W[1], d[0] * U[0] + d[1] * U[1])
  const cs = Math.cos(th) * c.radius, sn = Math.sin(th) * c.radius
  return [c.center[0] + u[0] * cs + w[0] * sn, c.center[1] + u[1] * cs + w[1] * sn, c.center[2] + u[2] * cs + w[2] * sn]
}
