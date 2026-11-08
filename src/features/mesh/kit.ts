/**
 * Shared plumbing of the Mesh tab tools in features/mesh: one registration that gives a tool a dialog, a live preview in the viewport
 * (the real kernel result, drawn over the body) and a timeline step that can be edited again.
 */
import type { Icon } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefReport } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import type { FeatureCtx } from '@/doc/types'
import { getKernel, type KernelClient } from '@/kernel/client'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamDef, ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, resetManip, setPreview } from '@/viewport/preview'
import { createRunner } from '../previewKit'
import { clearHandles } from '../handleKit'
import { liveRefEnv, type RefEnv } from '../modeling-tools/geo'

export const envOf = (ctx: FeatureCtx): RefEnv => ({ bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as unknown as RefEnv['kernel'] })

export const bodiesParam: ParamDef = { type: 'selection-ref', key: 'bodies', help: 'The bodies to work on. Click them in the viewport or the Browser.', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [] }

/** What a tool run is given. `bodies` are those of the document (compute) or the live geometry (preview). */
export interface RunCtx { kernel: KernelClient; env: RefEnv; report: RefReport; /** id of the n-th extra body a step makes (n from 1); a body that is changed keeps its own id */ newId: (n: number) => string; preview: boolean }

export interface MeshTool {
  type: string
  label: string
  icon: Icon
  command: string
  schema: ParamSchema
  /** the bodies the step works on (default: the `bodies` param) */
  targets?(p: ParamValues, env: RefEnv, report: RefReport): Body[]
  /** make the new bodies; `src` are the bodies from targets() */
  run(p: ParamValues, src: Body[], c: RunCtx): Promise<{ bodies: Body[]; note?: string }>
  /** drag handles in the viewport for the current values (async: a picked face has to be resolved first) */
  handles?(p: ParamValues, src: Body[], env: RefEnv, apply: (patch: ParamValues) => void): Promise<void>
  /** called when the dialog opens (paint tools); the handle hears every change of the values and the close */
  open?(c: { values: ParamValues; setValues(v: ParamValues): void }): { update?(v: ParamValues): void; dispose?(): void } | void
}

const bodyTargets = (p: ParamValues, env: RefEnv): Body[] => {
  const ids = ((p.bodies as string[]) ?? []).map((s) => { try { const r = JSON.parse(s) as { bodyId: string }; return r.bodyId } catch { return s } })
  if (!ids.length) throw new Error('Select the bodies to modify')
  const bodies = [...new Set(ids)].map((id) => env.bodies.find((b) => b.id === id))
  if (bodies.some((b) => !b)) throw new Error('A selected body no longer exists')
  return bodies as Body[]
}

export function registerMeshTool(tool: MeshTool) {
  const schema = tool.schema
  const targets = tool.targets ?? ((p, env) => bodyTargets(p, env))
  const meshOnly = (list: Body[]) => {
    const bad = list.find((b) => b.kind !== 'mesh')
    if (bad) throw new Error(`${tool.label} works on mesh bodies; ${bad.name} is a solid (use Convert to Mesh first)`)
    return list
  }
  registerFeature({
    type: tool.type,
    label: tool.label,
    icon: tool.icon,
    schema,
    async compute(ctx, p) {
      const report = new RefReport()
      const env = envOf(ctx)
      const src = meshOnly(targets(p, env, report))
      const out = await tool.run(p, src, { kernel: ctx.kernel, env, report, newId: (k) => ctx.newBodyId(k), preview: false })
      return { bodies: out.bodies, warning: report.warning, reboundRefs: report.flagged }
    },
    preview({ values, setValues }) {
      let cur = values
      const opened = tool.open?.({ values, setValues: (v) => { cur = v; setValues(v) } })
      const runner = createRunner(async (stale) => {
        let p: ParamValues, src: Body[]
        const env = liveRefEnv()
        try { p = resolveParams(schema, cur); src = meshOnly(targets(p, env, new RefReport())) } catch { clearPreview(); clearHandles(); useUi.setState({ inspectorNotice: null }); return }
        if (tool.handles) {
          try { await tool.handles(p, src, env, (patch) => { cur = { ...cur, ...patch }; setValues(cur) }) } catch { clearHandles() }
        }
        let out: { bodies: Body[]; note?: string }
        try {
          out = await tool.run(p, src, { kernel: getKernel(), env, report: new RefReport(), newId: (k) => `preview-other-${k}`, preview: true })
        } catch (e) {
          if (!stale()) { clearPreview(); useUi.setState({ inspectorNotice: e instanceof Error ? e.message : String(e) }) }
          return
        }
        if (stale()) return
        useUi.setState({ inspectorNotice: out.note ?? null })
        setPreview(out.bodies.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), src.map((b) => b.id))
      }, 240)
      runner.schedule()
      return {
        update(v) { cur = v; opened?.update?.(v); runner.schedule() },
        dispose() { runner.dispose(); clearPreview(); resetManip(); clearHandles(); useUi.setState({ inspectorNotice: null }); opened?.dispose?.() },
      }
    },
  })
}

/** Open a tool's dialog with `initial` values and the selected bodies filled in. */
export function startTool(type: string, command: string, initial: ParamValues = {}) {
  const geometry = useDoc.getState().geometry
  const sel = useUi.getState().selection
  const meshes = geometry.filter((b) => b.kind === 'mesh')
  let ids = [...new Set(sel.filter((r) => ['body', 'mesh', 'face', 'edge'].includes(r.kind)).map((r) => r.id))].filter((id) => meshes.some((b) => b.id === id))
  if (!ids.length && meshes.length === 1) ids = [meshes[0].id]
  createFeature(type, { bodies: ids, ...initial }, command)
}
