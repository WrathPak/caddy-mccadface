/** Extrude: sketch profiles or planar faces -> solid, combined with Join / Cut / Intersect / New body. */
import { ArrowFatLineUp } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, encodeSelection } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import type { FeatureCtx, PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { Body, Vec3 } from '@/kernel/types'
import { useSketchData } from '@/sketch/draw'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { viewportBus } from '@/viewport/bus'
import { autoOperation, bodySide, profileSamples } from './autoCut'
import { clearPreview, resetManip, setPreview, useManip, useProfilePick } from '@/viewport/preview'
import { ctxEnv, combine, liveEnv, profileRef, resolveInputs, type Inputs } from '../modeling'
import { createRunner, watchSelection } from '../previewKit'
import { showArrow } from '../handleKit'
import { newComponent } from '@/assembly/actions'
import { liveRefEnv, type RefEnv } from '../modeling-tools/geo'
import { resolveSpan, type ExtentP, type Span } from './extent'

export const extrudeSchema: ParamSchema = {
  id: 'extrude',
  title: 'Extrude',
  params: [
    { type: 'selection-ref', key: 'profiles', help: 'What to extrude: closed shapes from a sketch, or a flat face of a body. Click them in the viewport.', label: 'Profiles', accepts: ['sketch', 'face'], multiple: true, required: true, default: [] },
    {
      type: 'group',
      label: 'Extent',
      children: [
        {
          type: 'enum', key: 'start', help: 'Where the extrude begins. Profile Plane: on the sketch or face. Offset: a distance away from it. From Object: at a face or plane you pick.', label: 'Start', display: 'segmented', default: 'profile',
          options: [{ value: 'profile', label: 'Profile Plane' }, { value: 'offset', label: 'Offset' }, { value: 'object', label: 'From Object' }],
        },
        { type: 'number', key: 'startOffset', help: 'How far from the profile plane the extrude begins, in mm. A negative number starts on the other side.', label: 'Start offset', unit: 'mm', step: 0.5, default: 5, visibleWhen: (v) => v.start === 'offset' },
        { type: 'selection-ref', key: 'startObject', help: 'A flat face or a plane, parallel to the profile, that the extrude starts from. Click it in the viewport.', label: 'Start object', accepts: ['face', 'plane'], pick: true, autoActivate: true, required: true, default: [], visibleWhen: (v) => v.start === 'object' },
        {
          type: 'enum', key: 'direction', help: 'One side: grow one way. Symmetric: half the distance each way from the sketch. Two sides: a different distance each way.', label: 'Direction', display: 'segmented', default: 'one',
          options: [{ value: 'one', label: 'One side' }, { value: 'sym', label: 'Symmetric' }, { value: 'two', label: 'Two sides' }],
        },
        {
          type: 'enum', key: 'extent', help: 'Distance: a length you give. To Object: up to a face, plane or corner you pick. All: all the way through every body.', label: 'Extent type', display: 'select', default: 'dist',
          options: [{ value: 'dist', label: 'Distance' }, { value: 'object', label: 'To Object' }, { value: 'all', label: 'All' }],
        },
        { type: 'number', key: 'distance', help: 'How far to extrude, in mm. A negative number goes the other way. You can also drag the arrow in the viewport.', label: 'Distance', unit: 'mm', step: 0.5, default: 10, visibleWhen: (v) => !v.extent || v.extent === 'dist' },
        { type: 'selection-ref', key: 'toObject', help: 'The face, plane or corner (vertex) to extrude up to. A flat face that is not parallel to the profile cuts the extrude off at a slant.', label: 'To object', accepts: ['face', 'plane', 'vertex'], pick: true, autoActivate: true, required: true, default: [], visibleWhen: (v) => v.extent === 'object' },
        { type: 'number', key: 'toOffset', help: 'Stop this far before (negative) or past (positive) the object, in mm.', label: 'Object offset', unit: 'mm', step: 0.5, default: 0, visibleWhen: (v) => v.extent === 'object' },
        { type: 'bool', key: 'flip', help: 'All goes one way from the profile. Flip it to go the other way.', label: 'Flip direction', default: false, visibleWhen: (v) => v.extent === 'all' && v.direction === 'one' },
        {
          type: 'enum', key: 'extent2', help: 'How far the second side goes: a Distance, up to an object, or All the way through.', label: 'Second side extent', display: 'select', default: 'dist', visibleWhen: (v) => v.direction === 'two',
          options: [{ value: 'dist', label: 'Distance' }, { value: 'object', label: 'To Object' }, { value: 'all', label: 'All' }],
        },
        { type: 'number', key: 'distance2', help: 'How far to extrude in the opposite direction, in mm.', label: 'Distance 2', unit: 'mm', min: 0, step: 0.5, default: 5, visibleWhen: (v) => v.direction === 'two' && (!v.extent2 || v.extent2 === 'dist') },
        { type: 'selection-ref', key: 'toObject2', help: 'The face, plane or vertex the second side runs up to.', label: 'Second side object', accepts: ['face', 'plane', 'vertex'], pick: true, autoActivate: true, required: true, default: [], visibleWhen: (v) => v.direction === 'two' && v.extent2 === 'object' },
        { type: 'number', key: 'toOffset2', help: 'Stop the second side this far before (negative) or past (positive) its object, in mm.', label: 'Second side offset', unit: 'mm', step: 0.5, default: 0, visibleWhen: (v) => v.direction === 'two' && v.extent2 === 'object' },
        { type: 'number', key: 'taper', help: 'Tilts the sides inward (positive) or outward (negative), in degrees, like a draft angle for moulding. 0 keeps the sides straight.', label: 'Taper angle', unit: 'deg', min: -89, max: 89, step: 0.5, default: 0 },
      ],
    },
    {
      type: 'enum', key: 'operation', help: 'Join: add to the body. Cut: remove material. Intersect: keep only the overlap. New body: make a separate body. New Component: make a new component that holds the new body.', label: 'Operation', display: 'select', default: 'join',
      options: [
        { value: 'join', label: 'Join' }, { value: 'cut', label: 'Cut' },
        { value: 'intersect', label: 'Intersect' }, { value: 'new', label: 'New body' }, { value: 'component', label: 'New Component' },
      ],
    },
    { type: 'selection-ref', key: 'targets', help: 'The bodies to join to, cut or intersect. Leave empty to use every body that the shape touches.', label: 'Target bodies', accepts: ['body'], multiple: true, default: [], visibleWhen: (v) => v.operation !== 'new' && v.operation !== 'component' },
  ],
}

interface ExtrudeP extends ExtentP { profiles: string[]; taper: number }
const asP = (v: ParamValues) => v as unknown as ExtrudeP

/** Arguments for the worker's extrudeTool op. */
function toolArgs(p: ExtrudeP, inp: Inputs, id: string, name: string, span: Span | null) {
  return {
    id, name, groups: inp.groups, faces: inp.faces, mode: p.direction, d1: p.distance, d2: p.distance2, faceDir: p.operation === 'cut' ? -1 : 1, taper: p.taper ?? 0,
    ...(span ? { span: [span.from, span.to] as [number, number], trim: span.trim } : {}),
  }
}

/** The tool body of an extrude: the extrusion, cut off at a curved face when an end is one. */
async function buildTool(call: (name: string, args: unknown) => Promise<unknown>, p: ExtrudeP, inp: Inputs, id: string, name: string, span: Span | null, fid: string): Promise<Body> {
  let tool = (await call('extrudeTool', toolArgs(p, inp, id, name, span))) as Body
  for (const f of span?.faces ?? []) tool = (await call('trimToFace', { id, name, key: tool.key, face: f.face, grow: f.grow, keep: f.keep, fid })) as Body
  return tool
}

const refEnvOf = (ctx: FeatureCtx): RefEnv => ({ bodies: ctx.bodies, dataOf: ctx.dataOf, kernel: ctx.kernel as unknown as RefEnv['kernel'] })

registerFeature({
  type: 'extrude',
  label: 'Extrude',
  icon: ArrowFatLineUp,
  schema: extrudeSchema,
  async compute(ctx, raw) {
    const p = asP(raw)
    const inp = resolveInputs(p.profiles, ctxEnv(ctx))
    if (!inp.groups.length && !inp.faces.length) {
      throw new RefError(inp.missing ? 'The profile or face to extrude no longer exists (an edit upstream removed it). Pick it again.' : 'Select a profile or face to extrude', inp.report.lostRefs)
    }
    const span = await resolveSpan(p, inp, refEnvOf(ctx), inp.report)
    const tool = await buildTool((n, a) => ctx.kernel.call(n, a as never), p, inp, ctx.newBodyId(), ctx.feature.name, span, ctx.feature.id)
    if (p.operation === 'component' && !(p as unknown as { component?: string }).component) throw new Error('New Component needs its component: open the dialog and accept it again')
    const res = await combine(ctx, tool, p.operation === 'component' ? 'new' : p.operation, p.targets)
    // New Component: the new body belongs to the component the dialog made for it
    if (p.operation === 'component') res.bodies = res.bodies?.map((b) => ({ ...b, component: (p as unknown as { component: string }).component }))
    return { ...res, warning: inp.report.warning ?? res.warning, reboundRefs: inp.report.flagged, upgrades: inp.report.upgradeMap }
  },
  preview: (ctx) => extrudePreview(ctx),
  beforeAccept(v, isNew) {
    // New Component: make the component that will hold the new body (once; an edit keeps the one it has)
    const have = v.component as string | undefined
    if (v.operation !== 'component' || (have && useDoc.getState().assembly.components.some((c) => c.id === have))) return v
    const made = newComponent(undefined, isNew)
    return { ...v, component: made.def }
  },
})

/** Set by the Extrude command: the next dialog is a new extrude (turn the view, follow the arrow with Join / Cut), not an edit. */
let fresh = false

function extrudePreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  const ui = useUi
  const isNew = fresh
  fresh = false
  // Join / Cut follows the arrow until the user picks an operation themselves (any change we did not make)
  let auto = isNew && (values.operation ?? 'join') === 'join'
  let lastOp = values.operation
  let lastDistance = values.distance as number
  let lastInp: Inputs | null = null
  let turned = !isNew
  let lastExtent = String(values.extent ?? 'dist')
  let lastDirection = String(values.direction ?? 'one')
  /** where the extrude starts along the normal (Start: Offset / From Object), as last worked out */
  let lastStart = 0
  /** which way the first side goes along the profile normal, as last worked out */
  let lastDir: 1 | -1 = 1

  /** Which side of the profile the material lies on, worked out once per profile / body set. */
  let sideKey = '', sideVal: -1 | 0 | 1 = 0
  const sideOf = (inp: Inputs): -1 | 0 | 1 => {
    if (inp.faces.length && !inp.groups.length) return -1 // a face's normal points out of the body
    if (!inp.groups.length || inp.faces.length || !inp.anchor || !inp.normal) return 0
    const geo = useDoc.getState().geometry
    const key = `${geo.map((b) => b.key).join(',')}|${inp.anchor}|${inp.normal}|${inp.groups.length}`
    if (key !== sideKey) {
      const samples = inp.groups.flatMap((g) => g.profiles.flatMap((pr) => profileSamples(g.plane, pr.outer)))
      sideKey = key
      sideVal = bodySide(geo, [inp.anchor, ...samples], inp.normal)
    }
    return sideVal
  }
  const applyAuto = (v: ParamValues): ParamValues => {
    if (!auto || !lastInp || v.direction !== 'one' || v.distance === lastDistance || (v.extent ?? 'dist') !== 'dist') return v
    const out = autoOperation({ facesOnly: !!lastInp.faces.length && !lastInp.groups.length, side: sideOf(lastInp), operation: String(v.operation), distance: Number(v.distance) })
    return out ? { ...v, operation: out.operation, distance: out.distance } : v
  }

  const manip = (p: ExtrudeP, inp: Inputs) => {
    if (!inp.anchor || !inp.normal) return resetManip()
    // the arrow drags a Distance: with To Object or All there is no distance to drag
    const dist1 = (p.extent ?? 'dist') === 'dist'
    const sym = p.direction === 'sym'
    const sgn = inp.faces.length && !inp.groups.length && p.operation === 'cut' ? -1 : 1
    const s0 = (p.start ?? 'profile') === 'offset' ? Number(p.startOffset) || 0 : p.start === 'object' ? lastStart : 0
    const base: Vec3 = [inp.anchor[0] + inp.normal[0] * s0, inp.anchor[1] + inp.normal[1] * s0, inp.anchor[2] + inp.normal[2] * s0]
    if (!dist1) resetManip()
    else useManip.setState({
      active: true,
      origin: base,
      dir: [inp.normal[0] * sgn, inp.normal[1] * sgn, inp.normal[2] * sgn],
      tip: sym ? Math.abs(p.distance) / 2 : p.distance,
      factor: sym ? 2 : 1,
      label: (v) => `${v.toFixed(2)} mm`,
      onChange: (v) => {
        const next = { ...cur, distance: v }
        cur = next
        setValues(next)
      },
    })
    // two sides: a second arrow runs the other way for the second distance
    const bk = -sgn * (dist1 ? 1 : lastDir)
    const back: Vec3 = [inp.normal[0] * bk, inp.normal[1] * bk, inp.normal[2] * bk]
    showArrow(1, p.direction === 'two' && (p.extent2 ?? 'dist') === 'dist' ? { origin: base, dir: back, key: 'distance2', min: 0 } : null, p as unknown as ParamValues, (patch) => { cur = { ...cur, ...patch }; setValues(cur) })
  }

  const runner = createRunner(async (stale) => {
    let p: ExtrudeP
    try { p = asP(resolveParams(extrudeSchema, cur)) } catch { clearPreview(); return }
    const inp = resolveInputs(p.profiles, liveEnv())
    lastInp = inp
    manip(p, inp)
    if (!turned && inp.normal) { turned = true; viewportBus.emit('tiltFromFacing', { normal: inp.normal }) }
    if (!inp.groups.length && !inp.faces.length) { clearPreview(); return }
    let span: Span | null = null
    try {
      span = await resolveSpan(p, inp, liveRefEnv(), new RefReport())
    } catch (e) {
      if (!stale()) { clearPreview(); useUi.setState({ inspectorNotice: e instanceof Error ? e.message : String(e) }) }
      return
    }
    if (stale()) return
    useUi.setState({ inspectorNotice: null })
    if (span) {
      lastStart = span.start
      lastDir = span.dir
      // To Object / All: the operation follows where the extrude goes, like the arrow does for a Distance
      const side = sideOf(inp)
      const second = p.direction === 'two' ? p.extent2 : undefined
      if (auto && side !== 0 && span.dir !== undefined && (p.extent === 'all' || p.extent === 'object' || second === 'all' || second === 'object') && (p.operation === 'join' || p.operation === 'cut')) {
        // a one-sided extent cuts when it runs into the material; going both ways through everything is a cut whenever there is material
        const want = span.dir === side || ((p.extent === 'all' || second === 'all') && p.direction !== 'one') ? 'cut' : 'join'
        if (want !== p.operation) {
          cur = { ...cur, operation: want }
          lastOp = want
          setValues(cur)
          return // the new values run the preview again
        }
      }
    }
    let tool: Body
    try {
      tool = await buildTool((n, a) => getKernel().call(n, a as never), p, inp, 'preview', 'preview', span, 'preview')
    } catch (e) {
      if (!stale()) { clearPreview(); useUi.setState({ inspectorNotice: e instanceof Error ? e.message : String(e) }) }
      return
    }
    if (stale()) return
    setPreview([{ mesh: tool.mesh, kind: p.operation === 'cut' ? 'cut' : 'add' }])
  })

  const sync = () => useProfilePick.setState({
    active: true,
    selected: (cur.profiles as string[]).filter((s) => s.startsWith('prof:')),
    toggle: (ref) => {
      const list = cur.profiles as string[]
      const next = list.includes(ref) ? list.filter((r) => r !== ref) : [...list, ref]
      cur = { ...cur, profiles: next }
      setValues(cur)
    },
  })
  sync()
  ui.getState().setSelectionFilter('face')

  const off = watchSelection(['face'], () => {
    if (ui.getState().pickKinds.length) return // To object / Start object is taking the picks
    const faces = encodeSelection(ui.getState().selection.filter((r) => r.kind === 'face'), useDoc.getState().geometry)
    cur = { ...cur, profiles: [...(cur.profiles as string[]).filter((s) => s.startsWith('prof:')), ...faces] }
    setValues(cur)
  })

  runner.schedule()
  return {
    update(v) {
      let nv = v
      if (auto) {
        if (v.operation !== lastOp) auto = false // the user chose
        else nv = applyAuto(v)
      }
      // choosing All: go into the body (flip the direction when the material is behind the profile)
      if (auto && nv.extent === 'all' && (lastExtent !== 'all' || lastDirection !== 'one') && lastInp && nv.direction === 'one') {
        const side = sideOf(lastInp)
        if (side !== 0) nv = { ...nv, flip: side === -1 }
      }
      lastExtent = String(nv.extent ?? 'dist')
      lastDirection = String(nv.direction ?? 'one')
      lastOp = nv.operation
      lastDistance = nv.distance as number
      cur = nv
      sync()
      // the arrow follows at once: it must not lag behind a flip while it is being dragged
      if (lastInp) { try { manip(asP(resolveParams(extrudeSchema, nv)), lastInp) } catch { /* the runner reports it */ } }
      runner.schedule()
      if (nv !== v) setValues(nv)
    },
    dispose() {
      off()
      runner.dispose()
      clearPreview()
      resetManip()
      useProfilePick.setState({ active: false, selected: [], toggle: null })
    },
  }
}

/** Ribbon command (E): preselect the selected faces / sketch profiles. */
export function startExtrude() {
  fresh = true
  const ui = useUi.getState()
  const doc = useDoc.getState()
  const profiles: string[] = []
  const faces = ui.selection.filter((r) => r.kind === 'face')
  if (faces.length) profiles.push(...encodeSelection(faces, doc.geometry))
  const data = useSketchData.getState().data
  const visible = doc.features.filter((f, i) => f.type === 'sketch' && i < doc.rollback && !f.suppressed && data[f.id])
  const chosen = ui.selection.filter((r) => r.kind === 'sketch').map((r) => r.id)
  const pool = chosen.length ? visible.filter((f) => chosen.includes(f.id)) : visible
  const all = pool.flatMap((f) => data[f.id].profiles.map((p) => profileRef(f.id, p.key, p.id)))
  if (!profiles.length && (chosen.length ? all.length : all.length === 1)) profiles.push(...all)
  createFeature('extrude', { profiles }, 'solid.extrude')
}
