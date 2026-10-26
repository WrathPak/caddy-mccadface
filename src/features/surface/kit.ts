/**
 * Shared plumbing of the surface tools: one `SurfaceTool` describes a timeline feature (schema, how to build its bodies from
 * the params) and `registerSurfaceTool` turns it into a registered feature with a live preview, like the direct edits do.
 */
import type { Icon } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, bodyIdsOf } from '@/doc/refs'
import type { FeatureCtx, FeatureResult, PreviewCtx, PreviewHandle } from '@/doc/types'
import type { Body, Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValue, ParamValues } from '@/ui/schema'
import { clearPreview, resetManip, setPreview, useCurvePick, useManip } from '@/viewport/preview'
import { liveRefEnv, type RefEnv } from '../modeling-tools/geo'
import { createRunner } from '../previewKit'

export interface BuildEnv extends RefEnv {
  /** the feature running (names of the faces it makes are rooted there) and its name (the name of a new body) */
  fid: string
  name: string
  /** id of the n-th new body (the feature id for the first) */
  newId(n?: number): string
}
export interface Built {
  bodies: Body[]
  remove?: string[]
  warning?: string
  /** bodies to show faint while the preview stands in for them (default: the ones replaced or removed) */
  dim?: string[]
  /** a result drawn as an addition (a new surface) or as a replacement */
  kind?: 'add' | 'result'
}
export interface SurfaceTool {
  type: string
  label: string
  icon: Icon
  schema: ParamSchema
  build(p: ParamValues, env: BuildEnv, report: RefReport): Promise<Built>
  /** the arrow to drag in the viewport: origin, direction and the parameter it edits */
  manip?(p: ParamValues, env: BuildEnv): Promise<{ origin: Vec3; dir: Vec3; key: string; factor?: number } | null>
  /** the selection filter to start with in the dialog */
  filter?: 'face' | 'body' | 'edge'
  /** params whose values are curve refs: the chosen ones light up while the curve picker is on */
  curves?: string[]
}

export const call = async <T>(env: RefEnv, op: string, args: unknown) => (await env.kernel.call(op, args)) as T

const isCurveRef = (s: string) => s.startsWith('crv:') || s.startsWith('prof:')
const curveRefsOf = (keys: string[] | undefined, v: ParamValues) => (keys ?? []).flatMap((k) => ((v[k] as string[]) ?? []).filter(isCurveRef))

export function registerSurfaceTool(d: SurfaceTool) {
  registerFeature({
    type: d.type,
    label: d.label,
    icon: d.icon,
    schema: d.schema,
    async compute(ctx: FeatureCtx, raw): Promise<FeatureResult> {
      const report = new RefReport()
      const env: BuildEnv = { bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as unknown as RefEnv['kernel'], fid: ctx.feature.id, name: ctx.feature.name, newId: ctx.newBodyId }
      const r = await d.build(raw, env, report)
      return { bodies: r.bodies, remove: r.remove, warning: [report.warning, r.warning].filter(Boolean).join('; ') || undefined, reboundRefs: report.flagged, upgrades: report.upgradeMap }
    },
    preview: (ctx) => surfacePreview(d, ctx),
  })
}

function surfacePreview(d: SurfaceTool, { values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  const ui = useUi
  const before = ui.getState().selectionFilter
  if (d.filter) ui.getState().setSelectionFilter(d.filter)
  const publish = () => useCurvePick.setState({ selected: curveRefsOf(d.curves, cur) })
  publish()
  const runner = createRunner(async (stale) => {
    let p: ParamValues
    try { p = resolveParams(d.schema, cur) } catch { clearPreview(); resetManip(); return }
    const env: BuildEnv = { ...liveRefEnv(), fid: 'preview', name: 'preview', newId: (n) => (n ? `preview.${n}` : 'preview') }
    try {
      if (d.manip) {
        const m = await d.manip(p, env)
        if (m && !stale()) {
          const key = m.key, factor = m.factor ?? 1
          useManip.setState({
            active: true, origin: m.origin, dir: m.dir, tip: (p[key] as number) / factor, factor, label: (v) => `${v.toFixed(2)} mm`,
            onChange: (v) => { cur = { ...cur, [key]: v }; setValues(cur) },
          })
        } else if (!m) resetManip()
      }
      const r = await d.build(p, env, new RefReport())
      if (stale()) return
      const kind = r.kind ?? 'result'
      // whatever the result replaces stays in the scene, faint but pickable, so more faces or edges can still be picked
      setPreview(r.bodies.map((b) => ({ mesh: b.mesh, kind })), [], r.dim ?? [...r.bodies.map((b) => b.id), ...(r.remove ?? [])])
      ui.setState({ inspectorNotice: r.warning ?? null })
    } catch (e) {
      if (!stale()) { clearPreview(); ui.setState({ inspectorNotice: e instanceof Error && !(e instanceof RefError) ? e.message : null }) }
    }
  })
  let disposed = false
  runner.schedule()
  return {
    // dropping the curve picks below changes the selection, which the open Inspector answers with an update: ignore it
    update(v) { if (disposed) return; cur = v; publish(); runner.schedule() },
    dispose() {
      disposed = true
      runner.dispose()
      clearPreview()
      resetManip()
      useCurvePick.setState({ selected: [] })
      ui.setState((s) => (s.selection.some((r) => r.kind === 'curve') ? { inspectorNotice: null, selection: s.selection.filter((r) => r.kind !== 'curve') } : { inspectorNotice: null }))
      if (d.filter) ui.getState().setSelectionFilter(before)
    },
  }
}

// ---------------------------------------------------------------- helpers for builds

/** The surface bodies behind body refs (and the bodies of face refs). A solid is refused with a message that says what to do. */
export function surfaceBodies(refs: string[], env: { bodies: Body[] }, what: string): Body[] {
  const ids = bodyIdsOf(refs)
  if (!ids.length) throw new Error(`Select ${what}`)
  return ids.map((id) => {
    const b = env.bodies.find((x) => x.id === id)
    if (!b) throw new RefError(`A surface you picked no longer exists (an edit upstream removed it). Pick it again.`, refs)
    if (b.kind !== 'brep' || !b.surface) throw new Error(`${b.name} is a ${b.kind === 'mesh' ? 'mesh' : 'solid'}: this tool works on surfaces`)
    return b
  })
}

export const asNumber = (v: ParamValue) => v as number
