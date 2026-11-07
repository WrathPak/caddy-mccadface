/**
 * Mesh tab tools, Fusion style: Plane Cut (axis / plane / face / tilt, fill type), Reduce, Remesh, Generate / Combine / Separate Face Groups,
 * Delete Faces, Erase And Fill and Move Face Group. Each is a feature (timeline step, editable) with a dialog and a live preview.
 */
import { Funnel, GridFour, Intersect, Scissors, SplitVertical, Stack, ArrowsOutCardinal, Eraser, Trash } from '@phosphor-icons/react'
import { decodeRef, resolveFace } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { encodeRegion, resolveRegionSet, regionFromSelection, type RegionSet } from '@/features/hair/region'
import { loadSelection, setPaint, useHairPaint } from '@/features/hair/paint'
import { createFeature } from '@/doc/editor'
import type { Body, Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamValues } from '@/ui/schema'
import { showArrows } from '../handleKit'
import { bodiesParam, registerMeshTool, startTool, type MeshTool } from './kit'
import { regionFrame } from './frame'
import { planeEq, planeParams, resolveCutPlane, showPlaneHandles } from './plane'

const tris = (b: Body) => b.mesh.indices.length / 3
const fmt = (n: number) => n.toLocaleString('en-US')

// ================================================================================================ Plane Cut

const planeCut: MeshTool = {
  type: 'meshPlaneCut', label: 'Plane Cut', icon: Scissors, command: 'mesh.planeCut',
  schema: {
    id: 'meshPlaneCut', title: 'Plane Cut',
    params: [
      bodiesParam,
      ...planeParams,
      { type: 'enum', key: 'keep', help: 'Which side of the plane to keep: the positive side, the negative side, or both as separate bodies.', label: 'Keep', display: 'select', default: 'above', options: [{ value: 'above', label: 'Positive side' }, { value: 'below', label: 'Negative side' }, { value: 'both', label: 'Both (split)' }] },
      {
        type: 'enum', key: 'fill', label: 'Fill type', display: 'segmented', default: 'minimal',
        help: 'How the cut is closed. None leaves it open, Minimal caps it with as few triangles as possible, Uniform caps it with triangles as big as the rest of the mesh.',
        options: [{ value: 'none', label: 'None' }, { value: 'minimal', label: 'Minimal' }, { value: 'uniform', label: 'Uniform' }],
      },
    ],
  },
  handles: (p, src, env, apply) => showPlaneHandles(p, src, env, apply),
  async run(p, src, c) {
    const out: Body[] = []
    let n = 1
    for (const b of src) {
      const plane = planeEq(await resolveCutPlane(p, c.env, c.report))
      out.push(...((await c.kernel.call('meshCut', { id: b.id, name: b.name, key: b.key, normal: plane.normal, offset: plane.offset, keep: p.keep, fill: p.fill ?? 'minimal', otherId: c.newId(n++) })) as Body[]))
    }
    return { bodies: out }
  },
}

// ================================================================================================ Reduce

const reduce: MeshTool = {
  type: 'meshReduce', label: 'Reduce', icon: Funnel, command: 'mesh.reduce',
  schema: {
    id: 'meshReduce', title: 'Reduce',
    params: [
      bodiesParam,
      { type: 'enum', key: 'mode', label: 'Reduce type', display: 'segmented', default: 'tolerance', help: 'How to say how much to take off: by how far the new surface may stray from the old one, by the share of triangles to keep, or by a face count to reach.', options: [{ value: 'tolerance', label: 'Tolerance' }, { value: 'proportion', label: 'Proportion' }, { value: 'count', label: 'Face count' }] },
      { type: 'number', key: 'tolerance', label: 'Tolerance', unit: 'mm', min: 0.0001, step: 0.01, default: 0.05, help: 'How far the reduced surface may stray from the original, in mm. Larger takes more triangles off.', visibleWhen: (v) => (v.mode ?? 'tolerance') === 'tolerance' },
      { type: 'number', key: 'proportion', label: 'Proportion', unit: '%', min: 1, max: 99, step: 5, default: 50, help: 'The share of the triangles to keep, in percent. 50 keeps half of them.', visibleWhen: (v) => v.mode === 'proportion' },
      { type: 'number', key: 'count', label: 'Face count', min: 4, step: 100, default: 1000, help: 'The number of triangles to reduce the mesh to. It can end up a little over when the boundary or sharp edges are kept.', visibleWhen: (v) => v.mode === 'count' },
      { type: 'bool', key: 'preserveBoundaries', label: 'Preserve boundaries', default: true, help: 'Keep the open edges of the mesh (the rim of a hole or cut) exactly as they are.' },
      { type: 'bool', key: 'preserveSharp', label: 'Preserve sharp edges', default: true, help: 'Keep the corners and creases of the part crisp: only triangles on smooth areas are merged.' },
    ],
  },
  async run(p, src, c) {
    const out: Body[] = []
    for (const b of src) {
      out.push((await c.kernel.call('meshReduce2', { id: b.id, name: b.name, key: b.key, type: p.mode ?? 'tolerance', tolerance: p.tolerance, proportion: p.proportion ?? 50, count: p.count ?? 1000, preserveBoundaries: p.preserveBoundaries ?? true, preserveSharp: p.preserveSharp ?? true })) as Body)
    }
    return { bodies: out, note: `${fmt(src.reduce((n, b) => n + tris(b), 0))} to ${fmt(out.reduce((n, b) => n + tris(b), 0))} triangles` }
  },
}

// ================================================================================================ Remesh

const remesh: MeshTool = {
  type: 'meshRefine', label: 'Remesh', icon: GridFour, command: 'mesh.remesh',
  schema: {
    id: 'meshRefine', title: 'Remesh',
    params: [
      bodiesParam,
      {
        type: 'enum', key: 'type', label: 'Type', display: 'select', default: 'split',
        help: 'Split only cuts long edges and keeps every triangle that is there. Uniform and Adaptive rebuild the mesh with even triangles. Density rebuilds it with more or fewer.',
        options: [{ value: 'split', label: 'Refine (split only)' }, { value: 'uniform', label: 'Uniform' }, { value: 'adaptive', label: 'Adaptive' }, { value: 'density', label: 'Density' }],
      },
      { type: 'number', key: 'length', label: 'Max edge length', unit: 'mm', min: 0.01, step: 0.5, default: 2, help: 'Triangles with edges longer than this are split until none are, in mm. Smaller gives a finer mesh (and a heavier file).', visibleWhen: (v) => (v.type ?? 'split') === 'split' },
      { type: 'number', key: 'target', label: 'Edge length', unit: 'mm', min: 0.01, step: 0.5, default: 2, help: 'The edge length the new triangles aim for, in mm. Adaptive makes them shorter where the surface bends and longer where it is flat.', visibleWhen: (v) => v.type === 'uniform' || v.type === 'adaptive' },
      { type: 'number', key: 'density', label: 'Density', unit: '', min: 0.1, max: 8, step: 0.25, default: 1, help: 'How many triangles to aim for compared with now: 2 makes about twice as many, 0.5 about half as many.', visibleWhen: (v) => v.type === 'density' },
      { type: 'bool', key: 'preserveSharp', label: 'Preserve sharp edges', default: true, help: 'Keep the corners and creases of the part where they are, so the shape does not round off.', visibleWhen: (v) => (v.type ?? 'split') !== 'split' },
      { type: 'bool', key: 'preserveBoundaries', label: 'Preserve boundaries', default: true, help: 'Keep the open edges of the mesh (the rim of a hole or cut) in place.', visibleWhen: (v) => (v.type ?? 'split') !== 'split' },
    ],
  },
  async run(p, src, c) {
    const out: Body[] = []
    for (const b of src) {
      if ((p.type ?? 'split') === 'split') out.push((await c.kernel.call('meshRefine', { id: b.id, name: b.name, key: b.key, length: p.length })) as Body)
      else out.push((await c.kernel.call('meshRemesh', { id: b.id, name: b.name, key: b.key, type: p.type, length: p.target, density: p.density, preserveSharp: p.preserveSharp ?? true, preserveBoundaries: p.preserveBoundaries ?? true })) as Body)
    }
    return { bodies: out, note: `${fmt(src.reduce((n, b) => n + tris(b), 0))} to ${fmt(out.reduce((n, b) => n + tris(b), 0))} triangles` }
  },
}

// ================================================================================================ face groups

const generateGroups: MeshTool = {
  type: 'meshFaceGroups', label: 'Generate Face Groups', icon: Stack, command: 'mesh.faceGroups',
  schema: {
    id: 'meshFaceGroups', title: 'Generate Face Groups',
    params: [
      bodiesParam,
      { type: 'enum', key: 'method', label: 'Method', display: 'segmented', default: 'fast', help: 'Fast splits the mesh wherever two neighbouring triangles bend by more than the angle. Accurate follows each region as it grows, so a smooth curved surface is cut into patches instead of staying one face.', options: [{ value: 'fast', label: 'Fast' }, { value: 'accurate', label: 'Accurate' }] },
      { type: 'number', key: 'angle', label: 'Angle', unit: 'deg', min: 1, max: 89, step: 1, default: 20, help: 'Triangles that bend by more than this from their neighbours (Fast) or from the region they are joining (Accurate) start a new face group. Lower gives more, smaller groups.' },
    ],
  },
  async run(p, src, c) {
    const out: Body[] = []
    for (const b of src) out.push((await c.kernel.call('meshGroups', { id: b.id, name: b.name, key: b.key, action: 'generate', method: p.method ?? 'fast', angle: p.angle ?? 20, groups: [], tris: [] })) as Body)
    return { bodies: out, note: `${out.map((b) => new Set(Array.from(b.mesh.faceIds)).size).join(', ')} face groups` }
  },
}

/** The mesh body and face indices of face refs. */
function facesOfRefs(refs: string[], bodies: Body[]): { body: Body; faces: number[] } {
  let body: Body | null = null
  const faces: number[] = []
  for (const s of refs) {
    const r = decodeRef(s)
    if (!r || r.kind !== 'face') continue
    const hit = resolveFace(r, bodies)
    if (!hit || (body && body.id !== hit.body.id)) continue
    body = hit.body
    if (!faces.includes(hit.index)) faces.push(hit.index)
  }
  if (!body) throw new Error('Pick the face groups first')
  return { body, faces }
}

const combineGroups: MeshTool = {
  type: 'meshCombineGroups', label: 'Combine Face Groups', icon: Intersect, command: 'mesh.combineGroups',
  schema: {
    id: 'meshCombineGroups', title: 'Combine Face Groups',
    params: [{ type: 'selection-ref', key: 'faces', label: 'Face groups', accepts: ['face'], multiple: true, required: true, min: 2, pick: true, autoActivate: true, default: [], help: 'Click two or more face groups of one mesh. They become one group.' }],
  },
  targets: (p, env) => [facesOfRefs((p.faces as string[]) ?? [], env.bodies).body],
  async run(p, src, c) {
    const { faces } = facesOfRefs((p.faces as string[]) ?? [], c.env.bodies)
    const b = src[0]
    const out = (await c.kernel.call('meshGroups', { id: b.id, name: b.name, key: b.key, action: 'combine', method: 'fast', angle: 20, groups: faces, tris: [] })) as Body
    return { bodies: [out], note: `${faces.length} groups joined into one` }
  },
}

// ================================================================================================ region tools (brush / face groups)

function regionOf(p: ParamValues, bodies: Body[]): RegionSet {
  const rs = resolveRegionSet((p.region as string[]) ?? [], bodies)
  if (!rs || rs.kind !== 'mesh' || !rs.set.size) throw new Error('Select the faces first: click a face group, or paint with the Brush')
  return rs
}

/** Paint toolbar and cyan highlight while a region dialog is open. */
const regionOpen: MeshTool['open'] = ({ values, setValues }) => {
  let cur = values
  let last = ''
  const sync = (v: ParamValues) => {
    const region = (v.region as string[]) ?? []
    const key = region.join('|')
    if (key === last) return
    last = key
    const rs = resolveRegionSet(region, useDoc.getState().geometry)
    loadSelection(rs?.body.id ?? null, rs?.kind ?? null, rs?.set ?? new Set())
  }
  setPaint({ visible: true, mode: 'off', sink: (region) => { last = region.join('|'); cur = { ...cur, region }; setValues(cur) } })
  sync(values)
  return {
    update(v) { cur = v; sync(v) },
    dispose() { setPaint({ visible: false, mode: 'off', sink: null }); loadSelection(null, null, new Set()) },
  }
}

const regionParam = (help: string): MeshTool['schema']['params'][number] => ({ type: 'selection-ref', key: 'region', label: 'Faces', accepts: ['face'], multiple: true, required: true, pick: true, autoActivate: true, default: [], help })

const separateGroups: MeshTool = {
  type: 'meshSeparateGroups', label: 'Separate Face Groups', icon: SplitVertical, command: 'mesh.separateGroups',
  schema: { id: 'meshSeparateGroups', title: 'Separate Face Groups', params: [regionParam('The triangles to cut out of their face group. Click a face group or paint an area with the Brush. Each connected patch becomes a group of its own.')] },
  open: regionOpen,
  targets: (p, env) => [regionOf(p, env.bodies).body],
  async run(p, src, c) {
    const rs = regionOf(p, c.env.bodies)
    const b = src[0]
    const out = (await c.kernel.call('meshGroups', { id: b.id, name: b.name, key: b.key, action: 'separate', method: 'fast', angle: 20, groups: [], tris: [...rs.set] })) as Body
    return { bodies: [out], note: `${new Set(Array.from(b.mesh.faceIds)).size} to ${new Set(Array.from(out.mesh.faceIds)).size} face groups` }
  },
}

const deleteFaces: MeshTool = {
  type: 'meshDeleteFaces2', label: 'Delete Faces', icon: Trash, command: 'mesh.deleteFaces',
  schema: { id: 'meshDeleteFaces2', title: 'Delete Faces', params: [regionParam('The faces to remove: click face groups, or paint triangles with the Brush. The mesh is left open where they were.')] },
  open: regionOpen,
  targets: (p, env) => [regionOf(p, env.bodies).body],
  async run(p, src, c) {
    const rs = regionOf(p, c.env.bodies)
    const b = src[0]
    const out = (await c.kernel.call('meshErase', { id: b.id, name: b.name, key: b.key, tris: [...rs.set], fill: false })) as Body
    return { bodies: [out], note: `${fmt(rs.set.size)} triangles removed` }
  },
}

const eraseFill: MeshTool = {
  type: 'meshEraseFill', label: 'Erase And Fill', icon: Eraser, command: 'mesh.eraseFill',
  schema: { id: 'meshEraseFill', title: 'Erase And Fill', params: [regionParam('The faces to remove: click face groups, or paint a blemish or boss with the Brush. The hole is closed with a smooth patch.')] },
  open: regionOpen,
  targets: (p, env) => [regionOf(p, env.bodies).body],
  async run(p, src, c) {
    const rs = regionOf(p, c.env.bodies)
    const b = src[0]
    const out = (await c.kernel.call('meshErase', { id: b.id, name: b.name, key: b.key, tris: [...rs.set], fill: true })) as Body & { holes?: number }
    return { bodies: [out], note: `${fmt(rs.set.size)} triangles replaced by a smooth patch` }
  },
}

const moveFaces: MeshTool = {
  type: 'meshMoveFaces', label: 'Move Face Group', icon: ArrowsOutCardinal, command: 'mesh.moveFaces',
  schema: {
    id: 'meshMoveFaces', title: 'Move Face Group',
    params: [
      regionParam('The faces to move: click a face group, or paint an area with the Brush. The triangles around them stretch to follow.'),
      { type: 'number', key: 'distance', label: 'Distance', unit: 'mm', step: 1, default: 0, help: 'How far to move the faces along the way they point, in mm. Negative pushes them in. The arrow in the viewport does the same.' },
      { type: 'vector3', key: 'translate', label: 'Translate', unit: 'mm', step: 1, default: [0, 0, 0], help: 'Move the faces by this much along X, Y and Z as well, in mm.' },
    ],
  },
  open: regionOpen,
  targets: (p, env) => [regionOf(p, env.bodies).body],
  async handles(p, src, env, apply) {
    const rs = regionOf(p, env.bodies)
    const f = regionFrame(rs.body, rs.set)
    showArrows([{ origin: f.centre, dir: f.normal, key: 'distance' }], p, apply)
  },
  async run(p, src, c) {
    const rs = regionOf(p, c.env.bodies)
    const f = regionFrame(rs.body, rs.set)
    const d = (p.distance as number) ?? 0, t = (p.translate as Vec3) ?? [0, 0, 0]
    const delta: Vec3 = [f.normal[0] * d + t[0], f.normal[1] * d + t[1], f.normal[2] * d + t[2]]
    const b = src[0]
    const out = (await c.kernel.call('meshTranslateFaces', { id: b.id, name: b.name, key: b.key, tris: [...rs.set], delta })) as Body
    return { bodies: [out] }
  },
}

// ================================================================================================ registration

export const MESH2_TOOLS: MeshTool[] = [planeCut, reduce, remesh, generateGroups, combineGroups, separateGroups, deleteFaces, eraseFill, moveFaces]
for (const t of MESH2_TOOLS) registerMeshTool(t)

const REGION_TOOLS = new Set(['meshSeparateGroups', 'meshDeleteFaces2', 'meshEraseFill', 'meshMoveFaces'])

/** The faces to start a region tool with: what is painted, else the selected faces. */
function initialRegion(): string[] {
  const paint = useHairPaint.getState()
  const geometry = useDoc.getState().geometry
  const body = geometry.find((b) => b.id === paint.bodyId)
  if (body && body.kind === 'mesh' && paint.sel.size) return [paintToken(body, paint.sel)]
  const sel = useUi.getState().selection.filter((r) => r.kind === 'face')
  if (!sel.length) return []
  const meshOnly = sel.filter((r) => geometry.find((b) => b.id === r.id)?.kind === 'mesh')
  return regionFromSelection(meshOnly, geometry)
}
const paintToken = (b: Body, sel: Set<number>) => encodeRegion(b, sel)[0]

/** Ribbon / palette entry for the tools of this file. */
export function startMesh2(type: string) {
  const t = MESH2_TOOLS.find((x) => x.type === type)!
  if (REGION_TOOLS.has(type)) return createFeature(type, { region: initialRegion() }, t.command)
  if (type === 'meshCombineGroups') {
    const sel = useUi.getState().selection.filter((r) => r.kind === 'face')
    return createFeature(type, { faces: regionFromSelection(sel, useDoc.getState().geometry) }, t.command)
  }
  startTool(type, t.command)
}
