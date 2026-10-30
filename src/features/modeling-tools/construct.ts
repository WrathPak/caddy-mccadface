/** Construction geometry: planes (offset, at an angle, tangent, midplane, through three points), axes and points. */
import { Crosshair, Parallelogram, LineSegment, DotOutline } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefReport, decodeRef, encodeSelection, faceSigs, resolveEdge, resolveFace } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import type { EdgeGeom, FaceGeom } from '@/kernel/modeling-ops'
import type { Vec3 } from '@/kernel/types'
import { add3, cross3, dot3, mul3, norm3, rotationAbout, applyDir, sub3 } from '@/kernel/xform'
import { PLANE_FEATURES, usePlanes } from '@/sketch/planes'
import type { PlaneDef } from '@/sketch/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues, SelectionRefParam } from '@/ui/schema'
import { createRunner } from '../previewKit'
import { arcRadius, clearHandles, showAngle, showArrows, type AngleSpec, type ArrowSpec } from '../handleKit'
import { liveRefEnv, resolveAxis, resolvePlane, resolvePoint, useConstruct, type AxisDef, type RefEnv } from './geo'

PLANE_FEATURES.add('constructPlane')

const REF = ['plane', 'face'] as const
const sel = (key: string, label: string, help: string, accepts: SelectionRefParam['accepts'], visible: (v: ParamValues) => boolean): SelectionRefParam =>
  ({ type: 'selection-ref', key, label, help, accepts, pick: true, required: true, default: [], visibleWhen: visible })

// ------------------------------------------------------------------------------------------------ planes

export const constructPlaneSchema: ParamSchema = {
  id: 'constructPlane',
  title: 'Construction Plane',
  params: [
    {
      type: 'enum', key: 'mode', help: 'How the plane is defined: parallel to another plane, turned about an axis, touching a cylinder, between two planes, or through three points.', label: 'Method', display: 'select', default: 'offset',
      options: [
        { value: 'offset', label: 'Offset from a plane' }, { value: 'angle', label: 'At an angle' }, { value: 'tangent', label: 'Tangent to a face' },
        { value: 'midplane', label: 'Midplane' }, { value: 'threePoints', label: 'Through three points' },
      ],
    },
    sel('base', 'Plane', 'Click an origin plane, a construction plane or a flat face to start from.', [...REF], (v) => v.mode === 'offset' || v.mode === 'angle'),
    sel('axis', 'Axis', 'Click an edge, an axis or a cylinder to turn the plane about.', ['edge', 'axis', 'face'], (v) => v.mode === 'angle'),
    sel('face', 'Face', 'Click the cylindrical or spherical face the plane should touch.', ['face'], (v) => v.mode === 'tangent'),
    sel('plane1', 'First plane', 'Click the first of the two planes or flat faces.', [...REF], (v) => v.mode === 'midplane'),
    sel('plane2', 'Second plane', 'Click the second plane or flat face. It must be parallel to the first.', [...REF], (v) => v.mode === 'midplane'),
    sel('p1', 'Point 1', 'Click a vertex or a construction point.', ['vertex', 'point'], (v) => v.mode === 'threePoints'),
    sel('p2', 'Point 2', 'Click a second vertex or construction point.', ['vertex', 'point'], (v) => v.mode === 'threePoints'),
    sel('p3', 'Point 3', 'Click a third vertex or construction point, not on the line through the first two.', ['vertex', 'point'], (v) => v.mode === 'threePoints'),
    { type: 'number', key: 'distance', help: 'How far the new plane is from the starting plane, in mm. Negative goes the other way.', label: 'Distance', unit: 'mm', step: 1, default: 10, visibleWhen: (v) => v.mode === 'offset' },
    { type: 'number', key: 'angle', help: 'Offset angle in degrees: how far the plane is turned about the axis from the starting plane, or round the cylinder from the middle of the picked face.', label: 'Angle', unit: 'deg', step: 5, default: 45, visibleWhen: (v) => v.mode === 'angle' || v.mode === 'tangent' },
  ],
}

const one = (v: unknown) => ((v as string[])[0] ?? '')
const needed = (s: string, what: string) => { if (!s) throw new Error(`Select ${what}`); return s }

/** The plane for the given values; throws a readable error when something is missing. */
export async function planeFor(p: ParamValues, env: RefEnv, report = new RefReport()): Promise<PlaneDef> {
  switch (p.mode) {
    case 'offset': {
      const b = await resolvePlane(needed(one(p.base), 'a plane or flat face'), env, report)
      const d = p.distance as number
      return { origin: add3(b.origin, mul3(b.normal, d)), xDir: b.xDir, normal: b.normal }
    }
    case 'angle': {
      const b = await resolvePlane(needed(one(p.base), 'a plane or flat face'), env, report)
      const ax = await resolveAxis(needed(one(p.axis), 'an axis'), env, report)
      const u = norm3(ax.dir)
      const n0 = sub3(b.normal, mul3(u, dot3(b.normal, u)))
      if (Math.hypot(...n0) < 1e-6) throw new Error('The axis is perpendicular to the plane: pick an axis that lies in it')
      const r = rotationAbout([0, 0, 0], u, p.angle as number)
      return { origin: ax.origin, xDir: u, normal: norm3(applyDir(r, norm3(n0))) }
    }
    case 'tangent': {
      const ref = decodeRef(needed(one(p.face), 'a cylindrical face'))
      if (!ref || ref.kind !== 'face') throw new Error('Select a cylindrical face')
      const hit = resolveFace(ref, env.bodies, report)
      if (!hit) throw new Error('The face no longer exists (an edit upstream removed it). Pick it again.')
      const [g] = (await env.kernel.call('faceGeom', { key: hit.body.key, faces: [hit.index] })) as (FaceGeom | null)[]
      if (!g || (g.type !== 'cylinder' && g.type !== 'sphere')) throw new Error('The face must be a cylinder or a sphere')
      if (g.type === 'sphere') return planeAt(add3(g.origin, mul3(g.normal, g.radius)), g.normal)
      const u = norm3(g.dir)
      const c = sub3(g.center, g.origin)
      const along = dot3(c, u)
      const radial = norm3(sub3(c, mul3(u, along)))
      const dir = applyDir(rotationAbout([0, 0, 0], u, p.angle as number), radial)
      return { origin: add3(add3(g.origin, mul3(u, along)), mul3(dir, g.radius)), xDir: u, normal: norm3(dir) }
    }
    case 'midplane': {
      const a = await resolvePlane(needed(one(p.plane1), 'the first plane'), env, report)
      const b = await resolvePlane(needed(one(p.plane2), 'the second plane'), env, report)
      if (Math.hypot(...cross3(a.normal, b.normal)) > 1e-5) throw new Error('The two planes are not parallel')
      const n = norm3(a.normal)
      return { origin: add3(a.origin, mul3(n, dot3(sub3(b.origin, a.origin), n) / 2)), xDir: a.xDir, normal: n }
    }
    case 'threePoints': {
      const [a, b, c] = [await resolvePoint(needed(one(p.p1), 'the first point'), env, report), await resolvePoint(needed(one(p.p2), 'the second point'), env, report), await resolvePoint(needed(one(p.p3), 'the third point'), env, report)]
      const n = cross3(sub3(b, a), sub3(c, a))
      if (Math.hypot(...n) < 1e-9) throw new Error('The three points lie on one line, so they do not define a plane')
      return { origin: a, xDir: norm3(sub3(b, a)), normal: norm3(n) }
    }
  }
  throw new Error('Unknown method')
}

function planeAt(origin: Vec3, normal: Vec3): PlaneDef {
  const n = norm3(normal)
  const ref: Vec3 = Math.abs(n[2]) > 0.9999 ? [1, 0, 0] : norm3(cross3([0, 0, 1], n))
  return { origin, xDir: ref, normal: n }
}

const envOf = (ctx: { bodies: RefEnv['bodies']; dataOf: RefEnv['dataOf']; kernel: unknown }): RefEnv => ({ bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as RefEnv['kernel'] })

registerFeature({
  type: 'constructPlane',
  label: 'Construction Plane',
  icon: Parallelogram,
  schema: constructPlaneSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const plane = await planeFor(p, envOf(ctx), report)
    usePlanes.getState().set(ctx.feature.id, plane)
    return { data: { plane }, warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview: (ctx) => livePreview(ctx, constructPlaneSchema, async (p) => usePlanes.getState().set('preview', await planeFor(p, liveRefEnv())), () => usePlanes.getState().set('preview', null), planeHandles),
})

/**
 * The drag handles of a construction plane: an arrow standing on the base plane for an offset, an arc round the axis (or the
 * cylinder) for an angle. The arc starts along the base plane, so its knob swings with the new plane.
 */
async function planeHandles(p: ParamValues, env: RefEnv): Promise<{ arrows: ArrowSpec[]; angle: AngleSpec | null }> {
  const report = new RefReport()
  if (p.mode === 'offset') {
    const b = await resolvePlane(needed(one(p.base), 'a plane or flat face'), env, report)
    return { arrows: [{ origin: b.origin, dir: b.normal, key: 'distance' }], angle: null }
  }
  if (p.mode === 'angle') {
    const b = await resolvePlane(needed(one(p.base), 'a plane or flat face'), env, report)
    const ax = await resolveAxis(needed(one(p.axis), 'an axis'), env, report)
    const u = norm3(ax.dir)
    const n0 = sub3(b.normal, mul3(u, dot3(b.normal, u)))
    if (Math.hypot(...n0) < 1e-6) throw new Error('The axis is perpendicular to the plane')
    return { arrows: [], angle: { origin: ax.origin, axis: u, start: norm3(cross3(u, norm3(n0))), radius: arcRadius(env.bodies), key: 'angle' } }
  }
  if (p.mode === 'tangent') {
    const ref = decodeRef(needed(one(p.face), 'a cylindrical face'))
    if (!ref || ref.kind !== 'face') throw new Error('Select a cylindrical face')
    const hit = resolveFace(ref, env.bodies, report)
    if (!hit) throw new Error('The face no longer exists')
    const [g] = (await env.kernel.call('faceGeom', { key: hit.body.key, faces: [hit.index] })) as (FaceGeom | null)[]
    if (!g || g.type !== 'cylinder') return { arrows: [], angle: null }
    const u = norm3(g.dir)
    const c = sub3(g.center, g.origin)
    const along = dot3(c, u)
    const radial = norm3(sub3(c, mul3(u, along)))
    return { arrows: [], angle: { origin: add3(g.origin, mul3(u, along)), axis: u, start: radial, radius: g.radius, key: 'angle' } }
  }
  return { arrows: [], angle: null }
}

/** Preview that re-evaluates a construction value whenever the values change (and clears it when closed). */
function livePreview({ values, setValues }: PreviewCtx, schema: ParamSchema, show: (p: ParamValues) => Promise<void>, clear: () => void,
  handles?: (p: ParamValues, env: RefEnv) => Promise<{ arrows: ArrowSpec[]; angle: AngleSpec | null }>): PreviewHandle {
  let cur = values
  const runner = createRunner(async (stale) => {
    try {
      const p = resolveParams(schema, cur)
      await show(p)
      if (handles) {
        try {
          const h = await handles(p, liveRefEnv())
          if (stale()) return
          const apply = (patch: ParamValues) => { cur = { ...cur, ...patch }; setValues(cur) }
          showArrows(h.arrows, p, apply)
          showAngle(h.angle, p, apply)
        } catch { clearHandles() }
      }
    } catch { clear(); clearHandles() }
  })
  runner.schedule()
  return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clear(); clearHandles() } }
}

// ------------------------------------------------------------------------------------------------ axes

export const constructAxisSchema: ParamSchema = {
  id: 'constructAxis',
  title: 'Construction Axis',
  params: [
    {
      type: 'enum', key: 'mode', help: 'How the axis is defined: along an edge, through two points, perpendicular to a face at a point, or along the axis of a cylinder.', label: 'Method', display: 'select', default: 'edge',
      options: [{ value: 'edge', label: 'Through an edge' }, { value: 'twoPoints', label: 'Through two points' }, { value: 'normal', label: 'Normal at a point' }, { value: 'cylinder', label: 'Axis of a cylinder' }],
    },
    sel('edge', 'Edge', 'Click a straight edge, or a circular edge to get the axis through its centre.', ['edge'], (v) => v.mode === 'edge'),
    sel('cyl', 'Cylindrical face', 'Click a cylindrical face.', ['face'], (v) => v.mode === 'cylinder'),
    sel('p1', 'Point 1', 'Click a vertex or a construction point.', ['vertex', 'point'], (v) => v.mode === 'twoPoints'),
    sel('p2', 'Point 2', 'Click a second vertex or construction point.', ['vertex', 'point'], (v) => v.mode === 'twoPoints'),
    sel('plane', 'Face or plane', 'Click the flat face or plane the axis stands on.', [...REF], (v) => v.mode === 'normal'),
    { type: 'selection-ref', key: 'at', help: 'Click a vertex or a construction point for the axis to pass through. Leave empty to use the middle of the face.', label: 'Point', accepts: ['vertex', 'point'], pick: true, default: [], visibleWhen: (v) => v.mode === 'normal' },
  ],
}

export async function axisFor(p: ParamValues, env: RefEnv, report = new RefReport()): Promise<AxisDef> {
  switch (p.mode) {
    case 'edge': return resolveAxis(needed(one(p.edge), 'an edge'), env, report)
    case 'cylinder': return resolveAxis(needed(one(p.cyl), 'a cylindrical face'), env, report)
    case 'twoPoints': {
      const a = await resolvePoint(needed(one(p.p1), 'the first point'), env, report), b = await resolvePoint(needed(one(p.p2), 'the second point'), env, report)
      if (Math.hypot(...sub3(b, a)) < 1e-9) throw new Error('The two points are the same')
      return { origin: a, dir: norm3(sub3(b, a)) }
    }
    default: {
      const pl = await resolvePlane(needed(one(p.plane), 'a face or plane'), env, report)
      const at = one(p.at) ? await resolvePoint(one(p.at), env, report) : pl.origin
      return { origin: at, dir: pl.normal }
    }
  }
}

registerFeature({
  type: 'constructAxis',
  label: 'Construction Axis',
  icon: LineSegment,
  schema: constructAxisSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const axis = await axisFor(p, envOf(ctx), report)
    useConstruct.getState().setAxis(ctx.feature.id, axis)
    return { data: { axis }, warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview: (ctx) => livePreview(ctx, constructAxisSchema, async (p) => useConstruct.getState().setAxis('preview', await axisFor(p, liveRefEnv())), () => useConstruct.getState().setAxis('preview', null)),
})

// ------------------------------------------------------------------------------------------------ points

export const constructPointSchema: ParamSchema = {
  id: 'constructPoint',
  title: 'Construction Point',
  params: [
    {
      type: 'enum', key: 'mode', help: 'How the point is defined: by coordinates, at a vertex, at the centre of an edge or face, or where an axis meets a plane.', label: 'Method', display: 'select', default: 'coords',
      options: [{ value: 'coords', label: 'Coordinates' }, { value: 'vertex', label: 'At a vertex' }, { value: 'center', label: 'Centre of an edge or face' }, { value: 'axisPlane', label: 'Axis and plane' }],
    },
    { type: 'vector3', key: 'pos', help: 'The X, Y, Z position of the point in mm.', label: 'Position', unit: 'mm', step: 1, default: [0, 0, 0], visibleWhen: (v) => v.mode === 'coords' },
    sel('vertex', 'Vertex', 'Click a corner of a body.', ['vertex'], (v) => v.mode === 'vertex'),
    sel('item', 'Edge or face', 'Click an edge (its middle, or the centre of a circular edge) or a face (its centre).', ['edge', 'face'], (v) => v.mode === 'center'),
    sel('axis', 'Axis', 'Click an edge, an axis or a cylinder.', ['edge', 'axis', 'face'], (v) => v.mode === 'axisPlane'),
    sel('plane', 'Plane', 'Click a plane or flat face the axis passes through.', [...REF], (v) => v.mode === 'axisPlane'),
  ],
}

export async function pointFor(p: ParamValues, env: RefEnv, report = new RefReport()): Promise<Vec3> {
  switch (p.mode) {
    case 'coords': return [...(p.pos as Vec3)] as Vec3
    case 'vertex': return resolvePoint(needed(one(p.vertex), 'a vertex'), env, report)
    case 'center': {
      const ref = decodeRef(needed(one(p.item), 'an edge or face'))
      if (ref?.kind === 'edge') {
        const hit = resolveEdge(ref, env.bodies, report)
        if (!hit) throw new Error('The edge no longer exists (an edit upstream removed it). Pick it again.')
        const [g] = (await env.kernel.call('edgeGeom', { key: hit.body.key, edges: [hit.index] })) as (EdgeGeom | null)[]
        return g ? (g.type === 'circle' ? g.origin : g.mid) : [0, 0, 0]
      }
      if (ref?.kind === 'face') {
        const hit = resolveFace(ref, env.bodies, report)
        if (!hit) throw new Error('The face no longer exists (an edit upstream removed it). Pick it again.')
        return faceSigs(hit.body)[hit.index].centroid
      }
      throw new Error('Select an edge or a face')
    }
    default: {
      const ax = await resolveAxis(needed(one(p.axis), 'an axis'), env, report)
      const pl = await resolvePlane(needed(one(p.plane), 'a plane'), env, report)
      const den = dot3(ax.dir, pl.normal)
      if (Math.abs(den) < 1e-9) throw new Error('The axis runs parallel to the plane, so they never meet')
      return add3(ax.origin, mul3(ax.dir, dot3(sub3(pl.origin, ax.origin), pl.normal) / den))
    }
  }
}

registerFeature({
  type: 'constructPoint',
  label: 'Construction Point',
  icon: DotOutline,
  schema: constructPointSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const point = await pointFor(p, envOf(ctx), report)
    useConstruct.getState().setPoint(ctx.feature.id, point)
    return { data: { point }, warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview: (ctx) => livePreview(ctx, constructPointSchema, async (p) => useConstruct.getState().setPoint('preview', await pointFor(p, liveRefEnv())), () => useConstruct.getState().setPoint('preview', null)),
})

// ------------------------------------------------------------------------------------------------ commands

type Kind = 'constructPlane' | 'constructAxis' | 'constructPoint'
/** Start a construction tool, using the current selection where it fits. */
export function startConstruct(type: Kind, mode: string) {
  const ui = useUi.getState()
  const bodies = useDoc.getState().geometry
  const picked = encodeSelection(ui.selection.filter((r) => ['face', 'edge', 'vertex', 'plane', 'axis', 'point'].includes(r.kind)), bodies)
  const init: ParamValues = { mode }
  const first = picked[0]
  if (first) {
    const ref = first.startsWith('{') ? decodeRef(first) : null
    if (type === 'constructPlane' && (mode === 'offset' || mode === 'angle') && (!ref || ref.kind === 'face')) init.base = [first]
    if (type === 'constructPlane' && mode === 'tangent' && ref?.kind === 'face') init.face = [first]
    if (type === 'constructAxis' && mode === 'edge' && ref?.kind === 'edge') init.edge = [first]
    if (type === 'constructAxis' && mode === 'cylinder' && ref?.kind === 'face') init.cyl = [first]
  }
  createFeature(type, init, type === 'constructPlane' ? 'construct.plane' : type === 'constructAxis' ? 'construct.axis' : 'construct.point')
}
export { Crosshair }
