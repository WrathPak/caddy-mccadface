/** Starting a sketch: pick an origin plane (Browser or viewport) or a planar face. */
import { create } from 'zustand'
import { encodeRef, refFromSelection } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { useUi, type SelectionRef } from '@/store/ui'
import type { Body } from '@/kernel/types'
import { originPlane, planeFromNormal, type OriginPlaneName } from './plane'
import { beginSketch, flash } from './store'

/** True when every triangle of face `index` has (nearly) the same normal. */
export function isPlanarFace(b: Body, index: number): boolean {
  const { positions: p, indices, faceIds } = b.mesh
  let n: [number, number, number] | null = null
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== index) continue
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3
    const ux = p[i1] - p[i0], uy = p[i1 + 1] - p[i0 + 1], uz = p[i1 + 2] - p[i0 + 2]
    const vx = p[i2] - p[i0], vy = p[i2 + 1] - p[i0 + 1], vz = p[i2 + 2] - p[i0 + 2]
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    const l = Math.hypot(cx, cy, cz)
    if (l < 1e-12) continue
    const c: [number, number, number] = [cx / l, cy / l, cz / l]
    if (!n) n = c
    else if (n[0] * c[0] + n[1] * c[1] + n[2] * c[2] < 0.9995) return false
  }
  return n !== null
}

function planeNameOf(id: string): OriginPlaneName | null {
  const n = id.replace('plane', '')
  return n === 'XY' || n === 'XZ' || n === 'YZ' ? n : null
}

/** Begin a sketch from a plane / face selection. Returns true if it started. */
export function beginFromSelection(sel: SelectionRef): boolean {
  if (sel.kind === 'plane') {
    const name = planeNameOf(sel.id)
    if (!name) return false
    void beginSketch({ plane: originPlane(name) })
    return true
  }
  if (sel.kind === 'face') {
    const bodies = useDoc.getState().geometry
    const ref = refFromSelection(sel, bodies)
    const body = bodies.find((b) => b.id === sel.id)
    if (!ref || ref.kind !== 'face' || !body) return false
    if (!isPlanarFace(body, ref.index)) { flash('Select a planar face'); return false }
    void beginSketch({ plane: planeFromNormal(ref.sig.centroid, ref.sig.normal), face: encodeRef(ref) })
    return true
  }
  return false
}

export const useSketchPick = create<{ picking: boolean }>(() => ({ picking: false }))
let unsub: (() => void) | null = null

export function stopPicking() {
  unsub?.()
  unsub = null
  useSketchPick.setState({ picking: false })
}

/** Ribbon "Create Sketch": use the current plane / face selection, else wait for a pick. */
export function startSketchCommand() {
  const ui = useUi.getState()
  for (const s of ui.selection) {
    if (beginFromSelection(s)) { stopPicking(); return }
  }
  ui.setSelectionFilter('face')
  ui.setActiveTool('sketch.create')
  useSketchPick.setState({ picking: true })
  unsub?.()
  unsub = useUi.subscribe((st, prev) => {
    if (st.activeTool !== 'sketch.create') { stopPicking(); return }
    if (st.selection === prev.selection) return
    for (const s of st.selection) {
      if (beginFromSelection(s)) { stopPicking(); return }
    }
  })
}
