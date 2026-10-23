/** Extrude: sketch profiles or planar faces -> solid, combined with Join / Cut / Intersect / New body. */
import { ArrowFatLineUp } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { encodeSelection } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { Body } from '@/kernel/types'
import { useSketchData } from '@/sketch/draw'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, resetManip, setPreview, useManip, useProfilePick } from '@/viewport/preview'
import { ctxEnv, combine, liveEnv, profileRef, resolveInputs, type Inputs } from '../modeling'
import { createRunner, watchSelection } from '../previewKit'

export const extrudeSchema: ParamSchema = {
  id: 'extrude',
  title: 'Extrude',
  params: [
    { type: 'selection-ref', key: 'profiles', label: 'Profiles', accepts: ['sketch', 'face'], multiple: true, required: true, default: [] },
    {
      type: 'group',
      label: 'Extent',
      children: [
        {
          type: 'enum', key: 'direction', label: 'Direction', display: 'segmented', default: 'one',
          options: [{ value: 'one', label: 'One side' }, { value: 'sym', label: 'Symmetric' }, { value: 'two', label: 'Two sides' }],
        },
        { type: 'number', key: 'distance', label: 'Distance', unit: 'mm', step: 0.5, default: 10 },
        { type: 'number', key: 'distance2', label: 'Distance 2', unit: 'mm', min: 0, step: 0.5, default: 5, visibleWhen: (v) => v.direction === 'two' },
        { type: 'number', key: 'taper', label: 'Taper angle', unit: 'deg', min: -89, max: 89, step: 0.5, default: 0 },
      ],
    },
    {
      type: 'enum', key: 'operation', label: 'Operation', display: 'select', default: 'join',
      options: [
        { value: 'join', label: 'Join' }, { value: 'cut', label: 'Cut' },
        { value: 'intersect', label: 'Intersect' }, { value: 'new', label: 'New body' },
      ],
    },
    { type: 'selection-ref', key: 'targets', label: 'Target bodies', accepts: ['body'], multiple: true, default: [], visibleWhen: (v) => v.operation !== 'new' },
  ],
}

interface ExtrudeP { profiles: string[]; direction: string; distance: number; distance2: number; taper: number; operation: string; targets: string[] }
const asP = (v: ParamValues) => v as unknown as ExtrudeP

/** Arguments for the worker's extrudeTool op. */
function toolArgs(p: ExtrudeP, inp: Inputs, id: string, name: string) {
  return { id, name, groups: inp.groups, faces: inp.faces, mode: p.direction, d1: p.distance, d2: p.distance2, faceDir: p.operation === 'cut' ? -1 : 1, taper: p.taper ?? 0 }
}

registerFeature({
  type: 'extrude',
  label: 'Extrude',
  icon: ArrowFatLineUp,
  schema: extrudeSchema,
  async compute(ctx, raw) {
    const p = asP(raw)
    const inp = resolveInputs(p.profiles, ctxEnv(ctx))
    if (!inp.groups.length && !inp.faces.length) throw new Error(inp.missing ? 'The profile or face no longer exists' : 'Select a profile or face to extrude')
    const tool = (await ctx.kernel.call('extrudeTool', toolArgs(p, inp, ctx.newBodyId(), ctx.feature.name))) as Body
    return combine(ctx, tool, p.operation, p.targets)
  },
  preview: (ctx) => extrudePreview(ctx),
})

function extrudePreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  const ui = useUi

  const manip = (p: ExtrudeP, inp: Inputs) => {
    if (!inp.anchor || !inp.normal) return resetManip()
    const sym = p.direction === 'sym'
    const sgn = inp.faces.length && !inp.groups.length && p.operation === 'cut' ? -1 : 1
    useManip.setState({
      active: true,
      origin: inp.anchor,
      dir: [inp.normal[0] * sgn, inp.normal[1] * sgn, inp.normal[2] * sgn],
      tip: sym ? Math.abs(p.distance) / 2 : p.distance,
      factor: sym ? 2 : 1,
      label: (v) => `${v.toFixed(2)} mm`,
      onChange: (v) => {
        const next = { ...cur, distance: v }
        cur = next
        setValues(next)
      },
    })
  }

  const runner = createRunner(async (stale) => {
    let p: ExtrudeP
    try { p = asP(resolveParams(extrudeSchema, cur)) } catch { clearPreview(); return }
    const inp = resolveInputs(p.profiles, liveEnv())
    manip(p, inp)
    if (!inp.groups.length && !inp.faces.length) { clearPreview(); return }
    const tool = (await getKernel().call('extrudeTool', toolArgs(p, inp, 'preview', 'preview'))) as Body
    if (stale()) return
    setPreview([{ mesh: tool.mesh, kind: p.operation === 'cut' ? 'cut' : 'add' }])
  })

  const sync = () => useProfilePick.setState({
    active: true,
    selected: (cur.profiles as string[]).filter((s) => s.startsWith('prof:')),
    toggle: (ref) => {
      const list = cur.profiles as string[]
      const next = list.includes(ref) ? list.filter((r) => r !== ref) : [...list, ref]
      cur = { ...cur, profiles: next }
      setValues(cur)
    },
  })
  sync()
  ui.getState().setSelectionFilter('face')

  const off = watchSelection(['face'], () => {
    const faces = encodeSelection(ui.getState().selection.filter((r) => r.kind === 'face'), useDoc.getState().geometry)
    cur = { ...cur, profiles: [...(cur.profiles as string[]).filter((s) => s.startsWith('prof:')), ...faces] }
    setValues(cur)
  })

  runner.schedule()
  return {
    update(v) { cur = v; sync(); runner.schedule() },
    dispose() {
      off()
      runner.dispose()
      clearPreview()
      resetManip()
      useProfilePick.setState({ active: false, selected: [], toggle: null })
    },
  }
}

/** Ribbon command (E): preselect the selected faces / sketch profiles. */
export function startExtrude() {
  const ui = useUi.getState()
  const doc = useDoc.getState()
  const profiles: string[] = []
  const faces = ui.selection.filter((r) => r.kind === 'face')
  if (faces.length) profiles.push(...encodeSelection(faces, doc.geometry))
  const data = useSketchData.getState().data
  const visible = doc.features.filter((f, i) => f.type === 'sketch' && i < doc.rollback && !f.suppressed && data[f.id])
  const chosen = ui.selection.filter((r) => r.kind === 'sketch').map((r) => r.id)
  const pool = chosen.length ? visible.filter((f) => chosen.includes(f.id)) : visible
  const all = pool.flatMap((f) => data[f.id].profiles.map((p) => profileRef(f.id, p.key)))
  if (!profiles.length && (chosen.length ? all.length : all.length === 1)) profiles.push(...all)
  createFeature('extrude', { profiles }, 'solid.extrude')
}
