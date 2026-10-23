/** Hair surface selection: compact encoding (mesh triangles / B-rep faces) and sub-mesh extraction. */
import { decodeRef, encodeRef, faceSigs, resolveFace, type FaceRef } from '@/doc/refs'
import type { Body } from '@/kernel/types'

const PREFIX = 'tri:'

/** Run-length encoded triangle set as base64 Uint32 pairs [start, length]. */
export function encodeTris(bodyId: string, tris: Iterable<number>): string {
  const sorted = [...tris].sort((a, b) => a - b)
  const runs: number[] = []
  for (const t of sorted) {
    const n = runs.length
    if (n && runs[n - 2] + runs[n - 1] === t) runs[n - 1]++
    else runs.push(t, 1)
  }
  const bytes = new Uint8Array(new Uint32Array(runs).buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return `${PREFIX}${bodyId}:${btoa(bin)}`
}

export function decodeTris(s: string): { bodyId: string; tris: number[] } | null {
  if (!s.startsWith(PREFIX)) return null
  const cut = s.indexOf(':', PREFIX.length)
  if (cut < 0) return null
  try {
    const bin = atob(s.slice(cut + 1))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const runs = new Uint32Array(bytes.buffer)
    const tris: number[] = []
    for (let i = 0; i + 1 < runs.length; i += 2) for (let k = 0; k < runs[i + 1]; k++) tris.push(runs[i] + k)
    return { bodyId: s.slice(PREFIX.length, cut), tris }
  } catch {
    return null
  }
}

/** Face refs (re-resolved by signature after regeneration) for face ids of a B-rep or a face-segmented mesh body. */
function faceRefs(body: Body, ids: Iterable<number>): string[] {
  const sigs = faceSigs(body)
  return [...ids].sort((a, b) => a - b).filter((i) => sigs[i]).map((i) => encodeRef({ kind: 'face', bodyId: body.id, featureId: body.featureId, index: i, sig: sigs[i] }))
}

/** Triangles of the given faces of a mesh body. */
function trisOfFaces(body: Body, faces: Set<number>): Set<number> {
  const out = new Set<number>()
  const ids = body.mesh.faceIds
  for (let t = 0; t < ids.length; t++) if (faces.has(ids[t])) out.add(t)
  return out
}

/** Region param strings for a selection set on a body (mesh: one RLE token of triangles, B-rep: face refs). */
export function encodeRegion(body: Body, sel: Set<number>): string[] {
  if (!sel.size) return []
  if (body.kind === 'mesh') return [encodeTris(body.id, sel)]
  return faceRefs(body, sel)
}

export interface RegionSet { body: Body; kind: 'mesh' | 'brep'; set: Set<number> }

/** Every triangle (mesh bodies) / every face id (B-reps) of a body. */
function wholeBody(body: Body): RegionSet {
  if (body.kind === 'mesh') return { body, kind: 'mesh', set: new Set(Array.from({ length: body.mesh.indices.length / 3 }, (_, i) => i)) }
  return { body, kind: 'brep', set: new Set(body.mesh.faceIds) }
}

/**
 * Resolve region param strings against the current bodies. Accepts paint-tool tokens (mesh triangle runs), B-rep face refs,
 * and what the Inspector's "Use sel." produces: face refs / whole-body ids. Mesh bodies are segmented into faces on import
 * (see meshDisplay), so a face ref on a mesh body selects the triangles of that face; a body id selects the whole mesh.
 */
export function resolveRegionSet(region: string[], bodies: Body[]): RegionSet | null {
  if (!region.length) return null
  const t = decodeTris(region[0])
  if (t) {
    const body = bodies.find((b) => b.id === t.bodyId)
    return body ? { body, kind: 'mesh', set: new Set(t.tris) } : null
  }
  let body: Body | null = null
  const set = new Set<number>()
  let whole: Body | null = null
  for (const r of region) {
    const ref = decodeRef(r)
    if (!ref) continue
    if (ref.kind === 'body') { whole ??= bodies.find((b) => b.id === ref.bodyId) ?? null; continue }
    if (ref.kind !== 'face') continue
    const res = resolveFace(ref as FaceRef, bodies)
    if (!res || (body && body.id !== res.body.id)) continue
    body = res.body
    set.add(res.index)
  }
  if (body?.kind === 'mesh') return { body, kind: 'mesh', set: trisOfFaces(body, set) }
  if (body) return { body, kind: 'brep', set }
  return whole ? wholeBody(whole) : null
}

/** Triangles of the region as a standalone (unwelded) triangle soup for the worker. */
export function extractRegion(rs: RegionSet): { positions: Float32Array; indices: Uint32Array } {
  const m = rs.body.mesh
  const tris: number[] = []
  if (rs.kind === 'mesh') {
    for (const t of rs.set) if (t * 3 < m.indices.length) tris.push(t)
  } else {
    for (let t = 0; t < m.faceIds.length; t++) if (rs.set.has(m.faceIds[t])) tris.push(t)
  }
  const positions = new Float32Array(tris.length * 9)
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const v = m.indices[t * 3 + k] * 3
      positions.set([m.positions[v], m.positions[v + 1], m.positions[v + 2]], i * 9 + k * 3)
    }
  })
  return { positions, indices: Uint32Array.from({ length: tris.length * 3 }, (_, i) => i) }
}

/** The body's triangles that are NOT in the region, as an unwelded triangle soup (the obstacle strands must stay out of). */
export function extractOthers(rs: RegionSet): { positions: Float32Array; indices: Uint32Array } {
  const m = rs.body.mesh
  const T = m.indices.length / 3
  const tris: number[] = []
  for (let t = 0; t < T; t++) {
    const inRegion = rs.kind === 'mesh' ? rs.set.has(t) : rs.set.has(m.faceIds[t])
    if (!inRegion) tris.push(t)
  }
  const positions = new Float32Array(tris.length * 9)
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const v = m.indices[t * 3 + k] * 3
      positions.set([m.positions[v], m.positions[v + 1], m.positions[v + 2]], i * 9 + k * 3)
    }
  })
  return { positions, indices: Uint32Array.from({ length: tris.length * 3 }, (_, i) => i) }
}

/** Region from the current viewport selection (face refs, or a whole mesh body). */
export function regionFromSelection(sel: { kind: string; id: string; index?: number }[], bodies: Body[]): string[] {
  const faces = sel.filter((r) => r.kind === 'face' && r.index !== undefined)
  const bodyRef = sel.find((r) => r.kind === 'mesh' || r.kind === 'body')
  const b = bodies.find((x) => x.id === (faces[0]?.id ?? bodyRef?.id))
  if (!b) return []
  const own = faces.filter((f) => f.id === b.id).map((f) => f.index!)
  if (b.kind === 'mesh') {
    if (own.length) return faceRefs(b, own)
    return [encodeTris(b.id, Array.from({ length: b.mesh.indices.length / 3 }, (_, i) => i))]
  }
  return faceRefs(b, own.length ? own : new Set(b.mesh.faceIds))
}
