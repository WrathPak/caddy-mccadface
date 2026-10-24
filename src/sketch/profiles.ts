/**
 * Closed-region detection. Non-construction curves are planarised (split at every intersection), a half-edge
 * graph is built, dangling edges are pruned, and faces are walked. Islands become holes of the smallest
 * positive face that contains them.
 */
import {
  TAU, arcInfo, dist, intersectCircleCircle, intersectLineCircle, intersectLineLine, loopPoly, mid, polar,
  pointInPoly, polyArea, polyCentroid, relAngle,
} from './geom'
import { arcOf, circleOf, lineEnds, pos } from './model'
import { arcBeziers, bezAt, bezClosest, bezDeriv, bezIntersect, bezLine, bezSub, type Bez } from './bezier'
import { derivedSegs, isDerived } from './curves'
import { profileIdOf, profileKey, type Loop, type Profile, type Seg, type SketchModel, type Vec2 } from './types'

const EPS = 1e-6

/** the curves the trim tool and the analytic intersections work with (no Bezier pieces) */
export type ClassicCurve = Exclude<Curve, { k: 'b' }>
export type Curve =
  | { k: 'l'; a: Vec2; b: Vec2; src?: string }
  | { k: 'a'; c: Vec2; r: number; a0: number; span: number; src?: string }
  | { k: 'c'; c: Vec2; r: number; src?: string }
  | { k: 'b'; p: Bez; src?: string; ell?: Extract<Seg, { k: 'b' }>['ell'] }

/** Parameter of a point on a curve (line t in [0,1], arc/circle angle offset from a0 / 0). */
export function paramOn(cv: Curve, p: Vec2): number {
  if (cv.k === 'b') return bezClosest(cv.p, p).t
  if (cv.k === 'l') {
    const dx = cv.b[0] - cv.a[0], dy = cv.b[1] - cv.a[1]
    return ((p[0] - cv.a[0]) * dx + (p[1] - cv.a[1]) * dy) / (dx * dx + dy * dy)
  }
  const a = Math.atan2(p[1] - cv.c[1], p[0] - cv.c[0])
  return cv.k === 'a' ? relAngle(a, cv.a0) : relAngle(a, 0)
}
export const maxParam = (cv: Curve) => (cv.k === 'l' || cv.k === 'b' ? 1 : cv.k === 'a' ? cv.span : TAU)

/** The cubic pieces standing for a curve (exact for Bezier pieces and lines, within a micron for arcs and circles). */
function bezOf(cv: Curve): Bez[] {
  if (cv.k === 'b') return [cv.p]
  if (cv.k === 'l') return [bezLine(cv.a, cv.b)]
  return arcBeziers(cv.c, cv.r, cv.k === 'a' ? cv.a0 : 0, cv.k === 'a' ? cv.span : TAU)
}

/** Signed distance of a point from an exact (line / circle) curve: zero on the curve. */
function offCurve(cv: ClassicCurve, p: Vec2): number {
  if (cv.k === 'l') {
    const dx = cv.b[0] - cv.a[0], dy = cv.b[1] - cv.a[1]
    return ((p[0] - cv.a[0]) * dy - (p[1] - cv.a[1]) * dx) / (Math.hypot(dx, dy) || 1)
  }
  return Math.hypot(p[0] - cv.c[0], p[1] - cv.c[1]) - cv.r
}

export function intersections(a0: Curve, b0: Curve): Vec2[] {
  if ((a0.k === 'b') !== (b0.k === 'b')) {
    // a Bezier piece against a line / arc / circle: found on the cubic stand-in, then polished onto the exact curve so that the
    // split points of both curves agree to rounding error
    const bz = (a0.k === 'b' ? a0 : b0) as Extract<Curve, { k: 'b' }>
    const ex = (a0.k === 'b' ? b0 : a0) as ClassicCurve
    const out: Vec2[] = []
    const onArc = (p: Vec2) => ex.k !== 'a' || relAngle(Math.atan2(p[1] - ex.c[1], p[0] - ex.c[0]), ex.a0) <= ex.span + 1e-7
    for (const y of bezOf(ex)) {
      for (const h of bezIntersect(bz.p, y)) {
        let t = h.t
        for (let it = 0; it < 8; it++) {
          const f = offCurve(ex, bezAt(bz.p, t))
          const e = 1e-7
          const df = (offCurve(ex, bezAt(bz.p, Math.min(1, t + e))) - offCurve(ex, bezAt(bz.p, Math.max(0, t - e)))) / (Math.min(1, t + e) - Math.max(0, t - e))
          if (Math.abs(df) < 1e-12) break
          const nt = Math.max(0, Math.min(1, t - f / df))
          if (Math.abs(nt - t) < 1e-14) { t = nt; break }
          t = nt
        }
        const p = bezAt(bz.p, t)
        if (!onArc(p)) continue
        if (!out.some((q) => dist(q, p) < 1e-7)) out.push(p)
      }
    }
    return out
  }
  if (a0.k === 'b' && b0.k === 'b') {
    const a = a0, b = b0
    const out: Vec2[] = []
    for (const h of bezIntersect(a.p, b.p)) {
      // two pieces of the same spline only touch where they join
      if (a.src && a.src === b.src && (dist(h.p, a.p[0]) < 1e-6 || dist(h.p, a.p[3]) < 1e-6) && (dist(h.p, b.p[0]) < 1e-6 || dist(h.p, b.p[3]) < 1e-6)) continue
      if (!out.some((q) => dist(q, h.p) < 1e-7)) out.push(h.p)
    }
    return out
  }
  const a = a0 as ClassicCurve, b = b0 as ClassicCurve
  const out: Vec2[] = []
  const onArc = (cv: Curve, p: Vec2) => cv.k !== 'a' || relAngle(Math.atan2(p[1] - cv.c[1], p[0] - cv.c[0]), cv.a0) <= cv.span + 1e-9
  const onLine = (t: number) => t >= -1e-9 && t <= 1 + 1e-9
  if (a.k === 'l' && b.k === 'l') {
    const r = intersectLineLine(a.a, a.b, b.a, b.b)
    if (r && onLine(r.t) && onLine(r.u)) out.push(r.p)
  } else if (a.k === 'l' || b.k === 'l') {
    const l = (a.k === 'l' ? a : b) as Extract<Curve, { k: 'l' }>
    const c = (a.k === 'l' ? b : a) as Exclude<Curve, { k: 'l' | 'b' }>
    for (const h of intersectLineCircle(l.a, l.b, c.c, c.r)) if (onLine(h.t) && onArc(c, h.p)) out.push(h.p)
  } else {
    for (const p of intersectCircleCircle(a.c, a.r, (b as Exclude<Curve, { k: 'l' | 'b' }>).c, (b as Exclude<Curve, { k: 'l' | 'b' }>).r)) {
      if (onArc(a, p) && onArc(b, p)) out.push(p)
    }
  }
  return out
}

interface Edge { id: number; v0: number; v1: number; seg: Curve; poly: Vec2[] }
interface HalfEdge { id: number; edge: Edge; fwd: boolean; from: number; to: number; ang: number; curv: number; twin: number }

export function detectProfiles(m: SketchModel): Profile[] {
  // 1. curves
  const curves: Curve[] = []
  for (const e of m.entities) {
    if (e.construction) continue
    if (e.type === 'line') {
      const [a, b] = lineEnds(m, e)
      if (dist(a, b) > EPS) curves.push({ k: 'l', a, b, src: e.id })
    } else if (e.type === 'circle') {
      const { c, r } = circleOf(m, e)
      if (r > EPS) curves.push({ k: 'c', c, r, src: e.id })
    } else if (e.type === 'arc') {
      const i = arcOf(m, e)
      if (i.r > EPS) curves.push({ k: 'a', c: pos(m, e.c), r: i.r, a0: i.a0, span: i.span, src: e.id })
    } else if (isDerived(e)) {
      for (const chain of derivedSegs(m, e)) {
        for (const s of chain) {
          if (s.k === 'l') { if (dist(s.a, s.b) > EPS) curves.push({ k: 'l', a: s.a, b: s.b, src: s.id }) }
          else if (s.k === 'b') curves.push({ k: 'b', p: [s.a, s.c1, s.c2, s.b], src: s.id, ell: s.ell })
        }
      }
    }
  }
  if (!curves.length) return []

  // 2. split points per curve
  const splits: number[][] = curves.map(() => [])
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      for (const p of intersections(curves[i], curves[j])) {
        splits[i].push(paramOn(curves[i], p))
        splits[j].push(paramOn(curves[j], p))
      }
    }
  }

  // 3. vertices + edges
  const verts: Vec2[] = []
  const vid = (p: Vec2) => {
    for (let i = 0; i < verts.length; i++) if (Math.abs(verts[i][0] - p[0]) < 1e-5 && Math.abs(verts[i][1] - p[1]) < 1e-5) return i
    verts.push([p[0], p[1]])
    return verts.length - 1
  }
  const pointAt = (cv: Curve, t: number): Vec2 =>
    cv.k === 'b' ? bezAt(cv.p, t) : cv.k === 'l' ? [cv.a[0] + (cv.b[0] - cv.a[0]) * t, cv.a[1] + (cv.b[1] - cv.a[1]) * t] : polar(cv.c, cv.r, (cv.k === 'a' ? cv.a0 : 0) + t)
  const edges: Edge[] = []
  const standaloneCircles: Extract<Curve, { k: 'c' }>[] = []
  const pushEdge = (a: Vec2, b: Vec2, seg: Curve) => {
    const v0 = vid(a), v1 = vid(b)
    if (v0 === v1 && seg.k === 'l') return
    edges.push({ id: edges.length, v0, v1, seg, poly: [] })
  }
  curves.forEach((cv, i) => {
    const max = maxParam(cv)
    const raw = splits[i].map((t) => (cv.k === 'c' && t > TAU - 1e-9 ? 0 : +t.toFixed(9)))
    const ts = [...new Set(raw)].filter((t) => cv.k === 'c' || (t > (cv.k === 'b' ? 1e-7 : 1e-9) && t < max - (cv.k === 'b' ? 1e-7 : 1e-9))).sort((x, y) => x - y)
    if (cv.k === 'c') {
      if (ts.length === 0) { standaloneCircles.push(cv); return }
      for (let k = 0; k < ts.length; k++) {
        const t0 = ts[k], t1 = k + 1 < ts.length ? ts[k + 1] : ts[0] + TAU
        pushEdge(pointAt(cv, t0), pointAt(cv, t1), { k: 'a', c: cv.c, r: cv.r, a0: t0, span: t1 - t0, src: cv.src })
      }
      return
    }
    const bounds = [0, ...ts, max]
    for (let k = 0; k + 1 < bounds.length; k++) {
      const t0 = bounds[k], t1 = bounds[k + 1]
      if (cv.k === 'b') pushEdge(pointAt(cv, t0), pointAt(cv, t1), { k: 'b', p: bezSub(cv.p, t0, t1), src: cv.src, ell: t0 <= 0 && t1 >= 1 ? cv.ell : undefined })
      else if (cv.k === 'l') pushEdge(pointAt(cv, t0), pointAt(cv, t1), { k: 'l', a: pointAt(cv, t0), b: pointAt(cv, t1), src: cv.src })
      else pushEdge(pointAt(cv, t0), pointAt(cv, t1), { k: 'a', c: cv.c, r: cv.r, a0: cv.a0 + t0, span: t1 - t0, src: cv.src })
    }
  })

  // 4. prune dangling edges
  let alive = edges.slice()
  for (;;) {
    const deg = new Map<number, number>()
    for (const e of alive) {
      deg.set(e.v0, (deg.get(e.v0) ?? 0) + 1)
      deg.set(e.v1, (deg.get(e.v1) ?? 0) + 1)
    }
    const next = alive.filter((e) => e.v0 === e.v1 || ((deg.get(e.v0) ?? 0) > 1 && (deg.get(e.v1) ?? 0) > 1))
    if (next.length === alive.length) break
    alive = next
  }

  // 5. half edges
  const hes: HalfEdge[] = []
  for (const e of alive) {
    const s = e.seg
    const bd0 = s.k === 'b' ? bezDeriv(s.p, 0) : [0, 0], bd1 = s.k === 'b' ? bezDeriv(s.p, 1) : [0, 0]
    const angF = s.k === 'b' ? Math.atan2(bd0[1], bd0[0]) : s.k === 'l' ? Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) : s.k === 'a' ? s.a0 + Math.PI / 2 : 0
    const angB = s.k === 'b' ? Math.atan2(-bd1[1], -bd1[0]) : s.k === 'l' ? angF + Math.PI : s.k === 'a' ? s.a0 + s.span - Math.PI / 2 : 0
    // signed curvature at the start (ties between curves leaving a vertex in the same direction are broken by it)
    const k = s.k === 'b' ? (() => {
      const d1: Vec2 = [s.p[1][0] - s.p[0][0], s.p[1][1] - s.p[0][1]], d2: Vec2 = [s.p[2][0] - s.p[1][0], s.p[2][1] - s.p[1][1]]
      const l = Math.hypot(d1[0], d1[1]) || 1
      return (2 / 3) * (d1[0] * d2[1] - d1[1] * d2[0]) / (l * l * l)
    })() : s.k === 'a' ? 1 / s.r : 0
    const f: HalfEdge = { id: hes.length, edge: e, fwd: true, from: e.v0, to: e.v1, ang: angF, curv: k, twin: hes.length + 1 }
    const b: HalfEdge = { id: hes.length + 1, edge: e, fwd: false, from: e.v1, to: e.v0, ang: angB, curv: -k, twin: hes.length }
    hes.push(f, b)
  }
  const out = new Map<number, HalfEdge[]>()
  for (const h of hes) (out.get(h.from) ?? out.set(h.from, []).get(h.from)!).push(h)
  const norm = (a: number) => ((a % TAU) + TAU) % TAU
  for (const list of out.values()) list.sort((x, y) => norm(x.ang) - norm(y.ang) || x.curv - y.curv)
  const nextOf = (h: HalfEdge): HalfEdge => {
    const list = out.get(h.to)!
    const i = list.findIndex((x) => x.id === h.twin)
    return list[(i - 1 + list.length) % list.length]
  }

  const segOf = (h: HalfEdge): Seg => {
    const s = h.edge.seg
    const a = verts[h.from], b = verts[h.to]
    if (s.k === 'l') return { k: 'l', a, b, id: s.src }
    if (s.k === 'b') return h.fwd ? { k: 'b', a, c1: s.p[1], c2: s.p[2], b, id: s.src, ell: s.ell } : { k: 'b', a, c1: s.p[2], c2: s.p[1], b, id: s.src, ell: s.ell }
    if (s.k === 'a') return { k: 'a', a, b, m: polar(s.c, s.r, s.a0 + s.span / 2), c: s.c, r: s.r, ccw: h.fwd, id: s.src }
    return { k: 'c', c: s.c, r: s.r, id: s.src }
  }

  interface FaceRec { loop: Loop; poly: Vec2[]; area: number; comp: number }
  const faces: FaceRec[] = []
  const seen = new Set<number>()
  // connected components
  const comp = new Map<number, number>()
  let nComp = 0
  for (const e of alive) {
    if (comp.has(e.v0)) continue
    const stack = [e.v0]
    comp.set(e.v0, nComp)
    while (stack.length) {
      const v = stack.pop()!
      for (const h of out.get(v) ?? []) if (!comp.has(h.to)) { comp.set(h.to, nComp); stack.push(h.to) }
    }
    nComp++
  }
  for (const h0 of hes) {
    if (seen.has(h0.id)) continue
    const loop: Loop = []
    let h = h0, guard = 0
    do {
      seen.add(h.id)
      loop.push(segOf(h))
      h = nextOf(h)
    } while (h.id !== h0.id && ++guard < 10000)
    const poly = loopPoly(loop)
    faces.push({ loop, poly, area: polyArea(poly), comp: comp.get(h0.from) ?? 0 })
  }
  // standalone circles: disc (positive) + outer boundary (negative)
  for (const c of standaloneCircles) {
    const cc = nComp++
    const disc: Seg = { k: 'c', c: c.c, r: c.r, id: c.src }
    const poly = loopPoly([disc])
    faces.push({ loop: [disc], poly, area: polyArea(poly), comp: cc })
    const rev = [...poly].reverse()
    faces.push({ loop: [{ k: 'c', c: c.c, r: c.r, id: c.src }], poly: rev, area: -polyArea(poly), comp: cc })
  }

  // 6. nesting
  const positives = faces.filter((f) => f.area > 1e-9)
  const holesOf = new Map<FaceRec, Loop[]>()
  for (const outer of faces.filter((f) => f.area < -1e-9)) {
    const probe = outer.poly[0]
    let best: FaceRec | null = null
    for (const p of positives) {
      if (p.comp === outer.comp) continue
      if (pointInPoly(probe, p.poly) && (!best || p.area < best.area)) best = p
    }
    if (best) (holesOf.get(best) ?? holesOf.set(best, []).get(best)!).push(outer.loop)
  }

  // 7. profiles
  const res: Profile[] = []
  for (const f of positives) {
    const holes = holesOf.get(f) ?? []
    let area = f.area
    for (const h of holes) area -= Math.abs(polyArea(loopPoly(h)))
    const cen = polyCentroid(f.poly)
    // the region inside a letter's counter (an O's hole) is not a profile
    if (f.loop.length && f.loop.every((sg) => sg.id?.endsWith('h') && sg.id.includes('.'))) continue
    res.push({ key: profileKey(cen[0], cen[1], area), id: profileIdOf(f.loop), outer: f.loop, holes, area, centroid: cen })
  }
  return res
}

/** Midpoint helper re-exported for callers building labels. */
export { mid, arcInfo }
