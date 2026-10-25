/**
 * Reading the model for the drawing: edge polylines and circles from the tessellation, and the points a dimension can
 * be attached to. Points are stored as persistent refs (doc/refs.ts), so a dimension finds them again after the model changes.
 */
import { edgeRefOf, resolveRef, vertexRefOf } from './refs'
import { circleExtreme, fitCircle, project, type Circle3, type V2 } from '@/kernel/drawing-geom'
import { dot3, mul3, sub3, unit3 } from '@/kernel/print-geom'
import type { Body, Vec3 } from '@/kernel/types'
import { itemMatrix } from './components'
import type { PointRef, PointRole, ViewItem } from './types'

export { resolveRef }

// ---------------------------------------------------------------- polylines of edges

const edgeCache = new WeakMap<Body['mesh'], Map<number, Vec3[]>>()

/** The points along one B-rep edge, in order, from the tessellation. */
export function edgePoints(b: Body, index: number): Vec3[] {
  let m = edgeCache.get(b.mesh)
  if (!m) {
    m = new Map()
    const e = b.mesh.edges, ids = b.mesh.edgeIds
    const segs = e.length / 6
    const bySeg = new Map<number, number[]>()
    for (let s = 0; s < segs; s++) {
      const id = ids ? ids[s] : s
      ;(bySeg.get(id) ?? bySeg.set(id, []).get(id)!).push(s)
    }
    for (const [id, list] of bySeg) {
      const pts: Vec3[] = []
      for (const s of list) {
        const a: Vec3 = [e[s * 6], e[s * 6 + 1], e[s * 6 + 2]], c: Vec3 = [e[s * 6 + 3], e[s * 6 + 4], e[s * 6 + 5]]
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(last[0] - a[0], last[1] - a[1], last[2] - a[2]) > 1e-6) pts.push(a)
        pts.push(c)
      }
      m.set(id, pts)
    }
    edgeCache.set(b.mesh, m)
  }
  return m.get(index) ?? []
}

const circleCache = new WeakMap<Body['mesh'], Map<number, Circle3 | null>>()
/** The circle (or arc) an edge lies on, or null for straight edges and splines. */
export function edgeCircle(b: Body, index: number): Circle3 | null {
  let m = circleCache.get(b.mesh)
  if (!m) circleCache.set(b.mesh, (m = new Map()))
  if (!m.has(index)) m.set(index, fitCircle(edgePoints(b, index)))
  return m.get(index)!
}

// ---------------------------------------------------------------- circles for centerlines

export interface CircleGroup {
  center: Vec3
  normal: Vec3
  radius: number
  /** edge indices that make up the circle */
  edges: number[]
  /** closed circle (the edges add up to a full turn) */
  full: boolean
  bodyId: string
}

const groupCache = new WeakMap<Body['mesh'], CircleGroup[]>()

/** Full circles of a body (a circle split in two arcs counts once). */
export function bodyCircles(b: Body): CircleGroup[] {
  let g = groupCache.get(b.mesh)
  if (g) return g
  g = []
  const total = new Map<CircleGroup, number>()
  const n = b.mesh.edgeCount ?? 0
  for (let i = 0; i < n; i++) {
    const c = edgeCircle(b, i)
    if (!c || c.radius < 1e-4) continue
    const hit = g.find((x) => Math.abs(x.radius - c.radius) < 1e-4 * Math.max(1, c.radius) && Math.hypot(...sub3(x.center, c.center)) < 1e-4 * Math.max(1, c.radius) && Math.abs(Math.abs(dot3(x.normal, c.normal)) - 1) < 1e-5)
    if (hit) { hit.edges.push(i); total.set(hit, (total.get(hit) ?? 0) + c.sweep) }
    else {
      const ng: CircleGroup = { center: c.center, normal: c.normal, radius: c.radius, edges: [i], full: false, bodyId: b.id }
      g.push(ng)
      total.set(ng, c.sweep)
    }
  }
  for (const x of g) x.full = (total.get(x) ?? 0) > Math.PI * 2 - 0.1
  const out = g.filter((x) => x.full)
  groupCache.set(b.mesh, out)
  return out
}

/** Centerline pieces of the bodies in a view: [x0, y0, x1, y1, r] in view plane coordinates (r is the hole radius), plus center marks as [cx, cy, r]. */
export function centerMarks(bodies: { body: Body; item: ViewItem }[], basis: { x: Vec3; y: Vec3; z: Vec3 }): { lines: number[][]; marks: number[][] } {
  const lines: number[][] = [], marks: number[][] = []
  for (const { body, item } of bodies) {
    const mat = itemMatrix(item)
    const circles = bodyCircles(body).map((c) => (mat ? transformCircle(c, mat) : c))
    const used = new Set<number>()
    circles.forEach((c, i) => {
      if (used.has(i)) return
      const face = Math.abs(dot3(c.normal, basis.z))
      // every circle of the same axis and radius belongs to one hole / boss
      const same = circles
        .map((o, j) => ({ o, j }))
        .filter(({ o, j }) => j === i || (!used.has(j) && Math.abs(o.radius - c.radius) < 1e-4 * Math.max(1, c.radius) && Math.abs(Math.abs(dot3(o.normal, c.normal)) - 1) < 1e-5 && onAxis(o.center, c)))
      same.forEach(({ j }) => used.add(j))
      if (face > 0.995) {
        const p = project(c.center, basis)
        marks.push([p[0], p[1], c.radius])
      } else if (face < 0.02 && same.length >= 2) {
        const ts = same.map(({ o }) => dot3(o.center, c.normal))
        const lo = same[ts.indexOf(Math.min(...ts))].o.center, hi = same[ts.indexOf(Math.max(...ts))].o.center
        const a = project(lo, basis), z = project(hi, basis)
        lines.push([a[0], a[1], z[0], z[1], c.radius])
      }
    })
  }
  return { lines, marks }
}

const onAxis = (p: Vec3, c: { center: Vec3; normal: Vec3 }) => {
  const d = sub3(p, c.center)
  const along = mul3(c.normal, dot3(d, c.normal))
  return Math.hypot(...sub3(d, along)) < 1e-4 * Math.max(1, Math.hypot(...d))
}

function transformCircle(c: CircleGroup, m: number[]): CircleGroup {
  const pt = (p: Vec3): Vec3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
  const dir = (p: Vec3): Vec3 => unit3([m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]])
  return { ...c, center: pt(c.center), normal: dir(c.normal) }
}

// ---------------------------------------------------------------- points of a dimension

export interface Located { p3: Vec3; p2: V2 }

const place = (p: Vec3, m?: number[]): Vec3 => (m ? [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]] : p)

/** Where a dimension point is now: re-found by its persistent ref, then projected into the view. null when the model lost it. */
export function locate(pr: PointRef, bodies: Body[], basis: { x: Vec3; y: Vec3 }): Located | null {
  const res = resolveRef(pr.ref, bodies)
  if (!res) return null
  const mat = itemMatrix({ bodyId: res.body.id, occ: pr.occ })
  const wrap = (p: Vec3): Located => {
    const q = place(p, mat)
    return { p3: q, p2: project(q, basis) }
  }
  if (pr.ref.kind === 'vertex') {
    const p = res.body.mesh.vertexPos
    if (!p) return null
    return wrap([p[res.index * 3], p[res.index * 3 + 1], p[res.index * 3 + 2]])
  }
  const pts = edgePoints(res.body, res.index)
  if (pts.length < 2) return null
  switch (pr.role) {
    case 'start': return wrap(pts[0])
    case 'end': return wrap(pts[pts.length - 1])
    case 'mid': {
      // middle by arc length
      let total = 0
      for (let i = 1; i < pts.length; i++) total += Math.hypot(...sub3(pts[i], pts[i - 1]))
      let want = total / 2
      for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(...sub3(pts[i], pts[i - 1]))
        if (want <= seg) {
          const t = seg > 0 ? want / seg : 0
          return wrap([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * t])
        }
        want -= seg
      }
      return wrap(pts[pts.length - 1])
    }
    case 'center': {
      const c = edgeCircle(res.body, res.index)
      return c ? wrap(c.center) : null
    }
    case 'ext+x': case 'ext-x': case 'ext+y': case 'ext-y': {
      const c = edgeCircle(res.body, res.index)
      if (!c) return null
      const cc = mat ? { ...c, center: place(c.center, mat), normal: transformCircle({ ...c, edges: [], full: true, bodyId: '' }, mat).normal } : c
      const d: V2 = pr.role === 'ext+x' ? [1, 0] : pr.role === 'ext-x' ? [-1, 0] : pr.role === 'ext+y' ? [0, 1] : [0, -1]
      const p = circleExtreme(cc, basis as { x: Vec3; y: Vec3 }, d)
      return { p3: p, p2: project(p, basis) }
    }
    default: return null
  }
}

/** The circle radius (model units) a radius / diameter dimension measures, with its centre in the view. */
export function locateCircle(pr: PointRef, bodies: Body[], basis: { x: Vec3; y: Vec3 }): { center: V2; radius: number; p3: Vec3 } | null {
  const res = resolveRef(pr.ref, bodies)
  if (!res || pr.ref.kind !== 'edge') return null
  const c = edgeCircle(res.body, res.index)
  if (!c) return null
  const mat = itemMatrix({ bodyId: res.body.id, occ: pr.occ })
  const centre = place(c.center, mat)
  return { center: project(centre, basis), radius: c.radius, p3: centre }
}

// ---------------------------------------------------------------- snapping

export interface SnapPoint { pt: PointRef; p2: V2; p3: Vec3; kind: 'vertex' | 'mid' | 'center' | 'quad'; bodyId: string }

/** Every point of the bodies a dimension could be attached to, projected into a view. Cheap enough to rebuild per view. */
export function snapPoints(bodies: { body: Body; item: ViewItem }[], basis: { x: Vec3; y: Vec3 }): SnapPoint[] {
  const out: SnapPoint[] = []
  for (const { body, item } of bodies) {
    const mat = itemMatrix(item)
    const vp = body.mesh.vertexPos
    const vn = vp ? vp.length / 3 : 0
    for (let i = 0; i < vn; i++) {
      const ref = vertexRefOf(body, i)
      if (!ref) continue
      const p3 = place([vp![i * 3], vp![i * 3 + 1], vp![i * 3 + 2]], mat)
      out.push({ pt: { ref, role: 'vertex', occ: item.occ }, p2: project(p3, basis), p3, kind: 'vertex', bodyId: body.id })
    }
    const ne = body.mesh.edgeCount ?? 0
    for (let i = 0; i < ne; i++) {
      const pts = edgePoints(body, i)
      if (pts.length < 2) continue
      const ref = edgeRefOf(body, i)
      if (!ref) continue
      const c = edgeCircle(body, i)
      if (c) {
        const cen = place(c.center, mat)
        out.push({ pt: { ref, role: 'center', occ: item.occ }, p2: project(cen, basis), p3: cen, kind: 'center', bodyId: body.id })
        for (const role of ['ext+x', 'ext-x', 'ext+y', 'ext-y'] as PointRole[]) {
          const loc = locate({ ref, role, occ: item.occ }, [body], basis)
          if (loc) out.push({ pt: { ref, role, occ: item.occ }, p2: loc.p2, p3: loc.p3, kind: 'quad', bodyId: body.id })
        }
      } else if (pts.length === 2) {
        const loc = locate({ ref, role: 'mid', occ: item.occ }, [body], basis)
        if (loc) out.push({ pt: { ref, role: 'mid', occ: item.occ }, p2: loc.p2, p3: loc.p3, kind: 'mid', bodyId: body.id })
      }
    }
  }
  return out
}

