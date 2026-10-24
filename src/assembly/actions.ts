/**
 * Document edits for the component tree and the assembly data. Each one is a single undo step.
 * Instances are addressed by occurrence path (see types.ts); an edit of an occurrence is seen by every instance of the component it sits in.
 */
import { useDoc, activeDefId } from '@/doc/store'
import type { DocData } from '@/doc/types'
import { useUi } from '@/store/ui'
import { expandInstances, flatten, lastOf, parentPath, placeAssembly, within } from './instances'
import { defaultLimits, defaultValues, restValues } from './joints'
import { identity, invert, multiply, translation, type Mat4 } from './matrix'
import { ROOT, type AssemblyData, type ExplodeStep, type Joint, type MotionLink, type MotionTrack } from './types'

const nextNum = (ids: string[], prefix: string) => ids.reduce((m, id) => (id.startsWith(prefix) ? Math.max(m, parseInt(id.slice(prefix.length), 10) || 0) : m), 0) + 1
export const nextId = (ids: string[], prefix: string) => prefix + nextNum(ids, prefix)

const edit = (label: string, fn: (a: AssemblyData, d: DocData) => Partial<DocData> | AssemblyData | null) =>
  useDoc.getState().commit(label, (d) => {
    const r = fn(d.assembly, d)
    if (!r) return d
    return 'occurrences' in r ? { ...d, assembly: r } : { ...d, ...r }
  })

/** Display name of an instance: the component's name, numbered when several instances share it. */
export function occLabel(a: Pick<AssemblyData, 'components' | 'occurrences'>, path: string): string {
  if (path === '') return 'Root'
  const nodes = flatten(a)
  const n = nodes.find((x) => x.id === path)
  if (!n) return lastOf(path)
  const name = a.components.find((c) => c.id === n.component)?.name ?? n.component
  const same = nodes.filter((x) => x.component === n.component)
  return same.length > 1 ? `${name}:${same.indexOf(n) + 1}` : name
}

/** The component definition an instance path stands for (the root for null). */
export function defOf(a: Pick<AssemblyData, 'occurrences'>, path: string | null): string {
  return (path && a.occurrences.find((o) => o.id === lastOf(path))?.component) || ROOT
}

/** Instance paths from the given one down (itself, its children, ...). */
export function subtree(a: Pick<AssemblyData, 'occurrences'>, path: string): string[] {
  return flatten(a).filter((n) => within(n.id, path)).map((n) => n.id)
}

/** The path a new occurrence of the active component gets as an instance (inside the active instance, or at the top). */
const activePrefix = (activeOcc: string | null, id: string) => (activeOcc ? `${activeOcc}/${id}` : id)

/** Drop whatever became unreachable: components nothing places any more (with their features), joints on instances that are gone, ... */
function prune(a: AssemblyData, features: DocData['features']): { assembly: AssemblyData; features: DocData['features'] } {
  // a component is reachable when an occurrence in a reachable component places it; removing an occurrence can strand a whole branch
  const reachable = new Set<string>([ROOT])
  for (let changed = true; changed;) {
    changed = false
    for (const o of a.occurrences) if (reachable.has(o.parent) && !reachable.has(o.component)) { reachable.add(o.component); changed = true }
  }
  const occs = a.occurrences.filter((o) => reachable.has(o.parent))
  const dead = new Set(a.components.filter((c) => c.id !== ROOT && !reachable.has(c.id)).map((c) => c.id))
  const components = a.components.filter((c) => !dead.has(c.id))
  const clean: AssemblyData = { ...a, occurrences: occs, components }
  const ids = new Set(flatten(clean).map((n) => n.id))
  const joints = a.joints.filter((j) => ids.has(j.a.occ) && ids.has(j.b.occ))
  const jointIds = new Set(joints.map((j) => j.id))
  const extGone = new Set(a.components.filter((c) => dead.has(c.id)).map((c) => c.external).filter((x): x is string => !!x))
  return {
    assembly: {
      ...clean,
      joints,
      links: a.links.filter((l) => jointIds.has(l.a.joint) && jointIds.has(l.b.joint)),
      bodyOwner: Object.fromEntries(Object.entries(a.bodyOwner).filter(([, v]) => !dead.has(v))),
      externals: a.externals.filter((e) => !extGone.has(e.id)),
      explode: { steps: a.explode.steps.map((s) => ({ ...s, occs: s.occs.filter((o) => ids.has(o)) })).filter((s) => s.occs.length) },
      motion: { ...a.motion, tracks: a.motion.tracks.filter((t) => jointIds.has(t.joint)) },
    },
    features: features.filter((f) => !f.component || !dead.has(f.component)),
  }
}

// ---------------------------------------------------------------- components

/** New empty component inside the active one; it becomes the active component, so the next features go into it. */
export function newComponent(name?: string): { def: string; occ: string; path: string } {
  const d = useDoc.getState()
  const a = d.assembly
  const def = nextId(a.components.map((c) => c.id), 'c')
  const occ = nextId(a.occurrences.map((o) => o.id), 'o')
  const nm = name ?? `Component${a.components.filter((c) => c.id !== ROOT && !c.external).length + 1}`
  const parent = activeDefId(d)
  edit('New component', (x) => ({
    ...x,
    components: [...x.components, { id: def, name: nm }],
    occurrences: [...x.occurrences, { id: occ, name: nm, component: def, parent, transform: identity() }],
  }))
  const path = activePrefix(d.activeOcc, occ)
  useDoc.getState().setActiveOcc(path)
  return { def, occ, path }
}

/** One component per body: the body (and the feature that made it, when nothing else came from that feature) moves into it. */
export function componentsFromBodies(bodyIds: string[]): string[] {
  const d = useDoc.getState()
  const bodies = d.geometry.filter((b) => bodyIds.includes(b.id))
  if (!bodies.length) return []
  const made: string[] = []
  const parent = activeDefId(d)
  edit('Create components from bodies', (a, doc) => {
    let comps = a.components, occs = a.occurrences
    const owner = { ...a.bodyOwner }
    let features = doc.features
    for (const b of bodies) {
      const def = nextId(comps.map((c) => c.id), 'c')
      const occ = nextId(occs.map((o) => o.id), 'o')
      const name = doc.bodyNames[b.id] ?? b.name
      comps = [...comps, { id: def, name }]
      occs = [...occs, { id: occ, name, component: def, parent, transform: identity() }]
      owner[b.id] = def
      made.push(activePrefix(d.activeOcc, occ))
      const fid = b.featureId
      if (fid) {
        const others = d.geometry.some((x) => x.featureId === fid && !bodyIds.includes(x.id))
        if (!others) features = features.map((f) => (f.id === fid ? { ...f, component: def } : f))
      }
    }
    return { assembly: { ...a, components: comps, occurrences: occs, bodyOwner: owner }, features }
  })
  return made
}

export function activateOcc(path: string | null) {
  useDoc.getState().setActiveOcc(path)
}

export function renameComponent(def: string, name: string) {
  const n = name.trim()
  if (!n) return
  edit('Rename component', (a) => ({ ...a, components: a.components.map((c) => (c.id === def ? { ...c, name: n } : c)) }))
}

/** World extent along X of everything inside an instance (for placing a new instance beside it). */
function widthOf(path: string): number {
  const d = useDoc.getState()
  const place = placeAssembly(d.assembly)
  let lo = Infinity, hi = -Infinity
  for (const i of expandInstances(d.assembly, d.geometry, place.worlds)) {
    if (!within(i.path, path)) continue
    const p = i.body.mesh.positions
    for (let k = 0; k < p.length; k += 3) {
      const x = i.world[0] * p[k] + i.world[4] * p[k + 1] + i.world[8] * p[k + 2] + i.world[12]
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
  }
  return isFinite(lo) ? hi - lo : 0
}

/**
 * A new occurrence of the same component next to the given one, so it shares the geometry (and everything inside the component).
 * `offsetX` (mm, along X) keeps it from sitting on the original; by default the width of the original plus a gap.
 */
export function instanceOf(path: string, offsetX?: number): string | null {
  const a = useDoc.getState().assembly
  const src = a.occurrences.find((o) => o.id === lastOf(path))
  if (!src) return null
  const off = offsetX ?? (Math.round(widthOf(path) * 1.25 * 10) / 10 || 20)
  const id = nextId(a.occurrences.map((o) => o.id), 'o')
  edit('Paste as instance', (x) => ({
    ...x,
    occurrences: [...x.occurrences, { ...src, id, transform: multiply(translation([off, 0, 0]), src.transform), grounded: false }],
  }))
  const up = parentPath(path)
  return up ? `${up}/${id}` : id
}

export function setGrounded(path: string, on: boolean) {
  const o = lastOf(path)
  edit(on ? 'Ground' : 'Unground', (a) => ({ ...a, occurrences: a.occurrences.map((x) => (x.id === o ? { ...x, grounded: on } : x)) }))
}

/** Set the placement of an occurrence (relative to the component it sits in). */
export function moveOccurrence(path: string, transform: Mat4) {
  const o = lastOf(path)
  edit('Move component', (a) => ({ ...a, occurrences: a.occurrences.map((x) => (x.id === o ? { ...x, transform } : x)) }))
}

/**
 * Remove an occurrence. It goes from every instance of the component it sits in; a component nothing places any more is removed
 * with its timeline features, and so is everything that depended on the instances that are gone (joints, links, explode steps).
 */
export function deleteOccurrence(path: string) {
  const d0 = useDoc.getState()
  const o = lastOf(path)
  if (!d0.assembly.occurrences.some((x) => x.id === o)) return
  edit('Delete component', (a, doc) => prune({ ...a, occurrences: a.occurrences.filter((x) => x.id !== o) }, doc.features))
  const now = useDoc.getState()
  const live = new Set(flatten(now.assembly).map((n) => n.id))
  if (now.activeOcc && !live.has(now.activeOcc)) now.setActiveOcc(null)
  useUi.getState().clearSelection()
}

// ---------------------------------------------------------------- joints

/**
 * Bake the placements the joints give into the occurrences' own transforms, so removing a joint leaves the parts where they are.
 * An occurrence seen through several instances of its parent cannot hold a different pose in each, so those stay as stored.
 */
function bake(a: AssemblyData): AssemblyData {
  const place = placeAssembly(a)
  const count = new Map<string, number>()
  for (const n of place.nodes) count.set(n.occ, (count.get(n.occ) ?? 0) + 1)
  const transforms = new Map<string, Mat4>()
  for (const n of place.nodes) {
    if (!place.solve.placed.has(n.id) || count.get(n.occ) !== 1) continue
    const parentWorld = n.parent ? place.worlds[n.parent] : identity()
    transforms.set(n.occ, multiply(invert(parentWorld), place.worlds[n.id]))
  }
  return { ...a, occurrences: a.occurrences.map((o) => (transforms.has(o.id) ? { ...o, transform: transforms.get(o.id)! } : o)) }
}

export function addJoint(j: Omit<Joint, 'id'>): string {
  const a = useDoc.getState().assembly
  const id = nextId(a.joints.map((x) => x.id), 'j')
  edit('Add joint', (x) => ({ ...x, joints: [...x.joints, { ...j, id }] }))
  return id
}

export function updateJoint(id: string, patch: Partial<Joint>) {
  edit('Edit joint', (a) => ({ ...a, joints: a.joints.map((j) => (j.id === id ? { ...j, ...patch } : j)) }))
}

export function deleteJoint(id: string) {
  edit('Delete joint', (a) => {
    const baked = bake(a)
    return {
      ...baked,
      joints: a.joints.filter((j) => j.id !== id),
      links: a.links.filter((l) => l.a.joint !== id && l.b.joint !== id),
      motion: { ...a.motion, tracks: a.motion.tracks.filter((t) => t.joint !== id) },
    }
  })
}

/** Set joint values (the end of a drive, or the rest position) as one undo step. */
export function setJointValues(values: Record<string, Record<string, number>>, label = 'Drive joint') {
  edit(label, (a) => ({ ...a, joints: a.joints.map((j) => (values[j.id] ? { ...j, values: { ...j.values, ...values[j.id] } } : j)) }))
}
export function resetJointToRest(id: string) {
  const j = useDoc.getState().assembly.joints.find((x) => x.id === id)
  if (j) setJointValues({ [id]: restValues(j) }, 'Reset joint')
}

export function newJointDefaults(type: Joint['type']): Pick<Joint, 'values' | 'limits'> {
  return { values: defaultValues(type), limits: defaultLimits(type) }
}

export function addLink(l: Omit<MotionLink, 'id'>): string {
  const a = useDoc.getState().assembly
  const id = nextId(a.links.map((x) => x.id), 'l')
  edit('Add motion link', (x) => ({ ...x, links: [...x.links, { ...l, id }] }))
  return id
}
export function deleteLink(id: string) {
  edit('Delete motion link', (a) => ({ ...a, links: a.links.filter((l) => l.id !== id) }))
}

// ---------------------------------------------------------------- explode + motion study

export function addExplodeStep(s: Omit<ExplodeStep, 'id'>): string {
  const a = useDoc.getState().assembly
  const id = nextId(a.explode.steps.map((x) => x.id), 's')
  edit('Add explode step', (x) => ({ ...x, explode: { steps: [...x.explode.steps, { ...s, id }] } }))
  return id
}
export function updateExplodeStep(id: string, patch: Partial<ExplodeStep>) {
  edit('Edit explode step', (a) => ({ ...a, explode: { steps: a.explode.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) } }))
}
export function deleteExplodeStep(id: string) {
  edit('Delete explode step', (a) => ({ ...a, explode: { steps: a.explode.steps.filter((s) => s.id !== id) } }))
}

export function setMotionTrack(t: MotionTrack) {
  edit('Edit motion study', (a) => {
    const rest = a.motion.tracks.filter((x) => !(x.joint === t.joint && x.key === t.key))
    return { ...a, motion: { ...a.motion, tracks: t.frames.length ? [...rest, { ...t, frames: [...t.frames].sort((p, q) => p.t - q.t) }] : rest } }
  })
}
export function setMotionSettings(p: Partial<{ duration: number; loop: boolean }>) {
  edit('Edit motion study', (a) => ({ ...a, motion: { ...a.motion, ...p } }))
}
