/** Measure: pick one or two faces / edges / bodies and read lengths, areas, distances and angles. */
import { decodeRef, edgeSigs, faceSigs, resolveEdge, resolveFace } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { bbox, type Body, type Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema } from '@/ui/schema'

type Ent =
  | { kind: 'face'; label: string; normal: Vec3; point: Vec3; area: number }
  | { kind: 'edge'; label: string; dir: Vec3; point: Vec3; length: number }
  | { kind: 'body'; label: string; point: Vec3; size: Vec3; volume: number }

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const f = (n: number, d = 3) => String(+n.toFixed(d))
const deg = (rad: number) => (rad * 180) / Math.PI

function volumeOf(b: Body): number {
  const p = b.mesh.positions, ix = b.mesh.indices
  let v = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, bb = ix[t + 1] * 3, c = ix[t + 2] * 3
    v += (p[a] * (p[bb + 1] * p[c + 2] - p[bb + 2] * p[c + 1]) - p[a + 1] * (p[bb] * p[c + 2] - p[bb + 2] * p[c]) + p[a + 2] * (p[bb] * p[c + 1] - p[bb + 1] * p[c])) / 6
  }
  return Math.abs(v)
}

/** Resolve a selection-ref string against the bodies; null if it no longer exists. */
export function entityOf(ref: string, bodies: Body[]): Ent | null {
  const r = decodeRef(ref)
  if (!r) return null
  if (r.kind === 'face') {
    const hit = resolveFace(r, bodies)
    if (!hit) return null
    const s = faceSigs(hit.body)[hit.index]
    return { kind: 'face', label: `Face of ${hit.body.name}`, normal: s.normal, point: s.centroid, area: s.area }
  }
  if (r.kind === 'edge') {
    const hit = resolveEdge(r, bodies)
    if (!hit) return null
    const s = edgeSigs(hit.body)[hit.index]
    return { kind: 'edge', label: `Edge of ${hit.body.name}`, dir: s.direction, point: s.midpoint, length: s.length }
  }
  const b = bodies.find((x) => x.id === r.bodyId)
  if (!b) return null
  const bb = bbox(b.mesh.positions)
  return { kind: 'body', label: b.name, point: [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2], size: sub(bb.max, bb.min), volume: volumeOf(b) }
}

function describe(e: Ent): string[] {
  if (e.kind === 'face') return [`${e.label}`, `  Area      ${f(e.area)} mm²`, `  Normal    ${e.normal.map((n) => f(n, 3)).join(', ')}`]
  if (e.kind === 'edge') return [`${e.label}`, `  Length    ${f(e.length)} mm`, `  Direction ${e.dir.map((n) => f(n, 3)).join(', ')}`]
  return [`${e.label}`, `  Volume    ${f(e.volume)} mm³`, `  Size      ${e.size.map((n) => f(n)).join(' x ')} mm`]
}

const axisOf = (e: Ent): Vec3 | null => (e.kind === 'face' ? e.normal : e.kind === 'edge' ? e.dir : null)

/** Readout for the picked entities: properties of each, and (for two) distances and the angle between them. */
export function measureText(refs: string[], bodies: Body[]): string {
  const ents = refs.map((r) => entityOf(r, bodies))
  if (!refs.length) return 'Pick a face, edge or body.'
  if (ents.some((e) => !e)) return 'A picked entity no longer exists.'
  const [a, b] = ents as Ent[]
  const out = describe(a)
  if (!b) return out.join('\n') + '\n\nPick a second entity to measure between them.'
  out.push('', ...describe(b), '')
  const d = sub(b.point, a.point)
  out.push(`Center distance  ${f(len(d))} mm`, `  dX ${f(d[0])}   dY ${f(d[1])}   dZ ${f(d[2])}`)
  if (a.kind === 'face' && b.kind === 'face' && Math.abs(dot(a.normal, b.normal)) > 0.9999) out.push(`Plane distance   ${f(Math.abs(dot(d, a.normal)))} mm (parallel faces)`)
  const ua = axisOf(a), ub = axisOf(b)
  if (ua && ub) {
    // between the two directions (0..90); face / edge: the line against the plane is 90 minus the angle to the normal
    const between = deg(Math.acos(Math.min(1, Math.abs(dot(ua, ub)))))
    const mixed = a.kind !== b.kind
    out.push(`Angle            ${f(mixed ? 90 - between : between, 2)}°`)
  }
  return out.join('\n')
}

export const measureSchema: ParamSchema = {
  id: 'measure',
  title: 'Measure',
  params: [
    { type: 'enum', key: 'pick', label: 'Pick', display: 'segmented', default: 'face', options: [{ value: 'face', label: 'Face' }, { value: 'edge', label: 'Edge' }, { value: 'body', label: 'Body' }] },
    { type: 'selection-ref', key: 'first', label: 'Select first', accepts: ['face', 'edge', 'body'], pick: true, required: true, default: [] },
    { type: 'selection-ref', key: 'second', label: 'Select second', accepts: ['face', 'edge', 'body'], pick: true, default: [] },
    { type: 'info', key: 'result', label: 'Result', default: '', text: (v) => measureText([...((v.first as string[]) ?? []), ...((v.second as string[]) ?? [])], useDoc.getState().geometry) },
  ],
}

export function startMeasure() {
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  const finish = () => {
    useUi.getState().closeInspector()
    useUi.getState().setActiveTool(null)
  }
  ui.setActiveTool('inspect.measure')
  ui.openInspector({
    schema: measureSchema,
    values: { pick: 'face', first: [], second: [], result: '' },
    onChange: (v) => useUi.getState().setSelectionFilter(v.pick as 'face' | 'edge' | 'body'),
    onOk: finish,
    onCancel: finish,
  })
}
