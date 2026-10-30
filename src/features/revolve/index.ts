/** Revolve: sketch profiles around a sketch line, sketch axis, origin axis or edge. */
import { ArrowsClockwise } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, decodeRef, encodeSelection, resolveEdge } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { Body, Vec3 } from '@/kernel/types'
import { Vector3 } from 'three'
import { useSketchData } from '@/sketch/draw'
import { pos } from '@/sketch/model'
import { dirToWorld, toWorld, yDirOf } from '@/sketch/plane'
import type { SketchData } from '@/sketch/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, setPreview, useProfilePick } from '@/viewport/preview'
import { resetAngleManip, useAngleManip } from '@/viewport/AngleManipulator'
import { edgeSigs } from '@/doc/refs'
import { combine, ctxEnv, liveEnv, profileRef, resolveInputs, type Env, type Inputs } from '../modeling'
import { createRunner, watchSelection } from '../previewKit'

export const revolveSchema: ParamSchema = {
  id: 'revolve',
  title: 'Revolve',
  params: [
    { type: 'selection-ref', key: 'profiles', help: 'The closed sketch shapes to spin around the axis.', label: 'Profiles', accepts: ['sketch'], multiple: true, required: true, default: [] },
    {
      type: 'enum', key: 'axis', help: 'The line to spin around: a construction line in the sketch, one of the sketch or world axes, or a model edge.', label: 'Axis', display: 'select', default: 'line',
      options: [
        { value: 'line', label: 'Sketch construction line' }, { value: 'sketchX', label: 'Sketch X axis' }, { value: 'sketchY', label: 'Sketch Y axis' },
        { value: 'worldX', label: 'World X' }, { value: 'worldY', label: 'World Y' }, { value: 'worldZ', label: 'World Z' }, { value: 'edge', label: 'Edge' },
      ],
    },
    { type: 'selection-ref', key: 'edge', help: 'Click the straight model edge to spin around.', label: 'Axis edge', accepts: ['edge'], required: true, default: [], visibleWhen: (v) => v.axis === 'edge' },
    { type: 'number', key: 'angle', help: 'How far to spin, in degrees. 360 makes a full turn; less leaves a wedge.', label: 'Angle', unit: 'deg', step: 5, default: 360 },
    {
      type: 'enum', key: 'operation', help: 'Join: add to the body. Cut: remove material. Intersect: keep only the overlap. New body: make a separate body.', label: 'Operation', display: 'select', default: 'new',
      options: [
        { value: 'join', label: 'Join' }, { value: 'cut', label: 'Cut' },
        { value: 'intersect', label: 'Intersect' }, { value: 'new', label: 'New body' },
      ],
    },
    { type: 'selection-ref', key: 'targets', help: 'The bodies to join to, cut or intersect. Leave empty to use every body that the shape touches.', label: 'Target bodies', accepts: ['body'], multiple: true, default: [], visibleWhen: (v) => v.operation !== 'new' },
  ],
}

interface RevolveP { profiles: string[]; axis: string; edge: string[]; angle: number; operation: string; targets: string[] }
const asP = (v: ParamValues) => v as unknown as RevolveP

/** World-space axis for the chosen mode. */
function axisFor(p: RevolveP, sk: NonNullable<Inputs['sketch']>, env: Env, report?: RefReport): { origin: Vec3; dir: Vec3 } {
  const data: SketchData = sk.data
  const plane = data.plane
  switch (p.axis) {
    case 'sketchX': return { origin: plane.origin, dir: plane.xDir }
    case 'sketchY': return { origin: plane.origin, dir: yDirOf(plane) }
    case 'worldX': return { origin: [0, 0, 0], dir: [1, 0, 0] }
    case 'worldY': return { origin: [0, 0, 0], dir: [0, 1, 0] }
    case 'worldZ': return { origin: [0, 0, 0], dir: [0, 0, 1] }
    case 'edge': {
      const ref = p.edge[0] ? decodeRef(p.edge[0]) : null
      if (!ref || ref.kind !== 'edge') throw new Error('Select an edge for the axis')
      const rep = report ?? new RefReport()
      const r = resolveEdge(ref, env.bodies, rep)
      if (!r) throw new RefError('The axis edge no longer exists (an edit upstream removed it). Pick it again.', rep.lostRefs)
      const sg = edgeSigs(r.body)[r.index]
      return { origin: sg.midpoint, dir: sg.direction }
    }
    default: {
      const model = { entities: data.entities, constraints: data.constraints, next: 0 }
      const line = data.entities.find((e) => e.type === 'line' && e.construction)
      if (!line || line.type !== 'line') throw new Error('This sketch has no construction line; draw one (X) or pick another axis')
      const a = pos(model, line.p1), b = pos(model, line.p2)
      return { origin: toWorld(plane, a), dir: dirToWorld(plane, [b[0] - a[0], b[1] - a[1]]) }
    }
  }
}

function args(p: RevolveP, inp: Inputs, env: Env, id: string, name: string) {
  const ax = axisFor(p, inp.sketch!, env, inp.report)
  return { id, name, groups: inp.groups, axisOrigin: ax.origin, axisDir: ax.dir, angle: p.angle }
}

registerFeature({
  type: 'revolve',
  label: 'Revolve',
  icon: ArrowsClockwise,
  schema: revolveSchema,
  async compute(ctx, raw) {
    const p = asP(raw)
    const env = ctxEnv(ctx)
    const inp = resolveInputs(p.profiles, env)
    if (!inp.groups.length || !inp.sketch) throw new Error(inp.missing ? 'The profile no longer exists' : 'Select a profile to revolve')
    const tool = (await ctx.kernel.call('revolveTool', args(p, inp, env, ctx.newBodyId(), ctx.feature.name))) as Body
    const res = await combine(ctx, tool, p.operation, p.targets)
    return { ...res, warning: inp.report.warning ?? res.warning, reboundRefs: inp.report.flagged, upgrades: inp.report.upgradeMap }
  },
  preview: (ctx) => revolvePreview(ctx),
})

function revolvePreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  /** The rotary handle: a knob on an arc about the axis, starting where the profile is farthest from it. */
  const handle = (a: { axisOrigin: Vec3; axisDir: Vec3 }, inp: Inputs, angle: number) => {
    const o = new Vector3(...a.axisOrigin), d = new Vector3(...a.axisDir).normalize()
    let far: Vector3 | null = null, foot = o.clone(), best = 1e-6
    for (const g of inp.groups) for (const pr of g.profiles) for (const sg of pr.outer) {
      const pts: [number, number][] = sg.k === 'c' ? [[sg.c[0] + sg.r, sg.c[1]], [sg.c[0] - sg.r, sg.c[1]], [sg.c[0], sg.c[1] + sg.r], [sg.c[0], sg.c[1] - sg.r]] : [sg.a]
      for (const q of pts) {
        const w = new Vector3(...toWorld(g.plane, q)).sub(o)
        const along = w.dot(d)
        const r = w.clone().addScaledVector(d, -along)
        if (r.length() > best + 1e-9) { best = r.length(); far = r; foot = o.clone().addScaledVector(d, along) }
      }
    }
    if (!far) return resetAngleManip()
    useAngleManip.setState({
      active: true, origin: foot.toArray() as Vec3, axis: d.toArray() as Vec3, start: (far as Vector3).clone().normalize().toArray() as Vec3, radius: best, angle,
      onChange: (v) => { cur = { ...cur, angle: v }; setValues(cur) },
    })
  }
  let seenProfiles = (values.profiles as string[]).length > 0
  const runner = createRunner(async (stale) => {
    let p: RevolveP
    try { p = asP(resolveParams(revolveSchema, cur)) } catch { clearPreview(); return }
    const env = liveEnv()
    const inp = resolveInputs(p.profiles, env)
    if (!inp.groups.length || !inp.sketch) { clearPreview(); resetAngleManip(); return }
    let a
    try { a = args(p, inp, env, 'preview', 'preview') } catch { clearPreview(); resetAngleManip(); return }
    handle(a, inp, p.angle)
    const tool = (await getKernel().call('revolveTool', a)) as Body
    if (stale()) return
    setPreview([{ mesh: tool.mesh, kind: p.operation === 'cut' ? 'cut' : 'add' }])
  })
  const sync = () => useProfilePick.setState({
    active: true,
    selected: (cur.profiles as string[]).filter((s) => s.startsWith('prof:')),
    toggle: (ref) => {
      const list = cur.profiles as string[]
      cur = { ...cur, profiles: list.includes(ref) ? list.filter((r) => r !== ref) : [...list, ref] }
      setValues(cur)
    },
  })
  sync()
  const off = watchSelection(['edge'], () => {
    if (cur.axis !== 'edge') return
    cur = { ...cur, edge: encodeSelection(useUi.getState().selection.filter((r) => r.kind === 'edge').slice(0, 1), useDoc.getState().geometry) }
    setValues(cur)
  })
  runner.schedule()
  return {
    update(v) {
      // the first profile picked decides the axis (a construction line, else the sketch axis it hugs), unless an axis was chosen
      const first = (v.profiles as string[])[0]
      if (!seenProfiles && first?.startsWith('prof:') && v.axis === 'sketchX') {
        const d = useSketchData.getState().data[first.split(':')[1]]
        if (d) {
          const keys = (v.profiles as string[]).map((r) => r.split(':').slice(2).join(':').split('@')[0])
          const ax = d.entities.some((e) => e.type === 'line' && e.construction) ? 'line' : autoSketchAxis(d, keys)
          if (ax && ax !== 'sketchX') { v = { ...v, axis: ax }; cur = v; setValues(v) }
        }
      }
      if (first) seenProfiles = true
      if (v.axis === 'edge' && cur.axis !== 'edge') useUi.getState().setSelectionFilter('edge')
      cur = v
      if (useAngleManip.getState().active && typeof v.angle === 'number') useAngleManip.setState({ angle: v.angle })
      sync()
      runner.schedule()
    },
    dispose() {
      resetAngleManip()
      off()
      runner.dispose()
      clearPreview()
      useProfilePick.setState({ active: false, selected: [], toggle: null })
    },
  }
}

/** The sketch axis a profile is drawn against: the one its straight edges lie along (a half profile drawn on the Y axis spins about Y). */
export function autoSketchAxis(data: SketchData, keys: string[]): 'sketchX' | 'sketchY' | null {
  let onX = 0, onY = 0
  const eps = 1e-6
  for (const k of keys) {
    const prof = data.profiles.find((p) => p.key === k)
    if (!prof) continue
    for (const seg of prof.outer) {
      if (seg.k !== 'l') continue
      const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1])
      if (Math.abs(seg.a[1]) < eps && Math.abs(seg.b[1]) < eps) onX += len
      else if (Math.abs(seg.a[0]) < eps && Math.abs(seg.b[0]) < eps) onY += len
    }
  }
  return onY > onX ? 'sketchY' : onX > 0 ? 'sketchX' : null
}

/** Ribbon command: takes the selected profiles / sketch, a selected straight edge as the axis, the axis the profile hugs, and joins when there is a body to join. */
export function startRevolve() {
  const doc = useDoc.getState()
  const data = useSketchData.getState().data
  const visible = doc.features.filter((f, i) => f.type === 'sketch' && i < doc.rollback && !f.suppressed && data[f.id])
  const chosen = useUi.getState().selection.filter((r) => r.kind === 'sketch').map((r) => r.id)
  const pool = chosen.length ? visible.filter((f) => chosen.includes(f.id)) : visible
  const all = pool.flatMap((f) => data[f.id].profiles.map((p) => profileRef(f.id, p.key, p.id)))
  const has = (id: string) => pool.some((f) => f.id === id && data[f.id].entities.some((e) => e.type === 'line' && e.construction))
  const sketchId = pool.length === 1 ? pool[0].id : ''
  const profiles = chosen.length || all.length === 1 ? all : []
  const init: ParamValues = { profiles, operation: doc.geometry.some((b) => b.kind === 'brep' && !b.surface) ? 'join' : 'new' }
  const edge = useUi.getState().selection.find((r) => r.kind === 'edge')
  if (sketchId && has(sketchId)) init.axis = 'line'
  else if (edge) { init.axis = 'edge'; init.edge = encodeSelection([edge], doc.geometry) }
  else init.axis = (sketchId && autoSketchAxis(data[sketchId], data[sketchId].profiles.map((p) => p.key))) || 'sketchX'
  createFeature('revolve', init, 'solid.revolve')
}
