/**
 * Face / edge references that survive regeneration: body id + the producing feature id + a geometric signature.
 * Stored in selection-ref params as strings: a plain body id, or JSON for face/edge refs (see encodeRef).
 */
import { computeEdgeSigs, computeFaceSigs, type Body, type EdgeSig, type FaceSig, type Vec3 } from '@/kernel/types'
import type { SelectionRef } from '@/store/ui'

export interface FaceRef { kind: 'face'; bodyId: string; featureId?: string; index: number; sig: FaceSig }
export interface EdgeRef { kind: 'edge'; bodyId: string; featureId?: string; index: number; sig: EdgeSig }
export interface BodyRef { kind: 'body'; bodyId: string }
export type GeoRef = FaceRef | EdgeRef | BodyRef

// signature cache per body mesh
const faceCache = new WeakMap<Body['mesh'], FaceSig[]>()
const edgeCache = new WeakMap<Body['mesh'], EdgeSig[]>()
export const faceSigs = (b: Body) => {
  let s = faceCache.get(b.mesh)
  if (!s) faceCache.set(b.mesh, (s = computeFaceSigs(b.mesh)))
  return s
}
export const edgeSigs = (b: Body) => {
  let s = edgeCache.get(b.mesh)
  if (!s) edgeCache.set(b.mesh, (s = computeEdgeSigs(b.mesh)))
  return s
}

/** Build a ref from a viewport selection ref (kind face/edge/body) against the current bodies. */
export function refFromSelection(sel: SelectionRef, bodies: Body[]): GeoRef | null {
  const b = bodies.find((x) => x.id === sel.id)
  if (!b) return null
  if (sel.kind === 'body' || sel.kind === 'mesh') return { kind: 'body', bodyId: b.id }
  if (sel.kind === 'face' && sel.index !== undefined) {
    const sig = faceSigs(b)[sel.index]
    return sig ? { kind: 'face', bodyId: b.id, featureId: b.featureId, index: sel.index, sig } : null
  }
  if (sel.kind === 'edge' && sel.index !== undefined) {
    const sig = edgeSigs(b)[sel.index]
    return sig ? { kind: 'edge', bodyId: b.id, featureId: b.featureId, index: sel.index, sig } : null
  }
  return null
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function findBody(ref: GeoRef, bodies: Body[]) {
  return bodies.find((b) => b.id === ref.bodyId) ?? ('featureId' in ref && ref.featureId ? bodies.find((b) => b.featureId === ref.featureId) : undefined)
}

/** Re-find the face index a FaceRef points at in the regenerated body (best signature match), or null. */
export function resolveFace(ref: FaceRef, bodies: Body[]): { body: Body; index: number } | null {
  const body = findBody(ref, bodies)
  if (!body) return null
  const sigs = faceSigs(body)
  const scale = Math.max(1e-6, Math.sqrt(ref.sig.area))
  let best = -1, bestScore = Infinity
  sigs.forEach((s, i) => {
    const n = 1 - dot(s.normal, ref.sig.normal) // 0 when equal
    const c = dist(s.centroid, ref.sig.centroid) / scale
    const a = Math.abs(s.area - ref.sig.area) / Math.max(ref.sig.area, 1e-6)
    const score = n * 4 + c + a * 0.5
    if (score < bestScore) { bestScore = score; best = i }
  })
  return best >= 0 && bestScore < 3 ? { body, index: best } : null
}

export function resolveEdge(ref: EdgeRef, bodies: Body[]): { body: Body; index: number } | null {
  const body = findBody(ref, bodies)
  if (!body) return null
  const sigs = edgeSigs(body)
  const scale = Math.max(1e-6, ref.sig.length)
  let best = -1, bestScore = Infinity
  sigs.forEach((s, i) => {
    const score = dist(s.midpoint, ref.sig.midpoint) / scale + (1 - Math.abs(dot(s.direction, ref.sig.direction))) * 2 + Math.abs(s.length - ref.sig.length) / scale
    if (score < bestScore) { bestScore = score; best = i }
  })
  return best >= 0 && bestScore < 1.5 ? { body, index: best } : null
}

export const encodeRef = (r: GeoRef): string => (r.kind === 'body' ? r.bodyId : JSON.stringify(r))
export function decodeRef(s: string): GeoRef | null {
  if (s.startsWith('{')) {
    try { return JSON.parse(s) as GeoRef } catch { return null }
  }
  if (s.includes(':')) return null // legacy "id:index" strings carry no signature
  return { kind: 'body', bodyId: s }
}

/** Encode viewport selections for a selection-ref param. */
export function encodeSelection(sel: SelectionRef[], bodies: Body[]): string[] {
  const out: string[] = []
  for (const s of sel) {
    const r = refFromSelection(s, bodies)
    out.push(r ? encodeRef(r) : s.id + (s.index !== undefined ? ':' + s.index : ''))
  }
  return out
}

/** Body ids referenced by selection-ref strings (body refs, or the body of a face/edge ref). */
export function bodyIdsOf(values: string[]): string[] {
  const ids = new Set<string>()
  for (const v of values) {
    const r = decodeRef(v)
    ids.add(r ? r.bodyId : v.split(':')[0])
  }
  return [...ids]
}
