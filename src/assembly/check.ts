/** Interference check and clearance report over the assembled (not exploded) pose of the document. */
import { useDoc } from '@/doc/store'
import { getKernel } from '@/kernel/client'
import type { Body } from '@/kernel/types'
import type { Mat4 } from './matrix'
import { minClearance, type PlacedMesh } from './clearance'
import type { Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import { occLabel, subtree } from './actions'
import { expandInstances, placeAssembly, type Instance } from './instances'
import { useAssemblyRuntime, type ClearanceReport, type InterferenceHit, type InterferenceReport } from './runtime'

/** Instances in their assembled places: joints solved, nothing exploded, nothing held at its origin for editing. */
export function assembledInstances(): Instance[] {
  const d = useDoc.getState()
  const place = placeAssembly(d.assembly, useAssemblyRuntime.getState().drive, null, 0, d.geometry)
  const hidden = useUi.getState().hiddenIds
  return expandInstances(d.assembly, d.geometry, place.worlds).filter((i) => !hidden[i.body.id] && !(i.path && i.path.split('/').some((o) => hidden[o])))
}

const labelOf = (occ: string) => (occ ? occLabel(useDoc.getState().assembly, occ) : 'Root')
const bodyName = (id: string, fallback: string) => useDoc.getState().bodyNames[id] ?? fallback

/**
 * Find overlapping volumes. `occs` limits the check: two or more occurrences are checked against each other, one against
 * everything else, none (or an empty list) checks the whole assembly.
 */
export async function runInterference(occs: string[] = []): Promise<InterferenceReport> {
  const all = assembledInstances()
  const a = useDoc.getState().assembly
  const scope = occs.length ? new Set(occs.flatMap((o) => subtree(a, o))) : null
  const inScope = (i: Instance) => !scope || [...scope].some((o) => i.path.split('/').includes(o))
  const items = (occs.length > 1 ? all.filter(inScope) : all).map((i) => ({ id: i.key, key: i.body.key, matrix: i.world, group: i.occ }))
  const focus = occs.length === 1 ? all.filter(inScope).map((i) => i.key) : undefined
  const out = (await getKernel().call('assemblyInterference', { items, focus })) as { hits: (Omit<InterferenceHit, 'a' | 'b'> & { a: string; b: string })[]; checked: number }
  const byKey = new Map(all.map((i) => [i.key, i]))
  const hits: InterferenceHit[] = out.hits.map((h) => {
    const ia = byKey.get(h.a)!, ib = byKey.get(h.b)!
    return {
      a: { occ: ia.occ, body: ia.body.id, name: `${labelOf(ia.occ)} / ${bodyName(ia.body.id, ia.body.name)}` },
      b: { occ: ib.occ, body: ib.body.id, name: `${labelOf(ib.occ)} / ${bodyName(ib.body.id, ib.body.name)}` },
      volume: h.volume, min: h.min, max: h.max, positions: h.positions, indices: h.indices,
    }
  })
  hits.sort((p, q) => q.volume - p.volume)
  const report: InterferenceReport = { hits, checked: out.checked, stale: false }
  useAssemblyRuntime.getState().setInterference(report)
  return report
}

/** Smallest distance between two components (everything inside each counts). */
/**
 * Smallest distance between two sets of placed bodies. B-rep against B-rep is exact (OpenCascade, in the kernel); any pair with a
 * mesh body is measured triangle to triangle here.
 */
export async function clearanceBetween(a: { body: Body; world: Mat4 }[], b: { body: Body; world: Mat4 }[], kernel = getKernel()): Promise<{ distance: number; pa: Vec3; pb: Vec3 } | null> {
  let best: { distance: number; pa: Vec3; pb: Vec3 } | null = null
  const take = (r: { distance: number; pa: number[]; pb: number[] } | null) => { if (r && (!best || r.distance < best.distance)) best = { distance: r.distance, pa: r.pa as Vec3, pb: r.pb as Vec3 } }
  const solid = (x: { body: Body }) => x.body.kind === 'brep' && !x.body.surface
  const exactA = a.filter(solid), exactB = b.filter(solid)
  if (exactA.length && exactB.length) take((await kernel.call('assemblyClearance', { a: exactA.map((i) => ({ key: i.body.key, matrix: i.world })), b: exactB.map((i) => ({ key: i.body.key, matrix: i.world })) })) as never)
  const mesh = (i: { body: Body; world: Mat4 }): PlacedMesh => ({ positions: i.body.mesh.positions, indices: i.body.mesh.indices, matrix: i.world })
  for (const x of a) for (const y of b) if (!solid(x) || !solid(y)) take(minClearance([mesh(x)], [mesh(y)]))
  return best
}

export async function runClearance(occA: string, occB: string): Promise<ClearanceReport | null> {
  const a = useDoc.getState().assembly
  const all = assembledInstances()
  const items = (occ: string) => {
    const set = new Set(subtree(a, occ))
    return all.filter((i) => i.path.split('/').some((o) => set.has(o)))
  }
  const r = await clearanceBetween(items(occA), items(occB))
  if (!r) return null
  const report: ClearanceReport = {
    a: { occ: occA, name: labelOf(occA) },
    b: { occ: occB, name: labelOf(occB) },
    distance: r.distance,
    pa: r.pa as Vec3,
    pb: r.pb as Vec3,
  }
  useAssemblyRuntime.getState().setClearance(report)
  return report
}

/** The interference results no longer match the model (something moved or changed). */
export function markInterferenceStale() {
  const r = useAssemblyRuntime.getState().interference
  if (r && !r.stale) useAssemblyRuntime.getState().setInterference({ ...r, stale: true })
}
