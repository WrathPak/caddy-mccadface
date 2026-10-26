/** Surface > Create: Extrude, Revolve, Sweep, Loft, Patch and Offset Surface (kernel ops in kernel/surface-ops.ts). */
import { ArrowFatLineUp, ArrowsClockwise, Path, SelectionBackground, Shapes, Stack } from '@phosphor-icons/react'
import { RefError, RefReport, decodeRef, edgeSigs, faceSigs, resolveEdge, resolveFace } from '@/doc/refs'
import type { SurfaceExtrudeArgs, SurfaceLoftArgs, SurfaceOffsetArgs, SurfacePatchArgs, SurfaceRevolveArgs, SurfaceSweepArgs } from '@/kernel/surface-ops'
import type { Body, Vec3 } from '@/kernel/types'
import { norm3 } from '@/kernel/xform'
import { pos } from '@/sketch/model'
import { dirToWorld, toWorld, yDirOf } from '@/sketch/plane'
import type { SketchData } from '@/sketch/types'
import type { PathSeg } from '@/kernel/solid-ops'
import type { ParamSchema, ParamValues, SelectionRefParam } from '@/ui/schema'
import { sketchPath } from '../solids'
import { resolveCurves, type CurveInputs } from './curves'
import { call, registerSurfaceTool, type BuildEnv } from './kit'

/** The field the curve tools share: runs of sketch curves, or edges of a body. */
const curvesField = (help: string, over: Partial<SelectionRefParam> = {}): SelectionRefParam => ({
  type: 'selection-ref', key: 'curves', help, label: 'Curves', accepts: ['curve', 'edge'], multiple: true, pick: true, required: true, default: [], ...over,
})

function curvesOf(refs: string[], env: BuildEnv, what: string): CurveInputs {
  const inp = resolveCurves(refs, env)
  if (!inp.curves.length) {
    throw new RefError(inp.missing ? `The ${what} you picked no longer exists (an edit upstream removed it). Pick it again.` : `Select the ${what}`, inp.report.lostRefs)
  }
  return inp
}
/** Fold what the curve resolution learned into the feature's own report. */
function merge(into: RefReport, from: RefReport) {
  from.rebound.forEach((v, k) => into.rebound.set(k, v))
  from.lost.forEach((v, k) => into.lost.set(k, v))
}

// ------------------------------------------------------------------------------------------------ extrude

export const surfaceExtrudeSchema: ParamSchema = {
  id: 'surfaceExtrude',
  title: 'Extrude Surface',
  params: [
    curvesField('What to extrude: lines, arcs and splines from a sketch (click them in the viewport), or edges of a body. Open curves make an open surface; a closed shape makes a wall with no caps.'),
    {
      type: 'group',
      label: 'Extent',
      children: [
        {
          type: 'enum', key: 'direction', help: 'One side: grow one way. Symmetric: half the distance each way from the curves. Two sides: a different distance each way.', label: 'Direction', display: 'segmented', default: 'one',
          options: [{ value: 'one', label: 'One side' }, { value: 'sym', label: 'Symmetric' }, { value: 'two', label: 'Two sides' }],
        },
        { type: 'number', key: 'distance', help: 'How far to extrude, in mm. A negative number goes the other way. You can also drag the arrow in the viewport.', label: 'Distance', unit: 'mm', step: 0.5, default: 10 },
        { type: 'number', key: 'distance2', help: 'How far to extrude in the opposite direction, in mm.', label: 'Distance 2', unit: 'mm', min: 0, step: 0.5, default: 5, visibleWhen: (v) => v.direction === 'two' },
      ],
    },
    {
      type: 'enum', key: 'axis', help: 'Which way is up for the surface: the normal of the sketch plane the curves are on (or the plane the edges lie in), or one of the world axes.', label: 'Along', display: 'select', default: 'normal',
      options: [{ value: 'normal', label: 'Sketch plane normal' }, { value: 'worldX', label: 'World X' }, { value: 'worldY', label: 'World Y' }, { value: 'worldZ', label: 'World Z' }],
    },
  ],
}

const WORLD: Record<string, Vec3> = { worldX: [1, 0, 0], worldY: [0, 1, 0], worldZ: [0, 0, 1] }

function span(mode: string, d1: number, d2: number): [number, number] {
  if (mode === 'sym') return [-Math.abs(d1) / 2, Math.abs(d1) / 2]
  if (mode === 'two') return [-d2, d1]
  return d1 >= 0 ? [0, d1] : [d1, 0]
}

registerSurfaceTool({
  type: 'surfaceExtrude',
  label: 'Extrude Surface',
  icon: ArrowFatLineUp,
  schema: surfaceExtrudeSchema,
  curves: ['curves'],
  async build(p, env, report) {
    const inp = curvesOf(p.curves as string[], env, 'curves to extrude')
    merge(report, inp.report)
    const dir: Vec3 | null = WORLD[p.axis as string] ?? (inp.plane ? inp.plane.normal : null)
    const [from, to] = span(p.direction as string, p.distance as number, p.distance2 as number)
    const args: SurfaceExtrudeArgs = { id: env.newId(), name: env.name, curves: inp.curves, dir, from, to }
    return { bodies: [await call<Body>(env, 'surfaceExtrude', args)], kind: 'add' }
  },
  async manip(p, env) {
    const inp = resolveCurves(p.curves as string[], env)
    const dir: Vec3 | null = WORLD[p.axis as string] ?? (inp.plane ? inp.plane.normal : null)
    if (!inp.anchor || !dir) return null
    const sym = p.direction === 'sym'
    return { origin: inp.anchor, dir, key: 'distance', factor: sym ? 2 : 1 }
  },
})

// ------------------------------------------------------------------------------------------------ revolve

export const surfaceRevolveSchema: ParamSchema = {
  id: 'surfaceRevolve',
  title: 'Revolve Surface',
  params: [
    curvesField('What to spin around the axis: lines, arcs and splines from a sketch (click them in the viewport), or edges of a body.'),
    {
      type: 'enum', key: 'axis', help: 'The line to spin around: a construction line in the sketch, one of the sketch or world axes, or a model edge.', label: 'Axis', display: 'select', default: 'sketchY',
      options: [
        { value: 'line', label: 'Sketch construction line' }, { value: 'sketchX', label: 'Sketch X axis' }, { value: 'sketchY', label: 'Sketch Y axis' },
        { value: 'worldX', label: 'World X' }, { value: 'worldY', label: 'World Y' }, { value: 'worldZ', label: 'World Z' }, { value: 'edge', label: 'Edge' },
      ],
    },
    { type: 'selection-ref', key: 'edge', help: 'Click the straight model edge to spin around.', label: 'Axis edge', accepts: ['edge'], required: true, pick: true, default: [], visibleWhen: (v) => v.axis === 'edge' },
    { type: 'number', key: 'angle', help: 'How far to spin, in degrees. 360 makes a full turn; less leaves a wedge.', label: 'Angle', unit: 'deg', step: 5, default: 360 },
  ],
}

/** World-space axis for the chosen mode (the same choices as the solid Revolve). */
function axisFor(p: ParamValues, inp: CurveInputs, env: BuildEnv, report: RefReport): { origin: Vec3; dir: Vec3 } {
  const world = WORLD[p.axis as string]
  if (world) return { origin: [0, 0, 0], dir: world }
  if (p.axis === 'edge') {
    const ref = (p.edge as string[])[0] ? decodeRef((p.edge as string[])[0]) : null
    if (!ref || ref.kind !== 'edge') throw new Error('Select an edge for the axis')
    const r = resolveEdge(ref, env.bodies, report)
    if (!r) throw new RefError('The axis edge no longer exists (an edit upstream removed it). Pick it again.', report.lostRefs)
    const sg = edgeSigs(r.body)[r.index]
    return { origin: sg.midpoint, dir: sg.direction }
  }
  const plane = inp.plane
  if (!plane) throw new Error('This axis needs curves from a sketch: pick a world axis or an edge for edges')
  if (p.axis === 'sketchX') return { origin: plane.origin, dir: plane.xDir }
  if (p.axis === 'sketchY') return { origin: plane.origin, dir: yDirOf(plane) }
  const data = inp.sketch!.data
  const model = { entities: data.entities, constraints: data.constraints, next: 0 }
  const line = data.entities.find((e) => e.type === 'line' && e.construction)
  if (!line || line.type !== 'line') throw new Error('This sketch has no construction line; draw one (X) or pick another axis')
  const a = pos(model, line.p1), b = pos(model, line.p2)
  return { origin: toWorld(plane, a), dir: dirToWorld(plane, [b[0] - a[0], b[1] - a[1]]) }
}

registerSurfaceTool({
  type: 'surfaceRevolve',
  label: 'Revolve Surface',
  icon: ArrowsClockwise,
  schema: surfaceRevolveSchema,
  curves: ['curves'],
  async build(p, env, report) {
    const inp = curvesOf(p.curves as string[], env, 'curves to revolve')
    merge(report, inp.report)
    const ax = axisFor(p, inp, env, report)
    const args: SurfaceRevolveArgs = { id: env.newId(), name: env.name, curves: inp.curves, axisOrigin: ax.origin, axisDir: norm3(ax.dir), angle: p.angle as number }
    return { bodies: [await call<Body>(env, 'surfaceRevolve', args)], kind: 'add' }
  },
})

// ------------------------------------------------------------------------------------------------ sweep

export const surfaceSweepSchema: ParamSchema = {
  id: 'surfaceSweep',
  title: 'Sweep Surface',
  params: [
    curvesField('The curves to drag along the path: open or closed, from a sketch or edges of a body.', { key: 'profiles', label: 'Profile' }),
    { type: 'selection-ref', key: 'path', help: 'The line or curve the profile follows. Click one run of sketch curves, or a whole sketch, in the viewport.', label: 'Path', accepts: ['curve', 'sketch'], required: true, pick: true, default: [] },
  ],
}

/** The path as world-space pieces: one run of curves (`crv:`) or all curves of a sketch (they have to form one chain). */
function pathOf(refs: string[], env: BuildEnv, report: RefReport): PathSeg[] {
  const ref = refs[0]
  if (!ref) throw new Error('Select a curve for the path')
  if (ref.startsWith('crv:')) {
    const inp = resolveCurves([ref], env)
    merge(report, inp.report)
    const c = inp.curves[0]
    if (!c || c.kind !== 'chain') throw new RefError('The path no longer exists (an edit upstream removed it). Pick it again.', report.lostRefs)
    return c.segs
  }
  const id = decodeRef(ref)?.bodyId ?? ref
  const data = env.dataOf(id) as SketchData | undefined
  if (!data?.plane) throw new RefError('The path sketch no longer exists', [ref])
  return sketchPath(data)
}

registerSurfaceTool({
  type: 'surfaceSweep',
  label: 'Sweep Surface',
  icon: Path,
  schema: surfaceSweepSchema,
  curves: ['profiles', 'path'],
  async build(p, env, report) {
    const inp = curvesOf(p.profiles as string[], env, 'profile curves')
    merge(report, inp.report)
    const args: SurfaceSweepArgs = { id: env.newId(), name: env.name, profiles: inp.curves, path: pathOf(p.path as string[], env, report) }
    return { bodies: [await call<Body>(env, 'surfaceSweep', args)], kind: 'add' }
  },
})

// ------------------------------------------------------------------------------------------------ loft

export const surfaceLoftSchema: ParamSchema = {
  id: 'surfaceLoft',
  title: 'Loft Surface',
  params: [
    curvesField('The curves to blend between, in order. Pick at least two: runs of sketch curves, or the edges of a body (the edges of one outline count as one section). They must all be open or all be closed.', { key: 'sections', label: 'Sections', min: 2 }),
    { type: 'bool', key: 'ruled', help: 'On: straight lines between the sections (angular). Off: a smooth surface through them.', label: 'Ruled (straight sections)', default: false },
  ],
}

registerSurfaceTool({
  type: 'surfaceLoft',
  label: 'Loft Surface',
  icon: Shapes,
  schema: surfaceLoftSchema,
  curves: ['sections'],
  async build(p, env, report) {
    const inp = curvesOf(p.sections as string[], env, 'sections')
    merge(report, inp.report)
    const args: SurfaceLoftArgs = { id: env.newId(), name: env.name, sections: inp.curves, ruled: !!p.ruled }
    return { bodies: [await call<Body>(env, 'surfaceLoft', args)], kind: 'add' }
  },
})

// ------------------------------------------------------------------------------------------------ patch

export const surfacePatchSchema: ParamSchema = {
  id: 'surfacePatch',
  title: 'Patch',
  params: [
    curvesField('The closed loop to fill: runs of sketch curves, or the open edges of surfaces, that meet end to end all the way round.', { key: 'boundary', label: 'Boundary' }),
    {
      type: 'enum', key: 'continuity', help: 'How the patch meets the faces next to it when the boundary is made of their edges: Position just touches, Tangent follows their slope, Curvature follows their bend too. Sketch curves have no neighbour to follow.', label: 'Continuity', display: 'segmented', default: 'g0',
      options: [{ value: 'g0', label: 'Position' }, { value: 'g1', label: 'Tangent' }, { value: 'g2', label: 'Curvature' }],
    },
  ],
}

registerSurfaceTool({
  type: 'surfacePatch',
  label: 'Patch',
  icon: SelectionBackground,
  schema: surfacePatchSchema,
  curves: ['boundary'],
  async build(p, env, report) {
    const inp = curvesOf(p.boundary as string[], env, 'boundary')
    merge(report, inp.report)
    const args: SurfacePatchArgs = { id: env.newId(), name: env.name, boundary: inp.curves, continuity: p.continuity as 'g0' | 'g1' | 'g2' }
    return { bodies: [await call<Body>(env, 'surfacePatch', args)], kind: 'add' }
  },
})

// ------------------------------------------------------------------------------------------------ offset

export const surfaceOffsetSchema: ParamSchema = {
  id: 'surfaceOffset',
  title: 'Offset Surface',
  params: [
    { type: 'selection-ref', key: 'faces', help: 'The surfaces or faces to copy at a distance: whole surface bodies, or faces of a surface or a solid.', label: 'Surfaces', accepts: ['body', 'face'], multiple: true, required: true, pick: true, default: [] },
    { type: 'number', key: 'distance', help: 'How far to move the copy along the way the faces point, in mm. A negative number goes the other way. You can also drag the arrow in the viewport.', label: 'Distance', unit: 'mm', step: 0.5, default: 2 },
  ],
}

registerSurfaceTool({
  type: 'surfaceOffset',
  label: 'Offset Surface',
  icon: Stack,
  schema: surfaceOffsetSchema,
  filter: 'face',
  async build(p, env, report) {
    const refs = p.faces as string[]
    const bodies = new Map<string, { body: Body; faces: number[]; whole: boolean }>()
    const group = (b: Body) => bodies.get(b.id) ?? bodies.set(b.id, { body: b, faces: [], whole: false }).get(b.id)!
    for (const s of refs) {
      const ref = decodeRef(s)
      if (ref?.kind === 'face') {
        const hit = resolveFace(ref, env.bodies, report)
        if (!hit) continue
        const g = group(hit.body)
        if (!g.faces.includes(hit.index)) g.faces.push(hit.index)
      } else if (ref?.kind === 'body') {
        const b = env.bodies.find((x) => x.id === ref.bodyId)
        if (b) group(b).whole = true
      }
    }
    if (!bodies.size) throw new RefError(refs.length ? 'The surfaces you picked no longer exist (an edit upstream removed them). Pick them again.' : 'Select the surfaces or faces to offset', report.lostRefs)
    const out: Body[] = []
    for (const g of bodies.values()) {
      if (g.body.kind !== 'brep') throw new Error('Offset Surface needs B-rep surfaces, not a mesh')
      if (!g.body.surface && !g.faces.length) throw new Error(`${g.body.name} is a solid: pick some of its faces to offset`)
      const args: SurfaceOffsetArgs = { id: env.newId(out.length), name: `${g.body.name} offset`, sources: [{ key: g.body.key, ...(g.whole ? {} : { faces: g.faces }) }], distance: p.distance as number }
      out.push(await call<Body>(env, 'surfaceOffset', args))
    }
    return { bodies: out, kind: 'add' }
  },
  async manip(p, env) {
    const ref = (p.faces as string[])[0] ? decodeRef((p.faces as string[])[0]) : null
    if (ref?.kind !== 'face') return null
    const hit = resolveFace(ref, env.bodies)
    if (!hit) return null
    const sg = faceSigs(hit.body)[hit.index]
    return { origin: sg.centroid, dir: sg.normal, key: 'distance' }
  },
})

