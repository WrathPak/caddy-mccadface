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
export interface FaceRef { kind: 'face'; bodyId: string; featureId?: string; index: number; sig: FaceSig; name?: string; path?: string }
export interface EdgeRef { kind: 'edge'; bodyId: string; featureId?: string; index: number; sig: EdgeSig; name?: string; path?: string }
export interface VertexSig { pos: Vec3 }
/** Vertices are named from the faces that meet there (kernel/naming.ts); no feature picks them yet, but refs to them are stable. */
export interface VertexRef { kind: 'vertex'; bodyId: string; featureId?: string; index: number; sig: VertexSig; name?: string; path?: string }
export interface BodyRef { kind: 'body'; bodyId: string }
/** A joint origin snap point: the spec says which point of which face / edge / vertex (see assembly/snaps.ts). */
export interface SnapRef { kind: 'snap'; bodyId: string; path?: string; spec: { kind: string; ref: string } }
export type GeoRef = FaceRef | EdgeRef | VertexRef | BodyRef | SnapRef

/**
 * `path` on a face / edge / vertex ref is the component path of the occurrence it was picked in (occurrence ids from the top
 * down, joined by '/'; absent in the root). The geometry is shared by every instance of a component, so the path does not change
 * how the ref resolves; it keeps the persistent name of the pick unique and stable per instance (see assembly/snaps.ts persistentName).
 */

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

const vertexCache = new WeakMap<Body['mesh'], VertexSig[]>()
export const vertexSigs = (b: Body): VertexSig[] => {
  let s = vertexCache.get(b.mesh)
  if (!s) {
    const p = b.mesh.vertexPos ?? new Float32Array(0)
    s = Array.from({ length: p.length / 3 }, (_, i) => ({ pos: [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]] as Vec3 }))
    vertexCache.set(b.mesh, s)
  }
  return s
}

/**
 * Names of the segmented faces of a mesh body. A segment is keyed by what it IS (its quantized normal and centroid), not by
 * its position in the segment list, so re-importing the mesh or reshuffling its triangles gives the same names; two
 * segments with the same key get `~k` in index order. A changed split angle changes the segments themselves: those refs
 * are re-bound by signature (with a warning).
 */
const meshNameCache = new WeakMap<Body['mesh'], string[][]>()
export function meshFaceNames(b: Body): string[][] {
  let n = meshNameCache.get(b.mesh)
  if (!n) {
    const root = b.featureId ?? b.id
    const keys = faceSigs(b).map((s) => `${root}:seg:${s.normal.map((x) => Math.round(x * 8)).join(',')}:${s.centroid.map((x) => Math.round(x / 0.5)).join(',')}`)
    const count = new Map<string, number>()
    keys.forEach((k) => count.set(k, (count.get(k) ?? 0) + 1))
    const seen = new Map<string, number>()
    n = keys.map((k) => {
      if (count.get(k)! < 2) return [k]
      const j = seen.get(k) ?? 0
      seen.set(k, j + 1)
      return [`${k}~${j}`, k]
    })
    meshNameCache.set(b.mesh, n)
  }
  return n
}

/** Name table of a body for one kind of sub-shape (B-rep tables come from the kernel, mesh faces are derived here). */
function nameTable(b: Body, kind: 'face' | 'edge' | 'vertex'): string[][] | undefined {
  if (kind === 'face') return b.mesh.faceNames ?? (b.kind === 'mesh' ? meshFaceNames(b) : undefined)
  return kind === 'edge' ? b.mesh.edgeNames : b.mesh.vertexNames
}

/** Persistent name of face / edge / vertex `index` of a body. */
export function nameOf(b: Body, kind: 'face' | 'edge' | 'vertex', index: number): string | undefined {
  return nameTable(b, kind)?.[index]?.[0]
}

/** A ref to vertex `index` of a body. */
export function vertexRef(b: Body, index: number): VertexRef | null {
  const sig = vertexSigs(b)[index]
  return sig ? { kind: 'vertex', bodyId: b.id, featureId: b.featureId, index, sig, name: nameOf(b, 'vertex', index) } : null
}

/** Build a ref from a viewport selection ref (kind face/edge/body) against the current bodies. */
export function refFromSelection(sel: SelectionRef, bodies: Body[]): GeoRef | null {
  const b = bodies.find((x) => x.id === sel.id)
  if (!b) return null
  if (sel.kind === 'body' || sel.kind === 'mesh') return { kind: 'body', bodyId: b.id }
  if (sel.kind === 'face' && sel.index !== undefined) {
    const sig = faceSigs(b)[sel.index]
    return sig ? { kind: 'face', bodyId: b.id, featureId: b.featureId, index: sel.index, sig, name: nameOf(b, 'face', sel.index), ...(sel.path ? { path: sel.path } : {}) } : null
  }
  if (sel.kind === 'snap' && sel.snap) return { kind: 'snap', bodyId: b.id, path: sel.path || undefined, spec: sel.snap }
  if (sel.kind === 'vertex' && sel.index !== undefined) return { ...vertexRef(b, sel.index)!, ...(sel.path ? { path: sel.path } : {}) }
  if (sel.kind === 'edge' && sel.index !== undefined) {
    const sig = edgeSigs(b)[sel.index]
    return sig ? { kind: 'edge', bodyId: b.id, featureId: b.featureId, index: sel.index, sig, name: nameOf(b, 'edge', sel.index), ...(sel.path ? { path: sel.path } : {}) } : null
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
  /** legacy (name-less) refs that resolved: stored ref -> the same ref with its name, for the engine to write back */
  readonly upgrades = new Map<string, string>()
  get upgradeMap(): Record<string, string> | undefined { return this.upgrades.size ? Object.fromEntries(this.upgrades) : undefined }
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
const vertexScore = (s: VertexSig, r: VertexSig) => dist(s.pos, r.pos)
const edgeScore = (s: EdgeSig, r: EdgeSig) => {
  const scale = Math.max(1e-6, r.length)
  return dist(s.midpoint, r.midpoint) / scale + (1 - Math.abs(dot(s.direction, r.direction))) * 2 + Math.abs(s.length - r.length) / scale
}
// a legacy (name-less) ref only has its signature to go on, so it is matched generously; once a name was lost, only a close match counts
const FACE_LEGACY = 3, EDGE_LEGACY = 1.5, FACE_REBIND = 1.2, EDGE_REBIND = 0.75, MESH_KEEP = 1.2, VERTEX_LIMIT = 2

const withName = (names: string[][] | undefined, name: string) => {
  const out: number[] = []
  names?.forEach((n, i) => { if (n.includes(name)) out.push(i) })
  return out
}

function resolveGeneric<S>(
  kind: 'face' | 'edge' | 'vertex', ref: { name?: string; sig: S; bodyId: string; featureId?: string; index?: number }, encoded: string, body: Body | undefined,
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
    if (i < 0) return lose(`The ${kind} no longer exists`)
    // upgrade: remember the name it has now, the engine writes it back into the feature
    const name = nameOf(body, kind, i)
    if (name) report?.upgrades.set(encoded, JSON.stringify({ ...ref, name, index: i }))
    return { body, index: i }
  }
  const names = nameTable(body, kind)
  const cands = withName(names, ref.name)
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

export function resolveVertex(ref: VertexRef, bodies: Body[], report?: RefReport): Resolved | null {
  return resolveGeneric('vertex', ref, encodeRef(ref), findBody(ref, bodies), vertexSigs, vertexScore, VERTEX_LIMIT, VERTEX_LIMIT, report)
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
