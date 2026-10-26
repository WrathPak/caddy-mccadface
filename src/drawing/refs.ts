/** Persistent refs for dimension points: thin wrappers over doc/refs.ts. */
import { edgeSigs, nameOf, resolveEdge, resolveVertex, vertexRef, type EdgeRef, type Resolved, type VertexRef } from '@/doc/refs'
import type { Body } from '@/kernel/types'

export const vertexRefOf = (b: Body, index: number): VertexRef | null => vertexRef(b, index)

export function edgeRefOf(b: Body, index: number): EdgeRef | null {
  const sig = edgeSigs(b)[index]
  return sig ? { kind: 'edge', bodyId: b.id, featureId: b.featureId, index, sig, name: nameOf(b, 'edge', index) } : null
}

/** Re-find the vertex / edge a ref points at in the current bodies (by persistent name, else by position). */
export function resolveRef(ref: VertexRef | EdgeRef, bodies: Body[]): Resolved | null {
  return ref.kind === 'vertex' ? resolveVertex(ref, bodies) : resolveEdge(ref, bodies)
}
