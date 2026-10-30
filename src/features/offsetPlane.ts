/** Offset Plane: a construction plane parallel to an origin plane or a planar face, usable to start a sketch. */
import { Parallelogram } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, decodeRef, encodeSelection, faceSigs, resolveFace } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { Body } from '@/kernel/types'
import { isPlanarFace } from '@/sketch/create'
import { originPlane, planeFromNormal } from '@/sketch/plane'
import { PLANE_FEATURES, usePlanes } from '@/sketch/planes'
import type { PlaneDef } from '@/sketch/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { resetManip, useManip } from '@/viewport/preview'

export const offsetPlaneSchema: ParamSchema = {
  id: 'offsetPlane',
  title: 'Offset Plane',
  params: [
    { type: 'enum', key: 'base', help: 'What to offset from: an origin plane, or a flat face of a body.', label: 'Base', display: 'select', default: 'XY', options: [{ value: 'XY', label: 'XY plane' }, { value: 'XZ', label: 'XZ plane' }, { value: 'YZ', label: 'YZ plane' }, { value: 'face', label: 'Planar face' }] },
    { type: 'selection-ref', key: 'face', help: 'Click the flat face the new plane starts from.', label: 'Face', accepts: ['face'], required: true, pick: true, default: [], visibleWhen: (v) => v.base === 'face' },
    { type: 'number', key: 'distance', help: 'How far the new plane is from the base, in mm. Negative goes the other way. Sketch on it afterwards.', label: 'Distance', unit: 'mm', step: 1, default: 10 },
  ],
}

/** The plane for the given values; throws if the base face is missing or not planar. */
export function offsetPlaneDef(p: ParamValues, bodies: Body[], report = new RefReport()): PlaneDef {
  let base: PlaneDef
  if (p.base === 'face') {
    const ref = (p.face as string[])[0] ? decodeRef((p.face as string[])[0]) : null
    if (!ref || ref.kind !== 'face') throw new Error('Select a planar face')
    const hit = resolveFace(ref, bodies, report)
    if (!hit) throw new RefError('The base face no longer exists (an edit upstream removed it). Pick it again.', report.lostRefs)
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
    const report = new RefReport()
    const plane = offsetPlaneDef(p, ctx.bodies, report)
    usePlanes.getState().set(ctx.feature.id, plane)
    return { data: { plane }, warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview({ values, setValues }) {
    let cur = values
    const show = (v: ParamValues) => {
      cur = v
      try {
        const p = resolveParams(offsetPlaneSchema, v)
        const plane = offsetPlaneDef(p, useDoc.getState().geometry)
        usePlanes.getState().set('preview', plane)
        // drag arrow standing on the base plane: pull it to set the distance
        const d = p.distance as number, n = plane.normal
        useManip.setState({
          active: true, origin: [plane.origin[0] - n[0] * d, plane.origin[1] - n[1] * d, plane.origin[2] - n[2] * d], dir: n, tip: d, factor: 1,
          label: (x) => `${x.toFixed(2)} mm`,
          onChange: (x) => { cur = { ...cur, distance: x }; setValues(cur) },
        })
      } catch { usePlanes.getState().set('preview', null); resetManip() }
    }
    show(values)
    return { update: show, dispose: () => { usePlanes.getState().set('preview', null); resetManip() } }
  },
})

/** Ribbon command: starts from a selected planar face when there is one. */
export function startOffsetPlane() {
  const ui = useUi.getState()
  const faces = encodeSelection(ui.selection.filter((r) => r.kind === 'face').slice(0, 1), useDoc.getState().geometry)
  // a selected origin plane (viewport or Browser) is the base, like a selected face
  const origin = ui.selection.find((r) => r.kind === 'plane' && ['planeXY', 'planeXZ', 'planeYZ'].includes(r.id))
  createFeature('offsetPlane', faces.length ? { base: 'face', face: faces } : origin ? { base: origin.id.slice(5) } : {}, 'construct.plane')
}

/** Construction planes alive at the rollback point: [feature id, name, plane]. */
export function livePlanes(): { id: string; name: string; plane: PlaneDef }[] {
  const d = useDoc.getState()
  const data = usePlanes.getState().data
  return d.features.filter((f, i) => PLANE_FEATURES.has(f.type) && i < d.rollback && !f.suppressed && data[f.id]).map((f) => ({ id: f.id, name: f.name, plane: data[f.id] }))
}
