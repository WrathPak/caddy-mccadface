/** Builds the build plate for the slicer: the visible bodies as print meshes, their filament slots, and where each one sits. */
import { useDoc } from '@/doc/store'
import { getKernel } from '@/kernel/client'
import type { ExportMesh } from '@/kernel/print-ops'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import { assembledInstances } from '@/assembly/check'
import { mergePlaced, objectGroups } from '@/assembly/exportAssembly'
import { computeKindMaps, computePaintMap } from './paint'
import { resolveProfile } from './engine/profiles'
import { flatProjectConfig } from './slice/projectConfig'
import type { KindPaint } from './engine/types'
import { colorById } from './palette'
import { settingsOf, type PrintSettings } from './settings'
import { withSlots } from './slice/profile'
import { arrangeOnPlate, slotsNeeded, writeBambu3mf, type PlateObject, type Placement } from './threemf'

/** Filament slot per print-mesh triangle, from the slots the viewport shows (null when the body is unpainted). */
export function exportSlots(body: Body, paint: Uint8Array | undefined, mesh: ExportMesh): Uint8Array | null {
  if (!paint || !paint.some((s) => s)) return null
  const out = new Uint8Array(mesh.indices.length / 3)
  if (body.kind === 'mesh') {
    // mesh bodies print the very triangles the viewport shows, in the same order
    if (paint.length === out.length) out.set(paint)
    return out
  }
  // B-reps are tessellated finer for printing: the slot follows the face
  const faceSlot = new Map<number, number>()
  const ids = body.mesh.faceIds
  for (let t = 0; t < ids.length; t++) if (paint[t]) faceSlot.set(ids[t], paint[t])
  for (let t = 0; t < out.length; t++) out[t] = faceSlot.get(mesh.faceIds[t]) ?? 0
  return out
}

export interface PlateItem { id?: string; name: string; mesh: ExportMesh; slots: Uint8Array | null; paint?: KindPaint }

const bboxOf = (p: Float32Array) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]) }
  return { lo, hi }
}

/** Place the objects on the plate: grounded at z = 0, then arranged side by side or kept where they sit. */
export function planPlate(items: PlateItem[], settings: PrintSettings): { objects: PlateObject[]; placements: Placement[]; fits: boolean } {
  const boxes = items.map((it) => bboxOf(it.mesh.positions))
  const plate = settings.printer.bed
  let placements: Placement[]
  let fits = true
  if (settings.placement === 'arrange') {
    const arr = arrangeOnPlate(boxes.map((b) => ({ w: b.hi[0] - b.lo[0], d: b.hi[1] - b.lo[1] })), plate)
    fits = arr.fits
    placements = boxes.map((b, i) => ({
      offset: [arr.centres[i][0] - (b.lo[0] + b.hi[0]) / 2, arr.centres[i][1] - (b.lo[1] + b.hi[1]) / 2, -b.lo[2]] as [number, number, number],
    }))
  } else {
    const lo = [Math.min(...boxes.map((b) => b.lo[0])), Math.min(...boxes.map((b) => b.lo[1])), Math.min(...boxes.map((b) => b.lo[2]))]
    const hi = [Math.max(...boxes.map((b) => b.hi[0])), Math.max(...boxes.map((b) => b.hi[1])), Math.max(...boxes.map((b) => b.hi[2]))]
    fits = hi[0] - lo[0] <= plate[0] && hi[1] - lo[1] <= plate[1]
    const off: [number, number, number] = [plate[0] / 2 - (lo[0] + hi[0]) / 2, plate[1] / 2 - (lo[1] + hi[1]) / 2, -lo[2]]
    placements = items.map(() => ({ offset: off }))
  }
  const objects: PlateObject[] = items.map((it) => ({ name: it.name, positions: it.mesh.positions, indices: it.mesh.indices, slots: it.slots ?? undefined, id: it.id, paint: it.paint }))
  return { objects, placements, fits }
}

/** Unique, human names for the bodies of the plate. */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const c = (seen.get(n) ?? 0) + 1
    seen.set(n, c)
    return c === 1 ? n : `${n} (${c})`
  })
}

export interface BuiltPlate {
  bytes: Uint8Array; fileName: string; count: number; fits: boolean; colors: number; settings: PrintSettings
  /** the objects and where each sits on the plate: what the 3MF was written from, for a slicer engine to take directly */
  plan: { objects: PlateObject[]; placements: Placement[] }
}

/** The visible bodies as a Bambu / Orca 3MF. Throws a readable error when there is nothing to print. */
/**
 * An assembly prints as one object per component instance, each at the pose it has now (joints solved), with the filament colors
 * of its bodies. A component with several bodies is one object.
 */
async function assemblyItems(): Promise<PlateItem[]> {
  const d = useDoc.getState()
  const insts = assembledInstances().filter((i) => !i.body.surface)
  if (!insts.length) throw new Error('There is nothing to print: no visible solid bodies (open surfaces cannot be printed)')
  const paint = computePaintMap(d.features, d.rollback, d.geometry)
  const keys = [...new Set(insts.map((i) => i.body.key))]
  const meshes = (await getKernel().call('printMeshes', { keys })) as ExportMesh[]
  const byKey = new Map(keys.map((k, n) => [k, meshes[n]]))
  return objectGroups(insts, d.assembly, d.bodyNames).map((g) => {
    const id = g.instances[0].occ ? `occ:${g.instances[0].occ}` : g.instances[0].body.id
    const parts = g.instances.map((i) => ({ ...byKey.get(i.body.key)!, matrix: i.world }))
    const merged = mergePlaced(parts)
    const slotParts = g.instances.map((i) => exportSlots(i.body, paint.get(i.body.id), byKey.get(i.body.key)!))
    let slots: Uint8Array | null = null
    if (slotParts.some((s) => s)) {
      slots = new Uint8Array(merged.indices.length / 3)
      let at = 0
      slotParts.forEach((s, n) => {
        const tris = parts[n].indices.length / 3
        if (s) slots!.set(s, at)
        at += tris
      })
    }
    return { id, name: g.name, mesh: { positions: merged.positions, indices: merged.indices, faceIds: new Uint32Array(0) }, slots }
  })
}

/** The objects of the plate as the Objects tab lists them: id (the key of their own settings) and name. */
export function plateObjects(): { id: string; name: string }[] {
  const d = useDoc.getState()
  if (d.assembly.occurrences.length) {
    return objectGroups(assembledInstances().filter((i) => !i.body.surface), d.assembly, d.bodyNames).map((g) => ({ id: g.instances[0].occ ? `occ:${g.instances[0].occ}` : g.instances[0].body.id, name: g.name }))
  }
  const hidden = useUi.getState().hiddenIds
  const bodies = d.geometry.filter((b) => !hidden[b.id] && !b.surface)
  return bodies.map((b, i) => ({ id: b.id, name: uniqueNames(bodies.map((x) => d.bodyNames[x.id] ?? x.name))[i] }))
}

export async function buildPlate(): Promise<BuiltPlate> {
  const d = useDoc.getState()
  const hidden = useUi.getState().hiddenIds
  const settings = settingsOf(d.features, d.rollback)
  let items: PlateItem[]
  if (d.assembly.occurrences.length) items = await assemblyItems()
  else {
    const bodies = d.geometry.filter((b) => !hidden[b.id] && !b.surface)
    if (!bodies.length) throw new Error('There is nothing to print: no visible solid bodies (open surfaces cannot be printed)')
    const paint = computePaintMap(d.features, d.rollback, d.geometry)
    const meshes = (await getKernel().call('printMeshes', { keys: bodies.map((b) => b.key) })) as ExportMesh[]
    const names = uniqueNames(bodies.map((b) => d.bodyNames[b.id] ?? b.name))
    const kinds = computeKindMaps(d.features, d.rollback, d.geometry)
    items = bodies.map((b, i) => {
      const kp: KindPaint = {}
      for (const k of ['supports', 'seam', 'fuzzy'] as const) {
        const st = exportSlots(b, kinds[k].get(b.id), meshes[i])
        if (st) kp[k] = st
      }
      return { id: b.id, name: names[i], mesh: meshes[i], slots: exportSlots(b, paint.get(b.id), meshes[i]), paint: Object.keys(kp).length ? kp : undefined }
    })
  }
  const plan = planPlate(items, settings)
  for (const o of plan.objects) if (o.id && Object.keys(settings.profile.objects[o.id] ?? {}).length) o.config = settings.profile.objects[o.id]
  const colors = slotsNeeded(plan.objects)
  // the 3MF carries the presets as they are (every key), when the profile set is installed
  let full: Record<string, unknown> | undefined
  try {
    const hex = Array.from({ length: colors }, (_, i) => colorById(settings.slotColors[i] ?? 'white').hex.toUpperCase())
    const profile = withSlots(settings.profile, colors)
    full = flatProjectConfig(await resolveProfile(profile, hex), profile)
  } catch { /* no engine files: the 3MF carries the short settings only */ }
  const bytes = writeBambu3mf(plan.objects, plan.placements, settings, undefined, undefined, full)
  const safe = (d.name || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_')
  return { bytes, fileName: `${safe}.3mf`, count: items.length, fits: plan.fits, colors: slotsNeeded(plan.objects), settings, plan }
}
