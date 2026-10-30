/** Direct edits: Press/Pull, Offset Face, Delete Face, Replace Face, Split Face, Split Body and Draft. */
import { ArrowsOutLineVertical, Eraser, Knife, PushPin, Scissors, SplitVertical, TrendDown, ArrowsVertical } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, bodyIdsOf, decodeRef, encodeSelection, faceSigs, resolveEdge, resolveFace } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { FeatureCtx, FeatureResult, PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { DraftArgs, SplitTool, SurfaceTarget } from '@/kernel/modeling-ops'
import type { EdgeFrame } from '@/kernel/model-ops'
import type { Body, Vec3 } from '@/kernel/types'
import { cross3, dot3, mul3, norm3, sub3, add3 } from '@/kernel/xform'
import { useUi } from '@/store/ui'
import type { NumberParam, ParamSchema, ParamValues, SelectionRefParam } from '@/ui/schema'
import { clearPreview, resetManip, setPreview, useManip } from '@/viewport/preview'
import { resetAngleManip } from '@/viewport/AngleManipulator'
import { createRunner } from '../previewKit'
import { arcRadius, showAngle, type AngleSpec } from '../handleKit'
import { liveRefEnv, resolveDirection, resolvePlane, type RefEnv } from './geo'
import { facesOf, type FaceArg } from './source'

const facePick = (help: string, required = true): SelectionRefParam => ({ type: 'selection-ref', key: 'faces', help, label: 'Faces', accepts: ['face'], multiple: true, pick: true, required, default: [] }) 

interface BuildEnv extends RefEnv { fid: string }
interface Built { bodies: Body[]; remove?: string[] }
interface Direct {
  type: string
  label: string
  icon: Icon
  command: string
  schema: ParamSchema
  build(p: ParamValues, env: BuildEnv, report: RefReport): Promise<Built>
  /** the arrow to drag in the viewport: origin, direction and which parameter it edits */
  manip?(p: ParamValues, env: RefEnv): Promise<{ origin: Vec3; dir: Vec3; key: string } | null>
  /** the rotary handle to drag in the viewport (angles) */
  angleManip?(p: ParamValues, env: RefEnv): Promise<AngleSpec | null>
  /** the selection filter to switch to while the dialog is open */
  filter?: 'face' | 'body' | 'edge'
}

const call = async <T>(env: RefEnv, op: string, args: unknown) => (await env.kernel.call(op, args)) as T

/** Per body: the faces the refs point at. */
function byBody(refs: string[], env: RefEnv, report: RefReport) {
  return facesOf(refs, env, report)
}

function register(d: Direct) {
  registerFeature({
    type: d.type,
    label: d.label,
    icon: d.icon,
    schema: d.schema,
    async compute(ctx: FeatureCtx, raw): Promise<FeatureResult> {
      const report = new RefReport()
      const env: BuildEnv = { bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as unknown as RefEnv['kernel'], fid: ctx.feature.id }
      const r = await d.build(raw, env, report)
      return { bodies: r.bodies, remove: r.remove, warning: report.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
    },
    preview: (ctx) => directPreview(d, ctx),
  })
}

function directPreview(d: Direct, { values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  const ui = useUi
  const before = ui.getState().selectionFilter
  if (d.filter) ui.getState().setSelectionFilter(d.filter)
  const runner = createRunner(async (stale) => {
    let p: ParamValues
    try { p = resolveParams(d.schema, cur) } catch { clearPreview(); resetManip(); resetAngleManip(); return }
    const env = { ...liveRefEnv(), fid: 'preview' }
    try {
      if (d.manip) {
        const m = await d.manip(p, env)
        if (m && !stale()) {
          const key = m.key
          useManip.setState({
            active: true, origin: m.origin, dir: m.dir, tip: p[key] as number, factor: 1, label: (v) => `${v.toFixed(2)} mm`,
            onChange: (v) => { cur = { ...cur, [key]: v }; setValues(cur) },
          })
        } else if (!m) resetManip()
      }
      if (d.angleManip) {
        const a = await d.angleManip(p, env)
        if (!stale()) showAngle(a, p, (patch) => { cur = { ...cur, ...patch }; setValues(cur) })
      }
      const r = await d.build(p, env, new RefReport())
      if (stale()) return
      // the original stays in the scene, faint but pickable, so faces and edges can still be added or removed
      setPreview(r.bodies.map((b) => ({ mesh: b.mesh, kind: 'result' as const })), [], [...r.bodies.map((b) => b.id), ...(r.remove ?? [])])
    } catch { clearPreview() }
  })
  runner.schedule()
  return {
    update(v) { cur = v; runner.schedule() },
    dispose() { runner.dispose(); clearPreview(); resetManip(); resetAngleManip(); if (d.filter) ui.getState().setSelectionFilter(before) },
  }
}

/** Frame of the first picked face (centre and outward normal), for the drag arrow. */
function faceFrame(refs: string[], env: RefEnv): { origin: Vec3; dir: Vec3 } | null {
  try {
    const g = facesOf(refs, env, new RefReport())[0]
    const sg = faceSigs(g.body)[g.faces[0].index]
    return { origin: sg.centroid, dir: sg.normal }
  } catch { return null }
}

// ------------------------------------------------------------------------------------------------ offset face / press pull

const distanceParam: NumberParam = { type: 'number', key: 'distance', help: 'How far to move the faces along their normals, in mm. Positive grows the body, negative shrinks it. You can also drag the arrow in the viewport.', label: 'Distance', unit: 'mm', step: 0.5, default: 2 }

async function offsetFaces(p: ParamValues, env: BuildEnv, report: RefReport): Promise<Built> {
  const bodies: Body[] = []
  for (const g of byBody(p.faces as string[], env, report)) {
    if (g.body.kind !== 'brep' || g.body.surface) throw new Error('Offset Face needs a solid body' + (g.body.surface ? ': for a surface use Offset Surface' : ', not a mesh'))
    bodies.push(await call<Body>(env, 'offsetFaces', { id: g.body.id, name: g.body.name, key: g.body.key, faces: g.faces, distance: p.distance as number, fid: env.fid }))
  }
  return { bodies }
}

export const offsetFaceSchema: ParamSchema = { id: 'offsetFace', title: 'Offset Face', params: [facePick('The faces to move. Flat, cylindrical and spherical faces can be offset; the faces around them stretch or shrink to follow.'), distanceParam] }
register({
  type: 'offsetFace', label: 'Offset Face', icon: ArrowsOutLineVertical, command: 'solid.offsetFace', schema: offsetFaceSchema, filter: 'face', build: offsetFaces,
  manip: async (p, env) => { const f = faceFrame(p.faces as string[], env); return f ? { ...f, key: 'distance' } : null },
})

export const pressPullSchema: ParamSchema = {
  id: 'pressPull',
  title: 'Press/Pull',
  params: [
    { ...facePick('Click a face to push or pull it, or an edge to round it. Faces move along their normal; edges get a fillet of the distance as radius.', true), key: 'entities', label: 'Faces or edges', accepts: ['face', 'edge'] },
    { ...distanceParam, help: 'Faces: how far to move them (positive grows the body, negative shrinks it). Edges: the radius of the rounding, which must be positive. Drag the arrow in the viewport to change it.' },
  ],
}
register({
  type: 'pressPull', label: 'Press/Pull', icon: PushPin, command: 'solid.pressPull', schema: pressPullSchema,
  async build(p, env, report) {
    const refs = p.entities as string[]
    const kinds = refs.map((s) => decodeRef(s)?.kind)
    if (kinds.includes('edge') && kinds.includes('face')) throw new Error('Pick faces or edges, not both')
    if (kinds.includes('edge')) {
      const d = p.distance as number
      if (d <= 0) throw new Error('Press/Pull on an edge rounds it: use a positive distance')
      const by = new Map<string, { body: Body; edges: number[] }>()
      for (const s of refs) {
        const ref = decodeRef(s)
        if (!ref || ref.kind !== 'edge') continue
        const hit = resolveEdge(ref, env.bodies, report)
        if (!hit) continue
        const g = by.get(hit.body.id) ?? by.set(hit.body.id, { body: hit.body, edges: [] }).get(hit.body.id)!
        if (!g.edges.includes(hit.index)) g.edges.push(hit.index)
      }
      if (!by.size) throw new RefError('The selected edges no longer exist. Pick them again.', report.lostRefs)
      const bodies: Body[] = []
      for (const g of by.values()) bodies.push(await call<Body>(env, 'edgeMod', { id: g.body.id, name: g.body.name, key: g.body.key, edges: g.edges, size: d, mode: 'fillet', fid: env.fid }))
      return { bodies }
    }
    return offsetFaces({ ...p, faces: refs }, env, report)
  },
  manip: async (p, env) => {
    const refs = p.entities as string[]
    const ref = refs[0] ? decodeRef(refs[0]) : null
    if (ref?.kind === 'edge') {
      const hit = resolveEdge(ref, env.bodies)
      if (!hit) return null
      const [f] = (await env.kernel.call('edgeFrames', { key: hit.body.key, edges: [hit.index] })) as (EdgeFrame | null)[]
      return f ? { origin: f.mid, dir: f.dir, key: 'distance' } : null
    }
    const f = faceFrame(refs, env)
    return f ? { ...f, key: 'distance' } : null
  },
})

// ------------------------------------------------------------------------------------------------ delete / replace

export const deleteFaceSchema: ParamSchema = { id: 'deleteFace', title: 'Delete Face', params: [facePick('The faces to remove. The faces around them are extended until they close the gap (fillets, holes, bosses and pockets heal this way).')] }
register({
  type: 'deleteFace', label: 'Delete Face', icon: Eraser, command: 'solid.deleteFace', schema: deleteFaceSchema, filter: 'face',
  async build(p, env, report) {
    const bodies: Body[] = []
    for (const g of byBody(p.faces as string[], env, report)) {
      if (g.body.kind !== 'brep' || g.body.surface) throw new Error('Delete Face needs a solid body' + (g.body.surface ? ': for a surface use Delete Face in the Surface tab' : ', not a mesh'))
      bodies.push(await call<Body>(env, 'deleteFaces', { id: g.body.id, name: g.body.name, key: g.body.key, faces: g.faces, fid: env.fid }))
    }
    return { bodies }
  },
})

/** A plane or face reference as a surface the kernel can use. */
async function surfaceOf(s: string, env: RefEnv, report: RefReport): Promise<SurfaceTarget> {
  const ref = s.startsWith('{') ? decodeRef(s) : null
  if (ref?.kind === 'face') {
    const hit = resolveFace(ref, env.bodies, report)
    if (!hit) throw new RefError('The target face no longer exists. Pick it again.', [s])
    return { kind: 'face', key: hit.body.key, index: hit.index, names: (hit.body.mesh.faceNames?.[hit.index] ?? []) as string[] }
  }
  const pl = await resolvePlane(s, env, report)
  return { kind: 'plane', origin: pl.origin, normal: pl.normal }
}

export const replaceFaceSchema: ParamSchema = {
  id: 'replaceFace',
  title: 'Replace Face',
  params: [
    facePick('The faces to move onto the target. The faces around them are extended or trimmed to meet it.'),
    { type: 'selection-ref', key: 'target', help: 'The surface to move onto: a plane, a construction plane, or a face (flat, cylindrical or spherical) of this or another body.', label: 'Replace with', accepts: ['plane', 'face'], pick: true, required: true, default: [] },
  ],
}
register({
  type: 'replaceFace', label: 'Replace Face', icon: SplitVertical, command: 'solid.replaceFace', schema: replaceFaceSchema, filter: 'face',
  async build(p, env, report) {
    const target = await surfaceOf((p.target as string[])[0], env, report)
    const bodies: Body[] = []
    for (const g of byBody(p.faces as string[], env, report)) {
      bodies.push(await call<Body>(env, 'replaceFaces', { id: g.body.id, name: g.body.name, key: g.body.key, faces: g.faces, target, fid: env.fid }))
    }
    return { bodies }
  },
})

// ------------------------------------------------------------------------------------------------ split

const toolParam = (what: string): SelectionRefParam => ({ type: 'selection-ref', key: 'tool', help: `What to split ${what} with: a plane or construction plane, a face (flat or curved), or another body.`, label: 'Splitting tool', accepts: ['plane', 'face', 'body'], pick: true, required: true, default: [] })

async function toolOf(s: string, env: RefEnv, report: RefReport): Promise<SplitTool> {
  const ref = s.startsWith('{') ? decodeRef(s) : null
  if (ref?.kind === 'face') {
    const t = await surfaceOf(s, env, report)
    return t.kind === 'face' ? t : { kind: 'plane', origin: t.origin, normal: t.normal }
  }
  const body = env.bodies.find((b) => b.id === s)
  if (body) return { kind: 'body', key: body.key }
  const pl = await resolvePlane(s, env, report)
  return { kind: 'plane', origin: pl.origin, normal: pl.normal }
}

export const splitFaceSchema: ParamSchema = { id: 'splitFace', title: 'Split Face', params: [facePick('The faces to divide. The body itself stays in one piece.'), toolParam('the faces')] }
register({
  type: 'splitFace', label: 'Split Face', icon: Scissors, command: 'solid.splitFace', schema: splitFaceSchema, filter: 'face',
  async build(p, env, report) {
    const tool = await toolOf((p.tool as string[])[0], env, report)
    const bodies: Body[] = []
    for (const g of byBody(p.faces as string[], env, report)) {
      bodies.push(await call<Body>(env, 'splitFaces', { id: g.body.id, name: g.body.name, key: g.body.key, faces: g.faces, tool, fid: env.fid }))
    }
    return { bodies }
  },
})

export const splitBodySchema: ParamSchema = {
  id: 'splitBody',
  title: 'Split Body',
  params: [
    { type: 'selection-ref', key: 'bodies', help: 'The bodies to cut into pieces.', label: 'Bodies', accepts: ['body'], multiple: true, pick: true, required: true, default: [] },
    toolParam('the bodies'),
  ],
}
register({
  type: 'splitBody', label: 'Split Body', icon: Knife, command: 'solid.splitBody', schema: splitBodySchema, filter: 'body',
  async build(p, env, report) {
    const tool = await toolOf((p.tool as string[])[0], env, report)
    const ids = bodyIdsOf(p.bodies as string[])
    const out: Body[] = []
    for (const id of ids) {
      const b = env.bodies.find((x) => x.id === id)
      if (!b) throw new RefError('A body to split no longer exists. Pick it again.', p.bodies as string[])
      if (b.kind !== 'brep' || b.surface) throw new Error('Split Body needs solid bodies' + (b.surface ? ': for a surface use Trim' : ', not meshes'))
      // a body used as the tool is not split by itself
      if (tool.kind === 'body' && tool.key === b.key) continue
      out.push(...(await call<Body[]>(env, 'splitBody', { id: b.id, name: b.name, key: b.key, tool, fid: env.fid })))
    }
    if (!out.length) throw new Error('Nothing was split')
    return { bodies: out }
  },
})

// ------------------------------------------------------------------------------------------------ draft

export const draftSchema: ParamSchema = {
  id: 'draft',
  title: 'Draft',
  params: [
    { type: 'selection-ref', key: 'plane', help: 'The neutral plane: the faces tilt about the line where they meet it, so that line stays where it is. Click a plane or a flat face.', label: 'Neutral plane', accepts: ['plane', 'face'], pick: true, required: true, default: [] },
    facePick('The faces to tilt.'),
    { type: 'selection-ref', key: 'pull', help: 'The pull direction (the way the part comes out of the mould): a plane or flat face (its normal), an edge or an axis. Leave empty to use the neutral plane normal.', label: 'Pull direction', accepts: ['plane', 'face', 'edge', 'axis'], pick: true, default: [] },
    { type: 'number', key: 'angle', help: 'Draft angle in degrees. Positive tilts the faces so the body gets narrower away from the neutral plane along the pull direction.', label: 'Angle', unit: 'deg', min: -45, max: 45, step: 0.5, default: 3 },
    { type: 'bool', key: 'flip', help: 'Reverse the pull direction.', label: 'Flip direction', default: false },
  ],
}
// the faces field comes second here so that the plane is picked first
register({
  type: 'draft', label: 'Draft', icon: TrendDown, command: 'solid.draft', schema: draftSchema, filter: 'face',
  async build(p, env, report) {
    const plane = await resolvePlane((p.plane as string[])[0], env, report)
    const pullRef = (p.pull as string[])[0]
    let dir: Vec3 = pullRef ? await resolveDirection(pullRef, env, report) : plane.normal
    if (p.flip) dir = mul3(dir, -1)
    const bodies: Body[] = []
    for (const g of byBody(p.faces as string[], env, report)) {
      const args: DraftArgs = { id: g.body.id, name: g.body.name, key: g.body.key, faces: g.faces as FaceArg[], dir: norm3(dir), neutral: plane.origin, angle: p.angle as number, fid: env.fid }
      bodies.push(await call<Body>(env, 'draftFaces', args))
    }
    return { bodies }
  },
  // the arc turns about the line where the first face meets the neutral plane, starting along the face towards the pull direction
  // (a positive angle tilts the face the way that narrows the body along the pull direction)
  async angleManip(p, env) {
    const planeRef = (p.plane as string[])[0]
    if (!planeRef || !(p.faces as string[])[0]) return null
    const plane = await resolvePlane(planeRef, env, new RefReport())
    const pullRef = (p.pull as string[])[0]
    let pull: Vec3 = pullRef ? await resolveDirection(pullRef, env, new RefReport()) : plane.normal
    if (p.flip) pull = mul3(pull, -1)
    pull = norm3(pull)
    const f = faceFrame(p.faces as string[], env)
    if (!f) return null
    const n = norm3(f.dir)
    const u = sub3(pull, mul3(n, dot3(pull, n)))
    if (Math.hypot(...u) < 1e-3) return null
    const up = norm3(u)
    const pn = norm3(plane.normal)
    const den = dot3(up, pn)
    if (Math.abs(den) < 1e-3) return null
    const t = -dot3(sub3(f.origin, plane.origin), pn) / den
    return { origin: add3(f.origin, mul3(up, t)), axis: norm3(cross3(n, up)), start: up, radius: arcRadius(env.bodies), key: 'angle', min: -45, max: 45, step: 0.5, nonZero: false }
  },
})

// ------------------------------------------------------------------------------------------------ commands

/** Start a direct-edit tool with the current selection. */
export function startDirect(type: string, tool: string) {
  const ui = useUi.getState()
  const bodies = useDoc.getState().geometry
  const faces = encodeSelection(ui.selection.filter((r) => r.kind === 'face'), bodies)
  const edges = encodeSelection(ui.selection.filter((r) => r.kind === 'edge'), bodies)
  const wholeBodies = ui.selection.filter((r) => r.kind === 'body').map((r) => r.id)
  const init: ParamValues = {}
  if (type === 'pressPull') init.entities = [...faces, ...edges]
  else if (type === 'splitBody') init.bodies = wholeBodies
  else if (faces.length) init.faces = faces
  createFeature(type, init, tool)
}
export { ArrowsVertical, getKernel }
