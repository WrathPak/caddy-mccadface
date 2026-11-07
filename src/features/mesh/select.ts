/**
 * Selection on meshes: Brush (paint triangles), Grow and Shrink. They share the paint selection of the hair tools (features/hair/paint),
 * so the painted triangles show in the viewport and every region tool (Delete Faces, Erase And Fill, Move Face Group, Separate Face
 * Groups) picks them up when it opens.
 */
import { regionFromSelection, resolveRegionSet } from '@/features/hair/region'
import { commitSelection, loadSelection, setPaint, topoOf, useHairPaint } from '@/features/hair/paint'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'

/** Switch the paint brush on (or off again when it is already on). */
export function toggleBrush() {
  const p = useHairPaint.getState()
  if (p.visible && p.mode === 'brush') {
    // a dialog that owns the bar keeps it; a stand-alone brush goes away (the painted selection stays)
    setPaint(p.sink ? { mode: 'off' } : { visible: false, mode: 'off' })
    return
  }
  setPaint({ visible: true, mode: 'brush' })
}

/** The triangles that are selected now: the painted ones, else the faces picked in the viewport. */
function current(): { id: string; set: Set<number> } | null {
  const geometry = useDoc.getState().geometry
  const p = useHairPaint.getState()
  const body = geometry.find((b) => b.id === p.bodyId)
  if (body && body.kind === 'mesh' && p.sel.size) return { id: body.id, set: new Set(p.sel) }
  const faces = useUi.getState().selection.filter((r) => r.kind === 'face' && geometry.find((b) => b.id === r.id)?.kind === 'mesh')
  if (!faces.length) return null
  const rs = resolveRegionSet(regionFromSelection(faces, geometry), geometry)
  return rs && rs.kind === 'mesh' ? { id: rs.body.id, set: rs.set } : null
}

function apply(id: string, set: Set<number>) {
  loadSelection(id, 'mesh', set)
  // the picked faces are now painted triangles: leave the viewport selection so the two do not disagree
  if (useUi.getState().selection.length) useUi.getState().clearSelection()
  commitSelection(useDoc.getState().geometry)
}

/** Add the ring of triangles around the selection. */
export function growSelection() {
  const c = current()
  if (!c) return toast('Select some faces first, or paint them with the Brush', 'error')
  const body = useDoc.getState().geometry.find((b) => b.id === c.id)!
  const t = topoOf(body)
  const next = new Set(c.set)
  for (const tri of c.set) for (let k = 0; k < 3; k++) { const n = t.adj[tri * 3 + k]; if (n >= 0) next.add(n) }
  apply(c.id, next)
}

/** Take the outer ring of triangles off the selection (a triangle with a neighbour outside it, or on an open edge, goes). */
export function shrinkSelection() {
  const c = current()
  if (!c) return toast('Select some faces first, or paint them with the Brush', 'error')
  const body = useDoc.getState().geometry.find((b) => b.id === c.id)!
  const t = topoOf(body)
  const next = new Set<number>()
  for (const tri of c.set) {
    let inner = true
    for (let k = 0; k < 3; k++) { const n = t.adj[tri * 3 + k]; if (n < 0 || !c.set.has(n)) { inner = false; break } }
    if (inner) next.add(tri)
  }
  apply(c.id, next)
}
