/** Pattern: repeat features, faces or bodies in a rectangular, circular or path arrangement; click an instance marker to skip it. */
import { GridFour } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, decodeRef, encodeSelection, resolveEdge } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { stateAround } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import type { FeatureCtx, PreviewCtx, PreviewHandle } from '@/doc/types'
import type { Body, Vec3 } from '@/kernel/types'
import { applyPoint, type Xf } from '@/kernel/xform'
import { useSketchData } from '@/sketch/draw'
import { toWorld } from '@/sketch/plane'
import type { SketchData } from '@/sketch/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, setPreview } from '@/viewport/preview'
import { createRunner } from '../previewKit'
import { chainPolylines, edgePolyline, liveRefEnv, resolveAxis, resolveDirection, type AxisDef, type RefEnv } from './geo'
import { clearMarkers, setMarkers } from './markers'
import { entityPolyline } from '@/sketch/curves'
import { repeat, type RepeatEnv, type Source } from './source'
import { circXforms, pathXforms, rectXforms, type LinearDir } from './transforms'

const AXES = [{ value: 'X', label: 'X axis' }, { value: 'Y', label: 'Y axis' }, { value: 'Z', label: 'Z axis' }, { value: 'ref', label: 'Reference' }]
const WORLD: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }
const isRect = (v: ParamValues) => v.kind === 'rect'
const isCirc = (v: ParamValues) => v.kind === 'circ'
const isPath = (v: ParamValues) => v.kind === 'path'

/** The parameters of one direction of a rectangular pattern. */
function dirParams(n: '1' | '2', show: (v: ParamValues) => boolean): ParamSchema['params'] {
  const which = n === '1' ? 'first' : 'second'
  return [
    { type: 'enum', key: 'axis' + n, help: `The ${which} direction of the pattern: a world axis, or a reference (a model edge, an axis, or the normal of a plane or flat face).`, label: `Direction ${n}`, display: 'select', default: n === '1' ? 'X' : 'Y', options: AXES, visibleWhen: show },
    { type: 'selection-ref', key: 'ref' + n, help: `Click an edge, an axis, a construction plane or a flat face to set direction ${n}.`, label: `Direction ${n} reference`, accepts: ['edge', 'axis', 'plane', 'face'], pick: true, required: true, default: [], visibleWhen: (v) => show(v) && v['axis' + n] === 'ref' },
    { type: 'number', key: 'count' + n, help: `How many instances there are in direction ${n}, counting the original.`, label: `Quantity ${n}`, min: 1, step: 1, default: n === '1' ? 3 : 2, visibleWhen: show },
    { type: 'enum', key: 'type' + n, help: 'Spacing: the distance between neighbouring instances. Extent: the distance from the first instance to the last.', label: `Distance type ${n}`, display: 'segmented', default: 'spacing', options: [{ value: 'spacing', label: 'Spacing' }, { value: 'extent', label: 'Extent' }], visibleWhen: show },
    { type: 'number', key: 'distance' + n, help: `The spacing or the extent in direction ${n}, in mm.`, label: `Distance ${n}`, unit: 'mm', step: 1, default: 20, visibleWhen: show },
    { type: 'bool', key: 'sym' + n, help: 'Symmetric: spread the instances both ways around the original instead of only one way. With an even quantity the extra instance goes on the positive side.', label: `Symmetric ${n}`, default: false, visibleWhen: show },
    { type: 'bool', key: 'flip' + n, help: `Reverse direction ${n}.`, label: `Flip ${n}`, default: false, visibleWhen: show },
  ]
}

export const patternSchema: ParamSchema = {
  id: 'pattern',
  title: 'Pattern',
  params: [
    { type: 'enum', key: 'source', help: 'What to repeat: earlier features (their effect on the model), faces (a boss, a pocket, a hole...) or whole bodies.', label: 'Pattern', display: 'segmented', default: 'features', options: [{ value: 'features', label: 'Features' }, { value: 'faces', label: 'Faces' }, { value: 'bodies', label: 'Bodies' }] },
    { type: 'selection-ref', key: 'features', help: 'Click features in the timeline to repeat what they did to the model (a cut, a hole, a boss...). Click again to remove one.', label: 'Features', accepts: ['feature'], multiple: true, required: true, default: [], visibleWhen: (v) => v.source === 'features' },
    { type: 'selection-ref', key: 'faces', help: 'The faces that make up the feature to repeat, for example the walls and top of a boss, or the walls and floor of a pocket.', label: 'Faces', accepts: ['face'], multiple: true, required: true, pick: true, default: [], visibleWhen: (v) => v.source === 'faces' },
    { type: 'selection-ref', key: 'bodies', help: 'The bodies to copy.', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [], visibleWhen: (v) => v.source === 'bodies' },
    { type: 'enum', key: 'kind', help: 'Rectangular: a grid in one or two directions. Circular: round an axis. Path: along a curve.', label: 'Type', display: 'segmented', default: 'rect', options: [{ value: 'rect', label: 'Rectangular' }, { value: 'circ', label: 'Circular' }, { value: 'path', label: 'Path' }] },
    ...dirParams('1', isRect),
    { type: 'bool', key: 'second', help: 'Add a second direction to make a grid.', label: 'Second direction', default: false, visibleWhen: isRect },
    ...dirParams('2', (v) => isRect(v) && v.second === true),
    { type: 'enum', key: 'caxis', help: 'The axis to turn round: a world axis through the origin, or a reference (a cylinder, an edge or a construction axis).', label: 'Axis', display: 'select', default: 'Z', options: AXES, visibleWhen: isCirc },
    { type: 'selection-ref', key: 'cref', help: 'Click a cylindrical face, a circular or straight edge, or a construction axis to turn round.', label: 'Axis reference', accepts: ['face', 'edge', 'axis'], pick: true, required: true, default: [], visibleWhen: (v) => isCirc(v) && v.caxis === 'ref' },
    { type: 'number', key: 'ccount', help: 'How many instances there are round the axis, counting the original.', label: 'Quantity', min: 1, step: 1, default: 6, visibleWhen: isCirc },
    { type: 'number', key: 'cangle', help: 'The angle the pattern covers, in degrees. 360 spreads the instances evenly right round; less spreads them from the first to the last.', label: 'Angle', unit: 'deg', step: 5, default: 360, visibleWhen: isCirc },
    { type: 'bool', key: 'csym', help: 'Symmetric: spread the instances both ways around the original.', label: 'Symmetric', default: false, visibleWhen: isCirc },
    { type: 'bool', key: 'cflip', help: 'Turn the other way round.', label: 'Flip', default: false, visibleWhen: isCirc },
    { type: 'selection-ref', key: 'path', help: 'The curve to follow: click edges of a body (several edges are joined in order), or a sketch.', label: 'Path', accepts: ['edge', 'sketch'], multiple: true, pick: true, required: true, default: [], visibleWhen: isPath },
    { type: 'number', key: 'pcount', help: 'How many instances there are along the path, counting the original at its start.', label: 'Quantity', min: 1, step: 1, default: 5, visibleWhen: isPath },
    { type: 'enum', key: 'ptype', help: 'Spacing: a fixed distance between instances. Extent: the distance from the first to the last. Whole path: spread over the full length.', label: 'Distance type', display: 'select', default: 'full', options: [{ value: 'full', label: 'Whole path' }, { value: 'spacing', label: 'Spacing' }, { value: 'extent', label: 'Extent' }], visibleWhen: isPath },
    { type: 'number', key: 'pdistance', help: 'The spacing or the extent along the path, in mm.', label: 'Distance', unit: 'mm', step: 1, default: 20, visibleWhen: (v) => isPath(v) && v.ptype !== 'full' },
    { type: 'bool', key: 'palign', help: 'Turn each instance to follow the direction of the path.', label: 'Follow the path', default: false, visibleWhen: isPath },
    { type: 'bool', key: 'pflip', help: 'Start from the other end of the path.', label: 'Flip', default: false, visibleWhen: isPath },
    { type: 'enum', key: 'operation', help: 'New bodies: every copy is a separate body. Join: fold the copies into the original body.', label: 'Operation', display: 'segmented', default: 'new', options: [{ value: 'new', label: 'New bodies' }, { value: 'join', label: 'Join' }], visibleWhen: (v) => v.source === 'bodies' },
    { type: 'selection-ref', key: 'skip', help: 'Instances left out of the pattern (click an instance marker in the viewport to skip or restore it).', label: 'Skipped instances', accepts: [], multiple: true, default: [], visibleWhen: () => false },
    { type: 'info', key: 'hint', help: 'Markers show where every instance goes. Click one in the viewport to leave that instance out; click it again to bring it back.', label: 'Instances', default: '', text: (v) => instancesInfo(v) },
  ],
}

function instancesInfo(v: ParamValues): string {
  const skip = ((v.skip as string[]) ?? []).length
  const total = (v.kind === 'rect' ? (Math.max(1, Math.round(v.count1 as number)) * (v.second ? Math.max(1, Math.round(v.count2 as number)) : 1)) : v.kind === 'circ' ? Math.max(1, Math.round(v.ccount as number)) : Math.max(1, Math.round(v.pcount as number))) - 1
  return `${Math.max(0, total - skip)} copies${skip ? ` (${skip} skipped)` : ''}. Click a marker in the viewport to skip an instance.`
}

interface PatternP {
  source: 'features' | 'faces' | 'bodies'; features: string[]; faces: string[]; bodies: string[]
  kind: 'rect' | 'circ' | 'path'
  axis1: string; ref1: string[]; count1: number; type1: 'spacing' | 'extent'; distance1: number; sym1: boolean; flip1: boolean
  second: boolean
  axis2: string; ref2: string[]; count2: number; type2: 'spacing' | 'extent'; distance2: number; sym2: boolean; flip2: boolean
  caxis: string; cref: string[]; ccount: number; cangle: number; csym: boolean; cflip: boolean
  path: string[]; pcount: number; ptype: 'spacing' | 'extent' | 'full'; pdistance: number; palign: boolean; pflip: boolean
  operation: 'new' | 'join'
  skip: string[]
}
const asP = (v: ParamValues) => v as unknown as PatternP

/** The polyline of a path selection: body edges and / or sketches, joined in order. */
function pathOf(refs: string[], env: RefEnv, report: RefReport): Vec3[] {
  const lines: Vec3[][] = []
  for (const s of refs) {
    const ref = s.startsWith('{') ? decodeRef(s) : null
    if (ref?.kind === 'edge') {
      const hit = resolveEdge(ref, env.bodies, report)
      if (!hit) { report.lost.set(s, 'The path edge no longer exists'); continue }
      lines.push(edgePolyline(hit.body, hit.index))
      continue
    }
    const sk = env.dataOf(s) as SketchData | undefined
    if (sk?.entities && sk.plane) {
      const model = { entities: sk.entities, constraints: sk.constraints, next: 0 }
      for (const e of sk.entities) {
        if (e.type === 'point' || e.construction) continue
        lines.push(entityPolyline(model, e).map((p) => toWorld(sk.plane, p)))
      }
      continue
    }
    report.lost.set(s, 'The path no longer exists')
  }
  const path = chainPolylines(lines)
  if (path.length < 2) throw new RefError('The path no longer exists or has no length. Pick it again.', refs)
  return path
}

async function dirOf(axis: string, ref: string[], env: RefEnv, report: RefReport): Promise<Vec3> {
  if (axis !== 'ref') return WORLD[axis]
  if (!ref[0]) throw new Error('Select the direction reference')
  return resolveDirection(ref[0], env, report)
}

export interface Instance { xf: Xf; index: number }

/** All the instances of the pattern (the original is not one of them), numbered from 1 in a stable order. */
export async function instancesOf(p: PatternP, env: RefEnv, report: RefReport): Promise<Instance[]> {
  if (p.kind === 'rect') {
    const a: LinearDir = { dir: await dirOf(p.axis1, p.ref1, env, report), count: p.count1, distance: p.distance1, type: p.type1, symmetric: p.sym1, flip: p.flip1 }
    const b: LinearDir | undefined = p.second ? { dir: await dirOf(p.axis2, p.ref2, env, report), count: p.count2, distance: p.distance2, type: p.type2, symmetric: p.sym2, flip: p.flip2 } : undefined
    return rectXforms(a, b).map((r, i) => ({ xf: r.xf, index: i + 1 }))
  }
  if (p.kind === 'circ') {
    let ax: AxisDef = { origin: [0, 0, 0], dir: WORLD[p.caxis] ?? [0, 0, 1] }
    if (p.caxis === 'ref') {
      if (!p.cref[0]) throw new Error('Select the axis reference')
      ax = await resolveAxis(p.cref[0], env, report)
    }
    return circXforms({ origin: ax.origin, dir: ax.dir, count: p.ccount, angle: p.cangle, symmetric: p.csym, flip: p.cflip }).map((r, i) => ({ xf: r.xf, index: i + 1 }))
  }
  const path = pathOf(p.path, env, report)
  return pathXforms({ path, count: p.pcount, distance: p.pdistance, type: p.ptype, align: p.palign, flip: p.pflip }).map((r, i) => ({ xf: r.xf, index: i + 1 }))
}

export interface PatternResult { bodies: Body[]; instances: Instance[]; skipped: Set<number>; anchor: Vec3 | null; report: RefReport }

/** Build the pattern: shared by the feature and its live preview. */
export async function buildPattern(p: PatternP, env: RepeatEnv, report = new RefReport()): Promise<PatternResult> {
  const instances = await instancesOf(p, env, report)
  if (!instances.length) throw new Error('The pattern has only the original: raise the quantity')
  const skipped = new Set((p.skip ?? []).map(Number))
  const keep = instances.filter((i) => !skipped.has(i.index))
  const src: Source = { kind: p.source, features: p.features, faces: p.faces, bodies: p.bodies }
  if (!keep.length) {
    // every copy is skipped: still resolve the selection so the markers have an anchor
    const r = await repeat(env, src, [], p.operation, report).catch(() => null)
    return { bodies: [], instances, skipped, anchor: r?.anchor ?? null, report }
  }
  const r = await repeat(env, src, keep.map((i) => i.xf), p.operation, report)
  return { bodies: r.bodies, instances, skipped, anchor: r.anchor, report }
}

const envOf = (ctx: FeatureCtx): RepeatEnv => ({
  bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as unknown as RepeatEnv['kernel'], around: ctx.stateAround,
  fid: ctx.feature.id, newId: (n) => ctx.newBodyId(n),
})

registerFeature({
  type: 'pattern',
  label: 'Pattern',
  icon: GridFour,
  schema: patternSchema,
  async compute(ctx, raw) {
    const p = asP(raw)
    const r = await buildPattern(p, envOf(ctx))
    if (!r.bodies.length && !p.skip.length) throw new Error('Nothing to repeat')
    return { bodies: r.bodies, warning: r.report.warning, reboundRefs: r.report.flagged, upgrades: r.report.upgradeMap }
  },
  preview: (ctx) => patternPreview(ctx),
})

function patternPreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  const ui = useUi
  const filterBefore = ui.getState().selectionFilter

  const toggle = (id: string) => {
    const skip = new Set(((cur.skip as string[]) ?? []))
    if (skip.has(id)) skip.delete(id)
    else skip.add(id)
    cur = { ...cur, skip: [...skip].sort((a, b) => Number(a) - Number(b)) }
    setValues(cur)
  }

  const runner = createRunner(async (stale) => {
    let p: PatternP
    try { p = asP(resolveParams(patternSchema, cur)) } catch { clearPreview(); clearMarkers(); return }
    const env: RepeatEnv = {
      ...liveRefEnv(), around: stateAround, fid: 'preview', newId: (n) => `preview.${n}`,
    }
    let r: PatternResult
    try { r = await buildPattern(p, env) } catch { clearPreview(); clearMarkers(); return }
    if (stale()) return
    const anchor = r.anchor
    if (anchor) {
      setMarkers([
        { id: '0', pos: anchor, state: 'fixed', label: 'Original' },
        ...r.instances.map((i) => ({ id: String(i.index), pos: applyPoint(i.xf, anchor), state: (r.skipped.has(i.index) ? 'off' : 'on') as 'on' | 'off' })),
      ], toggle)
    } else clearMarkers()
    const ids = r.bodies.map((b) => b.id).filter((id) => env.bodies.some((b) => b.id === id))
    setPreview(r.bodies.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), ids)
  })

  // timeline chips are the way to pick features: a click on a chip toggles that feature
  const offFeature = useDoc.subscribe((s, prev) => {
    if (s.selectedFeatureId === prev.selectedFeatureId || !s.selectedFeatureId || cur.source !== 'features') return
    const id = s.selectedFeatureId
    const list = (cur.features as string[]) ?? []
    cur = { ...cur, features: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] }
    setValues(cur)
  })
  runner.schedule()
  return {
    update(v) { cur = v; runner.schedule() },
    dispose() {
      offFeature()
      runner.dispose()
      clearPreview()
      clearMarkers()
      ui.getState().setSelectionFilter(filterBefore)
    },
  }
}

/** Ribbon command: starts from the selection (faces / bodies), else from the selected timeline feature. */
export function startPattern() {
  const ui = useUi.getState()
  const d = useDoc.getState()
  const faces = ui.selection.filter((r) => r.kind === 'face')
  const bodies = ui.selection.filter((r) => r.kind === 'body')
  const init: ParamValues = {}
  if (faces.length) { init.source = 'faces'; init.faces = encodeSelection(faces, d.geometry) }
  else if (bodies.length) { init.source = 'bodies'; init.bodies = bodies.map((b) => b.id) }
  else if (d.selectedFeatureId && d.features.some((f) => f.id === d.selectedFeatureId && f.type !== 'sketch')) init.features = [d.selectedFeatureId]
  createFeature('pattern', init, 'solid.pattern')
}
