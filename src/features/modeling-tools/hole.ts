/** Hole: simple, counterbore or countersink holes at points clicked on a face or at sketch points; tapped holes with a cosmetic or modeled thread. */
import { CircleDashed } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, decodeRef, encodeRef, faceSigs, resolveFace } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { FeatureCtx, PreviewCtx, PreviewHandle } from '@/doc/types'
import { bbox, type Body, type Vec3 } from '@/kernel/types'
import type { HoleArgs, HolePlace, HoleSpec } from '@/kernel/modeling-ops'
import { add3, mul3, norm3 } from '@/kernel/xform'
import { isPlanarFace } from '@/sketch/create'
import { planeFromNormal, toLocal, toWorld } from '@/sketch/plane'
import type { SketchData } from '@/sketch/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { useLastPick } from '@/viewport/lastPick'
import { clearPreview, setPreview } from '@/viewport/preview'
import { createRunner } from '../previewKit'
import { liveRefEnv, resolvePoint, useConstruct, type CosmeticThread, type RefEnv } from './geo'
import { HOLE_PRESETS, tapDrill } from './holePresets'
import { clearMarkers, setMarkers } from './markers'

const tapped = (v: ParamValues) => v.tapType === 'tapped'
/** holes that are not clicked onto a face (sketch points, construction points, vertices) need a direction */
const offFace = (v: ParamValues) => ((v.places as string[]) ?? []).some((s) => !s.startsWith('{'))
const through = (v: ParamValues) => v.depthMode === 'through'

export const holeSchema: ParamSchema = {
  id: 'hole',
  title: 'Hole',
  params: [
    { type: 'selection-ref', key: 'places', help: 'Where the holes go. Click points on a flat face of the model (each click adds a hole; click its dot to remove it), or pick sketches (holes go at their points and circle centres), construction points or vertices.', label: 'Positions', accepts: ['sketch', 'point', 'vertex'], multiple: true, pick: true, required: true, default: [] },
    { type: 'bool', key: 'flip', help: 'Drill from the other side of a sketch plane.', label: 'Flip direction', default: false, visibleWhen: (v) => offFace(v) },
    { type: 'enum', key: 'pointDir', help: 'For holes at construction points or vertices: the direction the hole opens towards.', label: 'Opens towards', display: 'select', default: '+Z', visibleWhen: (v) => offFace(v), options: ['+Z', '-Z', '+X', '-X', '+Y', '-Y'].map((v) => ({ value: v, label: v })) },
    { type: 'preset', key: 'preset', help: 'Fill in the sizes for a standard screw: clearance, counterbore, countersink, tapped, or a heat-set insert for 3D printing.', label: 'Size', presets: HOLE_PRESETS, default: 'custom' },
    { type: 'enum', key: 'holeType', help: 'Simple: a plain hole. Counterbore: a wider flat-bottomed recess for a screw head. Countersink: a cone for a flat head screw.', label: 'Type', display: 'segmented', default: 'simple', options: [{ value: 'simple', label: 'Simple' }, { value: 'cbore', label: 'Counterbore' }, { value: 'csink', label: 'Countersink' }] },
    { type: 'enum', key: 'tapType', help: 'Simple: a plain drilled hole. Tapped: drilled to the tap size and marked with a thread.', label: 'Thread', display: 'segmented', default: 'simple', options: [{ value: 'simple', label: 'None' }, { value: 'tapped', label: 'Tapped' }] },
    { type: 'number', key: 'dia', help: 'Diameter of the hole, in mm. For a tapped hole this is worked out from the thread.', label: 'Diameter', unit: 'mm', min: 0.1, step: 0.1, default: 6, visibleWhen: (v) => !tapped(v) },
    { type: 'number', key: 'major', help: 'Nominal (outside) diameter of the thread, in mm.', label: 'Thread diameter', unit: 'mm', min: 1, step: 0.5, default: 6, visibleWhen: tapped },
    { type: 'number', key: 'pitch', help: 'Distance between the thread crests, in mm (1 for an M6 coarse thread).', label: 'Thread pitch', unit: 'mm', min: 0.2, step: 0.05, default: 1, visibleWhen: tapped },
    { type: 'number', key: 'threadLength', help: 'How deep the thread goes, in mm from the surface.', label: 'Thread length', unit: 'mm', min: 0.5, step: 0.5, default: 10, visibleWhen: tapped },
    { type: 'bool', key: 'modeled', help: 'Cut the real helical thread into the model instead of only marking it. It looks right and exports as geometry, but is slower to rebuild.', label: 'Model the thread', default: false, visibleWhen: tapped },
    { type: 'number', key: 'cbDia', help: 'Diameter of the counterbore, in mm.', label: 'Counterbore diameter', unit: 'mm', min: 0.1, step: 0.1, default: 11, visibleWhen: (v) => v.holeType === 'cbore' },
    { type: 'number', key: 'cbDepth', help: 'Depth of the counterbore, in mm.', label: 'Counterbore depth', unit: 'mm', min: 0.1, step: 0.1, default: 6, visibleWhen: (v) => v.holeType === 'cbore' },
    { type: 'number', key: 'cskDia', help: 'Diameter of the countersink at the surface, in mm.', label: 'Countersink diameter', unit: 'mm', min: 0.1, step: 0.1, default: 12, visibleWhen: (v) => v.holeType === 'csink' },
    { type: 'number', key: 'cskAngle', help: 'Included angle of the countersink cone, in degrees (90 for metric flat head screws).', label: 'Countersink angle', unit: 'deg', min: 10, max: 170, step: 1, default: 90, visibleWhen: (v) => v.holeType === 'csink' },
    { type: 'enum', key: 'depthMode', help: 'Distance: a blind hole of the depth below. Through all: right through the body.', label: 'Extent', display: 'segmented', default: 'through', options: [{ value: 'depth', label: 'Distance' }, { value: 'through', label: 'Through all' }] },
    { type: 'number', key: 'depth', help: 'Depth of the hole from the surface, in mm.', label: 'Depth', unit: 'mm', min: 0.1, step: 0.5, default: 10, visibleWhen: (v) => !through(v) },
    { type: 'number', key: 'tip', help: 'Included angle of the drill point at the bottom of a blind hole, in degrees (118 is a standard drill). 0 leaves a flat bottom.', label: 'Drill point angle', unit: 'deg', min: 0, max: 170, step: 1, default: 0, visibleWhen: (v) => !through(v) },
    { type: 'info', key: 'summary', help: 'The size the hole will be drilled to.', label: 'Drill', default: '', text: (v) => summary(v) },
  ],
}

function summary(v: ParamValues): string {
  const n = ((v.places as string[]) ?? []).length
  const dia = tapped(v) ? tapDrill(v.major as number, v.pitch as number) : (v.dia as number)
  const bits = [`${n} hole${n === 1 ? '' : 's'}`, `drill ${+dia.toFixed(2)} mm`]
  if (tapped(v)) bits.push(`M${v.major}x${v.pitch} thread`)
  return bits.join(', ')
}

interface HoleP {
  places: string[]; flip: boolean; pointDir: string; holeType: 'simple' | 'cbore' | 'csink'; tapType: string
  dia: number; major: number; pitch: number; threadLength: number; modeled: boolean
  cbDia: number; cbDepth: number; cskDia: number; cskAngle: number; depthMode: string; depth: number; tip: number
}
const asP = (v: ParamValues) => v as unknown as HoleP

const DIR: Record<string, Vec3> = { '+Z': [0, 0, 1], '-Z': [0, 0, -1], '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0] }

/** One hole clicked on a face: the face and the position in the face's own frame, so it follows the face when the model changes. */
interface FaceHole { hole: 1; k: string; face: string; u: number; v: number }
const parseFaceHole = (s: string): FaceHole | null => {
  if (!s.startsWith('{')) return null
  try { const j = JSON.parse(s); return j.hole === 1 ? (j as FaceHole) : null } catch { return null }
}

export interface PlacedHole extends HolePlace { body: Body | null }

/** Where every hole goes in the model. */
export async function placeHoles(p: HoleP, env: RefEnv, report: RefReport): Promise<PlacedHole[]> {
  const out: PlacedHole[] = []
  let n = 0
  const bodyAt = (origin: Vec3, dir: Vec3): Body | null => {
    const q = add3(origin, mul3(norm3(dir), -0.05))
    for (const b of env.bodies) {
      if (b.kind !== 'brep' || b.surface) continue
      const bb = bbox(b.mesh.positions)
      if ([0, 1, 2].every((k) => q[k] >= bb.min[k] - 1e-6 && q[k] <= bb.max[k] + 1e-6)) return b
    }
    return null
  }
  for (const s of p.places) {
    const fh = parseFaceHole(s)
    if (fh) {
      const ref = decodeRef(fh.face)
      const hit = ref && ref.kind === 'face' ? resolveFace(ref, env.bodies, report) : null
      if (!hit) { report.lost.set(s, 'A face with holes on it no longer exists'); continue }
      const sg = faceSigs(hit.body)[hit.index]
      const pl = planeFromNormal(sg.centroid, sg.normal)
      out.push({ k: fh.k, origin: toWorld(pl, [fh.u, fh.v]), dir: sg.normal, body: hit.body })
      continue
    }
    const sk = env.dataOf(s) as SketchData | undefined
    if (sk?.entities && sk.plane) {
      const used = new Set<string>()
      for (const e of sk.entities) if (e.type === 'line' || e.type === 'arc') { if (e.type === 'line') { used.add(e.p1); used.add(e.p2) } else { used.add(e.s); used.add(e.e) } }
      const centers = new Set(sk.entities.filter((e) => e.type === 'circle' || e.type === 'arc').map((e) => (e as { c: string }).c))
      for (const e of sk.entities) {
        if (e.type !== 'point' || e.construction) continue
        if (used.has(e.id) && !centers.has(e.id)) continue
        const origin = toWorld(sk.plane, [e.x, e.y])
        const dir = mul3(sk.plane.normal, p.flip ? -1 : 1)
        out.push({ k: `${s}${e.id}`, origin, dir, body: bodyAt(origin, dir) })
        n++
      }
      continue
    }
    try {
      const origin = await resolvePoint(s, env, report)
      const dir = DIR[p.pointDir] ?? DIR['+Z']
      out.push({ k: `p${n++}${s.length}`, origin, dir, body: bodyAt(origin, dir) })
    } catch (e) {
      if (e instanceof RefError) report.lost.set(s, 'A hole position no longer exists')
      else throw e
    }
  }
  if (!out.length) throw new RefError('None of the hole positions exist any more. Pick them again.', p.places)
  return out
}

function specOf(p: HoleP): HoleSpec {
  const isTap = p.tapType === 'tapped'
  const blind = p.depthMode !== 'through'
  return {
    kind: p.holeType,
    dia: isTap ? tapDrill(p.major, p.pitch) : p.dia,
    depth: blind ? p.depth : null,
    cbDia: p.cbDia, cbDepth: p.cbDepth, cskDia: p.cskDia, cskAngle: p.cskAngle,
    tip: blind ? p.tip : 0,
    ...(isTap && p.modeled ? { thread: { pitch: p.pitch, major: p.major, length: p.threadLength } } : {}),
  }
}

export interface HoleResult { bodies: Body[]; placed: PlacedHole[]; threads: CosmeticThread[]; report: RefReport }

/** Build the holes: shared by the feature and its preview. */
export async function buildHoles(p: HoleP, env: RefEnv, fid: string, report = new RefReport(), toolOnly = false): Promise<HoleResult> {
  const placed = await placeHoles(p, env, report)
  const spec = specOf(p)
  const by = new Map<string, { body: Body; holes: PlacedHole[] }>()
  for (const h of placed) {
    if (!h.body) { report.lost.set(h.k, 'A hole is not on any body'); continue }
    const g = by.get(h.body.id) ?? by.set(h.body.id, { body: h.body, holes: [] }).get(h.body.id)!
    g.holes.push(h)
  }
  if (!by.size) throw new Error('None of the hole positions are on a body. Click a face of the model, or pick points that lie on it.')
  const bodies: Body[] = []
  for (const g of by.values()) {
    const args: HoleArgs = { id: g.body.id, name: g.body.name, key: g.body.key, holes: g.holes.map((h) => ({ k: h.k, origin: h.origin, dir: h.dir })), spec, fid, toolOnly }
    bodies.push((await env.kernel.call('holes', args)) as Body)
  }
  const threads: CosmeticThread[] = p.tapType === 'tapped' && !p.modeled
    ? placed.filter((h) => h.body).map((h) => ({ origin: h.origin, dir: h.dir, major: p.major, length: Math.min(p.threadLength, p.depthMode === 'through' ? p.threadLength : p.depth), label: `M${p.major}x${p.pitch}` }))
    : []
  return { bodies, placed, threads, report }
}

registerFeature({
  type: 'hole',
  label: 'Hole',
  icon: CircleDashed,
  schema: holeSchema,
  async compute(ctx: FeatureCtx, raw) {
    const p = asP(raw)
    const env: RefEnv = { bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as unknown as RefEnv['kernel'] }
    const r = await buildHoles(p, env, ctx.feature.id)
    useConstruct.getState().setThreads(ctx.feature.id, r.threads)
    return { bodies: r.bodies, data: { threads: r.threads }, warning: r.report.warning, reboundRefs: r.report.flagged, upgrades: r.report.upgradeMap }
  },
  preview: (ctx) => holePreview(ctx),
})

function holePreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  let seq = useLastPick.getState().seq
  const markerClick = (id: string) => {
    cur = { ...cur, places: (cur.places as string[]).filter((s) => parseFaceHole(s)?.k !== id) }
    setValues(cur)
  }
  const runner = createRunner(async (stale) => {
    let p: HoleP
    try { p = asP(resolveParams(holeSchema, cur)) } catch { clearPreview(); clearMarkers(); return }
    const env = liveRefEnv()
    const rep = new RefReport()
    try {
      const placed = await placeHoles(p, env, rep)
      setMarkers(placed.map((h) => ({ id: h.k, pos: add3(h.origin, mul3(norm3(h.dir), 0.05)), state: 'on' as const })), markerClick)
      // the original body stays pickable (more holes can be clicked onto it); the drills show in red where they cut
      const r = await buildHoles(p, env, 'preview', rep, true)
      if (stale()) return
      setPreview(r.bodies.map((b) => ({ mesh: b.mesh, kind: 'cut' as const })))
      useConstruct.getState().setThreads('preview', r.threads)
    } catch { clearPreview() }
  })
  // a click on a flat face adds a hole there
  const off = useLastPick.subscribe((s) => {
    if (s.seq === seq || !s.point || s.ref?.kind !== 'face') return
    seq = s.seq
    const bodies = useDoc.getState().geometry
    const body = bodies.find((b) => b.id === s.ref!.id)
    if (!body || s.ref.index === undefined || !isPlanarFace(body, s.ref.index)) return
    const sg = faceSigs(body)[s.ref.index]
    const pl = planeFromNormal(sg.centroid, sg.normal)
    const [u, v] = toLocal(pl, s.point)
    const ref = { kind: 'face' as const, bodyId: body.id, featureId: body.featureId, index: s.ref.index, sig: sg, name: body.mesh.faceNames?.[s.ref.index]?.[0] }
    const places = [...(cur.places as string[])]
    const k = 'a' + Math.random().toString(36).slice(2, 7)
    places.push(JSON.stringify({ hole: 1, k, face: encodeRef(ref), u: +u.toFixed(4), v: +v.toFixed(4) }))
    cur = { ...cur, places }
    setValues(cur)
  })
  runner.schedule()
  return {
    update(v) { cur = v; runner.schedule() },
    dispose() { off(); runner.dispose(); clearPreview(); clearMarkers(); useConstruct.getState().setThreads('preview', null) },
  }
}

/** Ribbon command: starts with the selected sketch(es) or face point, else waits for clicks on a face. */
export function startHole() {
  const ui = useUi.getState()
  const places = ui.selection.filter((r) => r.kind === 'sketch').map((r) => r.id)
  createFeature('hole', places.length ? { places } : {}, 'solid.hole')
}
