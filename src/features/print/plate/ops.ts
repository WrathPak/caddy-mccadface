/** What the object toolbar does: every action writes the plate placement into the document (one undo step), never the CAD model. */
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import { eulerFromMatrix, rotationBetween } from '@/kernel/print-geom'
import type { Body, Vec3 } from '@/kernel/types'
import { autoOrient } from '../orient'
import { currentSettings } from '../settings'
import { frameBed } from './frame'
import { arrangeAll, bedCentre, type PlaceEntry, type PlateStore } from './model'
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

/** Turn a part so the model direction `down` faces the bed. */
const rotationFor = (down: Vec3): Vec3 => {
  const l = Math.hypot(down[0], down[1], down[2]) || 1
  const d: Vec3 = [down[0] / l, down[1] / l, down[2] / l]
  return eulerFromMatrix(rotationBetween(d, [0, 0, -1])).map(round) as Vec3
}

/** Area-weighted normal of one face of the body (CAD space). */
function faceNormal(b: Body, face: number): Vec3 | null {
  const { positions: p, indices: ix, faceIds } = b.mesh
  const n: Vec3 = [0, 0, 0]
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== face) continue
    const a = ix[t * 3] * 3, c = ix[t * 3 + 1] * 3, d = ix[t * 3 + 2] * 3
    const ux = p[c] - p[a], uy = p[c + 1] - p[a + 1], uz = p[c + 2] - p[a + 2]
    const vx = p[d] - p[a], vy = p[d + 1] - p[a + 1], vz = p[d + 2] - p[a + 2]
    n[0] += uy * vz - uz * vy; n[1] += uz * vx - ux * vz; n[2] += ux * vy - uy * vx
  }
  const l = Math.hypot(n[0], n[1], n[2])
  return l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : null
}

/** Lay a part on one of its faces: that face becomes the bottom. */
export async function layOnFace(id: string, face: number) {
  const b = useDoc.getState().geometry.find((x) => x.id === id)
  const n = b && faceNormal(b, face)
  if (!n) return toast('That face has no direction to lay flat on', 'info')
  await setPose(id, { r: rotationFor(n) }, 'Lay on face')
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
      if (best && cur) change[b.id] = { ...cur, r: rotationFor(best.down) }
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
