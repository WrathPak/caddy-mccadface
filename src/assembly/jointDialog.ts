/** The Joint, As-built Joint and Motion Link dialogs (the schema-driven Inspector), and the pure code that turns their values into joints. */
import { decodeRef, type SnapRef } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import type { ParamDef, ParamSchema, ParamValues } from '@/ui/schema'
import { addJoint, addLink, newJointDefaults, updateJoint } from './actions'
import { dofsOf, JOINT_TYPES } from './joints'
import { invert, matrixFrame, multiply, frameMatrix, type Frame } from './matrix'
import { placeAssembly } from './instances'
import { useAssemblyRuntime } from './runtime'
import { resolveSnap } from './snaps'
import type { AssemblyData, Joint, JointOrigin, JointType, Limit } from './types'
import { flatten } from './instances'

// ---------------------------------------------------------------- the schema

const KEYS = (() => {
  const seen = new Map<string, { label: string; unit: 'mm' | 'deg'; min: number; max: number; types: JointType[] }>()
  for (const t of JOINT_TYPES) for (const d of t.dofs) {
    const e = seen.get(d.key)
    if (e) e.types.push(t.type)
    else seen.set(d.key, { label: d.label, unit: d.unit, min: d.defaultMin, max: d.defaultMax, types: [t.type] })
  }
  return [...seen.entries()].map(([key, v]) => ({ key, ...v }))
})()
const has = (v: ParamValues, types: JointType[]) => types.includes(v.type as JointType)

function jointParams(editing: boolean): ParamDef[] {
  const origin = (key: string, label: string, help: string): ParamDef => ({ type: 'selection-ref', key, label, help, accepts: ['snap'], required: !editing, pick: true, default: [] })
  const out: ParamDef[] = [
    origin('origin1', 'Origin 1', 'The joint origin that stays. Click a face center, an edge midpoint, a circle center or a vertex of a component. Its Z axis is the joint axis.'),
    origin('origin2', 'Origin 2', 'The joint origin that moves to origin 1. Pick it on a different component.'),
    {
      type: 'enum', key: 'type', label: 'Type', display: 'select', default: 'rigid',
      options: JOINT_TYPES.map((j) => ({ value: j.type, label: j.label, desc: j.help })),
    },
    { type: 'info', key: 'typeHelp', label: 'Motion', default: '', text: (v) => JOINT_TYPES.find((j) => j.type === v.type)?.help ?? '' },
    { type: 'bool', key: 'flip', label: 'Flip', help: 'Turn the second component over so its axis points the other way.', default: false },
    { type: 'vector3', key: 'offset', label: 'Offset', unit: 'mm', step: 1, help: 'Moves the joint frame, in the frame of origin 1 (X, Y and Z of the snap point).', default: [0, 0, 0] },
    { type: 'number', key: 'angle', label: 'Angle offset', unit: 'deg', step: 5, help: 'An extra turn about the joint axis.', default: 0 },
  ]
  const motion: ParamDef[] = KEYS.map((k) => ({
    type: 'number', key: 'v_' + k.key, label: k.label, unit: k.unit, step: k.unit === 'deg' ? 5 : 1, help: 'Where the joint sits now. You can also drive it from the Joints panel.', default: 0, visibleWhen: (v) => has(v, k.types),
  }) as ParamDef)
  const limits: ParamDef[] = KEYS.flatMap((k): ParamDef[] => [
    { type: 'bool', key: 'lim_' + k.key, label: `Limit ${k.label.toLowerCase()}`, help: 'Stops the joint at a minimum and maximum.', default: false, visibleWhen: (v) => has(v, k.types) },
    { type: 'number', key: 'min_' + k.key, label: 'Minimum', unit: k.unit, step: k.unit === 'deg' ? 5 : 1, default: k.min, visibleWhen: (v) => has(v, k.types) && !!v['lim_' + k.key] },
    { type: 'number', key: 'max_' + k.key, label: 'Maximum', unit: k.unit, step: k.unit === 'deg' ? 5 : 1, default: k.max, visibleWhen: (v) => has(v, k.types) && !!v['lim_' + k.key] },
    { type: 'number', key: 'rest_' + k.key, label: 'Rest', unit: k.unit, step: k.unit === 'deg' ? 5 : 1, help: 'The value the Reset button on the Joints panel returns to.', default: 0, visibleWhen: (v) => has(v, k.types) && !!v['lim_' + k.key] },
  ])
  return [
    ...out,
    { type: 'group', label: 'Position', id: 'position', children: motion, help: 'The current value of each degree of freedom.' },
    { type: 'group', label: 'Limits', id: 'limits', collapsed: true, children: limits },
  ]
}

export const jointSchema = (editing = false): ParamSchema => ({ id: 'joint', title: editing ? 'Edit Joint' : 'Joint', params: jointParams(editing) })

// ---------------------------------------------------------------- values <-> joints

const snapOf = (v: ParamValues, key: string): SnapRef | null => {
  const s = (v[key] as string[] | undefined)?.[0]
  const r = s ? decodeRef(s) : null
  return r && r.kind === 'snap' ? r : null
}

/** The origin a snap ref stands for (its frame in the component's space), or why it cannot be used. */
export function originFromSnap(r: SnapRef, geometry: Body[], a: AssemblyData): { origin: JointOrigin } | { error: string } {
  if (!r.path) return { error: 'Joints connect components. Make the body a component first (New Component or Create Components from Bodies).' }
  if (!flatten(a).some((n) => n.id === r.path)) return { error: 'That component no longer exists.' }
  const hit = resolveSnap(r.spec as never, geometry)
  if (!hit) return { error: 'The face, edge or vertex of this origin no longer exists. Pick it again.' }
  return { origin: { occ: r.path, frame: hit.frame, snap: r.spec as never } }
}

/** Build a joint from the dialog values. `base` keeps the id, and the origins of an edit that did not re-pick them. */
export function jointFromValues(v: ParamValues, geometry: Body[], a: AssemblyData, base?: Joint): { joint: Joint } | { error: string } {
  const type = v.type as JointType
  const side = (key: string, keep?: JointOrigin): JointOrigin | string => {
    const r = snapOf(v, key)
    if (!r) return keep ?? 'Pick both joint origins.'
    const o = originFromSnap(r, geometry, a)
    return 'error' in o ? o.error : o.origin
  }
  const oa = side('origin1', base?.a)
  const ob = side('origin2', base?.b)
  if (typeof oa === 'string') return { error: oa }
  if (typeof ob === 'string') return { error: ob }
  if (oa.occ === ob.occ) return { error: 'Pick the two origins on different components.' }
  const values: Record<string, number> = {}
  const limits: Record<string, Limit> = {}
  for (const d of dofsOf(type)) {
    values[d.key] = Number(v['v_' + d.key] ?? 0)
    limits[d.key] = { enabled: !!v['lim_' + d.key], min: Number(v['min_' + d.key] ?? d.defaultMin), max: Number(v['max_' + d.key] ?? d.defaultMax), rest: Number(v['rest_' + d.key] ?? 0) }
    if (limits[d.key].min > limits[d.key].max) return { error: `${d.label}: the minimum is above the maximum.` }
  }
  const base0 = base ?? { id: 'preview', name: '', asBuilt: false, suppressed: false }
  const nm = base?.name ?? `${JOINT_TYPES.find((j) => j.type === type)!.label} ${a.joints.filter((j) => j.type === type).length + 1}`
  return {
    joint: {
      id: base0.id, name: nm, type, a: oa, b: ob, flip: !!v.flip, offset: (v.offset as [number, number, number]) ?? [0, 0, 0], angle: Number(v.angle ?? 0),
      values, limits, suppressed: base?.suppressed, asBuilt: base?.asBuilt,
    },
  }
}

const snapString = (o: JointOrigin): string[] => {
  if (!o.snap) return []
  const r = decodeRef(o.snap.ref)
  return [JSON.stringify({ kind: 'snap', bodyId: r && 'bodyId' in r ? r.bodyId : '', path: o.occ, spec: o.snap })]
}

export function valuesOfJoint(j: Joint): ParamValues {
  const v: ParamValues = { origin1: snapString(j.a), origin2: snapString(j.b), type: j.type, flip: j.flip, offset: j.offset, angle: j.angle }
  for (const d of dofsOf(j.type)) {
    v['v_' + d.key] = j.values[d.key] ?? 0
    const l = j.limits[d.key]
    if (l) { v['lim_' + d.key] = l.enabled; v['min_' + d.key] = l.min; v['max_' + d.key] = l.max; v['rest_' + d.key] = l.rest }
  }
  return v
}

// ---------------------------------------------------------------- the dialogs

const end = () => {
  useAssemblyRuntime.getState().setPreviewJoint(null)
  useUi.getState().closeInspector()
  useUi.getState().setActiveTool(null)
}

/** Open the Joint dialog: new, or editing the joint with this id. */
export function startJoint(editId?: string) {
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  const existing = editId ? useDoc.getState().assembly.joints.find((j) => j.id === editId) : undefined
  const schema = jointSchema(!!existing)
  const defaults: ParamValues = Object.fromEntries(schema.params.flatMap((p) => (p.type === 'group' ? p.children : [p])).filter((p) => p.type !== 'info' && p.type !== 'preset').map((p) => [(p as { key: string }).key, (p as { default: ParamValues[string] }).default]))
  const start = { ...defaults, ...(existing ? valuesOfJoint(existing) : {}) }
  const build = (v: ParamValues) => {
    const d = useDoc.getState()
    return jointFromValues(v, d.geometry, d.assembly, existing)
  }
  const preview = (v: ParamValues) => {
    const r = build(v)
    useAssemblyRuntime.getState().setPreviewJoint('joint' in r ? { ...r.joint, id: existing?.id ?? 'preview' } : null)
  }
  const warnings = (v: ParamValues): string[] => {
    const r = build(v)
    return 'error' in r && (snapOf(v, 'origin1') || snapOf(v, 'origin2')) ? [r.error] : []
  }
  ui.setActiveTool('assembly.joint')
  ui.openInspector({
    schema: { ...schema, warnings },
    values: start,
    onChange: preview,
    onOk: (v) => {
      const r = build(v)
      if ('error' in r) return void toast(r.error, 'error')
      end()
      if (existing) updateJoint(existing.id, { ...r.joint, id: existing.id })
      else addJoint({ ...r.joint, ...newJointDefaultsFor(r.joint) } as Omit<Joint, 'id'>)
    },
    onCancel: end,
  })
  preview(start)
}

const newJointDefaultsFor = (j: Joint) => ({ ...newJointDefaults(j.type), values: j.values, limits: j.limits })

// ---- as-built

export const asBuiltSchema: ParamSchema = {
  id: 'asBuiltJoint',
  title: 'As-built Joint',
  params: [
    { type: 'selection-ref', key: 'comp1', label: 'Component 1', help: 'The component that stays. Click it in the Browser or in the viewport.', accepts: ['component', 'body'], required: true, pick: true, default: [] },
    { type: 'selection-ref', key: 'comp2', label: 'Component 2', help: 'The component the joint holds in place. It keeps the position it has now.', accepts: ['component', 'body'], required: true, pick: true, default: [] },
    { type: 'selection-ref', key: 'origin', label: 'Joint origin', help: 'Where the joint is. Click a face center, an edge midpoint, a circle center or a vertex.', accepts: ['snap'], required: true, pick: true, default: [] },
    { type: 'enum', key: 'type', label: 'Type', display: 'select', default: 'revolute', options: JOINT_TYPES.map((j) => ({ value: j.type, label: j.label })) },
  ],
}

const pathOfRef = (v: ParamValues, key: string): string => {
  const s = (v[key] as string[] | undefined)?.[0]
  const r = s ? decodeRef(s) : null
  if (!r) return ''
  if (r.kind === 'component') return r.path
  if (r.kind === 'body') return r.path ?? ''
  return ''
}

/** A joint that leaves both components where they are: the frames are put at one world place and the values are zero. */
export function asBuiltFromValues(v: ParamValues, geometry: Body[], a: AssemblyData, drive = useAssemblyRuntime.getState().drive): { joint: Omit<Joint, 'id'> } | { error: string } {
  const p1 = pathOfRef(v, 'comp1'), p2 = pathOfRef(v, 'comp2')
  if (!p1 || !p2) return { error: 'Pick the two components. A body of the root component cannot be joined: make it a component first.' }
  if (p1 === p2) return { error: 'Pick two different components.' }
  const snap = snapOf(v, 'origin')
  if (!snap) return { error: 'Pick the joint origin.' }
  const hit = resolveSnap(snap.spec as never, geometry)
  if (!hit) return { error: 'The face, edge or vertex of this origin no longer exists. Pick it again.' }
  const place = placeAssembly(a, drive, null, 0, geometry)
  const worlds = place.worlds
  if (!worlds[p1] || !worlds[p2] || !worlds[snap.path ?? '']) return { error: 'One of the picked components no longer exists.' }
  const frameWorld = multiply(worlds[snap.path ?? ''], frameMatrix(hit.frame))
  const local = (path: string): Frame => matrixFrame(multiply(invert(worlds[path]), frameWorld))
  const type = v.type as JointType
  return {
    joint: { name: `As-built ${JOINT_TYPES.find((j) => j.type === type)!.label}`, type, a: { occ: p1, frame: local(p1) }, b: { occ: p2, frame: local(p2) }, flip: false, offset: [0, 0, 0], angle: 0, asBuilt: true, ...newJointDefaults(type) },
  }
}

export function startAsBuilt() {
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  ui.setActiveTool('assembly.asBuilt')
  const sel = ui.selection
  const pre = (i: number) => {
    const s = sel.filter((r) => (r.kind === 'component' || (r.kind === 'body' && r.path)))[i]
    return s ? [JSON.stringify(s.kind === 'component' ? { kind: 'component', bodyId: '', path: s.id } : { kind: 'body', bodyId: s.id, path: s.path })] : []
  }
  const close = () => { useUi.getState().closeInspector(); useUi.getState().setActiveTool(null) }
  ui.openInspector({
    schema: {
      ...asBuiltSchema,
      warnings: (v) => {
        const d = useDoc.getState()
        const r = asBuiltFromValues(v, d.geometry, d.assembly)
        return 'error' in r && (pathOfRef(v, 'comp1') || pathOfRef(v, 'comp2')) && snapOf(v, 'origin') ? [r.error] : []
      },
    },
    values: { comp1: pre(0), comp2: pre(1), origin: [], type: 'revolute' },
    onOk: (v) => {
      const d = useDoc.getState()
      const r = asBuiltFromValues(v, d.geometry, d.assembly)
      if ('error' in r) return void toast(r.error, 'error')
      close()
      addJoint(r.joint)
    },
    onCancel: close,
  })
}

// ---- motion link

export const dofChoices = (a: Pick<AssemblyData, 'joints'>) =>
  a.joints.flatMap((j) => dofsOf(j.type).map((d) => ({ value: `${j.id}:${d.key}`, label: `${j.name}: ${d.label}` })))

export function startMotionLink() {
  const a = useDoc.getState().assembly
  const choices = dofChoices(a)
  if (choices.length < 2) return void toast('A motion link needs two joints that can move. Add joints first.', 'error')
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  ui.setActiveTool('assembly.motionLink')
  const close = () => { useUi.getState().closeInspector(); useUi.getState().setActiveTool(null) }
  const schema: ParamSchema = {
    id: 'motionLink',
    title: 'Motion Link',
    params: [
      { type: 'enum', key: 'a', label: 'Driver', display: 'select', help: 'The degree of freedom you move.', default: choices[0].value, options: choices },
      { type: 'enum', key: 'b', label: 'Follower', display: 'select', help: 'The degree of freedom that follows it.', default: choices[1].value, options: choices },
      { type: 'number', key: 'ratio', label: 'Ratio', help: 'Follower = driver x ratio. Use -2 for a gear that turns the other way at twice the angle, or a pitch (mm per degree) for a screw.', step: 0.1, default: 1 },
    ],
    warnings: (v) => (v.a === v.b ? ['Pick two different degrees of freedom.'] : v.a.toString().split(':')[0] === v.b.toString().split(':')[0] ? ['Both belong to the same joint.'] : []),
  }
  ui.openInspector({
    schema,
    values: { a: choices[0].value, b: choices[1].value, ratio: 1 },
    onOk: (v) => {
      const [ja, ka] = String(v.a).split(':'), [jb, kb] = String(v.b).split(':')
      if (v.a === v.b) return void toast('Pick two different degrees of freedom.', 'error')
      close()
      const d = useDoc.getState().assembly
      addLink({ name: `${d.joints.find((j) => j.id === ja)?.name} to ${d.joints.find((j) => j.id === jb)?.name}`, a: { joint: ja, key: ka }, b: { joint: jb, key: kb }, ratio: Number(v.ratio) })
    },
    onCancel: close,
  })
}

