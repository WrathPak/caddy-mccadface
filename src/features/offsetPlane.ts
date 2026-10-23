/** Offset Plane: a construction plane parallel to an origin plane or a planar face, usable to start a sketch. */
import { Parallelogram } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { decodeRef, encodeSelection, faceSigs, resolveFace } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { Body } from '@/kernel/types'
import { isPlanarFace } from '@/sketch/create'
import { originPlane, planeFromNormal } from '@/sketch/plane'
import { usePlanes } from '@/sketch/planes'
import type { PlaneDef } from '@/sketch/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'

export const offsetPlaneSchema: ParamSchema = {
  id: 'offsetPlane',
  title: 'Offset Plane',
  params: [
    { type: 'enum', key: 'base', label: 'Base', display: 'select', default: 'XY', options: [{ value: 'XY', label: 'XY plane' }, { value: 'XZ', label: 'XZ plane' }, { value: 'YZ', label: 'YZ plane' }, { value: 'face', label: 'Planar face' }] },
    { type: 'selection-ref', key: 'face', label: 'Face', accepts: ['face'], required: true, pick: true, default: [], visibleWhen: (v) => v.base === 'face' },
    { type: 'number', key: 'distance', label: 'Distance', unit: 'mm', step: 1, default: 10 },
  ],
}

/** The plane for the given values; throws if the base face is missing or not planar. */
export function offsetPlaneDef(p: ParamValues, bodies: Body[]): PlaneDef {
  let base: PlaneDef
  if (p.base === 'face') {
    const ref = (p.face as string[])[0] ? decodeRef((p.face as string[])[0]) : null
    if (!ref || ref.kind !== 'face') throw new Error('Select a planar face')
    const hit = resolveFace(ref, bodies)
    if (!hit) throw new Error('The base face no longer exists')
    if (!isPlanarFace(hit.body, hit.index)) throw new Error('The base face is not planar')
    const sig = faceSigs(hit.body)[hit.index]
    base = planeFromNormal(sig.centroid, sig.normal)
  } else base = originPlane(p.base as 'XY' | 'XZ' | 'YZ')
  const d = p.distance as number
  const n = base.normal
  return { origin: [base.origin[0] + n[0] * d, base.origin[1] + n[1] * d, base.origin[2] + n[2] * d], xDir: base.xDir, normal: n }
}

registerFeature({
  type: 'offsetPlane',
  label: 'Offset Plane',
  icon: Parallelogram,
  schema: offsetPlaneSchema,
  async compute(ctx, p) {
    const plane = offsetPlaneDef(p, ctx.bodies)
    usePlanes.getState().set(ctx.feature.id, plane)
    return { data: { plane } }
  },
  preview({ values }) {
    const show = (v: ParamValues) => {
      try { usePlanes.getState().set('preview', offsetPlaneDef(resolveParams(offsetPlaneSchema, v), useDoc.getState().geometry)) } catch { usePlanes.getState().set('preview', null) }
    }
    show(values)
    return { update: show, dispose: () => usePlanes.getState().set('preview', null) }
  },
})

/** Ribbon command: starts from a selected planar face when there is one. */
export function startOffsetPlane() {
  const ui = useUi.getState()
  const faces = encodeSelection(ui.selection.filter((r) => r.kind === 'face').slice(0, 1), useDoc.getState().geometry)
  createFeature('offsetPlane', faces.length ? { base: 'face', face: faces } : {}, 'construct.plane')
}

/** Construction planes alive at the rollback point: [feature id, name, plane]. */
export function livePlanes(): { id: string; name: string; plane: PlaneDef }[] {
  const d = useDoc.getState()
  const data = usePlanes.getState().data
  return d.features.filter((f, i) => f.type === 'offsetPlane' && i < d.rollback && !f.suppressed && data[f.id]).map((f) => ({ id: f.id, name: f.name, plane: data[f.id] }))
}
