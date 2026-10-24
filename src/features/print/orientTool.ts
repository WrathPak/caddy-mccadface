/** Auto orient dialog: ranks print orientations, previews one on the bodies and applies it as a Move feature. */
import { bodyIdsOf, encodeSelection } from '@/doc/refs'
import { resolveParams } from '@/doc/params'
import { useDoc } from '@/doc/store'
import type { Body, Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import { missingRequired, type ParamSchema, type ParamValues } from '@/ui/schema'
import { pivotOf, useMove } from '../move'
import type { MeshIn } from './analysis'
import { autoOrient, orientMove, type OrientResult } from './orient'
import { currentSettings } from './settings'

export const orientSchema: ParamSchema = {
  id: 'autoOrient',
  title: 'Auto orient',
  params: [
    { type: 'selection-ref', key: 'bodyIds', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [], help: 'The bodies to turn. They are turned together, so their positions stay in step.' },
    {
      type: 'enum', key: 'goal', label: 'Minimize', display: 'segmented', default: 'support', options: [{ value: 'support', label: 'Support' }, { value: 'overhang', label: 'Overhang' }],
      help: 'Support: the least support material. Overhang: the least surface that hangs over empty air. Support also counts how tall the supports would be.',
    },
    { type: 'number', key: 'angle', label: 'Overhang angle', unit: 'deg', min: 5, max: 85, step: 5, default: 45, help: 'Steepest overhang that prints without support, measured from vertical. It comes from the Print settings.' },
    { type: 'number', key: 'choice', label: 'Option', unit: '', min: 1, max: 10, step: 1, default: 1, help: 'Which orientation to use. 1 is the best one found, 2 the next best, and so on.' },
    {
      type: 'info', key: 'report', label: 'Result', default: '',
      help: 'What the chosen orientation does compared with the one the part has now.',
      text: () => state.text,
    },
  ],
}

const state: { text: string; result: OrientResult | null; mesh: MeshIn | null; bodies: Body[] } = { text: 'Choose bodies to see the best way up.', result: null, mesh: null, bodies: [] }

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))

function mergeMeshes(bodies: Body[]): MeshIn {
  let pc = 0, ic = 0
  for (const b of bodies) { pc += b.mesh.positions.length; ic += b.mesh.indices.length }
  const positions = new Float32Array(pc), indices = new Uint32Array(ic)
  let po = 0, io = 0
  for (const b of bodies) {
    for (let i = 0; i < b.mesh.indices.length; i++) indices[io + i] = b.mesh.indices[i] + po / 3
    positions.set(b.mesh.positions, po)
    po += b.mesh.positions.length
    io += b.mesh.indices.length
  }
  return { positions, indices }
}

/** The Move values for option `choice` (1-based) of a result. */
export function moveFor(mesh: MeshIn, result: OrientResult, choice: number) {
  const cand = result.ranked[Math.min(result.ranked.length, Math.max(1, choice)) - 1]
  return { cand, ...orientMove(mesh, cand.down) }
}

function describe(result: OrientResult, choice: number): string {
  const cand = result.ranked[Math.min(result.ranked.length, Math.max(1, choice)) - 1]
  const cur = result.current
  const line = (label: string, c: typeof cur) => `${label}: ${fmt(c.supportVolume)} mm3 of support, ${fmt(c.overhangArea)} mm2 of overhang, ${fmt(c.height)} mm tall`
  return `${line('Now', cur)}\n${line(`Option ${choice}`, cand)}`
}

function preview(values: ParamValues) {
  let p
  try { p = resolveParams(orientSchema, values) } catch { return }
  const ids = bodyIdsOf(p.bodyIds as string[])
  const bodies = useDoc.getState().geometry.filter((b) => ids.includes(b.id))
  if (!bodies.length) { useMove.setState({ active: false, bodyIds: [], push: null }); state.text = 'Choose bodies to see the best way up.'; return }
  const mesh = mergeMeshes(bodies)
  const res = autoOrient(mesh, { angle: p.angle as number, goal: p.goal as 'support' | 'overhang' })
  state.result = res
  state.mesh = mesh
  state.bodies = bodies
  state.text = describe(res, p.choice as number)
  const mv = moveFor(mesh, res, p.choice as number)
  useMove.setState({ active: true, bodyIds: bodies.map((b) => b.id), pivot: pivotOf(bodies), translate: mv.translate, rotate: mv.rotate, scale: 1, mode: 'translate', push: null })
}

/** Ribbon command. */
export function startAutoOrient() {
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  const { geometry } = useDoc.getState()
  let ids = [...new Set(ui.selection.map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id))
  if (!ids.length) ids = geometry.filter((b) => !ui.hiddenIds[b.id]).map((b) => b.id)
  let values: ParamValues = { bodyIds: encodeSelection(ids.map((id) => ({ kind: 'body' as const, id })), geometry), goal: 'support', angle: currentSettings().overhang, choice: 1 }
  const finish = () => {
    useMove.setState({ active: false, bodyIds: [], push: null })
    useUi.getState().closeInspector()
    useUi.getState().setActiveTool(null)
  }
  const session = (v: ParamValues) => ({
    schema: orientSchema,
    values: v,
    onChange: (nv: ParamValues) => {
      const heavy = nv.goal !== values.goal || nv.angle !== values.angle || nv.bodyIds !== values.bodyIds
      values = nv
      if (heavy || !state.result) preview(nv)
      else {
        const p = resolveParams(orientSchema, nv)
        state.text = describe(state.result, p.choice as number)
        const mv = moveFor(state.mesh!, state.result, p.choice as number)
        useMove.setState({ translate: mv.translate, rotate: mv.rotate })
      }
    },
    onOk: (nv: ParamValues) => {
      if (missingRequired(orientSchema, nv).length) return
      const p = resolveParams(orientSchema, nv)
      const bodies = useDoc.getState().geometry.filter((b) => bodyIdsOf(p.bodyIds as string[]).includes(b.id))
      if (!bodies.length || !state.result || !state.mesh) return
      const mv = moveFor(state.mesh, state.result, p.choice as number)
      finish()
      useDoc.getState().addFeature('move', { bodyIds: p.bodyIds as string[], gizmo: 'translate', translate: mv.translate as Vec3, rotate: mv.rotate as Vec3, scale: 1 }, 'Orient for printing')
    },
    onCancel: finish,
  })
  preview(values)
  ui.setActiveTool('print.orient')
  ui.openInspector(session(values))
}

export { state as orientState }
