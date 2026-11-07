/** Mesh workspace features: Smooth, Repair and Convert to Mesh (kernel ops in kernel/mesh-ops.ts). Plane Cut, Reduce and Remesh are in features/mesh. */
import { Cube, MagicWand, Waves, type Icon } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { bodyIdsOf } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { getKernel, type KernelClient } from '@/kernel/client'
import type { RepairResult } from '@/kernel/mesh-ops'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamDef, ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, resetManip, setPreview } from '@/viewport/preview'
import { createRunner } from './previewKit'
import { showArrows, type ArrowSpec } from './handleKit'
import { refinement, refinementParams } from './mesh/refine'

interface Ids { id: string; otherId: string }
interface BodyTool {
  type: string
  label: string
  icon: Icon
  command: string
  params: ParamDef[]
  /** only B-rep bodies (Convert) */
  brepOnly?: boolean
  run(kernel: KernelClient, p: ParamValues, b: Body, ids: Ids): Promise<Body[]>
  /** the drag arrows of the tool in the viewport */
  arrows?(p: ParamValues, bodies: Body[]): ArrowSpec[]
}

const bodiesParam: ParamDef = { type: 'selection-ref', key: 'bodies', help: 'The bodies to work on. Click them in the viewport or the Browser.', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [] }
const asBody = (b: unknown) => b as Body

const TOOLS: BodyTool[] = [
  // Plane Cut, Reduce and Remesh live in features/mesh/tools.ts
  {
    type: 'meshSmooth', label: 'Smooth', icon: Waves, command: 'mesh.smooth',
    params: [
      { type: 'number', key: 'iterations', help: 'How many smoothing passes to run. More passes give a smoother, slightly smaller surface.', label: 'Iterations', min: 1, max: 200, step: 1, default: 10 },
      { type: 'number', key: 'strength', help: 'How far each point moves toward its neighbours per pass (0 to 1). Lower is gentler.', label: 'Strength', min: 0, max: 1, step: 0.05, default: 0.5 },
    ],
    async run(k, p, b, ids) { return [asBody(await k.call('meshSmooth', { id: ids.id, name: b.name, key: b.key, iterations: p.iterations, strength: p.strength }))] },
  },
  {
    type: 'meshRepair', label: 'Repair', icon: MagicWand, command: 'mesh.repair',
    params: [{ type: 'number', key: 'tolerance', help: 'Points closer than this are merged into one, in mm. Closes tiny cracks between triangles.', label: 'Weld distance', unit: 'mm', min: 0, step: 0.001, default: 0.001 }],
    async run(k, p, b, ids) { return [((await k.call('meshRepair', { id: ids.id, name: b.name, key: b.key, tolerance: p.tolerance })) as RepairResult).body] },
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
      for (const b of targets(p, (id) => ctx.body(id), tool)) out.push(...(await tool.run(ctx.kernel, p, b, { id: b.id, otherId: ctx.newBodyId(n++) })))
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
          for (const b of list) out.push(...(await tool.run(getKernel(), p, b, { id: 'preview-' + b.id, otherId: 'preview-other-' + b.id })))
        } catch { clearPreview(); return }
        if (stale()) return
        setPreview(out.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), list.map((b) => b.id))
      }, 220)
      runner.schedule()
      return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clearPreview(); resetManip() } }
    },
  })
}

/** Ribbon / palette entry: open the tool with the selected bodies (or the only body). */
export function startMeshTool(type: string) {
  const geometry = useDoc.getState().geometry
  const tool = TOOLS.find((t) => t.type === type)!
  const usable = (b: Body) => !tool.brepOnly || (b.kind === 'brep' && !b.surface)
  let ids = [...new Set(useUi.getState().selection.filter((r) => ['body', 'mesh', 'face', 'edge'].includes(r.kind)).map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id && usable(b)))
  const pool = geometry.filter(usable)
  if (!ids.length && pool.length === 1) ids = [pool[0].id]
  createFeature(type, { bodies: ids }, tool.command)
}

export const MESH_COMMANDS = TOOLS.map((t) => ({ id: t.command, type: t.type, label: t.label, icon: t.icon }))
