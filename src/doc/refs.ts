/**
 * Face / edge references that survive regeneration: body id + persistent topological name + geometric signature.
 *
 * The name (kernel/naming.ts) is what normally finds the face again: it is composed down the operation history, so it
 * follows the logical face through upstream edits. The signature is the fallback (and tie-breaker between the pieces
 * of a split face); a ref that had to use it is reported through a RefReport so the feature can warn and the Inspector
 * can highlight it.
 *
 * `index` is the B-rep topology index: the mesh's `faceIds` / `edgeIds` ARE positions in the kernel's
 * `topoOf(shape).faces` / `.edges` (the tessellator maps each face / edge shape hash to that position, see
 * kernel/occ.ts), so an index from a pick can be handed to a worker op as is.
 * Stored in selection-ref params as strings: a plain body id, or JSON for face/edge refs (see encodeRef).
 */
import { computeEdgeSigs, computeFaceSigs, type Body, type EdgeSig, type FaceSig, type Vec3 } from '@/kernel/types'
import type { SelectionRef } from '@/store/ui'

/**
 * `name` is the persistent topological name of the face / edge (see kernel/naming.ts): the primary name from the body's
 * name table at the time of the pick. Resolution looks the name up first and only falls back to the geometric signature
 * when the name is gone. Refs from older documents carry no name; they resolve by signature alone, as before.
 */
export interface FaceRef { kind: 'face'; bodyId: string; featureId?: string; index: number; sig: FaceSig; name?: string }
export interface EdgeRef { kind: 'edge'; bodyId: string; featureId?: string; index: number; sig: EdgeSig; name?: string }
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

/** Persistent name of face / edge `index` of a body: from its name table, or (mesh bodies) `seg:<segmented face index>`. */
export function nameOf(b: Body, kind: 'face' | 'edge', index: number): string | undefined {
  const t = kind === 'face' ? b.mesh.faceNames : b.mesh.edgeNames
  if (t) return t[index]?.[0]
  return b.kind === 'mesh' && kind === 'face' ? `seg:${index}` : undefined
}

/** Build a ref from a viewport selection ref (kind face/edge/body) against the current bodies. */
export function refFromSelection(sel: SelectionRef, bodies: Body[]): GeoRef | null {
  const b = bodies.find((x) => x.id === sel.id)
  if (!b) return null
  if (sel.kind === 'body' || sel.kind === 'mesh') return { kind: 'body', bodyId: b.id }
  if (sel.kind === 'face' && sel.index !== undefined) {
    const sig = faceSigs(b)[sel.index]
    return sig ? { kind: 'face', bodyId: b.id, featureId: b.featureId, index: sel.index, sig, name: nameOf(b, 'face', sel.index) } : null
  }
  if (sel.kind === 'edge' && sel.index !== undefined) {
    const sig = edgeSigs(b)[sel.index]
    return sig ? { kind: 'edge', bodyId: b.id, featureId: b.featureId, index: sel.index, sig, name: nameOf(b, 'edge', sel.index) } : null
  }
  return null
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function findBody(ref: GeoRef, bodies: Body[]) {
  return bodies.find((b) => b.id === ref.bodyId) ?? ('featureId' in ref && ref.featureId ? bodies.find((b) => b.featureId === ref.featureId) : undefined)
}

/**
 * What a feature learned while resolving its refs: refs that were re-bound by position (the name was gone or ambiguous;
 * the feature shows a warning and the Inspector highlights them) and refs that could not be resolved at all. Keys are the
 * encoded refs exactly as stored in the feature params.
 */
export class RefReport {
  readonly rebound = new Map<string, string>()
  readonly lost = new Map<string, string>()
  /** warning text for a feature that still built (some refs re-bound, or skipped because they were lost) */
  get warning(): string | undefined {
    const parts: string[] = []
    const n = this.rebound.size, l = this.lost.size
    if (n) parts.push(n === 1 ? [...this.rebound.values()][0] : `${n} references were re-bound, check them`)
    if (l) parts.push(l === 1 ? 'A reference could not be found and was skipped' : `${l} references could not be found and were skipped`)
    return parts.length ? parts.join('; ') : undefined
  }
  /** every stored ref the Inspector should flag (re-bound or lost) */
  get flagged(): string[] | undefined { return this.rebound.size || this.lost.size ? [...this.rebound.keys(), ...this.lost.keys()] : undefined }
  get lostRefs(): string[] { return [...this.lost.keys()] }
}

/** A failed resolution that knows which stored refs are to blame (the Inspector highlights them). */
export class RefError extends Error {
  constructor(message: string, readonly refs: string[]) { super(message) }
}

export interface Resolved { body: Body; index: number }

const faceScore = (s: FaceSig, r: FaceSig) => {
  const scale = Math.max(1e-6, Math.sqrt(r.area))
  return (1 - dot(s.normal, r.normal)) * 4 + dist(s.centroid, r.centroid) / scale + (Math.abs(s.area - r.area) / Math.max(r.area, 1e-6)) * 0.5
}
const edgeScore = (s: EdgeSig, r: EdgeSig) => {
  const scale = Math.max(1e-6, r.length)
  return dist(s.midpoint, r.midpoint) / scale + (1 - Math.abs(dot(s.direction, r.direction))) * 2 + Math.abs(s.length - r.length) / scale
}
// a legacy (name-less) ref only has its signature to go on, so it is matched generously; once a name was lost, only a close match counts
const FACE_LEGACY = 3, EDGE_LEGACY = 1.5, FACE_REBIND = 1.2, EDGE_REBIND = 0.75, MESH_KEEP = 1.2

const withName = (names: string[][] | undefined, name: string) => {
  const out: number[] = []
  names?.forEach((n, i) => { if (n.includes(name)) out.push(i) })
  return out
}

function resolveGeneric<S>(
  kind: 'face' | 'edge', ref: { name?: string; sig: S; bodyId: string; featureId?: string }, encoded: string, body: Body | undefined,
  sigs: (b: Body) => S[], score: (s: S, r: S) => number, legacy: number, rebind: number, report?: RefReport,
): Resolved | null {
  const lose = (msg: string) => { report?.lost.set(encoded, msg); return null }
  if (!body) return lose(`The body this ${kind} belonged to no longer exists`)
  const all = sigs(body)
  const bySig = (limit: number, among?: number[]) => {
    let best = -1, bestScore = Infinity
    for (const i of among ?? all.keys()) {
      const sc = score(all[i], ref.sig)
      if (sc < bestScore - 1e-9) { bestScore = sc; best = i } // ties keep the first candidate
    }
    return best >= 0 && bestScore < limit ? best : -1
  }
  if (!ref.name) {
    const i = bySig(legacy)
    return i >= 0 ? { body, index: i } : lose(`The ${kind} no longer exists`)
  }
  const names = kind === 'face' ? body.mesh.faceNames : body.mesh.edgeNames
  let cands = withName(names, ref.name)
  if (!names && body.kind === 'mesh') {
    const m = /^seg:(\d+)$/.exec(ref.name)
    cands = m && all[+m[1]] ? [+m[1]] : []
  }
  if (cands.length === 1) {
    // mesh segments are re-cut when the mesh changes: only keep the index while the segment still looks like the picked one
    if (body.kind !== 'mesh' || score(all[cands[0]], ref.sig) < MESH_KEEP) return { body, index: cands[0] }
  } else if (cands.length > 1) {
    // equally good pieces (a symmetric split) are told apart by name, which is ordered by a geometric key: deterministic
    cands.sort((a, b) => (names![a][0] < names![b][0] ? -1 : 1))
    const i = bySig(Infinity, cands)
    report?.rebound.set(encoded, `A ${kind} you picked was split into ${cands.length} parts; the closest one is used, check it`)
    return { body, index: i }
  }
  const i = bySig(rebind)
  if (i >= 0) {
    report?.rebound.set(encoded, `A ${kind} reference was re-bound by position, check it`)
    return { body, index: i }
  }
  return lose(`The ${kind} no longer exists (the edit removed it)`)
}

/** Re-find the face a FaceRef points at in the regenerated body: by persistent name, else by signature (see RefReport), or null. */
export function resolveFace(ref: FaceRef, bodies: Body[], report?: RefReport): Resolved | null {
  return resolveGeneric('face', ref, encodeRef(ref), findBody(ref, bodies), faceSigs, faceScore, FACE_LEGACY, FACE_REBIND, report)
}

export function resolveEdge(ref: EdgeRef, bodies: Body[], report?: RefReport): Resolved | null {
  return resolveGeneric('edge', ref, encodeRef(ref), findBody(ref, bodies), edgeSigs, edgeScore, EDGE_LEGACY, EDGE_REBIND, report)
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
