/** Exporting the assembly: STEP with the component structure, and 3MF with one object per component instance. */
import { useDoc } from '@/doc/store'
import { getKernel } from '@/kernel/client'
import type { StepDef } from '@/kernel/assembly-ops'
import type { Body, TopoMesh } from '@/kernel/types'
import { occLabel } from './actions'
import { assembledInstances } from './check'
import { flatten, ownerOf, placeAssembly, type Instance } from './instances'
import { identity, invert, multiply, type Mat4 } from './matrix'
import { useUi } from '@/store/ui'
import { useAssemblyRuntime } from './runtime'
import { ROOT, type AssemblyData } from './types'

export interface StepInput {
  assembly: AssemblyData
  /** every body of the document */
  geometry: Body[]
  bodyNames: Record<string, string>
  docName: string
  /** placement of every instance (assembled pose) */
  worlds: Record<string, Mat4>
  /** instance paths and body ids to leave out */
  hidden?: Record<string, true>
}

/**
 * The component structure as STEP definitions, the way XDE assemblies are normally built: the document is the root product, every
 * component is ONE product (a definition) and each instance of it is an occurrence of that product placed relative to the product
 * it sits in, named like its Browser node ("Peg:2"). Every solid is one shared part too. Two instances share a product when what is
 * inside them is placed the same way; instances whose insides differ (a joint moved something inside only one of them) get a
 * product each. Bodies that are not B-reps (meshes) cannot go into a STEP file.
 */
export function buildStepDefs(i: StepInput): { defs: StepDef[]; root: string; skipped: string[] } {
  const hidden = i.hidden ?? {}
  const skipped: string[] = []
  const nodes = flatten(i.assembly).filter((n) => !n.id.split('/').some((p) => hidden[p]))
  const label = (path: string) => occLabel(i.assembly, path)
  const nameOf = (b: Body) => i.bodyNames[b.id] ?? b.name
  const compName = (c: string) => i.assembly.components.find((x) => x.id === c)?.name ?? c
  const bodiesOf = (def: string) => i.geometry.filter((b) => ownerOf(b, i.assembly) === def && !hidden[b.id])
  const defs: StepDef[] = [{ id: 'root', name: i.docName || 'Assembly', bodies: [], children: [] }]
  const parts = new Set<string>()
  const part = (b: Body): string => {
    const id = 'b:' + b.id
    if (!parts.has(id)) {
      parts.add(id)
      defs.push({ id, name: nameOf(b), solid: b.key, bodies: [], children: [] })
    }
    return id
  }
  const bodyChildren = (def: string) => {
    const out: StepDef['children'] = []
    for (const b of bodiesOf(def)) {
      if (b.kind !== 'brep') { skipped.push(nameOf(b)); continue }
      out.push({ def: part(b), name: nameOf(b), matrix: b.placement ?? identity() })
    }
    return out
  }
  const round = (m: number[]) => m.map((v) => Math.round(v * 1e6) / 1e6)
  const byParent = new Map<string | null, typeof nodes>()
  for (const n of nodes) (byParent.get(n.parent) ?? byParent.set(n.parent, []).get(n.parent)!).push(n)
  const bySig = new Map<string, string>()
  /** The occurrence of an instance inside the product it sits in. */
  const place = (n: (typeof nodes)[number]): StepDef['children'][number] => {
    const parentWorld = n.parent ? i.worlds[n.parent] ?? identity() : identity()
    const matrix = multiply(invert(parentWorld), i.worlds[n.id] ?? identity())
    const kids = byParent.get(n.id) ?? []
    const own = bodyChildren(n.component)
    // a component with a single body and nothing inside is that part, placed: its instances are occurrences of the part
    if (!kids.length && own.length === 1 && own[0].matrix.every((v, k) => v === identity()[k])) return { def: own[0].def, name: label(n.id), matrix }
    const children = [...own, ...kids.map(place)]
    const sig = n.component + '|' + JSON.stringify(children.map((c) => [c.def, round(c.matrix)]))
    let id = bySig.get(sig)
    if (!id) {
      id = 'n:' + n.id
      bySig.set(sig, id)
      defs.push({ id, name: compName(n.component), bodies: [], children })
    }
    return { def: id, name: label(n.id), matrix }
  }
  defs[0].children.push(...bodyChildren(ROOT), ...(byParent.get(null) ?? []).map(place))
  return { defs, root: 'root', skipped: [...new Set(skipped)] }
}

export async function exportAssemblyStep(): Promise<{ bytes: ArrayBuffer; parts: number; skipped: string[] }> {
  const d = useDoc.getState()
  // assembled pose: joints solved, nothing exploded, nothing held at its origin for editing
  const worlds = placeAssembly(d.assembly, useAssemblyRuntime.getState().drive, null, 0, d.geometry).worlds
  const { defs, root, skipped } = buildStepDefs({ assembly: d.assembly, geometry: d.geometry, bodyNames: d.bodyNames, docName: d.name, worlds, hidden: useUi.getState().hiddenIds })
  const bytes = (await getKernel().call('assemblyStep', { defs, root })) as ArrayBuffer
  return { bytes, parts: defs.filter((x) => x.solid).length, skipped }
}

// ---------------------------------------------------------------- 3MF

export interface ObjectGroup { name: string; instances: Instance[] }

/** One group per component instance (all the bodies it holds directly); bodies of the root component are an object each. */
export function objectGroups(insts: Instance[], assembly: AssemblyData, bodyNames: Record<string, string>): ObjectGroup[] {
  const out: ObjectGroup[] = []
  const byOcc = new Map<string, Instance[]>()
  for (const i of insts) {
    if (!i.occ) { out.push({ name: bodyNames[i.body.id] ?? i.body.name, instances: [i] }); continue }
    ;(byOcc.get(i.occ) ?? byOcc.set(i.occ, []).get(i.occ)!).push(i)
  }
  for (const [occ, list] of byOcc) out.push({ name: occLabel(assembly, occ), instances: list })
  const seen = new Map<string, number>()
  return out.map((g) => {
    const c = (seen.get(g.name) ?? 0) + 1
    seen.set(g.name, c)
    return { ...g, name: c === 1 ? g.name : `${g.name} (${c})` }
  })
}

/** Several meshes, each moved by its matrix, as one mesh. */
export function mergePlaced(parts: { positions: Float32Array; indices: Uint32Array; matrix: Mat4 }[]): TopoMesh {
  let nv = 0, ni = 0
  for (const p of parts) { nv += p.positions.length; ni += p.indices.length }
  const positions = new Float32Array(nv), indices = new Uint32Array(ni)
  let vo = 0, io = 0
  for (const p of parts) {
    const m = p.matrix
    for (let k = 0; k < p.positions.length; k += 3) {
      const x = p.positions[k], y = p.positions[k + 1], z = p.positions[k + 2]
      positions[vo + k] = m[0] * x + m[4] * y + m[8] * z + m[12]
      positions[vo + k + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
      positions[vo + k + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
    }
    for (let k = 0; k < p.indices.length; k++) indices[io + k] = p.indices[k] + vo / 3
    vo += p.positions.length
    io += p.indices.length
  }
  return { positions, indices }
}

/** The assembly's objects for a 3MF: one per component instance, at its current position. `keep` limits it to some instances. */
export async function assemblyObjects(keep: (i: Instance) => boolean = () => true): Promise<{ name: string; mesh: TopoMesh }[]> {
  const d = useDoc.getState()
  const insts = assembledInstances().filter(keep)
  const groups = objectGroups(insts, d.assembly, d.bodyNames)
  const keys = [...new Set(insts.map((i) => i.body.key))]
  const meshes = await getKernel().exportMeshes(keys)
  const byKey = new Map(keys.map((k, n) => [k, meshes[n]]))
  return groups.map((g) => ({ name: g.name, mesh: mergePlaced(g.instances.map((i) => ({ ...byKey.get(i.body.key)!, matrix: i.world }))) }))
}

