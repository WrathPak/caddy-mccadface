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
import { getKernel } from '@/kernel/client'
import { clearPreview, setPreview, usePreview } from '@/viewport/preview'
import { createRunner } from './previewKit'
import { liveRefEnv } from './modeling-tools/geo'
import { copyPreview, ghostOf, moveAdvanced, moveExtraParams, moveTypeParam, moveXf } from './solids2/transform'

export type GizmoMode = 'translate' | 'rotate' | 'scale'

export const moveSchema: ParamSchema = {
  id: 'move',
  title: 'Move / Transform',
  params: [
    { type: 'selection-ref', key: 'bodyIds', help: 'The bodies to move, rotate or scale together.', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [] },
    moveTypeParam,
    {
      type: 'enum', key: 'gizmo', help: 'Which handle appears in the viewport: Move, Rotate or Scale. The numbers below stay in sync with it.', label: 'Gizmo', display: 'segmented', default: 'translate',
      options: [{ value: 'translate', label: 'Move' }, { value: 'rotate', label: 'Rotate' }, { value: 'scale', label: 'Scale' }], visibleWhen: (v) => (v.moveType ?? 'free') === 'free',
    },
    { type: 'vector3', key: 'translate', help: 'How far to move along X, Y and Z, in mm.', label: 'Translate', unit: 'mm', step: 1, default: [0, 0, 0], visibleWhen: (v) => (v.moveType ?? 'free') === 'free' },
    { type: 'vector3', key: 'rotate', help: 'Turn around the X, Y and Z axes through the middle of the bodies, in degrees.', label: 'Rotate', unit: 'deg', step: 5, default: [0, 0, 0], visibleWhen: (v) => (v.moveType ?? 'free') === 'free' },
    {
      type: 'enum', key: 'scaleType', label: 'Scale type', display: 'segmented', default: 'uniform', visibleWhen: (v) => (v.moveType ?? 'free') === 'free',
      help: 'Uniform resizes the same amount in every direction. Non-uniform takes a separate factor for X, Y and Z, which works on mesh bodies.',
      options: [{ value: 'uniform', label: 'Uniform' }, { value: 'nonuniform', label: 'Non-uniform' }],
    },
    { type: 'number', key: 'scale', help: 'Resizes the bodies about their middle. 1 keeps the size, 2 doubles it, 0.5 halves it.', label: 'Scale', unit: '', min: 0.001, step: 0.1, default: 1, visibleWhen: (v) => (v.moveType ?? 'free') === 'free' && v.scaleType !== 'nonuniform' },
    { type: 'vector3', key: 'scaleXYZ', help: 'The factor along X, Y and Z, about the middle of the bodies. 1 keeps the size, 2 doubles it, 0.5 halves it. A negative factor mirrors the mesh.', label: 'Scale X, Y, Z', unit: '', step: 0.1, default: [1, 1, 1], visibleWhen: (v) => (v.moveType ?? 'free') === 'free' && v.scaleType === 'nonuniform' },
    ...moveExtraParams,
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
  /** a move by points or an axis: the bodies show where they land, with no gizmo */
  ghostOnly: boolean
  /** Create copy: the bodies stay put (the copies are drawn as a preview) */
  keep: boolean
}
export const useMove = create<MoveState>(() => ({
  active: false, bodyIds: [], pivot: [0, 0, 0], translate: [0, 0, 0], rotate: [0, 0, 0], scale: 1, mode: 'translate', push: null, ghostOnly: false, keep: false,
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
    if ((p.moveType ?? 'free') === 'free' && p.scaleType === 'nonuniform') {
      if (p.copy) throw new Error('Create copy is not available with a non-uniform scale')
      if (targets.some((b) => b.kind !== 'mesh')) throw new Error('Non-uniform scale works on mesh bodies; use Uniform for solids')
      const pivot = pivotOf(targets)
      const f = p.scaleXYZ as Vec3
      const moved = (p.translate as Vec3).some((x) => x) || (p.rotate as Vec3).some((x) => x)
      const out: Body[] = []
      for (const b of targets) {
        const scaled = (await ctx.kernel.call('meshScale', { id: b.id, name: b.name, key: b.key, pivot, factors: f })) as Body
        out.push(moved ? await ctx.kernel.transform({ id: b.id, name: b.name, key: scaled.key, spec: { pivot, translate: p.translate as Vec3, rotate: p.rotate as Vec3, scale: 1 } }) : scaled)
      }
      return { bodies: out }
    }
    if ((p.moveType ?? 'free') !== 'free' || p.copy) return moveAdvanced(ctx, p, targets, pivotOf(targets))
    const spec = { pivot: pivotOf(targets), translate: p.translate as Vec3, rotate: p.rotate as Vec3, scale: p.scale as number }
    const out: Body[] = []
    for (const b of targets) out.push(await ctx.kernel.transform({ id: b.id, name: b.name, key: b.key, spec }))
    return { bodies: out }
  },
  preview({ values, setValues }) {
    let cur = values
    const copies = copyPreview(() => cur, () => liveRefEnv(), () => getKernel())
    // a non-uniform scale has no gizmo ghost: the scaled meshes themselves are drawn
    const stretch = createRunner(async (stale) => {
      const v = cur
      if ((v.moveType ?? 'free') !== 'free' || v.scaleType !== 'nonuniform' || v.copy) return
      const ids = bodyIdsOf((v.bodyIds as string[]) ?? [])
      const bodies = useDoc.getState().geometry.filter((b) => ids.includes(b.id) && b.kind === 'mesh')
      if (!bodies.length) return
      const pivot = pivotOf(bodies)
      try {
        const out: Body[] = []
        for (const b of bodies) out.push((await getKernel().call('meshScale', { id: 'preview-' + b.id, name: b.name, key: b.key, pivot, factors: v.scaleXYZ as Vec3 })) as Body)
        if (stale()) return
        setPreview(out.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), bodies.map((b) => b.id))
      } catch { clearPreview() }
    }, 200)
    const apply = (v: ParamValues) => {
      cur = v
      const ids = bodyIdsOf((v.bodyIds as string[]) ?? [])
      const bodies = useDoc.getState().geometry.filter((b) => ids.includes(b.id))
      const pivot = pivotOf(bodies)
      const free = (v.moveType ?? 'free') === 'free'
      useMove.setState({
        active: true,
        bodyIds: bodies.map((b) => b.id),
        pivot,
        translate: free ? (v.translate as Vec3) : [0, 0, 0],
        rotate: free ? (v.rotate as Vec3) : [0, 0, 0],
        scale: free && v.scaleType !== 'nonuniform' ? (v.scale as number) : 1,
        mode: v.gizmo as GizmoMode,
        push: (patch) => setValues({ ...v, ...patch }),
        ghostOnly: !free,
        keep: !!v.copy,
      })
      // a move by points or an axis: work out where the bodies land and show them there
      if (!free) {
        void moveXf(v, liveRefEnv()).then((xf) => { if (xf && cur === v) useMove.setState(ghostOf(xf, pivot)) }).catch(() => {})
      }
      copies.schedule()
      if (v.scaleType === 'nonuniform') stretch.schedule(); else if (usePreview.getState().items.length && !v.copy && (v.moveType ?? 'free') === 'free') clearPreview()
    }
    apply(values)
    return { update: apply, dispose: () => { copies.dispose(); stretch.dispose(); clearPreview(); useMove.setState({ active: false, bodyIds: [], push: null, ghostOnly: false, keep: false }) } }
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
