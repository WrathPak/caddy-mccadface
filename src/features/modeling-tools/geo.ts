/**
 * Construction geometry as references: planes (the existing `usePlanes` mirror), axes and points. `resolve*` turn the
 * strings stored in feature params (origin plane / axis ids, construction feature ids, JSON face / edge / vertex refs) into
 * world geometry, so every feature can take any of them.
 */
import { create } from 'zustand'
import { RefError, RefReport, decodeRef, faceSigs, resolveEdge, resolveFace, resolveVertex, vertexSigs } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { getKernel } from '@/kernel/client'
import type { EdgeGeom, FaceGeom } from '@/kernel/modeling-ops'
import type { Body, Vec3 } from '@/kernel/types'
import { norm3 } from '@/kernel/xform'
import { useSketchData } from '@/sketch/draw'
import { isPlanarFace } from '@/sketch/create'
import { originPlane, planeFromNormal } from '@/sketch/plane'
import { usePlanes } from '@/sketch/planes'
import type { PlaneDef, SketchData } from '@/sketch/types'
import { toWorld } from '@/sketch/plane'

export interface AxisDef { origin: Vec3; dir: Vec3 }

/** Main-thread mirror of the construction axes and points (planes live in `usePlanes`). */
export const useConstruct = create<{
  axes: Record<string, AxisDef>
  points: Record<string, Vec3>
  setAxis: (id: string, a: AxisDef | null) => void
  setPoint: (id: string, p: Vec3 | null) => void
}>((set) => ({
  axes: {},
  points: {},
  setAxis: (id, a) => set((s) => { const axes = { ...s.axes }; if (a) axes[id] = a; else delete axes[id]; return { axes } }),
  setPoint: (id, p) => set((s) => { const points = { ...s.points }; if (p) points[id] = p; else delete points[id]; return { points } }),
}))

/** What the resolvers need from the document. */
export interface RefEnv {
  bodies: Body[]
  /** the `data` an earlier feature published: `{ plane }`, `{ axis }`, `{ point }` or a sketch's data */
  dataOf(id: string): unknown
  kernel: { call(name: string, args: unknown): Promise<unknown> }
}

/** Environment for live previews: the current geometry and the construction mirrors. */
export function liveRefEnv(): RefEnv {
  return {
    bodies: useDoc.getState().geometry,
    dataOf: (id) => {
      const sk = useSketchData.getState().data[id]
      if (sk) return sk
      return { plane: usePlanes.getState().data[id], axis: useConstruct.getState().axes[id], point: useConstruct.getState().points[id] }
    },
    kernel: getKernel() as unknown as RefEnv['kernel'],
  }
}

export const ORIGIN_PLANES = ['planeXY', 'planeXZ', 'planeYZ']
export const ORIGIN_AXES = ['axisX', 'axisY', 'axisZ']
const AXIS_DIR: Record<string, Vec3> = { axisX: [1, 0, 0], axisY: [0, 1, 0], axisZ: [0, 0, 1] }

const lost = (what: string, s: string, report?: RefReport) => {
  report?.lost.set(s, what)
  return new RefError(`${what}. Pick it again.`, [s])
}

export async function resolvePlane(s: string, env: RefEnv, report?: RefReport): Promise<PlaneDef> {
  if (ORIGIN_PLANES.includes(s)) return originPlane(s.slice(5) as 'XY' | 'XZ' | 'YZ')
  const ref = s.startsWith('{') ? decodeRef(s) : null
  if (ref && ref.kind === 'face') {
    const hit = resolveFace(ref, env.bodies, report)
    if (!hit) throw lost('The face no longer exists (an edit upstream removed it)', s)
    if (!isPlanarFace(hit.body, hit.index)) throw new Error('The face is not flat; pick a planar face or a plane')
    const sg = faceSigs(hit.body)[hit.index]
    return planeFromNormal(sg.centroid, sg.normal)
  }
  const d = env.dataOf(s) as { plane?: PlaneDef } | undefined
  if (d?.plane) return d.plane
  throw lost('The plane no longer exists', s, report)
}

export async function resolveAxis(s: string, env: RefEnv, report?: RefReport): Promise<AxisDef> {
  if (ORIGIN_AXES.includes(s)) return { origin: [0, 0, 0], dir: AXIS_DIR[s] }
  const ref = s.startsWith('{') ? decodeRef(s) : null
  if (ref && ref.kind === 'edge') {
    const hit = resolveEdge(ref, env.bodies, report)
    if (!hit) throw lost('The edge no longer exists (an edit upstream removed it)', s)
    const [g] = (await env.kernel.call('edgeGeom', { key: hit.body.key, edges: [hit.index] })) as (EdgeGeom | null)[]
    if (!g || g.type === 'other') throw new Error('The edge is neither straight nor circular, so it has no axis')
    return { origin: g.origin, dir: norm3(g.dir) }
  }
  if (ref && ref.kind === 'face') {
    const hit = resolveFace(ref, env.bodies, report)
    if (!hit) throw lost('The face no longer exists (an edit upstream removed it)', s)
    const [g] = (await env.kernel.call('faceGeom', { key: hit.body.key, faces: [hit.index] })) as (FaceGeom | null)[]
    if (!g || g.type !== 'cylinder') throw new Error('The face is not a cylinder, so it has no axis')
    return { origin: g.origin, dir: norm3(g.dir) }
  }
  const d = env.dataOf(s) as { axis?: AxisDef } | undefined
  if (d?.axis) return d.axis
  throw lost('The axis no longer exists', s, report)
}

export async function resolvePoint(s: string, env: RefEnv, report?: RefReport): Promise<Vec3> {
  const ref = s.startsWith('{') ? decodeRef(s) : null
  if (ref && ref.kind === 'vertex') {
    const hit = resolveVertex(ref, env.bodies, report)
    if (!hit) throw lost('The vertex no longer exists (an edit upstream removed it)', s)
    return vertexSigs(hit.body)[hit.index].pos
  }
  if (s.startsWith('pt:')) {
    // a point of a finished sketch: pt:<sketch feature>:<entity id>
    const [, fid, eid] = s.split(':')
    const sk = env.dataOf(fid) as SketchData | undefined
    const e = sk?.entities.find((x) => x.id === eid)
    if (!sk || !e || e.type !== 'point') throw lost('The sketch point no longer exists', s, report)
    return toWorld(sk.plane, [e.x, e.y])
  }
  const d = env.dataOf(s) as { point?: Vec3 } | undefined
  if (d?.point) return d.point
  throw lost('The point no longer exists', s, report)
}

/** A direction from a plane / planar face (its normal), an axis, a straight edge or a cylinder. */
export async function resolveDirection(s: string, env: RefEnv, report?: RefReport): Promise<Vec3> {
  if (ORIGIN_PLANES.includes(s)) return originPlane(s.slice(5) as 'XY' | 'XZ' | 'YZ').normal
  if (ORIGIN_AXES.includes(s)) return AXIS_DIR[s]
  const ref = s.startsWith('{') ? decodeRef(s) : null
  if (ref?.kind === 'face') {
    const hit = resolveFace(ref, env.bodies, report)
    if (!hit) throw lost('The face no longer exists (an edit upstream removed it)', s)
    if (isPlanarFace(hit.body, hit.index)) return faceSigs(hit.body)[hit.index].normal
    return (await resolveAxis(s, env, report)).dir
  }
  if (ref?.kind === 'edge') return (await resolveAxis(s, env, report)).dir
  const d = env.dataOf(s) as { plane?: PlaneDef; axis?: AxisDef } | undefined
  if (d?.plane) return d.plane.normal
  if (d?.axis) return d.axis.dir
  throw lost('The direction reference no longer exists', s, report)
}

/** Edge polylines of a body edge, read from the display mesh (segments tagged with the edge index), joined in order. */
export function edgePolyline(body: Body, index: number): Vec3[] {
  const m = body.mesh
  const segs: [Vec3, Vec3][] = []
  for (let s = 0; s < m.edges.length / 6; s++) {
    if ((m.edgeIds ? m.edgeIds[s] : s) !== index) continue
    segs.push([[m.edges[s * 6], m.edges[s * 6 + 1], m.edges[s * 6 + 2]], [m.edges[s * 6 + 3], m.edges[s * 6 + 4], m.edges[s * 6 + 5]]])
  }
  return joinSegments(segs)
}

const same = (a: Vec3, b: Vec3, tol = 1e-5) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol

/** Order loose segments into one polyline (greedy, from the first segment, extending either end). */
export function joinSegments(segs: [Vec3, Vec3][]): Vec3[] {
  if (!segs.length) return []
  const left = segs.slice(1)
  const pts: Vec3[] = [segs[0][0], segs[0][1]]
  for (let guard = 0; left.length && guard < segs.length * 2; guard++) {
    const end = pts[pts.length - 1], start = pts[0]
    const i = left.findIndex(([a, b]) => same(a, end) || same(b, end) || same(a, start) || same(b, start))
    if (i < 0) break
    const [a, b] = left.splice(i, 1)[0]
    if (same(a, end)) pts.push(b)
    else if (same(b, end)) pts.push(a)
    else if (same(b, start)) pts.unshift(a)
    else pts.unshift(b)
  }
  return pts
}

/** Join several polylines into one path (each is flipped when needed so the end meets the next start). */
export function chainPolylines(lines: Vec3[][]): Vec3[] {
  const pool = lines.filter((l) => l.length > 1).map((l) => [...l])
  if (!pool.length) return []
  let path = pool.shift()!
  for (let guard = 0; pool.length && guard < 100; guard++) {
    const end = path[path.length - 1], start = path[0]
    const i = pool.findIndex((l) => same(l[0], end) || same(l[l.length - 1], end) || same(l[0], start) || same(l[l.length - 1], start))
    if (i < 0) break
    const l = pool.splice(i, 1)[0]
    if (same(l[0], end)) path = [...path, ...l.slice(1)]
    else if (same(l[l.length - 1], end)) path = [...path, ...[...l].reverse().slice(1)]
    else if (same(l[l.length - 1], start)) path = [...l.slice(0, -1), ...path]
    else path = [...[...l].reverse().slice(0, -1), ...path]
  }
  return path
}
