/**
 * Snap points of a body, the places a joint origin can be put: face centers, edge midpoints, circle / arc centers and vertices.
 * Every point carries the frame it gives the origin (z = the axis the joint works about) and the face / edge / vertex it
 * belongs to, so the origin can be found again after the body changes (see resolveSnap).
 */
import { decodeRef, edgeSigs, encodeRef, faceSigs, nameOf, resolveEdge, resolveFace, resolveVertex, vertexRef, vertexSigs, type EdgeRef, type FaceRef, type GeoRef, type VertexRef } from '@/doc/refs'
import type { Body, Vec3 } from '@/kernel/types'
import { add, cross, dist, dot, len, mul, norm, perpendicular, sub, type Frame } from './matrix'
import type { SnapKind, SnapSpec } from './types'

export interface SnapPoint {
  kind: SnapKind
  pos: Vec3
  /** the joint axis this point gives (outward normal of a face, the axis of a circle, the direction of an edge) */
  z: Vec3
  x: Vec3
  /** index of the face / edge / vertex it belongs to (topology index of the body) */
  index: number
}

export const snapFrame = (s: SnapPoint): Frame => ({ origin: s.pos, z: s.z, x: s.x })

const cache = new WeakMap<Body['mesh'], SnapPoint[]>()

function circleFrom(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; r: number; n: Vec3 } | null {
  const ab = sub(b, a), ac = sub(c, a)
  const n = cross(ab, ac)
  const nn = dot(n, n)
  if (nn < 1e-12) return null
  const t = mul(cross(n, ab), dot(ac, ac))
  const u = mul(cross(ac, n), dot(ab, ab))
  const center = add(a, mul(add(t, u), 1 / (2 * nn)))
  return { center, r: dist(center, a), n: norm(n) }
}

/** The polylines of every B-rep edge, from the display segments. */
function edgePolylines(m: Body['mesh']): Vec3[][] {
  const n = m.edgeCount ?? 0
  const lines: Vec3[][] = Array.from({ length: n }, () => [])
  const e = m.edges, ids = m.edgeIds
  if (!ids) return lines
  for (let s = 0; s < e.length / 6; s++) {
    const id = ids[s]
    const pl = lines[id]
    if (!pl) continue
    const a: Vec3 = [e[s * 6], e[s * 6 + 1], e[s * 6 + 2]], b: Vec3 = [e[s * 6 + 3], e[s * 6 + 4], e[s * 6 + 5]]
    if (!pl.length) pl.push(a)
    else if (dist(pl[pl.length - 1], a) > 1e-6) pl.push(a)
    pl.push(b)
  }
  return lines
}

interface FaceInfo { planar: boolean; normal: Vec3; centroid: Vec3; area: number }
function faceInfos(b: Body): FaceInfo[] {
  const sigs = faceSigs(b)
  const m = b.mesh
  const minDot = sigs.map(() => 1)
  const p = m.positions
  for (let t = 0; t < m.indices.length / 3; t++) {
    const f = m.faceIds[t]
    const i0 = m.indices[t * 3] * 3, i1 = m.indices[t * 3 + 1] * 3, i2 = m.indices[t * 3 + 2] * 3
    const tn = norm(cross([p[i1] - p[i0], p[i1 + 1] - p[i0 + 1], p[i1 + 2] - p[i0 + 2]], [p[i2] - p[i0], p[i2 + 1] - p[i0 + 1], p[i2 + 2] - p[i0 + 2]]))
    const d = dot(tn, sigs[f].normal)
    if (d < minDot[f]) minDot[f] = d
  }
  return sigs.map((s, i) => ({ planar: minDot[i] > 0.9995 && len(s.normal) > 0.5, normal: s.normal, centroid: s.centroid, area: s.area }))
}

/** All snap points of a body (cached per mesh). Mesh bodies only offer their face centers. */
export function snapPoints(b: Body): SnapPoint[] {
  const hit = cache.get(b.mesh)
  if (hit) return hit
  const out: SnapPoint[] = []
  const faces = faceInfos(b)
  faces.forEach((f, index) => {
    if (!f.planar || f.area < 1e-9) return
    out.push({ kind: 'face', pos: f.centroid, z: f.normal, x: perpendicular(f.normal), index })
  })
  if (b.kind === 'brep') {
    const planes = faces.map((f, i) => ({ ...f, i })).filter((f) => f.planar)
    // adjacent plane normals decide how a circle's axis points
    const outward = (center: Vec3, axis: Vec3): Vec3 => {
      for (const f of planes) {
        if (Math.abs(dot(f.normal, axis)) < 0.999) continue
        if (Math.abs(dot(f.normal, sub(center, f.centroid))) > 1e-3) continue
        return dot(f.normal, axis) >= 0 ? axis : mul(axis, -1)
      }
      return axis
    }
    edgePolylines(b.mesh).forEach((pl, index) => {
      if (pl.length < 2) return
      const first = pl[0], last = pl[pl.length - 1]
      let total = 0
      const cum = [0]
      for (let i = 1; i < pl.length; i++) { total += dist(pl[i - 1], pl[i]); cum.push(total) }
      if (total < 1e-9) return
      const at = (s: number): { pos: Vec3; tangent: Vec3 } => {
        let i = 1
        while (i < pl.length - 1 && cum[i] < s) i++
        const seg = sub(pl[i], pl[i - 1])
        const t = (s - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-12)
        return { pos: add(pl[i - 1], mul(seg, Math.min(1, Math.max(0, t)))), tangent: norm(seg) }
      }
      const closed = dist(first, last) < 1e-6 * Math.max(1, total)
      const straight = pl.every((q) => len(cross(sub(q, first), norm(sub(last, first)))) < 1e-6 * Math.max(1, total))
      if (!closed && straight) {
        const d = norm(sub(last, first))
        out.push({ kind: 'edgeMid', pos: at(total / 2).pos, z: d, x: perpendicular(d), index })
        return
      }
      // a circle or an arc: fit through three points of the polyline, then check the rest lie on it
      const i1 = closed ? Math.floor(pl.length / 3) : Math.floor(pl.length / 2)
      const i2 = closed ? Math.floor((2 * pl.length) / 3) : pl.length - 1
      const c = circleFrom(first, pl[i1], pl[i2])
      const onCircle = c && c.r > 1e-6 && pl.every((q) => Math.abs(dist(q, c.center) - c.r) < 0.02 * c.r + 1e-4 && Math.abs(dot(c.n, sub(q, c.center))) < 0.02 * c.r + 1e-4)
      if (c && onCircle) {
        const axis = outward(c.center, c.n)
        out.push({ kind: 'circle', pos: c.center, z: axis, x: norm(sub(first, c.center)), index })
        if (!closed) {
          const mid = at(total / 2)
          out.push({ kind: 'edgeMid', pos: mid.pos, z: mid.tangent, x: perpendicular(mid.tangent), index })
        }
        return
      }
      const mid = at(total / 2)
      out.push({ kind: 'edgeMid', pos: mid.pos, z: mid.tangent, x: perpendicular(mid.tangent), index })
    })
    // vertices take the axis of the planar faces that meet there
    const vs = vertexSigs(b)
    if (vs.length) {
      const key = (q: Vec3) => `${Math.round(q[0] * 1e3)},${Math.round(q[1] * 1e3)},${Math.round(q[2] * 1e3)}`
      const at = new Map<string, Set<number>>()
      const p = b.mesh.positions
      for (let t = 0; t < b.mesh.indices.length; t++) {
        const k = key([p[b.mesh.indices[t] * 3], p[b.mesh.indices[t] * 3 + 1], p[b.mesh.indices[t] * 3 + 2]])
        const f = b.mesh.faceIds[Math.floor(t / 3)]
        ;(at.get(k) ?? at.set(k, new Set()).get(k)!).add(f)
      }
      vs.forEach((v, index) => {
        let n: Vec3 = [0, 0, 0]
        for (const f of at.get(key(v.pos)) ?? []) if (faces[f]?.planar) n = add(n, faces[f].normal)
        const z: Vec3 = len(n) > 1e-6 ? norm(n) : [0, 0, 1]
        out.push({ kind: 'vertex', pos: v.pos, z, x: perpendicular(z), index })
      })
    }
  }
  cache.set(b.mesh, out)
  return out
}

/** Persistent reference to a snap point: the face / edge / vertex it sits on, with its name, plus which point of it. */
export function snapSpec(b: Body, s: SnapPoint, path?: string): SnapSpec {
  let ref: GeoRef
  if (s.kind === 'face') {
    const sig = faceSigs(b)[s.index]
    ref = { kind: 'face', bodyId: b.id, featureId: b.featureId, index: s.index, sig, name: nameOf(b, 'face', s.index), path } as FaceRef
  } else if (s.kind === 'vertex') {
    ref = { ...vertexRef(b, s.index)!, path }
  } else {
    const sig = edgeSigs(b)[s.index]
    ref = { kind: 'edge', bodyId: b.id, featureId: b.featureId, index: s.index, sig, name: nameOf(b, 'edge', s.index), path } as EdgeRef
  }
  return { kind: s.kind, ref: encodeRef(ref) }
}

/** The persistent name of a snap spec, led by the component path: stays the same when the model is regenerated. */
export function persistentName(spec: SnapSpec): string {
  const r = decodeRef(spec.ref) as (GeoRef & { path?: string; name?: string }) | null
  if (!r) return spec.ref
  const nm = 'name' in r && r.name ? r.name : r.bodyId
  return `${r.path ? r.path + '/' : ''}${nm}@${spec.kind}`
}

/** Find the snap point a spec stands for in the current bodies; null when its face / edge / vertex is gone. */
export function resolveSnap(spec: SnapSpec, bodies: Body[]): { frame: Frame; body: Body; point: SnapPoint } | null {
  const r = decodeRef(spec.ref)
  if (!r || r.kind === 'body') return null
  let hit: { body: Body; index: number } | null = null
  if (r.kind === 'face') hit = resolveFace(r as FaceRef, bodies)
  else if (r.kind === 'edge') hit = resolveEdge(r as EdgeRef, bodies)
  else if (r.kind === 'vertex') hit = resolveVertex(r as VertexRef, bodies)
  if (!hit) return null
  const point = snapPoints(hit.body).find((s) => s.kind === spec.kind && s.index === hit!.index)
  return point ? { frame: snapFrame(point), body: hit.body, point } : null
}

export const SNAP_LABEL: Record<SnapKind, string> = { face: 'Face center', edgeMid: 'Edge midpoint', circle: 'Circle center', vertex: 'Vertex' }
