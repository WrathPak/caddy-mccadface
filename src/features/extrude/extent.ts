/**
 * Extrude extents: where an extrude begins (Start: Profile Plane / Offset / From Object) and where it ends (Extent: Distance /
 * To Object / All). Everything is worked out here into two signed distances along the profile's outward normal, which the worker's
 * `extrudeTool` takes as `span` (plus a `trim` plane for a To Object end that is not parallel to the profile).
 */
import { RefReport, decodeRef, faceSigs, vertexSigs, resolveFace, resolveVertex } from '@/doc/refs'
import { isPlanarFace } from '@/sketch/create'
import type { Body, Vec3 } from '@/kernel/types'
import { bbox } from '@/kernel/types'
import { bodyIdsOf } from '@/doc/refs'
import { resolvePlane, resolvePoint, type RefEnv } from '../modeling-tools/geo'
import type { Inputs } from '../modeling'
import type { Seg, Vec2 } from '@/sketch/types'
import { toWorld } from '@/sketch/plane'

export interface ExtentP {
  direction: string
  distance: number
  distance2: number
  extent: string
  toObject: string[]
  toOffset: number
  /** the second side of Two sides has its own extent */
  extent2: string
  toObject2: string[]
  toOffset2: number
  start: string
  startOffset: number
  startObject: string[]
  flip: boolean
  operation: string
  targets: string[]
}

export interface PlaneTrim { origin: Vec3; normal: Vec3 }
/** An end at a curved face: the extrude runs past it and the worker cuts it off at the face. */
export interface FaceTrim { face: { key: string; index: number }; grow: number; keep: Vec3[] }
export interface Span {
  from: number
  to: number
  /** slanted ends: cut away everything beyond these planes */
  trim?: PlaneTrim[]
  /** ends at a curved face */
  faces?: FaceTrim[]
  /** where the extrude starts, as a distance from the profile plane */
  start: number
  /** which way the far end lies along the profile normal (+1 / -1) */
  dir: 1 | -1
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const madd = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const sgn = (x: number): 1 | -1 => (x < 0 ? -1 : 1)

/** True when the Distance extent from the profile plane is all there is (the plain, older way). */
export const isPlainExtent = (p: Pick<ExtentP, 'extent' | 'start' | 'direction' | 'extent2'>) =>
  (p.extent ?? 'dist') === 'dist' && (p.start ?? 'profile') === 'profile' && (p.direction !== 'two' || (p.extent2 ?? 'dist') === 'dist')

/** Where the corners of a profile loop reach, in world space (used to find where a slanted end plane meets the extrude). */
function loopPoints(l: Seg[]): Vec2[] {
  return l.flatMap((s): Vec2[] => (s.k === 'c' ? [[s.c[0] + s.r, s.c[1]], [s.c[0] - s.r, s.c[1]], [s.c[0], s.c[1] + s.r], [s.c[0], s.c[1] - s.r]] : s.k === 'l' ? [s.a, s.b] : s.k === 'a' ? [s.a, s.m, s.b] : s.k === 'b' ? [s.a, s.c1, s.c2, s.b] : []))
}

/** World points on the profile plane that the extrude covers (profile outlines, or the vertices of the picked faces). */
function profileWorld(inp: Inputs, bodies: Body[]): Vec3[] {
  const out: Vec3[] = []
  for (const g of inp.groups) for (const pr of g.profiles) for (const q of loopPoints(pr.outer)) out.push(toWorld(g.plane, q))
  for (const f of inp.faces) {
    const body = bodies.find((b) => b.key === f.key)
    if (!body) continue
    const { positions: p, indices, faceIds } = body.mesh
    const seen = new Set<number>()
    for (let t = 0; t < faceIds.length; t++) {
      if (faceIds[t] !== f.index) continue
      for (let k = 0; k < 3; k++) {
        const vi = indices[t * 3 + k]
        if (seen.has(vi)) continue
        seen.add(vi)
        out.push([p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]])
      }
    }
  }
  return out
}

/** The solid bodies a through-all extrude has to get through: the named targets, else every solid. */
function reachBodies(bodies: Body[], targets: string[]): Body[] {
  const solid = bodies.filter((b) => !b.surface && b.mesh.indices.length)
  const ids = bodyIdsOf(targets)
  return ids.length ? solid.filter((b) => ids.includes(b.id)) : solid
}

/** Extent of the bodies along the normal, relative to the profile plane through `a`: [lowest, highest]. */
function reach(list: Body[], a: Vec3, n: Vec3): [number, number] | null {
  let lo = Infinity, hi = -Infinity
  for (const b of list) {
    const bb = bbox(b.mesh.positions)
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [i & 1 ? bb.max[0] : bb.min[0], i & 2 ? bb.max[1] : bb.min[1], i & 4 ? bb.max[2] : bb.min[2]]
      const t = dot(sub(c, a), n)
      lo = Math.min(lo, t); hi = Math.max(hi, t)
    }
  }
  return lo <= hi ? [lo, hi] : null
}

interface ObjPlane { origin: Vec3; normal: Vec3; /** a curved face: where it is (its vertices) and which one */ curved?: { key: string; index: number; points: Vec3[]; /** which way the face looks out of its body, on average */ outward: Vec3 } }

/** A face, plane or vertex as a plane (a vertex is the plane through it parallel to the profile). */
async function objectPlane(ref: string, n: Vec3, env: RefEnv, report: RefReport): Promise<ObjPlane> {
  const r = ref.startsWith('{') ? decodeRef(ref) : null
  if (r?.kind === 'vertex') {
    const hit = resolveVertex(r, env.bodies, report)
    if (!hit) throw new Error('The vertex no longer exists. Pick it again.')
    return { origin: vertexSigs(hit.body)[hit.index].pos, normal: n }
  }
  if (ref.startsWith('pt:')) return { origin: await resolvePoint(ref, env, report), normal: n }
  if (r?.kind === 'face') {
    const hit = resolveFace(r, env.bodies, report)
    if (hit && !isPlanarFace(hit.body, hit.index)) {
      const { positions: pos, indices, faceIds } = hit.body.mesh
      const seen = new Set<number>(), points: Vec3[] = []
      for (let t = 0; t < faceIds.length; t++) {
        if (faceIds[t] !== hit.index) continue
        for (let k = 0; k < 3; k++) { const vi = indices[t * 3 + k]; if (!seen.has(vi)) { seen.add(vi); points.push([pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]]) } }
      }
      return { origin: points[0] ?? [0, 0, 0], normal: n, curved: { key: hit.body.key, index: hit.index, points, outward: faceSigs(hit.body)[hit.index].normal } }
    }
  }
  const pl = await resolvePlane(ref, env, report)
  return { origin: pl.origin, normal: pl.normal }
}

/** What one side of the extrude is told: its extent type and the things that go with it. */
interface SideSpec { extent: string; obj: string | undefined; off: number; dist: number }

/** Where one side ends: the distance along the normal from the profile plane, which way it went, and what has to be cut off there. */
interface End { end: number; dir: 1 | -1; trim?: PlaneTrim; face?: FaceTrim }

/**
 * Work out the extent of an extrude. `null` when it is the plain Distance from the profile plane (the worker then uses mode / d1 / d2).
 * Throws an Error with a plain message when the extent cannot be made (nothing to go through, an object behind the profile, ...).
 */
export async function resolveSpan(p: ExtentP, inp: Inputs, env: RefEnv, report: RefReport): Promise<Span | null> {
  if (isPlainExtent(p)) return null
  if (!inp.anchor || !inp.normal) throw new Error('Select a profile or face to extrude')
  const a = inp.anchor, n = inp.normal
  const mode = p.direction

  // Start
  let s = 0
  if ((p.start ?? 'profile') === 'offset') s = Number(p.startOffset) || 0
  else if (p.start === 'object') {
    const ref = p.startObject?.[0]
    if (!ref) throw new Error('Pick the face or plane the extrude starts from')
    const o = await objectPlane(ref, n, env, report)
    if (o.curved || Math.abs(dot(o.normal, n)) < 1 - 1e-6) throw new Error('The start face or plane must be flat and parallel to the profile')
    s = dot(sub(o.origin, a), n)
  }

  const world = profileWorld(inp, env.bodies)
  const keepFor = (dir: 1 | -1): Vec3[] => {
    const c = madd(a, n, s + 0.01 * dir)
    return [c, ...world.map((q): Vec3 => { const t = madd(q, n, 0); const f = [c[0] + (t[0] - a[0]) * 0.85, c[1] + (t[1] - a[1]) * 0.85, c[2] + (t[2] - a[2]) * 0.85] as Vec3; const d = dot(sub(f, c), n); return madd(f, n, -d) })]
  }

  /** The end of one side. `want`: the direction it has to go (the second of Two sides goes against the first). */
  const endOf = async (side: SideSpec, want: 1 | -1 | undefined, signedDist = false): Promise<End> => {
    if (side.extent === 'all') {
      const r = reach(reachBodies(env.bodies, p.targets ?? []), a, n)
      if (!r) throw new Error('Extent All needs a body to go through')
      const m = p.operation === 'cut' ? 1 : 0 // a cut goes a little past the far side so no skin is left
      const up = r[1] - s > 1e-6, down = s - r[0] > 1e-6
      // Two sides: the first side goes where the material is; a side with nothing to go through just stays at the start
      const dir = want ?? (mode === 'two' ? (up || !down ? 1 : -1) : p.flip ? -1 : 1)
      if (dir > 0 ? !up : !down) {
        if (mode === 'two') return { end: s, dir }
        throw new Error('There is nothing to go through in that direction. Flip the direction.')
      }
      return { end: dir > 0 ? Math.max(r[1], s) + m : Math.min(r[0], s) - m, dir }
    }
    if (side.extent === 'object') {
      const ref = side.obj
      if (!ref) throw new Error('Pick the face, plane or vertex to extrude to')
      const o = await objectPlane(ref, n, env, report)
      const off = Number(side.off) || 0
      if (o.curved) {
        // a curved face (cylinder or sphere): extrude past it, then cut at the face. The direction is the way its middle lies.
        const f = o.curved
        const ts = f.points.map((q) => dot(sub(q, a), n))
        const mid = ts.reduce((x, y) => x + y, 0) / ts.length - s
        const dir = want ?? sgn(mid)
        const far = dir > 0 ? Math.max(...ts) : Math.min(...ts)
        if (dir * (far - s) < 1e-6) throw new Error('That face is behind the start of the extrude')
        // the Object offset is past the face (positive) or short of it (negative), whichever way the face looks: when the extrude runs along its
        // outward normal (leaving the body) past is outwards, when it runs into the body past is inwards
        const into = dot(f.outward, n) * dir < 0
        return { end: far + dir * (Math.abs(off) + 1), dir, face: { face: { key: f.key, index: f.index }, grow: into ? -off : off, keep: keepFor(dir) } }
      }
      const m = o.normal
      const denom = dot(n, m)
      if (Math.abs(denom) < 1e-6) throw new Error('That object is parallel to the extrude direction, so the extrude never reaches it')
      const reachAlong = (origin: Vec3, q: Vec3) => dot(sub(origin, q), m) / denom
      const at = reachAlong(o.origin, madd(a, n, s))
      if (Math.abs(at) < 1e-9) throw new Error('The object is on the plane the extrude starts from')
      const dir = want ?? sgn(at)
      if (dir !== sgn(at)) throw new Error('The object is behind the start of the extrude')
      const beyond: Vec3 = madd([0, 0, 0], m, sgn(dir * denom))
      const origin = madd(o.origin, beyond, off)
      let end: number
      let trim: PlaneTrim | undefined
      if (Math.abs(denom) > 1 - 1e-6) end = dot(sub(origin, a), n)
      else {
        // slanted end: extrude to the furthest the plane gets over the profile, then cut the excess off at the plane
        const ts = (world.length ? world : [a]).map((q) => reachAlong(origin, q))
        end = dir > 0 ? Math.max(...ts) : Math.min(...ts)
        trim = { origin, normal: beyond }
      }
      if (dir * (end - s) < 1e-6) throw new Error('The object is behind the start of the extrude')
      return { end, dir, trim }
    }
    const d = signedDist ? side.dist : Math.abs(side.dist)
    const dir = want ?? (d < 0 ? -1 : 1)
    return { end: s + dir * Math.abs(d), dir }
  }
  const spec1: SideSpec = { extent: p.extent ?? 'dist', obj: p.toObject?.[0], off: p.toOffset, dist: p.distance }
  const spec2: SideSpec = { extent: p.extent2 ?? 'dist', obj: p.toObject2?.[0], off: p.toOffset2, dist: p.distance2 }
  const done = (ends: End[], dir: 1 | -1): Span => {
    const all = [s, ...ends.map((e) => e.end)]
    return {
      from: Math.min(...all), to: Math.max(...all), start: s, dir,
      ...(ends.some((e) => e.trim) ? { trim: ends.flatMap((e) => (e.trim ? [e.trim] : [])) } : {}),
      ...(ends.some((e) => e.face) ? { faces: ends.flatMap((e) => (e.face ? [e.face] : [])) } : {}),
    }
  }

  if (mode === 'sym') {
    // both ways by the same amount: a distance is the whole length, an object or All sets the reach of one half
    if (spec1.extent === 'dist') return { from: s - Math.abs(p.distance) / 2, to: s + Math.abs(p.distance) / 2, start: s, dir: 1 }
    if (spec1.extent === 'all') {
      const r = reach(reachBodies(env.bodies, p.targets ?? []), a, n)
      if (!r) throw new Error('Extent All needs a body to go through')
      const m = p.operation === 'cut' ? 1 : 0
      if (!(r[1] - s > 1e-6 || s - r[0] > 1e-6)) throw new Error('There is nothing to go through in that direction. Flip the direction.')
      return { from: Math.min(r[0], s) - m, to: Math.max(r[1], s) + m, start: s, dir: 1 }
    }
    const e = await endOf(spec1, undefined)
    const h = Math.abs(e.end - s)
    return { from: s - h, to: s + h, start: s, dir: e.dir, ...(e.face ? { faces: [e.face] } : {}) }
  }
  if (mode === 'two') {
    const e1 = await endOf(spec1, undefined)
    const e2 = await endOf(spec2, (e1.dir === 1 ? -1 : 1) as 1 | -1)
    return done([e1, e2], e1.dir)
  }
  const e = await endOf(spec1, undefined, true)
  return done([e], e.dir)
}
