/** Move / transform feature: translate, rotate (euler deg) and uniform scale about the selection's bbox center. */
import { create } from 'zustand'
import { ArrowsOutCardinal } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { bodyIdsOf } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { createFeature } from '@/doc/editor'
import { bbox, type Body, type Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'

export type GizmoMode = 'translate' | 'rotate' | 'scale'

export const moveSchema: ParamSchema = {
  id: 'move',
  title: 'Move / Transform',
  params: [
    { type: 'selection-ref', key: 'bodyIds', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [] },
    {
      type: 'enum', key: 'gizmo', label: 'Gizmo', display: 'segmented', default: 'translate',
      options: [{ value: 'translate', label: 'Move' }, { value: 'rotate', label: 'Rotate' }, { value: 'scale', label: 'Scale' }],
    },
    { type: 'vector3', key: 'translate', label: 'Translate', unit: 'mm', step: 1, default: [0, 0, 0] },
    { type: 'vector3', key: 'rotate', label: 'Rotate', unit: 'deg', step: 5, default: [0, 0, 0] },
    { type: 'number', key: 'scale', label: 'Scale', unit: '', min: 0.001, step: 0.1, default: 1 },
  ],
}

/** Union bbox center of the bodies (the pivot for rotate/scale). */
export function pivotOf(bodies: Body[]): Vec3 {
  if (!bodies.length) return [0, 0, 0]
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const b of bodies) {
    const bb = bbox(b.mesh.positions)
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], bb.min[k]); max[k] = Math.max(max[k], bb.max[k]) }
  }
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
}

/** Live transform preview shared with the viewport (gizmo + ghosted bodies). */
interface MoveState {
  active: boolean
  bodyIds: string[]
  pivot: Vec3
  translate: Vec3
  rotate: Vec3
  scale: number
  mode: GizmoMode
  /** set by the gizmo while dragging, consumed by the preview's setValues */
  push: ((v: ParamValues) => void) | null
}
export const useMove = create<MoveState>(() => ({
  active: false, bodyIds: [], pivot: [0, 0, 0], translate: [0, 0, 0], rotate: [0, 0, 0], scale: 1, mode: 'translate', push: null,
}))

registerFeature({
  type: 'move',
  label: 'Move',
  icon: ArrowsOutCardinal,
  schema: moveSchema,
  async compute(ctx, p) {
    const ids = bodyIdsOf(p.bodyIds as string[])
    const targets = ids.map((id) => ctx.body(id)).filter((b): b is Body => !!b)
    if (!targets.length) throw new Error('No bodies selected')
    const spec = { pivot: pivotOf(targets), translate: p.translate as Vec3, rotate: p.rotate as Vec3, scale: p.scale as number }
    const out: Body[] = []
    for (const b of targets) out.push(await ctx.kernel.transform({ id: b.id, name: b.name, key: b.key, spec }))
    return { bodies: out }
  },
  preview({ values, setValues }) {
    const apply = (v: ParamValues) => {
      const ids = bodyIdsOf((v.bodyIds as string[]) ?? [])
      const bodies = useDoc.getState().geometry.filter((b) => ids.includes(b.id))
      useMove.setState({
        active: true,
        bodyIds: bodies.map((b) => b.id),
        pivot: pivotOf(bodies),
        translate: v.translate as Vec3,
        rotate: v.rotate as Vec3,
        scale: v.scale as number,
        mode: v.gizmo as GizmoMode,
        push: (patch) => setValues({ ...v, ...patch }),
      })
    }
    apply(values)
    return { update: apply, dispose: () => useMove.setState({ active: false, bodyIds: [], push: null }) }
  },
})

/** Ribbon command: Move the selected bodies (or the only body). */
export function startMove() {
  const { geometry } = useDoc.getState()
  const sel = useUi.getState().selection.filter((r) => r.kind === 'body' || r.kind === 'face' || r.kind === 'edge' || r.kind === 'mesh')
  let ids = [...new Set(sel.map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id))
  if (!ids.length && geometry.length === 1) ids = [geometry[0].id]
  createFeature('move', { bodyIds: ids }, 'solid.move')
}
