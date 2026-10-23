import { Box3, Vector3 } from 'three'
import type { Body } from '@/kernel/types'
import type { SelectionRef } from '@/store/ui'

/** Bounding box of the selected faces / edges / bodies (null when the selection has no geometry). */
export function selectionBounds(sel: SelectionRef[], bodies: Body[]): Box3 | null {
  const box = new Box3()
  const v = new Vector3()
  const grow = (p: ArrayLike<number>, i: number) => box.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]))
  for (const r of sel) {
    const b = bodies.find((x) => x.id === r.id)
    if (!b) continue
    const m = b.mesh
    if (r.kind === 'face' && r.index !== undefined) {
      for (let t = 0; t < m.faceIds.length; t++) {
        if (m.faceIds[t] !== r.index) continue
        for (let k = 0; k < 3; k++) grow(m.positions, m.indices[t * 3 + k] * 3)
      }
    } else if (r.kind === 'edge' && r.index !== undefined) {
      const n = m.edges.length / 6
      for (let s = 0; s < n; s++) {
        if ((m.edgeIds ? m.edgeIds[s] : s) !== r.index) continue
        grow(m.edges, s * 6); grow(m.edges, s * 6 + 3)
      }
    } else if (r.kind === 'body' || r.kind === 'mesh') {
      for (let i = 0; i < m.positions.length; i += 3) grow(m.positions, i)
    }
  }
  return box.isEmpty() ? null : box
}
