/** What the object toolbar does: every action writes the plate placement into the document (one undo step), never the CAD model. */
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import type { Body, Vec3 } from '@/kernel/types'
import { autoOrient } from '../orient'
import { currentSettings } from '../settings'
import { frameBed } from './frame'
import { arrangeAll, bedCentre, laidDown, settleEntries, type PlaceEntry, type PlateStore } from './model'
import { bedFor, commitPlacements, currentPlate, isAssembly, plateBodies, usePlate } from './store'

const round = (n: number) => +n.toFixed(3)

/** The bodies the toolbar acts on: the selected ones on the plate, or every body when nothing is selected. */
export function targetIds(allWhenNone = true): string[] {
  const ids = new Set(useDoc.getState().geometry.map((b) => b.id))
  const sel = [...new Set(useUi.getState().selection.map((r) => r.id))].filter((id) => ids.has(id))
  if (sel.length || !allWhenNone) return sel
  return plateBodies(useDoc.getState().geometry, useUi.getState().hiddenIds).map((b) => b.id)
}

export const selectedId = (): string | null => targetIds(false)[0] ?? null

async function plateNow() {
  const bed = await bedFor(currentSettings().profile)
  return currentPlate(bed)
}

/** Put a part's pose: any of x, y and the rotation. */
export async function setPose(id: string, pose: Partial<{ x: number; y: number; r: Vec3 }>, label = 'Move part') {
  if (isAssembly()) return
  const pl = await plateNow()
  const cur = pl.entries[id]
  if (!cur) return
  const e: PlaceEntry = { r: pose.r ?? cur.r, x: pose.x ?? cur.x, y: pose.y ?? cur.y }
  commitPlacements({ [id]: e }, label, pl.entries)
}

/** Lay a part on a face: the face's outward normal (model space) turns to face the bed, by the shortest turn. */
export async function layOnNormal(id: string, normal: Vec3) {
  if (isAssembly()) return
  const pl = await plateNow()
  const cur = pl.entries[id], body = pl.bodies.find((b) => b.id === id)
  if (!cur || !body) return
  const e = laidDown(body, cur, normal, pl.bed)
  commitPlacements(settleEntries(pl.bodies, { ...pl.entries, [id]: e }, [id], pl.bed), 'Lay on face', pl.entries)
}

/** Find the way up that needs the least support (the same ranking as the Auto Orient tool) and apply it to the placement. */
export async function autoOrientParts() {
  if (isAssembly()) return toast('Assemblies are laid out automatically when sliced', 'info')
  const ids = targetIds()
  const bodies = useDoc.getState().geometry.filter((b) => ids.includes(b.id))
  if (!bodies.length) return toast('There is nothing on the plate to orient', 'info')
  usePlate.setState({ busy: 'Finding the best way up' })
  // let the toolbar show the busy state before the (synchronous) ranking starts
  await new Promise((r) => setTimeout(r, 30))
  try {
    const pl = await plateNow()
    const angle = currentSettings().overhang
    const change: PlateStore = {}
    for (const b of bodies) {
      const res = autoOrient(b.mesh, { angle, goal: 'support' })
      const best = res.ranked[0]
      const cur = pl.entries[b.id]
      if (best && cur) change[b.id] = laidDown(b, cur, best.down, pl.bed)
    }
    // the new footprints may overlap their neighbours: with several parts the plate is laid out again, in the same undo step
    commitPlacements(pl.bodies.length > 1 ? arrangeAll(pl.bodies, { ...pl.entries, ...change }, pl.bed) : change, 'Auto orient', pl.entries)
  } finally {
    usePlate.setState({ busy: null })
  }
}

/** Arrange every part on the bed (rotations stay). */
export async function arrangeParts() {
  if (isAssembly()) return toast('Assemblies are laid out automatically when sliced', 'info')
  const pl = await plateNow()
  if (!pl.bodies.length) return
  commitPlacements(arrangeAll(pl.bodies, pl.entries, pl.bed), 'Arrange plate', pl.entries)
  frameBed(pl.bed)
}

/** Centre the selected part (or the whole group) on the bed. */
export async function centreParts() {
  if (isAssembly()) return
  const pl = await plateNow()
  const ids = targetIds()
  const mine = pl.list.filter((p) => ids.includes(p.id))
  if (!mine.length) return
  const [bx, by] = bedCentre(pl.bed)
  const lo = [Math.min(...mine.map((p) => p.lo[0])), Math.min(...mine.map((p) => p.lo[1]))]
  const hi = [Math.max(...mine.map((p) => p.hi[0])), Math.max(...mine.map((p) => p.hi[1]))]
  const dx = bx - (lo[0] + hi[0]) / 2, dy = by - (lo[1] + hi[1]) / 2
  const change: PlateStore = {}
  for (const p of mine) change[p.id] = { ...p.entry, x: round(p.entry.x + dx), y: round(p.entry.y + dy) }
  commitPlacements(change, 'Center on plate', pl.entries)
}

/** Back to the CAD orientation (rotation cleared), where the part stands now. */
export async function resetParts() {
  if (isAssembly()) return
  const pl = await plateNow()
  const ids = targetIds()
  const change: PlateStore = {}
  for (const p of pl.list) if (ids.includes(p.id)) change[p.id] = { ...p.entry, r: [0, 0, 0] }
  commitPlacements(change, 'Reset placement', pl.entries)
}
