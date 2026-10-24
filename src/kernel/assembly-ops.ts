/** Worker ops for assemblies: interference between placed bodies (manifold intersection) and the STEP assembly writer (OCC XDE). */
import { GCWithScope, getOC, type AnyShape } from 'replicad'
import { initOcc } from './occ'
import { fromManifold, toManifold } from './mesh'
import { getBrep, getTopo, registerOp } from './store'
import type { TopoMesh, Vec3 } from './types'

// ---------------------------------------------------------------- interference

export interface InterferenceItem {
  /** caller's id for the placed body, handed back in the hits */
  id: string
  /** worker handle of the body */
  key: string
  /** column-major 4x4 that places it */
  matrix: number[]
  /** items of one group never interfere with each other (the bodies of one component) */
  group: string
}
export interface InterferenceHit { a: string; b: string; volume: number; min: Vec3; max: Vec3; positions: Float32Array; indices: Uint32Array }

function placed(m: TopoMesh, mat: number[]): TopoMesh {
  const src = m.positions
  const p = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2]
    p[i] = mat[0] * x + mat[4] * y + mat[8] * z + mat[12]
    p[i + 1] = mat[1] * x + mat[5] * y + mat[9] * z + mat[13]
    p[i + 2] = mat[2] * x + mat[6] * y + mat[10] * z + mat[14]
  }
  return { positions: p, indices: m.indices }
}

function boundsOf(p: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < min[k]) min[k] = p[i + k]; if (p[i + k] > max[k]) max[k] = p[i + k] }
  return { min, max }
}

/** Volume of a closed triangle mesh (signed tetrahedra sum, absolute value). */
export function meshVolume(m: TopoMesh): number {
  const p = m.positions, ix = m.indices
  let v = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6
  }
  return Math.abs(v)
}

/**
 * Overlapping volumes between placed bodies of different groups. Touching faces are not an overlap (the volume must be above `minVolume`).
 * With `focus`, only pairs that include one of those item ids are checked.
 */
export async function interference(items: InterferenceItem[], minVolume = 1e-3, focus?: string[]): Promise<{ hits: InterferenceHit[]; checked: number }> {
  const meshes = items.map((it) => placed(getTopo(it.key), it.matrix))
  const boxes = meshes.map((m) => boundsOf(m.positions))
  const hits: InterferenceHit[] = []
  let checked = 0
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].group === items[j].group) continue
      if (focus && !focus.includes(items[i].id) && !focus.includes(items[j].id)) continue
      const A = boxes[i], B = boxes[j]
      if ([0, 1, 2].some((k) => A.max[k] < B.min[k] - 1e-6 || B.max[k] < A.min[k] - 1e-6)) continue
      checked++
      const ma = await toManifold(meshes[i])
      const mb = await toManifold(meshes[j])
      const x = ma.intersect(mb)
      try {
        const out = fromManifold(x)
        const vol = out.indices.length ? meshVolume(out) : 0
        if (vol > minVolume) hits.push({ a: items[i].id, b: items[j].id, volume: vol, ...boundsOf(out.positions), positions: out.positions, indices: out.indices })
      } finally {
        x.delete()
        ma.delete()
        mb.delete()
      }
    }
  }
  return { hits, checked }
}

registerOp<{ items: InterferenceItem[]; minVolume?: number; focus?: string[] }, { hits: InterferenceHit[]; checked: number }>('assemblyInterference', (a) => interference(a.items, a.minVolume, a.focus))

// ---------------------------------------------------------------- STEP with the assembly structure

export interface StepDef {
  id: string
  name: string
  /** this definition is a single part: the solid with this worker handle */
  solid?: string
  /** the bodies of this component (worker handles), each placed by `matrix` (column-major 4x4, identity when absent) */
  bodies: { key: string; name: string; matrix?: number[] }[]
  /** components placed inside this one; `matrix` is column-major 4x4 */
  children: { def: string; name: string; matrix: number[] }[]
}

interface OcLabel { delete?: () => void }

/**
 * Write the component tree as a STEP assembly: one product per component, one occurrence per instance (the instances of a
 * component share its definition), every body a named solid. Uses OCC's XDE document (XCAF), the same writer replicad's exportSTEP uses.
 */
export async function writeStepAssembly(defs: StepDef[], rootId: string): Promise<ArrayBuffer> {
  await initOcc()
  const oc = getOC() as unknown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = GCWithScope()
  const str = (s: string) => new oc.TCollection_ExtendedString(s, true)
  const doc = r(new oc.TDocStd_Document(str('XmlOcaf')))
  oc.XCAFDoc_ShapeTool.SetAutoNaming(false)
  const tool = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main())
  const byId = new Map(defs.map((d) => [d.id, d]))
  const labels = new Map<string, OcLabel>()
  const loc = (m: number[]) => {
    const t = new oc.gp_Trsf()
    t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14])
    return new oc.TopLoc_Location(t)
  }
  const name = (label: OcLabel, s: string) => oc.TDataStd_Name.Set(label, str(s || 'Component'))
  const build = (id: string, stack: string[]): OcLabel => {
    if (stack.includes(id)) throw new Error('A component contains itself')
    const hit = labels.get(id)
    if (hit) return hit
    const d = byId.get(id)
    if (!d) throw new Error(`Unknown component ${id}`)
    const label: OcLabel = tool.NewShape()
    labels.set(id, label)
    name(label, d.name)
    if (d.solid) tool.SetShape(label, (getBrep(d.solid) as AnyShape).wrapped)
    for (const b of d.bodies) {
      const bl: OcLabel = tool.NewShape()
      tool.SetShape(bl, (getBrep(b.key) as AnyShape).wrapped)
      name(bl, b.name)
      const comp = tool.AddComponent(label, bl, loc(b.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
      name(comp, b.name)
    }
    for (const c of d.children) {
      const child = build(c.def, [...stack, id])
      const comp = tool.AddComponent(label, child, loc(c.matrix))
      name(comp, c.name)
    }
    return label
  }
  build(rootId, [])
  tool.UpdateAssemblies()

  const session = r(new oc.XSControl_WorkSession())
  const writer = r(new oc.STEPCAFControl_Writer(session, false))
  writer.SetColorMode(true)
  writer.SetLayerMode(true)
  writer.SetNameMode(true)
  oc.Interface_Static.SetIVal('write.surfacecurve.mode', 1)
  oc.Interface_Static.SetIVal('write.precision.mode', 0)
  oc.Interface_Static.SetIVal('write.step.assembly', 2)
  oc.Interface_Static.SetIVal('write.step.schema', 5)
  const progress = r(new oc.Message_ProgressRange())
  if (!writer.Perform(doc, 'assembly.step', progress)) throw new Error('Writing the STEP file failed')
  const file: Uint8Array = oc.FS.readFile('/assembly.step')
  oc.FS.unlink('/assembly.step')
  const out = new ArrayBuffer(file.byteLength)
  new Uint8Array(out).set(file)
  return out
}

registerOp<{ defs: StepDef[]; root: string }, ArrayBuffer>('assemblyStep', (a) => writeStepAssembly(a.defs, a.root))
