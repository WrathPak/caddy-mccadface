import { Box3, Vector3 } from 'three'
import type { Body } from '@/kernel/types'
import type { SelectionRef } from '@/store/ui'
import { within, type Instance } from '@/assembly/instances'

/**
 * Bounding box of the selected faces / edges / bodies / components (null when the selection has no geometry).
 * With `instances` the box is where things are drawn: a body in a component is measured through the instance's placement.
 */
export function selectionBounds(sel: SelectionRef[], bodies: Body[], instances?: Instance[]): Box3 | null {
  const box = new Box3()
  const v = new Vector3()
  const place = (w: ArrayLike<number> | null, p: ArrayLike<number>, i: number) =>
    w ? v.set(w[0] * p[i] + w[4] * p[i + 1] + w[8] * p[i + 2] + w[12], w[1] * p[i] + w[5] * p[i + 1] + w[9] * p[i + 2] + w[13], w[2] * p[i] + w[6] * p[i + 1] + w[10] * p[i + 2] + w[14]) : v.set(p[i], p[i + 1], p[i + 2])
  const bodyOf = (b: Body, w: ArrayLike<number> | null, r: SelectionRef) => {
    const grow = (p: ArrayLike<number>, i: number) => box.expandByPoint(place(w, p, i))
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
    } else {
      for (let i = 0; i < m.positions.length; i += 3) grow(m.positions, i)
    }
  }
  for (const r of sel) {
    if (r.kind === 'component') {
      for (const i of instances ?? []) if (within(i.path, r.id)) bodyOf(i.body, i.world, { kind: 'body', id: i.body.id })
      continue
    }
    if (!['face', 'edge', 'body', 'mesh'].includes(r.kind)) continue
    const inst = instances?.find((i) => i.body.id === r.id && (r.path === undefined || i.occ === r.path))
    const b = inst?.body ?? bodies.find((x) => x.id === r.id)
    if (b) bodyOf(b, inst ? inst.world : null, r)
  }
  return box.isEmpty() ? null : box
}
