/**
 * Keeps strands out of the body: every centerline segment, grown by the strand radius, is tested against the unselected faces
 * of the body (anywhere along the strand) and against the selected faces (beyond the root zone, where the strand is meant to
 * touch its own face). A strand that collides is bent away from the obstacle; if that is not possible it is removed.
 */
import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Line3, Ray, Vector3 } from 'three'
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh'
import type { HairParams, V3 } from './schema'
import type { Surf } from './sampling'
import { COLLISION_CLEARANCE, sectionRadius, type Strand } from './strands'
import type { Mesh3 } from './wall'
import { add, dot, len, mul, norm, sub } from './vec'

function bvhOf(m: Mesh3): { bvh: MeshBVH; geo: BufferGeometry } {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(m.positions, 3))
  geo.setIndex(new BufferAttribute(m.indices.slice(), 1))
  return { geo, bvh: new MeshBVH(geo, { indirect: true }) }
}

export interface Obstacles {
  /** unselected faces of the body (null when the region is the whole body) */
  other: MeshBVH | null
  /** the selected faces */
  region: MeshBVH
  regionPatch: Int32Array
  /** distance along a ray into the body (both sets), Infinity when nothing is hit */
  rayDown: (p: V3, dir: V3, far: number) => number
}

export function makeObstacles(region: Surf, other: Mesh3 | null): Obstacles {
  const r = bvhOf({ positions: region.pos, indices: region.idx })
  const o = other && other.indices.length ? bvhOf(other) : null
  const ray = new Ray()
  return {
    other: o?.bvh ?? null,
    region: r.bvh,
    regionPatch: region.patch,
    rayDown(p, dir, far) {
      ray.origin.set(p[0], p[1], p[2])
      ray.direction.set(dir[0], dir[1], dir[2])
      let best = Infinity
      for (const b of [r.bvh, o?.bvh]) {
        const h = b?.raycastFirst(ray, DoubleSide, 1e-3, far)
        if (h && h.distance < best) best = h.distance
      }
      return best
    },
  }
}

interface Hit { d: number; tp: V3; sp: V3; n: V3 }

const seg = new Line3()
const t1 = new Vector3(), t2 = new Vector3()
const segBox = new Box3()
const tmpN = new Vector3(), tmpB = new Vector3(), tmpP = new Vector3()

/** Closest approach (and the triangle's facing) of a segment to the triangles accepted by `accept`; null when nothing is within r. */
function probe(bvh: MeshBVH, A: V3, B: V3, r: number, accept?: (tri: number) => boolean): Hit | null {
  seg.start.set(A[0], A[1], A[2])
  seg.end.set(B[0], B[1], B[2])
  segBox.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(r)
  let best: Hit | null = null
  bvh.shapecast({
    intersectsBounds: (box) => box.intersectsBox(segBox),
    intersectsTriangle: (tri: ExtendedTriangle, ti: number) => {
      if (accept && !accept(ti)) return false
      tmpN.subVectors(tri.b, tri.a)
      tmpB.subVectors(tri.c, tri.a)
      tmpN.cross(tmpB).normalize()
      const sa = tmpN.dot(tmpP.subVectors(seg.start, tri.a)), sb = tmpN.dot(tmpP.subVectors(seg.end, tri.a))
      let d: number
      let tp: V3, sp: V3
      if (sa * sb < 0) {
        // the segment crosses the triangle's plane: does it pierce the triangle itself?
        const f = sa / (sa - sb)
        tmpP.copy(seg.start).lerp(seg.end, f)
        if (tri.containsPoint(tmpP)) {
          d = 0
          tp = sp = [tmpP.x, tmpP.y, tmpP.z]
          if (!best || d < best.d) best = { d, tp, sp, n: sa >= 0 ? [tmpN.x, tmpN.y, tmpN.z] : [-tmpN.x, -tmpN.y, -tmpN.z] }
          return false
        }
      }
      d = tri.closestPointToSegment(seg, t1, t2)
      if (d < r && (!best || d < best.d)) {
        tp = [t1.x, t1.y, t1.z]
        sp = [t2.x, t2.y, t2.z]
        // facing: toward the side the segment is on
        const side = tmpN.dot(tmpP.set(t2.x - t1.x, t2.y - t1.y, t2.z - t1.z))
        best = { d, tp, sp, n: side >= 0 ? [tmpN.x, tmpN.y, tmpN.z] : [-tmpN.x, -tmpN.y, -tmpN.z] }
      }
      return false
    },
  })
  return best
}

export interface CollisionStats { bent: number; removed: number }

const STEP = 0.75
const MAX_PTS = 120

interface Work { pts: V3[]; sc: number[]; arc: number[]; fixed: Uint8Array }

function toWork(st: Strand): Work {
  const n = st.scale.length
  const pts: V3[] = [], sc: number[] = []
  for (let i = 0; i < n; i++) { pts.push([st.pts[i * 3], st.pts[i * 3 + 1], st.pts[i * 3 + 2]]); sc.push(st.scale[i]) }
  return finish(pts, sc, st)
}

function arcsOf(pts: V3[]): number[] {
  const arc = [0]
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + len(sub(pts[i], pts[i - 1])))
  return arc
}

function finish(pts: V3[], sc: number[], st: Strand): Work {
  const arc = arcsOf(pts)
  const fixed = new Uint8Array(pts.length)
  for (let i = 0; i < pts.length; i++) if (Math.abs(arc[i] - st.rootArc) < 1e-3) fixed[i] = 1
  // with a wall the contact and the buried tip stay where they are
  if (st.contact) { fixed[pts.length - 1] = 1; if (pts.length > 1) fixed[pts.length - 2] = 1 }
  return { pts, sc, arc, fixed }
}

/** Subdivide long segments so the strand can bend smoothly. */
function densify(w: Work, st: Strand): Work {
  const total = w.arc[w.arc.length - 1]
  const step = Math.max(STEP, total / MAX_PTS)
  const pts: V3[] = [w.pts[0]], sc: number[] = [w.sc[0]]
  const keepFixed: number[] = w.fixed[0] ? [0] : []
  for (let i = 1; i < w.pts.length; i++) {
    const L = w.arc[i] - w.arc[i - 1]
    const k = Math.max(1, Math.ceil(L / step))
    for (let j = 1; j <= k; j++) {
      const f = j / k
      pts.push([w.pts[i - 1][0] + (w.pts[i][0] - w.pts[i - 1][0]) * f, w.pts[i - 1][1] + (w.pts[i][1] - w.pts[i - 1][1]) * f, w.pts[i - 1][2] + (w.pts[i][2] - w.pts[i - 1][2]) * f])
      sc.push(w.sc[i - 1] + (w.sc[i] - w.sc[i - 1]) * f)
    }
    if (w.fixed[i]) keepFixed.push(pts.length - 1)
  }
  const out = finish(pts, sc, st)
  for (const i of keepFixed) out.fixed[i] = 1
  return out
}

interface Viol { j: number; f: number; push: number; dir: V3 }

function violations(w: Work, st: Strand, R: number, obs: Obstacles): Viol[] {
  const out: Viol[] = []
  for (let j = 0; j + 1 < w.pts.length; j++) {
    const A = w.pts[j], B = w.pts[j + 1]
    const r = R * Math.max(w.sc[j], w.sc[j + 1]) + COLLISION_CLEARANCE - 0.01
    const hits: Hit[] = []
    if (obs.other) { const h = probe(obs.other, A, B, r); if (h) hits.push(h) }
    if (w.arc[j] >= st.exempt) {
      const h = probe(obs.region, A, B, r)
      if (h) hits.push(h)
    } else {
      // inside the root zone only the other faces of the selection matter
      const h = probe(obs.region, A, B, r, (ti) => obs.regionPatch[ti] !== st.patch)
      if (h) hits.push(h)
    }
    for (const h of hits) {
      let dir: V3 = h.d > 1e-6 ? norm(sub(h.sp, h.tp)) : h.n
      if (!dir.some(Boolean)) dir = h.n
      // a segment on the far side of the surface it hit by piercing is pushed back to the side where it started
      if (h.d > 1e-6 && dot(dir, h.n) < 0) dir = h.n
      const sl = len(sub(B, A)) || 1
      const f = Math.min(1, Math.max(0, dot(sub(h.sp, A), sub(B, A)) / (sl * sl)))
      out.push({ j, f, push: r - h.d + 0.03, dir })
    }
  }
  return out
}

/** Moves vertices away from the violations; returns false when the strand cannot be freed. */
function bend(w: Work, vs: Viol[], horizontal: boolean, moved: V3[], cap: number): boolean {
  const n = w.pts.length
  const acc: V3[] = Array.from({ length: n }, () => [0, 0, 0])
  const wt = new Float64Array(n)
  for (const v of vs) {
    let u = v.dir
    if (horizontal) { u = [u[0], u[1], 0]; const l = len(u); if (l < 0.2) return false; u = mul(u, 1 / l) }
    const m = mul(u, v.push)
    for (const [i, k] of [[v.j, 1 - v.f], [v.j + 1, v.f]] as const) {
      const wgt = Math.max(k, 0.25)
      acc[i] = add(acc[i], mul(m, wgt)); wt[i] += wgt
    }
  }
  const d: V3[] = acc.map((a, i) => (wt[i] > 0 ? mul(a, 1 / wt[i]) : ([0, 0, 0] as V3)))
  // spread to the neighbours so the strand bends gently
  const spread: V3[] = d.map((v) => v)
  for (let i = 0; i < n; i++) {
    for (const [o, k] of [[-1, 0.6], [1, 0.6], [-2, 0.25], [2, 0.25]] as const) {
      const q = i + o
      if (q < 0 || q >= n) continue
      const c = mul(d[q], k)
      if (len(c) > len(spread[i])) spread[i] = c
    }
  }
  for (let i = 0; i < n; i++) {
    if (w.fixed[i]) continue
    w.pts[i] = add(w.pts[i], spread[i])
    moved[i] = add(moved[i], spread[i])
    if (len(moved[i]) > cap) return false
  }
  return true
}

/**
 * Resolve collisions for every strand in place. Strands that still collide after bending are removed.
 * Returns the surviving strands and counts.
 */
export function resolveCollisions(strands: Strand[], P: HairParams, obs: Obstacles): { strands: Strand[]; stats: CollisionStats } {
  const R = sectionRadius(P) * (1 + P.rootFlare / 100)
  const out: Strand[] = []
  const stats: CollisionStats = { bent: 0, removed: 0 }
  for (const st of strands) {
    let w = toWork(st)
    let vs = violations(w, st, R, obs)
    if (!vs.length) { out.push(st); continue }
    w = densify(w, st)
    const moved: V3[] = w.pts.map(() => [0, 0, 0] as V3)
    const cap = Math.max(1, 0.5 * w.arc[w.arc.length - 1])
    let ok = true
    for (let it = 0; it < 16; it++) {
      vs = violations(w, st, R, obs)
      if (!vs.length) break
      if (!bend(w, vs, P.printAware, moved, cap)) { ok = false; break }
      w.arc = arcsOf(w.pts)
    }
    if (ok) ok = violations(w, st, R, obs).length === 0
    if (!ok) { stats.removed++; continue }
    stats.bent++
    const pts = new Float32Array(w.pts.length * 3), scale = new Float32Array(w.pts.length)
    w.pts.forEach((p, i) => { pts.set(p, i * 3); scale[i] = w.sc[i] })
    out.push({ ...st, pts, scale, tip: w.pts[w.pts.length - 1] })
  }
  return { strands: out, stats }
}

/** Depth of the body under a root, along -n, from the root (hits closer than a hair are ignored). */
export function bodyThickness(obs: Obstacles, p: V3, n: V3): number {
  return obs.rayDown(p, mul(n, -1), 1e4)
}

