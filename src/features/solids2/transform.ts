/** Move / Copy extras (point to point, axis moves, rotation about an axis or pivot, Create copy), Align and Scale. */
import { ArrowsHorizontal, ArrowsIn, ArrowsInLineHorizontal } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, bodyIdsOf, decodeRef, edgeSigs, faceSigs, resolveEdge, resolveFace, resolveVertex, vertexSigs } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { FeatureCtx } from '@/doc/types'
import { getKernel, type KernelClient } from '@/kernel/client'
import { bbox, type Body, type Vec3 } from '@/kernel/types'
import { add3, compose, cross3, dot3, mul3, norm3, rotationAbout, rotationBetween, sub3, translation, applyPoint, type Xf } from '@/kernel/xform'
import { useUi } from '@/store/ui'
import type { ParamDef, ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, setPreview } from '@/viewport/preview'
import { resolveAxis, resolvePoint, type RefEnv } from '../modeling-tools/geo'
import { createRunner } from '../previewKit'

type Kernel = Pick<KernelClient, 'call' | 'transform'>
const free = (v: ParamValues) => (v.moveType ?? 'free') === 'free'
const mt = (v: ParamValues) => (v.moveType as string | undefined) ?? 'free'

// ================================================================================================ Move / Copy

export const moveTypeParam: ParamDef = {
  type: 'enum', key: 'moveType', label: 'Move type', display: 'select', default: 'free',
  help: 'Free move: type or drag the move, turn and scale. Point to point: carry one picked point onto another. Point to position: carry a point to typed coordinates. Translate along axis: slide along an axis or straight edge. Rotate about axis: turn about an axis or edge, through a pivot point.',
  options: [{ value: 'free', label: 'Free move' }, { value: 'p2p', label: 'Point to point' }, { value: 'p2pos', label: 'Point to position' }, { value: 'axis', label: 'Translate along axis' }, { value: 'rotate', label: 'Rotate about axis' }],
}

export const moveExtraParams: ParamDef[] = [
  { type: 'selection-ref', key: 'fromPt', help: 'The point that is carried: click a corner of the body, or pick a construction point.', label: 'From point', accepts: ['vertex', 'point'], required: true, pick: true, default: [], visibleWhen: (v) => mt(v) === 'p2p' || mt(v) === 'p2pos' },
  { type: 'selection-ref', key: 'toPt', help: 'The point it lands on: a corner of another body, or a construction point.', label: 'To point', accepts: ['vertex', 'point'], required: true, pick: true, default: [], visibleWhen: (v) => mt(v) === 'p2p' },
  { type: 'vector3', key: 'toPos', help: 'The coordinates the From point lands on, as X, Y, Z in mm.', label: 'To position', unit: 'mm', step: 1, default: [0, 0, 0], visibleWhen: (v) => mt(v) === 'p2pos' },
  { type: 'selection-ref', key: 'axisRef', help: 'The axis: a world axis, a construction axis, a straight edge or the axis of a cylinder.', label: 'Axis', accepts: ['axis', 'edge', 'face'], required: true, pick: true, default: [], visibleWhen: (v) => mt(v) === 'axis' || mt(v) === 'rotate' },
  { type: 'number', key: 'distance', help: 'How far to slide along the axis, in mm (negative goes the other way).', label: 'Distance', unit: 'mm', step: 1, default: 10, visibleWhen: (v) => mt(v) === 'axis' },
  { type: 'number', key: 'axisAngle', help: 'How far to turn about the axis, in degrees.', label: 'Angle', unit: 'deg', step: 5, default: 90, visibleWhen: (v) => mt(v) === 'rotate' },
  { type: 'selection-ref', key: 'pivotPt', help: 'The pivot the bodies turn about: a corner or construction point. Optional; the point of the axis nearest the origin is used when empty.', label: 'Pivot point', accepts: ['vertex', 'point'], pick: true, default: [], visibleWhen: (v) => mt(v) === 'rotate' },
  { type: 'bool', key: 'copy', help: 'Leave the original where it is and make a moved copy.', label: 'Create copy', default: false },
]

/** The rigid transform of a non-free move, or null when the dialog is not complete yet. */
export async function moveXf(p: ParamValues, env: RefEnv, report = new RefReport()): Promise<Xf | null> {
  const ref = (k: string) => ((p[k] as string[] | undefined) ?? [])[0]
  switch (mt(p)) {
    case 'p2p': {
      if (!ref('fromPt') || !ref('toPt')) return null
      const a = await resolvePoint(ref('fromPt'), env, report), b = await resolvePoint(ref('toPt'), env, report)
      return translation(sub3(b, a))
    }
    case 'p2pos': {
      if (!ref('fromPt')) return null
      const a = await resolvePoint(ref('fromPt'), env, report)
      return translation(sub3(p.toPos as Vec3, a))
    }
    case 'axis': {
      if (!ref('axisRef')) return null
      const ax = await resolveAxis(ref('axisRef'), env, report)
      return translation(mul3(norm3(ax.dir), p.distance as number))
    }
    case 'rotate': {
      if (!ref('axisRef')) return null
      const ax = await resolveAxis(ref('axisRef'), env, report)
      const pivot = ref('pivotPt') ? await resolvePoint(ref('pivotPt'), env, report) : ax.origin
      return rotationAbout(pivot, ax.dir, p.axisAngle as number)
    }
    default: return null
  }
}

/** ZYX Euler angles in degrees (the order the move gizmo applies them). */
export function eulerOf(R: number[]): Vec3 {
  const sy = Math.max(-1, Math.min(1, -R[6]))
  const ry = Math.asin(sy)
  const D = 180 / Math.PI
  if (Math.abs(sy) > 0.99999) return [Math.atan2(-R[5], R[4]) * D, ry * D, 0]
  return [Math.atan2(R[7], R[8]) * D, ry * D, Math.atan2(R[3], R[0]) * D]
}

/** The translate / rotate the viewport ghost needs for a rigid transform about the pivot (the bodies' middle). */
export function ghostOf(xf: Xf, pivot: Vec3): { translate: Vec3; rotate: Vec3 } {
  if (xf.t !== 'rigid') return { translate: [0, 0, 0], rotate: [0, 0, 0] }
  return { translate: sub3(applyPoint(xf, pivot), pivot), rotate: eulerOf(xf.R) }
}

/** Run a Move that uses a Fusion option (a move type other than free, or Create copy). */
export async function moveAdvanced(ctx: FeatureCtx, p: ParamValues, targets: Body[], pivot: Vec3): Promise<{ bodies: Body[] }> {
  const copy = !!p.copy
  const out: Body[] = []
  if (free(p)) {
    // a free move that leaves the original: the same transform, into new bodies
    const spec = { pivot, translate: p.translate as Vec3, rotate: p.rotate as Vec3, scale: p.scale as number }
    for (let i = 0; i < targets.length; i++) out.push(await ctx.kernel.transform({ id: ctx.newBodyId(i + 1), name: targets[i].name + ' copy', key: targets[i].key, spec }))
    return { bodies: out }
  }
  const env: RefEnv = { bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as unknown as RefEnv['kernel'] }
  const report = new RefReport()
  const xf = await moveXf(p, env, report)
  if (!xf) throw new RefError('Pick the points or the axis to move by', report.lostRefs)
  for (let i = 0; i < targets.length; i++) {
    const b = targets[i]
    out.push((await ctx.kernel.call('bodyXform', { id: copy ? ctx.newBodyId(i + 1) : b.id, name: copy ? b.name + ' copy' : b.name, key: b.key, xform: xf, tag: copy ? `${ctx.feature.id}.${i + 1}` : '' })) as Body)
  }
  return { bodies: out }
}

/** Translucent copies standing where a Create copy move puts them. */
export function copyPreview(getValues: () => ParamValues, getEnv: () => RefEnv, kernel: () => Kernel) {
  const runner = createRunner(async (stale) => {
    const v = getValues()
    if (!v.copy) return clearPreview()
    try {
      const ids = bodyIdsOf((v.bodyIds as string[]) ?? [])
      const bodies = useDoc.getState().geometry.filter((b) => ids.includes(b.id))
      if (!bodies.length) return clearPreview()
      const pivot = pivotOfBodies(bodies)
      const made: Body[] = []
      if (free(v)) {
        const spec = { pivot, translate: v.translate as Vec3, rotate: v.rotate as Vec3, scale: v.scale as number }
        for (const b of bodies) made.push(await kernel().transform({ id: 'preview', name: 'preview', key: b.key, spec }))
      } else {
        const xf = await moveXf(v, getEnv())
        if (!xf) return clearPreview()
        for (const b of bodies) made.push((await kernel().call('bodyXform', { id: 'preview', name: 'preview', key: b.key, xform: xf, tag: 'p' })) as Body)
      }
      if (!stale()) setPreview(made.map((b) => ({ mesh: b.mesh, kind: 'add' as const })))
    } catch { clearPreview() }
  })
  return runner
}

function pivotOfBodies(bodies: Body[]): Vec3 {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const b of bodies) {
    const bb = bbox(b.mesh.positions)
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], bb.min[k]); max[k] = Math.max(max[k], bb.max[k]) }
  }
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
}

// ================================================================================================ Align

type Anchor = { kind: 'face'; point: Vec3; dir: Vec3 } | { kind: 'edge'; point: Vec3; dir: Vec3 } | { kind: 'vertex'; point: Vec3 }

function anchorOf(s: string, bodies: Body[], report: RefReport, what: string): Anchor {
  const ref = decodeRef(s)
  if (ref?.kind === 'face') {
    const hit = resolveFace(ref, bodies, report)
    if (!hit) throw new RefError(`The ${what} face no longer exists. Pick it again.`, report.lostRefs)
    const sg = faceSigs(hit.body)[hit.index]
    return { kind: 'face', point: sg.centroid, dir: sg.normal }
  }
  if (ref?.kind === 'edge') {
    const hit = resolveEdge(ref, bodies, report)
    if (!hit) throw new RefError(`The ${what} edge no longer exists. Pick it again.`, report.lostRefs)
    const sg = edgeSigs(hit.body)[hit.index]
    return { kind: 'edge', point: sg.midpoint, dir: sg.direction }
  }
  if (ref?.kind === 'vertex') {
    const hit = resolveVertex(ref, bodies, report)
    if (!hit) throw new RefError(`The ${what} corner no longer exists. Pick it again.`, report.lostRefs)
    return { kind: 'vertex', point: vertexSigs(hit.body)[hit.index].pos }
  }
  throw new Error(`Pick a face, edge or corner for ${what}`)
}

/** The transform that carries the From feature onto the To feature: faces meet face to face (or side by side when flipped), edges line up, corners coincide. */
export function alignXf(from: Anchor, to: Anchor, flip: boolean, angle: number, offset: number): Xf {
  if (from.kind !== to.kind) throw new Error('Pick the same kind of thing for From and To: two faces, two edges or two corners')
  if (from.kind === 'vertex' || to.kind === 'vertex') return translation(sub3(to.point, from.point))
  const target = from.kind === 'face' ? (flip ? to.dir : mul3(to.dir, -1)) : (flip ? mul3(to.dir, -1) : to.dir)
  const R = rotationBetween(from.dir, target)
  const rigid: Xf = { t: 'rigid', R, p: [0, 0, 0] }
  const pf = applyPoint(rigid, from.point)
  const lift = from.kind === 'face' ? mul3(norm3(to.dir), offset) : [0, 0, 0] as Vec3
  const base: Xf = { t: 'rigid', R, p: add3(sub3(to.point, pf), lift) }
  return Math.abs(angle) > 1e-9 ? compose(base, rotationAbout(add3(to.point, lift), to.dir, angle)) : base
}

export const alignSchema: ParamSchema = {
  id: 'align',
  title: 'Align',
  params: [
    { type: 'selection-ref', key: 'bodyIds', help: 'The bodies that move. Click them in the viewport or the Browser.', label: 'Bodies to move', accepts: ['body'], multiple: true, required: true, pick: true, default: [] },
    { type: 'selection-ref', key: 'fromRef', help: 'A face, edge or corner of the body that moves. Click it in the viewport.', label: 'From', accepts: ['face', 'edge', 'vertex'], required: true, pick: true, default: [] },
    { type: 'selection-ref', key: 'toRef', help: 'The face, edge or corner it lands on: the same kind as From, on another body.', label: 'To', accepts: ['face', 'edge', 'vertex'], required: true, pick: true, default: [] },
    { type: 'bool', key: 'flip', help: 'Faces: turn the body round so the faces point the same way instead of touching. Edges: reverse the direction.', label: 'Flip', default: false },
    { type: 'number', key: 'angle', help: 'Turn the body this many degrees about the line it is aligned on.', label: 'Angle', unit: 'deg', step: 5, default: 0 },
    { type: 'number', key: 'offset', help: 'Face to face: leave this gap between the faces, in mm.', label: 'Offset', unit: 'mm', step: 0.5, default: 0 },
  ],
}

function alignPlan(p: ParamValues, bodies: Body[], report: RefReport): { targets: Body[]; xf: Xf } {
  const ids = bodyIdsOf(p.bodyIds as string[])
  const targets = ids.map((id) => bodies.find((b) => b.id === id)).filter((b): b is Body => !!b)
  if (!targets.length) throw new Error('Select the bodies to move')
  const f = ((p.fromRef as string[]) ?? [])[0], t = ((p.toRef as string[]) ?? [])[0]
  if (!f || !t) throw new Error('Pick the From and To features')
  const xf = alignXf(anchorOf(f, bodies, report, 'From'), anchorOf(t, bodies, report, 'To'), !!p.flip, p.angle as number, p.offset as number)
  return { targets, xf }
}

registerFeature({
  type: 'align',
  label: 'Align',
  icon: ArrowsHorizontal,
  schema: alignSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const { targets, xf } = alignPlan(p, ctx.bodies, report)
    const out: Body[] = []
    for (const b of targets) out.push((await ctx.kernel.call('bodyXform', { id: b.id, name: b.name, key: b.key, xform: xf, tag: '' })) as Body)
    return { bodies: out, warning: report.warning, reboundRefs: report.flagged }
  },
  preview({ values }) {
    let cur = values
    const runner = createRunner(async (stale) => {
      let p: ParamValues
      try { p = resolveParams(alignSchema, cur) } catch { return clearPreview() }
      try {
        const bodies = useDoc.getState().geometry
        const { targets, xf } = alignPlan(p, bodies, new RefReport())
        const made: Body[] = []
        for (const b of targets) made.push((await getKernel().call('bodyXform', { id: 'preview-' + b.id, name: 'preview', key: b.key, xform: xf, tag: '' })) as Body)
        if (!stale()) setPreview(made.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), targets.map((b) => b.id))
      } catch { if (!stale()) clearPreview() }
    })
    runner.schedule()
    return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clearPreview() } }
  },
})

export function startAlign() {
  const sel = useUi.getState().selection
  const geometry = useDoc.getState().geometry
  const ids = [...new Set(sel.filter((r) => r.kind === 'body').map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id))
  createFeature('align', { bodyIds: ids.slice(0, 1) }, 'solid.align')
}

// ================================================================================================ Scale

export const scaleSchema: ParamSchema = {
  id: 'scale',
  title: 'Scale',
  params: [
    { type: 'selection-ref', key: 'bodyIds', help: 'The bodies to scale. Click them in the viewport or the Browser.', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [] },
    { type: 'enum', key: 'scaleType', help: 'Uniform: one factor for every direction. Non-uniform: a factor for X, Y and Z (the result is a mesh body, because a solid cannot be stretched unevenly here).', label: 'Scale type', display: 'segmented', default: 'uniform', options: [{ value: 'uniform', label: 'Uniform' }, { value: 'nonUniform', label: 'Non-uniform' }] },
    { type: 'number', key: 'factor', help: 'How much bigger (above 1) or smaller (below 1) the bodies become.', label: 'Scale factor', min: 0.001, step: 0.1, default: 2, visibleWhen: (v) => v.scaleType !== 'nonUniform' },
    { type: 'vector3', key: 'factors', help: 'The scale factor along X, Y and Z.', label: 'Scale factors', step: 0.1, default: [1, 1, 1], visibleWhen: (v) => v.scaleType === 'nonUniform' },
    { type: 'selection-ref', key: 'point', help: 'The point that stays where it is while everything grows or shrinks about it: a corner or construction point. Leave empty to scale about the middle of the bodies.', label: 'Scale point', accepts: ['vertex', 'point'], pick: true, default: [] },
  ],
}

async function scaleRun(kernel: Pick<KernelClient, 'call'>, p: ParamValues, bodies: Body[], env: RefEnv, idOf: (b: Body) => string, report: RefReport): Promise<Body[]> {
  const ids = bodyIdsOf(p.bodyIds as string[])
  const targets = ids.map((id) => bodies.find((b) => b.id === id)).filter((b): b is Body => !!b)
  if (!targets.length) throw new Error('Select the bodies to scale')
  const pt = ((p.point as string[]) ?? [])[0]
  const centre = pt ? await resolvePoint(pt, env, report) : pivotOfBodies(targets)
  const factors: Vec3 = p.scaleType === 'nonUniform' ? (p.factors as Vec3) : [p.factor as number, p.factor as number, p.factor as number]
  const out: Body[] = []
  for (const b of targets) out.push((await kernel.call('scaleBody', { id: idOf(b), name: b.name, key: b.key, factors, centre })) as Body)
  return out
}

registerFeature({
  type: 'scale',
  label: 'Scale',
  icon: ArrowsInLineHorizontal,
  schema: scaleSchema,
  async compute(ctx, p) {
    const report = new RefReport()
    const bodies = await scaleRun(ctx.kernel, p, ctx.bodies, { bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as unknown as RefEnv['kernel'] }, (b) => b.id, report)
    return { bodies, warning: report.warning, reboundRefs: report.flagged }
  },
  preview({ values }) {
    let cur = values
    const runner = createRunner(async (stale) => {
      let p: ParamValues
      try { p = resolveParams(scaleSchema, cur) } catch { return clearPreview() }
      try {
        const geometry = useDoc.getState().geometry
        const made = await scaleRun(getKernel(), p, geometry, { bodies: geometry, dataOf: () => undefined, kernel: getKernel() as unknown as RefEnv['kernel'] }, (b) => 'preview-' + b.id, new RefReport())
        if (!stale()) setPreview(made.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), made.map((b) => b.id.replace('preview-', '')))
      } catch { if (!stale()) clearPreview() }
    })
    runner.schedule()
    return { update(v) { cur = v; runner.schedule() }, dispose() { runner.dispose(); clearPreview() } }
  },
})

export function startScale() {
  const sel = useUi.getState().selection
  const geometry = useDoc.getState().geometry
  let ids = [...new Set(sel.filter((r) => r.kind === 'body').map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id))
  if (!ids.length && geometry.length === 1) ids = [geometry[0].id]
  createFeature('scale', { bodyIds: ids }, 'solid.scale')
}

void ArrowsIn
void dot3
void cross3
