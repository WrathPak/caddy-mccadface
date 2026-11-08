/** Mesh workspace features: Smooth, Repair, Make Closed Mesh, Reverse Normal, Convert (to Mesh and Mesh to B-rep) and Delete Faces (kernel ops in kernel/mesh-ops.ts). Plane Cut, Reduce and Remesh are in features/mesh. */
import { ArrowsLeftRight, Cube, CubeFocus, Funnel, GridFour, MagicWand, Scissors, ShieldCheck, Trash, Waves, type Icon } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { bodyIdsOf, decodeRef, encodeSelection, resolveFace } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { getKernel, type KernelClient } from '@/kernel/client'
import type { RepairResult } from '@/kernel/mesh-ops'
import type { MeshToBrepResult } from '@/kernel/mesh-brep'
import { describeRepair } from '@/kernel/repairText'
import type { Body, Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import type { ParamDef, ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, resetManip, setPreview } from '@/viewport/preview'
import { createRunner } from './previewKit'
import { showArrows, type ArrowSpec } from './handleKit'
import { refinement, refinementParams } from './mesh/refine'

interface Ids { id: string; otherId: string; /** every body of the document (to turn picked faces into face numbers) */ all: Body[] }
interface BodyTool {
  type: string
  label: string
  icon: Icon
  command: string
  params: ParamDef[]
  /** only B-rep bodies (Convert to Mesh) */
  brepOnly?: boolean
  /** only mesh bodies (Convert Mesh to B-rep) */
  meshOnly?: boolean
  run(kernel: KernelClient, p: ParamValues, b: Body, ids: Ids): Promise<Body[]>
  /** the drag arrows of the tool in the viewport */
  arrows?(p: ParamValues, bodies: Body[]): ArrowSpec[]
}

const bodiesParam: ParamDef = { type: 'selection-ref', key: 'bodies', help: 'The bodies to work on. Click them in the viewport or the Browser.', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [] }
const asBody = (b: unknown) => b as Body

/** Face numbers of `body` among the picked face refs. */
function faceNumbers(refs: string[] | undefined, all: Body[], body: Body): number[] {
  const out: number[] = []
  for (const s of refs ?? []) {
    const r = decodeRef(s)
    const hit = r && r.kind === 'face' ? resolveFace(r, all) : null
    if (hit && hit.body.id === body.id && !out.includes(hit.index)) out.push(hit.index)
  }
  return out
}
/** A kernel op can leave a sentence for the person on the first body it returns (what Repair fixed, a cut that stayed open). */
function takeNote(bodies: Body[]): string | null {
  let note: string | null = null
  for (const b of bodies as (Body & { note?: string })[]) if (b.note) { note ??= b.note; delete b.note }
  return note
}
const toasted = new Map<string, string>()
/** Show a note once per step and text, not at every regenerate. */
function tell(featureId: string, text: string | null) {
  if (!text || toasted.get(featureId) === text) return
  toasted.set(featureId, text)
  toast(text, 'info')
}
const withNote = (b: Body, text: string): Body => { (b as Body & { note?: string }).note = text; return b }

const TOOLS: BodyTool[] = [
  // Plane Cut, Reduce and Remesh live in features/mesh/tools.ts
  {
    type: 'meshSmooth', label: 'Smooth', icon: Waves, command: 'mesh.smooth',
    params: [
      { type: 'number', key: 'iterations', help: 'How many smoothing passes to run. More passes give a smoother surface; the part keeps its size.', label: 'Iterations', min: 1, max: 200, step: 1, default: 10 },
      { type: 'number', key: 'strength', help: 'How far each point moves toward its neighbours per pass (0 to 1). Lower is gentler.', label: 'Strength', min: 0, max: 1, step: 0.05, default: 0.5 },
      { type: 'bool', key: 'preserveBoundary', help: 'Keep the edge of an open mesh, and the border of the faces you pick, where it is.', label: 'Preserve boundaries', default: true },
      { type: 'bool', key: 'preserveSharp', help: 'Keep sharp creases and corners where they are, so a box stays a box. Switch it off to round them.', label: 'Preserve sharp edges', default: true },
      { type: 'selection-ref', key: 'faces', help: 'Smooth only these faces (click them in the viewport). Leave empty to smooth the whole body.', label: 'Faces (optional)', accepts: ['face'], multiple: true, pick: true, default: [] },
    ],
    async run(k, p, b, ids) {
      return [asBody(await k.call('meshSmooth', { id: ids.id, name: b.name, key: b.key, iterations: p.iterations, strength: p.strength, preserveBoundary: p.preserveBoundary !== false, preserveSharp: p.preserveSharp !== false, faces: faceNumbers(p.faces as string[], ids.all, b) }))]
    },
  },
  {
    type: 'meshRepair', label: 'Repair', icon: MagicWand, command: 'mesh.repair',
    params: [
      {
        type: 'enum', key: 'type', label: 'Type', display: 'select', default: 'closed',
        help: 'Make Closed Mesh: join cracks, wind every triangle the same way, close holes. Close Holes and Stitch do one part of that. Remove drops small loose shells. Wrap and Rebuild build a new clean closed mesh from a badly broken one (the surface becomes finer and smoother).',
        options: [
          { value: 'closed', label: 'Make Closed Mesh', desc: 'Weld, orient and close every hole' },
          { value: 'holes', label: 'Close Holes', desc: 'Fill the open boundaries' },
          { value: 'stitch', label: 'Stitch', desc: 'Join vertices that nearly touch and unify the triangle direction' },
          { value: 'remove', label: 'Remove', desc: 'Delete small loose shells' },
          { value: 'wrap', label: 'Wrap', desc: 'Shrink-wrap the outside into a new closed mesh' },
          { value: 'rebuild', label: 'Rebuild', desc: 'Rebuild as a closed mesh and keep closed cavities' },
        ],
      },
      { type: 'number', key: 'tolerance', help: 'Points closer than this are merged into one, in mm. Closes tiny cracks between triangles.', label: 'Weld distance', unit: 'mm', min: 0, step: 0.001, default: 0.001, visibleWhen: (v) => v.type !== 'remove' },
      { type: 'number', key: 'minShell', help: 'Loose shells whose size is below this percent of the biggest shell are removed.', label: 'Smaller than', unit: '%', min: 0.1, max: 90, step: 1, default: 5, visibleWhen: (v) => v.type === 'remove' },
      { type: 'number', key: 'voxel', help: 'The size of the grid the new surface is built on, in mm. 0 picks one from the size of the part. Smaller keeps more detail and takes longer.', label: 'Voxel size', unit: 'mm', min: 0, step: 0.1, default: 0, visibleWhen: (v) => v.type === 'wrap' || v.type === 'rebuild' },
      { type: 'number', key: 'gap', help: 'Holes and gaps up to this wide are sealed shut, in mm. 0 seals about two voxels. Raise it if the result is empty or leaks.', label: 'Gap to close', unit: 'mm', min: 0, step: 0.1, default: 0, visibleWhen: (v) => v.type === 'wrap' || v.type === 'rebuild' },
    ],
    async run(k, p, b, ids) {
      const r = (await k.call('meshRepair', { id: ids.id, name: b.name, key: b.key, tolerance: p.tolerance, type: p.type ?? 'closed', minShell: p.minShell, voxel: p.voxel, gap: p.gap })) as RepairResult
      return [withNote(r.body, describeRepair(r.report))]
    },
  },
  {
    type: 'meshMakeClosed', label: 'Make Closed Mesh', icon: ShieldCheck, command: 'mesh.makeClosed',
    params: [{ type: 'number', key: 'tolerance', help: 'Points closer than this are merged into one, in mm. Closes tiny cracks between triangles.', label: 'Weld distance', unit: 'mm', min: 0, step: 0.001, default: 0.001 }],
    async run(k, p, b, ids) {
      const r = (await k.call('meshRepair', { id: ids.id, name: b.name, key: b.key, tolerance: p.tolerance, type: 'closed' })) as RepairResult
      return [withNote(r.body, describeRepair(r.report))]
    },
  },
  {
    type: 'meshReverse', label: 'Reverse Normal', icon: ArrowsLeftRight, command: 'mesh.reverse', params: [],
    async run(k, _p, b, ids) { return [asBody(await k.call('meshReverse', { id: ids.id, name: b.name, key: b.key }))] },
  },
  {
    type: 'meshToBrep', label: 'Convert Mesh', icon: CubeFocus, command: 'mesh.toBrep', meshOnly: true,
    params: [
      {
        type: 'enum', key: 'mode', label: 'Type', display: 'segmented', default: 'prismatic',
        help: 'Prismatic: flat face groups become real planar faces, so Fillet, Shell, Hole and Press/Pull work on them (round holes and bosses become cylinders, other curved parts stay as small flat faces). Faceted: every triangle becomes a face.',
        options: [{ value: 'prismatic', label: 'Prismatic' }, { value: 'faceted', label: 'Faceted' }],
      },
      { type: 'number', key: 'angle', help: 'Prismatic: neighbouring triangles that meet at a sharper angle than this belong to different faces, in degrees.', label: 'Face split angle', unit: 'deg', min: 1, max: 89, step: 1, default: 20, visibleWhen: (v) => v.mode !== 'faceted' },
      { type: 'number', key: 'tolerance', help: 'Prismatic: a group of triangles this close to flat becomes one plane, in mm.', label: 'Flatness', unit: 'mm', min: 0.0001, step: 0.01, default: 0.05, visibleWhen: (v) => v.mode !== 'faceted' },
      { type: 'number', key: 'maxTris', help: 'The most flat faces the solid may get. Every triangle that is not part of a plane becomes a face, and OpenCascade slows down with thousands of them.', label: 'Face limit', min: 100, max: 50000, step: 500, default: 5000 },
    ],
    async run(k, p, b, ids) {
      const r = (await k.call('meshToBrep', { id: ids.id, name: b.name, key: b.key, mode: p.mode === 'faceted' ? 'faceted' : 'prismatic', crease: (p.angle as number | undefined) ?? 20, tolerance: (p.tolerance as number | undefined) ?? 0.05, maxTris: (p.maxTris as number | undefined) ?? 5000 })) as MeshToBrepResult
      return [withNote(r.body, r.report.mode === 'faceted'
        ? `Converted to a solid: ${r.report.faces} triangle faces.`
        : `Converted to a solid: ${r.report.planes} planar face${r.report.planes === 1 ? '' : 's'}${r.report.cylinders ? ` and ${r.report.cylinders} cylinder${r.report.cylinders === 1 ? '' : 's'}` : ''}${r.report.triangleFaces ? ` and ${r.report.triangleFaces} triangle faces where the surface is curved` : ''}.`)]
    },
  },
  {
    type: 'meshConvert', label: 'Convert to Mesh', icon: Cube, command: 'mesh.convert', brepOnly: true, params: refinementParams(),
    async run(k, p, b, ids) { const r = refinement(p); return [asBody(await k.call('meshConvert', { id: ids.id, name: b.name, key: b.key, tol: r.tol, ang: r.ang }))] },
  },
]

function targets(p: ParamValues, find: (id: string) => Body | undefined, tool: BodyTool): Body[] {
  const ids = bodyIdsOf((p.bodies as string[]) ?? [])
  if (!ids.length) throw new Error('Select the bodies to modify')
  const bodies = ids.map(find)
  if (bodies.some((b) => !b)) throw new Error('A selected body no longer exists')
  if (tool.meshOnly && bodies.some((b) => b!.kind !== 'mesh')) throw new Error('Only mesh bodies can be converted to a B-rep; this one is already a solid')
  if (tool.brepOnly && bodies.some((b) => b!.kind !== 'brep')) throw new Error('Only solid (B-rep) bodies can be converted; mesh bodies are already meshes')
  if (tool.brepOnly && bodies.some((b) => b!.surface)) throw new Error('An open surface cannot be turned into a mesh body: stitch it closed or thicken it first')
  return bodies as Body[]
}

for (const tool of TOOLS) {
  const schema: ParamSchema = { id: tool.type, title: tool.label, params: [bodiesParam, ...tool.params] }
  registerFeature({
    type: tool.type,
    label: tool.label,
    icon: tool.icon,
    schema,
    async compute(ctx, p) {
      const out: Body[] = []
      let n = 1
      for (const b of targets(p, (id) => ctx.body(id), tool)) out.push(...(await tool.run(ctx.kernel, p, b, { id: b.id, otherId: ctx.newBodyId(n++), all: ctx.bodies })))
      tell(ctx.feature.id, takeNote(out))
      return { bodies: out }
    },
    preview({ values, setValues }) {
      let cur = values
      const runner = createRunner(async (stale) => {
        let list: Body[], p: ParamValues
        try { p = resolveParams(schema, cur); list = targets(p, (id) => useDoc.getState().geometry.find((b) => b.id === id), tool) } catch { clearPreview(); resetManip(); return }
        if (tool.arrows) showArrows(tool.arrows(p, list), p, (patch) => { cur = { ...cur, ...patch }; setValues(cur) })
        const out: Body[] = []
        try {
          for (const b of list) out.push(...(await tool.run(getKernel(), p, b, { id: 'preview-' + b.id, otherId: 'preview-other-' + b.id, all: useDoc.getState().geometry })))
        } catch (e) {
          clearPreview()
          if (!stale()) useUi.setState({ inspectorNotice: e instanceof Error ? e.message : String(e) })
          return
        }
        if (stale()) return
        takeNote(out) // what a step reports is shown as a message when it is accepted; the notice line is for errors
        useUi.setState({ inspectorNotice: null })
        setPreview(out.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), list.map((b) => b.id))
      }, 220)
      runner.schedule()
      return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clearPreview(); resetManip(); useUi.setState({ inspectorNotice: null }) } }
    },
  })
}

/** Ribbon / palette entry: open the tool with the selected bodies (or the only body). */
export function startMeshTool(type: string) {
  const geometry = useDoc.getState().geometry
  const tool = TOOLS.find((t) => t.type === type)!
  const usable = (b: Body) => (!tool.brepOnly || (b.kind === 'brep' && !b.surface)) && (!tool.meshOnly || b.kind === 'mesh')
  let ids = [...new Set(useUi.getState().selection.filter((r) => ['body', 'mesh', 'face', 'edge'].includes(r.kind)).map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id && usable(b)))
  const pool = geometry.filter(usable)
  if (!ids.length && pool.length === 1) ids = [pool[0].id]
  const faces = type === 'meshSmooth' ? useUi.getState().selection.filter((r) => r.kind === 'face') : []
  createFeature(type, { bodies: ids, ...(faces.length ? { faces: encodeSelection(faces, geometry) } : {}) }, tool.command)
}

export const MESH_COMMANDS = TOOLS.map((t) => ({ id: t.command, type: t.type, label: t.label, icon: t.icon }))

// ---------------------------------------------------------------- Delete Faces on a mesh

const meshDeleteFacesSchema: ParamSchema = {
  id: 'meshDeleteFaces',
  title: 'Delete faces',
  params: [{ type: 'selection-ref', key: 'faces', help: 'The faces of a mesh body to remove. The mesh is left open where they were; Repair closes it again.', label: 'Faces', accepts: ['face'], multiple: true, required: true, pick: true, default: [] }],
}
registerFeature({
  type: 'meshDeleteFaces',
  label: 'Delete Faces',
  icon: Trash,
  schema: meshDeleteFacesSchema,
  async compute(ctx, p) {
    const by = new Map<string, { body: Body; faces: number[] }>()
    for (const s of p.faces as string[]) {
      const r = decodeRef(s)
      const hit = r && r.kind === 'face' ? resolveFace(r, ctx.bodies) : null
      if (!hit) throw new Error('A face to delete no longer exists (an edit upstream removed it). Pick it again.')
      if (hit.body.kind !== 'mesh') throw new Error('Delete Faces on this step needs mesh bodies; use Delete Face for a solid')
      const g = by.get(hit.body.id) ?? by.set(hit.body.id, { body: hit.body, faces: [] }).get(hit.body.id)!
      if (!g.faces.includes(hit.index)) g.faces.push(hit.index)
    }
    if (!by.size) throw new Error('Select the faces to delete')
    const out: Body[] = []
    let count = 0
    for (const g of by.values()) {
      out.push((await ctx.kernel.call('meshDeleteFaces', { id: g.body.id, name: g.body.name, key: g.body.key, faces: g.faces })) as Body)
      count += g.faces.length
    }
    tell(ctx.feature.id, `Deleted ${count} face${count === 1 ? '' : 's'}. The mesh is open where they were; Mesh > Repair closes it again.`)
    return { bodies: out }
  },
})
