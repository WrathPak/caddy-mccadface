/** Split body: cut bodies with a plane, a planar face or a sketch into separate parts, with optional alignment connectors. */
import { SplitVertical } from '@phosphor-icons/react'
import { create } from 'zustand'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, bodyIdsOf, decodeRef, faceSigs, resolveFace } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import { add3, cross3, dot3, mul3, sub3, unit3 } from '@/kernel/print-geom'
import type { ConnectorSpec, ConnectorSpot, Cutter, SplitArgs, SplitResult } from '@/kernel/print-ops'
import { bbox, type Body, type Vec3 } from '@/kernel/types'
import { useSketchData } from '@/sketch/draw'
import type { SketchData } from '@/sketch/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, setPreview } from '@/viewport/preview'
import { sketchPath } from '../solids'
import { createRunner } from '../previewKit'
import { clearHandles, showAngle, showArrows, type ArrowSpec } from '../handleKit'
import type { PathSeg } from '@/kernel/solid-ops'

export const PARTS_PER_BODY = 16

export const splitSchema: ParamSchema = {
  id: 'split',
  title: 'Split body',
  params: [
    { type: 'selection-ref', key: 'bodies', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [], help: 'The bodies to cut apart. Every piece that comes out is its own body.' },
    {
      type: 'enum', key: 'mode', label: 'Split with', display: 'segmented', default: 'plane', options: [{ value: 'plane', label: 'Plane' }, { value: 'sketch', label: 'Sketch' }],
      help: 'Plane: one flat cut. Sketch: cut along a sketch line, or cut out the inside of a closed sketch shape.',
    },
    {
      type: 'enum', key: 'plane', label: 'Plane', display: 'select', default: 'XY', visibleWhen: (v) => v.mode === 'plane',
      options: [{ value: 'XY', label: 'XY (cuts across Z)' }, { value: 'XZ', label: 'XZ (cuts across Y)' }, { value: 'YZ', label: 'YZ (cuts across X)' }, { value: 'face', label: 'A flat face' }],
      help: 'Which plane to cut on. The pieces on the positive axis side come first.',
    },
    { type: 'selection-ref', key: 'face', label: 'Face', accepts: ['face'], required: true, pick: true, default: [], visibleWhen: (v) => v.mode === 'plane' && v.plane === 'face', help: 'A flat face to cut along. The cut runs through the plane of the face, then moves by the offset.' },
    { type: 'number', key: 'offset', label: 'Offset', unit: 'mm', step: 1, default: 0, visibleWhen: (v) => v.mode === 'plane', help: 'How far to move the cutting plane along its normal, in mm.' },
    {
      type: 'selection-ref', key: 'sketch', label: 'Sketch', accepts: ['sketch'], required: true, pick: true, default: [], visibleWhen: (v) => v.mode === 'sketch',
      help: 'A sketch to cut with. A line (or a chain of lines) cuts off the part on its left. A closed shape cuts out the part inside it.',
    },
    {
      type: 'group',
      label: 'Alignment connectors',
      children: [
        {
          type: 'enum', key: 'connector', label: 'Connectors', display: 'select', default: 'none',
          options: [{ value: 'none', label: 'None' }, { value: 'round', label: 'Round pins' }, { value: 'square', label: 'Square pins' }, { value: 'dovetail', label: 'Dovetails' }],
          help: 'Pins or dovetails that line the parts up when you glue them. One part gets the pin, the other a slightly bigger socket. They need a flat cut.',
        },
        { type: 'number', key: 'count', label: 'Count', unit: '', min: 1, max: 12, step: 1, default: 2, visibleWhen: (v) => v.connector !== 'none', help: 'How many connectors to place. Fewer are used when they do not fit on the cut.' },
        { type: 'number', key: 'size', label: 'Size', unit: 'mm', min: 0.5, step: 0.5, default: 6, visibleWhen: (v) => v.connector !== 'none', help: 'Pin diameter, pin side or dovetail neck width, in mm.' },
        { type: 'number', key: 'depth', label: 'Depth', unit: 'mm', min: 0.5, step: 0.5, default: 6, visibleWhen: (v) => v.connector !== 'none', help: 'How far the pin or dovetail goes into the other part, in mm. It is shortened when the part is too thin.' },
        { type: 'number', key: 'clearance', label: 'Clearance', unit: 'mm', min: 0, max: 2, step: 0.05, default: 0.2, visibleWhen: (v) => v.connector !== 'none', help: 'The gap left around the pin inside its socket, in mm, so the parts fit after printing. 0.2 suits most printers.' },
        { type: 'number', key: 'angle', label: 'Dovetail angle', unit: 'deg', min: 5, max: 45, step: 1, default: 15, visibleWhen: (v) => v.connector === 'dovetail', help: 'How much the dovetail flares out, in degrees. Steeper holds better but is harder to print.' },
      ],
    },
  ],
}

export interface SplitP {
  bodies: string[]; mode: 'plane' | 'sketch'; plane: 'XY' | 'XZ' | 'YZ' | 'face'; face: string[]; offset: number; sketch: string[]
  connector: 'none' | 'round' | 'square' | 'dovetail'; count: number; size: number; depth: number; clearance: number; angle: number
}

const AXIS: Record<'XY' | 'XZ' | 'YZ', Vec3> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] }

/** Points along a 3-point arc (a, m, b). */
function arcPoints(a: Vec3, m: Vec3, b: Vec3, steps = 24): Vec3[] {
  const ab = sub3(b, a), am = sub3(m, a)
  const n = cross3(am, ab)
  const nn = dot3(n, n)
  if (nn < 1e-18) return [a, b]
  // circumcentre of the three points
  const c = add3(a, mul3(add3(mul3(cross3(n, am), dot3(ab, ab)), mul3(cross3(ab, n), dot3(am, am))), 1 / (2 * nn)))
  const ra = sub3(a, c), rb = sub3(b, c), rm = sub3(m, c)
  const axis = unit3(n)
  const ang = (u: Vec3, v: Vec3) => Math.atan2(dot3(cross3(u, v), axis), dot3(u, v))
  let span = ang(ra, rb)
  const toM = ang(ra, rm)
  // choose the sweep direction that passes through m
  if (span >= 0 !== toM >= 0 || Math.abs(toM) > Math.abs(span)) span = span > 0 ? span - 2 * Math.PI : span + 2 * Math.PI
  const out: Vec3[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (span * i) / steps, cs = Math.cos(t), sn = Math.sin(t)
    const cr = cross3(axis, ra)
    out.push(add3(c, add3(mul3(ra, cs), mul3(cr, sn))))
  }
  return out
}

function bezPoints(a: Vec3, c1: Vec3, c2: Vec3, b: Vec3): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, u = 1 - t
    out.push([0, 1, 2].map((k) => u * u * u * a[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * b[k]) as Vec3)
  }
  return out
}

/** World points of a sketch path (lines, arcs and splines). */
export function pathPoints(path: PathSeg[]): Vec3[] {
  const pts: Vec3[] = []
  for (const s of path) {
    const seg = s.k === 'l' ? [s.a, s.b] : s.k === 'a' ? arcPoints(s.a, s.m, s.b) : bezPoints(s.a, s.c1, s.c2, s.b)
    pts.push(...(pts.length ? seg.slice(1) : seg))
  }
  return pts
}

export interface SplitEnv { bodies: Body[]; dataOf(id: string): unknown }

/** Resolve the cutting tool of a Split from its values. */
export function cutterOf(p: SplitP, env: SplitEnv, report: RefReport): Cutter {
  if (p.mode === 'plane') {
    if (p.plane !== 'face') return { kind: 'plane', origin: mul3(AXIS[p.plane], p.offset), normal: AXIS[p.plane] }
    const ref = p.face[0] ? decodeRef(p.face[0]) : null
    if (!ref || ref.kind !== 'face') throw new RefError('Pick a flat face to cut along', [])
    const res = resolveFace(ref, env.bodies, report)
    if (!res) throw new RefError('The face to cut along no longer exists. Pick it again.', report.lostRefs)
    const sig = faceSigs(res.body)[res.index]
    const n = unit3(sig.normal)
    return { kind: 'plane', origin: add3(sig.centroid, mul3(n, p.offset)), normal: n }
  }
  const id = p.sketch[0] ? bodyIdsOf([p.sketch[0]])[0] : undefined
  const data = id ? (env.dataOf(id) as SketchData | undefined) : undefined
  if (!data) throw new RefError(p.sketch.length ? 'The sketch to split with no longer exists. Pick it again.' : 'Pick a sketch to split with', p.sketch)
  if (data.profiles.length) {
    return { kind: 'profiles', groups: [{ plane: data.plane, profiles: data.profiles.map((pr) => ({ outer: pr.outer, holes: pr.holes })) }] }
  }
  let path: PathSeg[]
  try { path = sketchPath(data) } catch (e) { throw new Error(`${e instanceof Error ? e.message : e}. A line, a chain of lines or a closed shape can split a body.`) }
  return { kind: 'path', points: pathPoints(path), normal: data.plane.normal }
}

const connectorOf = (p: SplitP): ConnectorSpec | undefined =>
  p.connector === 'none' ? undefined : { type: p.connector, count: Math.round(p.count), size: p.size, depth: p.depth, clearance: p.clearance, angle: p.angle }

function partIds(base: Body, j: number, newId: (n: number) => string): string[] {
  return Array.from({ length: PARTS_PER_BODY }, (_, i) => (i === 0 ? base.id : newId(j * PARTS_PER_BODY + i)))
}

/** Split every body; bodies the cut misses are skipped with a warning. Throws when nothing was cut. */
export async function runSplit(p: SplitP, env: SplitEnv, call: (name: string, args: unknown) => Promise<unknown>, newId: (n: number) => string, fid: string, report = new RefReport()) {
  const bodies = bodyIdsOf(p.bodies).map((id) => env.bodies.find((b) => b.id === id)).filter((b): b is Body => !!b)
  if (!bodies.length) throw new RefError(p.bodies.length ? 'The bodies to split no longer exist. Pick them again.' : 'Select a body to split', report.lostRefs)
  const cutter = cutterOf(p, env, report)
  const out: Body[] = []
  const notes: string[] = []
  let connector: ConnectorSpot | undefined
  let lastErr: Error | null = null
  for (let j = 0; j < bodies.length; j++) {
    const b = bodies[j]
    try {
      const r = (await call('printSplit', { id: b.id, name: b.name, key: b.key, ids: partIds(b, j, newId), cutter, connectors: connectorOf(p), fid } satisfies SplitArgs)) as SplitResult
      out.push(...r.bodies)
      connector ??= r.connector
      if (r.warning) notes.push(bodies.length > 1 ? `${b.name}: ${r.warning}` : r.warning)
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      if (/does not go through/.test(lastErr.message)) notes.push(`${b.name} is not touched by the cut`)
      else throw lastErr
    }
  }
  if (!out.length) throw lastErr ?? new Error('Nothing was split')
  return { bodies: out, warning: [report.warning, ...notes].filter(Boolean).join('; ') || undefined, cutter, connector }
}

registerFeature({
  type: 'split',
  label: 'Split body',
  icon: SplitVertical,
  schema: splitSchema,
  async compute(ctx, raw) {
    const report = new RefReport()
    const r = await runSplit(raw as unknown as SplitP, { bodies: ctx.bodies, dataOf: ctx.dataOf }, (n, a) => ctx.kernel.call(n, a as never), ctx.newBodyId, ctx.feature.id, report)
    return { bodies: r.bodies, warning: r.warning, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview: (ctx) => splitPreview(ctx),
})

/** What the viewport shows while the dialog is open: the cutting plane and the pieces in two colors. */
export const useSplitView = create<{ plane: { origin: Vec3; normal: Vec3; size: number } | null; error: string | null }>(() => ({ plane: null, error: null }))

/** The middle of the bodies along the normal of an origin plane: where a cut would go if it were to cut them in half. */
export function middleOffset(bodies: Body[], plane: SplitP['plane']): number {
  if (plane === 'face' || !bodies.length) return 0
  const k = AXIS[plane].findIndex((x) => x !== 0)
  let lo = Infinity, hi = -Infinity
  for (const b of bodies) { const bb = bbox(b.mesh.positions); lo = Math.min(lo, bb.min[k]); hi = Math.max(hi, bb.max[k]) }
  return Number.isFinite(lo) ? +((lo + hi) / 2).toFixed(2) : 0
}

/** Where the cutting plane stands in the viewport (through the middle of the bodies) and the arrow that moves it. */
function planeHandle(p: SplitP, bodies: Body[], cutter: Extract<Cutter, { kind: 'plane' }>): { plane: { origin: Vec3; normal: Vec3; size: number }; arrow: ArrowSpec } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const b of bodies) { const bb = bbox(b.mesh.positions); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], bb.min[k]); hi[k] = Math.max(hi[k], bb.max[k]) } }
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.9
  const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const n = unit3(cutter.normal)
  const origin = sub3(c, mul3(n, dot3(sub3(c, cutter.origin), n)))
  // the offset arrow stands on the plane the cut starts from (offset 0) at the edge of the part, so it stays clear of the connectors that sit in the middle of the cut
  const tan = unit3(Math.abs(n[2]) > 0.9 ? [1, 0, 0] : cross3(n, [0, 0, 1]))
  let reach = 0
  for (const b of bodies) {
    const P = b.mesh.positions
    for (let i = 0; i < P.length; i += 3) reach = Math.max(reach, Math.abs(dot3(sub3([P[i], P[i + 1], P[i + 2]], c), tan)))
  }
  return { plane: { origin, normal: n, size }, arrow: { origin: add3(sub3(origin, mul3(n, p.offset)), mul3(tan, reach)), dir: n, key: 'offset' } }
}

function splitPreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur = values
  // the offset follows the bodies (their middle along the plane normal) until the person sets one themselves
  let auto = values.offset as number
  let fitKey = `${bodyIdsOf((values.bodies as string[]) ?? []).join()}|${values.plane}`
  const runner = createRunner(async (stale) => {
    let p: SplitP
    try { p = resolveParams(splitSchema, cur) as unknown as SplitP } catch { clearPreview(); clearHandles(); useSplitView.setState({ plane: null, error: null }); return }
    const geometry = useDoc.getState().geometry
    const env: SplitEnv = { bodies: geometry, dataOf: (id) => useSketchData.getState().data[id] }
    const report = new RefReport()
    const ids = bodyIdsOf(p.bodies)
    const all = geometry.filter((b) => ids.includes(b.id))
    const apply = (patch: ParamValues) => { cur = { ...cur, ...patch }; auto = NaN; setValues(cur) }
    // the plane and its offset arrow stand as soon as there is a body, whether or not the cut reaches it: an offset that misses
    // the part is moved back with the arrow
    let offsetArrow: ArrowSpec | null = null
    try {
      const cutter = cutterOf(p, env, new RefReport())
      if (all.length && cutter.kind === 'plane') {
        const h = planeHandle(p, all, cutter)
        useSplitView.setState({ plane: h.plane, error: null })
        offsetArrow = h.arrow
        showArrows([offsetArrow], p as unknown as ParamValues, apply)
      } else useSplitView.setState({ plane: null, error: null })
    } catch { useSplitView.setState({ plane: null, error: null }) }
    try {
      const r = await runSplit(p, env, (n, a) => getKernel().call(n, a as never), (n) => `preview.${n}`, 'preview', report)
      if (stale()) return
      // each piece gets its own translucent tint
      setPreview(r.bodies.map((b, i) => ({ mesh: b.mesh, kind: i % 2 ? 'cut' : 'result' })), ids)
      // the connector arrows stand on the first connector: how far it goes into the other part, how wide it is, and (dovetails) how far its flanks flare
      const cn = p.connector !== 'none' ? r.connector : undefined
      const arrows: ArrowSpec[] = offsetArrow ? [offsetArrow] : []
      // (the depth arrow stands at the far side of the connector from the size arrow, so their grips do not overlap on a small connector)
      if (cn) arrows.push({ origin: sub3(cn.origin, mul3(cn.across, p.size / 2)), dir: cn.down, key: 'depth', min: 0.5 }, { origin: cn.origin, dir: cn.across, key: 'size', factor: 2, min: 0.5 })
      showArrows(arrows, p as unknown as ParamValues, apply)
      showAngle(cn?.flare && p.connector === 'dovetail' ? { origin: cn.flare.origin, axis: cn.flare.axis, start: cn.down, radius: Math.max(3, p.depth), key: 'angle', min: 5, max: 45, step: 1 } : null, p as unknown as ParamValues, apply)
      useUi.setState({ inspectorNotice: null })
    } catch (e) {
      if (stale()) return
      clearPreview()
      if (!offsetArrow) clearHandles()
      const msg = e instanceof Error ? e.message : String(e)
      useSplitView.setState({ error: msg })
      // say why nothing is cut (typically: the plane misses the body)
      useUi.setState({ inspectorNotice: /does not go through/.test(msg) ? `${msg}. Move the offset so the plane passes through the body.` : msg })
    }
  }, 220)
  runner.schedule()
  return {
    update(v) {
      // picking the bodies (or another plane) puts the cut through the middle of them, unless an offset was set
      const key = `${bodyIdsOf((v.bodies as string[]) ?? []).join()}|${v.plane}`
      if (key !== fitKey) {
        fitKey = key
        if (v.offset === auto) {
          const ids = bodyIdsOf((v.bodies as string[]) ?? [])
          const mid = middleOffset(useDoc.getState().geometry.filter((b) => ids.includes(b.id)), v.plane as SplitP['plane'])
          auto = mid
          v = { ...v, offset: mid }
          cur = v
          setValues(v)
        }
      }
      if (v.offset !== auto) auto = NaN
      cur = v
      runner.schedule()
    },
    dispose() {
      runner.dispose()
      clearPreview()
      clearHandles()
      useSplitView.setState({ plane: null, error: null })
      useUi.setState({ inspectorNotice: null })
    },
  }
}

/** Ribbon entry point: the selected bodies (or the only body). */
export function startSplit() {
  const { geometry } = useDoc.getState()
  const sel = useUi.getState().selection
  let ids = [...new Set(sel.map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id))
  if (!ids.length && geometry.length === 1) ids = [geometry[0].id]
  // the cut starts through the middle of the body (the first plane, XY, cuts across Z): offset 0 would sit on the base of a part on the ground and cut nothing
  const offset = middleOffset(geometry.filter((b) => ids.includes(b.id)), 'XY')
  createFeature('split', { bodies: ids, offset }, 'print.split')
}

export type { ParamValues }
