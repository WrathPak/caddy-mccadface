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
 * The component structure as STEP definitions. The document is the root product; every instance of a component is a product
 * named like its Browser node ("Peg:2") placed relative to the instance it sits in, and every solid is one shared part, so
 * instances of a component reference the same geometry. Bodies that are not B-reps (meshes) cannot go into a STEP file.
 */
export function buildStepDefs(i: StepInput): { defs: StepDef[]; root: string; skipped: string[] } {
  const hidden = i.hidden ?? {}
  const skipped: string[] = []
  const nodes = flatten(i.assembly).filter((n) => !n.id.split('/').some((p) => hidden[p]))
  const ok = new Set(nodes.map((n) => n.id))
  const label = (path: string) => occLabel(i.assembly, path)
  const nameOf = (b: Body) => i.bodyNames[b.id] ?? b.name
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
  const addBodies = (target: StepDef, def: string, instanceName: (b: Body) => string) => {
    for (const b of bodiesOf(def)) {
      if (b.kind !== 'brep') { skipped.push(nameOf(b)); continue }
      target.children.push({ def: part(b), name: instanceName(b), matrix: b.placement ?? identity() })
    }
  }
  addBodies(defs[0], ROOT, nameOf)
  for (const n of nodes) {
    if (n.parent && !ok.has(n.parent)) continue
    const def: StepDef = { id: 'n:' + n.id, name: label(n.id), bodies: [], children: [] }
    addBodies(def, n.component, nameOf)
    const up = n.parent ? defs.find((d) => d.id === 'n:' + n.parent)! : defs[0]
    const parentWorld = n.parent ? i.worlds[n.parent] ?? identity() : identity()
    const local = multiply(invert(parentWorld), i.worlds[n.id] ?? identity())
    // a component with a single body and nothing inside is that part, placed: the instance takes the part's place
    const single = def.children.length === 1 && !nodes.some((m) => m.parent === n.id) && def.children[0].matrix.every((v, k) => v === identity()[k])
    if (single) {
      // the instance is the part itself
      up.children.push({ def: def.children[0].def, name: def.name, matrix: local })
    } else {
      defs.push(def)
      up.children.push({ def: def.id, name: def.name, matrix: local })
    }
  }
  return { defs, root: 'root', skipped }
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

