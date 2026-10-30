/** Surface > Modify: Trim, Extend, Stitch, Unstitch, Thicken, Delete Face and Fit to Surface (kernel ops in kernel/surface-ops.ts). */
import { ArrowLineRight, Eraser, LinkBreak, Needle, Rows, Scissors, Swap } from '@phosphor-icons/react'
import { RefError, RefReport, bodyIdsOf, decodeRef, faceSigs, resolveEdge } from '@/doc/refs'
import type { SurfaceDeleteFaceArgs, SurfaceExtendArgs, SurfaceReplaceFaceArgs, SurfaceStitchArgs, SurfaceThickenArgs, SurfaceTrimArgs, SurfaceUnstitchArgs, TrimTool } from '@/kernel/surface-ops'
import type { Body } from '@/kernel/types'
import { mul3 } from '@/kernel/xform'
import type { ParamSchema } from '@/ui/schema'
import { resolvePlane } from '../modeling-tools/geo'
import { facesOf } from '../modeling-tools/source'
import { call, registerSurfaceTool, surfaceBodies } from './kit'

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

// ------------------------------------------------------------------------------------------------ trim

export const surfaceTrimSchema: ParamSchema = {
  id: 'surfaceTrim',
  title: 'Trim',
  params: [
    { type: 'selection-ref', key: 'target', help: 'The surface to cut. Click it in the viewport.', label: 'Surface', accepts: ['body'], required: true, pick: true, default: [] },
    { type: 'selection-ref', key: 'tool', help: 'What cuts it: a plane or construction plane (goes on forever), the faces of a surface or solid, or a whole body. The surface is cut where it meets the tool.', label: 'Trimming tool', accepts: ['face', 'body', 'plane'], multiple: true, required: true, pick: true, default: [] },
    {
      type: 'enum', key: 'keep', help: 'Which side of the tool stays: the side its normal points to (outside, for a solid), or the other one.', label: 'Keep', display: 'segmented', default: 'front',
      options: [{ value: 'front', label: 'Front / outside' }, { value: 'back', label: 'Back / inside' }],
    },
  ],
}

async function trimTool(refs: string[], target: Body, env: Parameters<typeof resolvePlane>[1], report: RefReport): Promise<TrimTool> {
  const first = refs[0]
  const ref = first.startsWith('{') ? decodeRef(first) : null
  if (ref?.kind === 'face') {
    const groups = facesOf(refs, env, report)
    if (groups.length > 1) throw new Error('Pick the faces of one body as the trimming tool')
    if (groups[0].body.id === target.id) throw new Error('A surface cannot trim itself: pick a face of another body, or a plane')
    return { kind: 'faces', key: groups[0].body.key, faces: groups[0].faces.map((f) => f.index) }
  }
  const body = env.bodies.find((b) => b.id === first)
  if (body) {
    if (body.id === target.id) throw new Error('A surface cannot trim itself: pick another body or a plane')
    return { kind: 'body', key: body.key }
  }
  const pl = await resolvePlane(first, env, report)
  return { kind: 'plane', origin: pl.origin, normal: pl.normal }
}

registerSurfaceTool({
  type: 'surfaceTrim',
  label: 'Trim',
  icon: Scissors,
  schema: surfaceTrimSchema,
  filter: 'body',
  async build(p, env, report) {
    const [target] = surfaceBodies(p.target as string[], env, 'the surface to trim')
    const tool = await trimTool(p.tool as string[], target, env, report)
    const args: SurfaceTrimArgs = { id: target.id, name: target.name, key: target.key, tool, keep: p.keep as 'front' | 'back' }
    return { bodies: [await call<Body>(env, 'surfaceTrim', args)] }
  },
})

// ------------------------------------------------------------------------------------------------ extend

export const surfaceExtendSchema: ParamSchema = {
  id: 'surfaceExtend',
  title: 'Extend',
  params: [
    { type: 'selection-ref', key: 'edges', help: 'The open edges of a surface to push outward. Click them in the viewport. Edges that meet at a corner have that corner filled in when you pick both.', label: 'Edges', accepts: ['edge'], multiple: true, required: true, pick: true, default: [] },
    { type: 'number', key: 'distance', help: 'How far to extend, in mm.', label: 'Distance', unit: 'mm', min: 0.001, step: 0.5, default: 5 },
    {
      type: 'enum', key: 'mode', help: 'Natural keeps following the surface, so a cylinder stays a cylinder. Tangent carries straight on along the surface at the edge, like a cone off a sphere.', label: 'Type', display: 'segmented', default: 'natural',
      options: [{ value: 'natural', label: 'Natural' }, { value: 'tangent', label: 'Tangent' }],
    },
  ],
}

registerSurfaceTool({
  type: 'surfaceExtend',
  label: 'Extend',
  icon: ArrowLineRight,
  schema: surfaceExtendSchema,
  filter: 'edge',
  async build(p, env, report) {
    const refs = p.edges as string[]
    const by = new Map<string, { body: Body; edges: number[] }>()
    for (const s of refs) {
      const ref = decodeRef(s)
      if (ref?.kind !== 'edge') continue
      const hit = resolveEdge(ref, env.bodies, report)
      if (!hit) continue
      const g = by.get(hit.body.id) ?? by.set(hit.body.id, { body: hit.body, edges: [] }).get(hit.body.id)!
      if (!g.edges.includes(hit.index)) g.edges.push(hit.index)
    }
    if (!by.size) throw new RefError(refs.length ? 'The edges you picked no longer exist (an edit upstream removed them). Pick them again.' : 'Select the edges to extend', report.lostRefs)
    const bodies: Body[] = []
    for (const g of by.values()) {
      if (!g.body.surface) throw new Error(`${g.body.name} is a ${g.body.kind === 'mesh' ? 'mesh' : 'solid'}: Extend works on the open edges of surfaces`)
      const args: SurfaceExtendArgs = { id: g.body.id, name: g.body.name, key: g.body.key, edges: g.edges, distance: p.distance as number, mode: p.mode as 'natural' | 'tangent' }
      bodies.push(await call<Body>(env, 'surfaceExtend', args))
    }
    return { bodies }
  },
})

// ------------------------------------------------------------------------------------------------ stitch / unstitch

export const surfaceStitchSchema: ParamSchema = {
  id: 'surfaceStitch',
  title: 'Stitch',
  params: [
    { type: 'selection-ref', key: 'surfaces', help: 'The surfaces to sew together along the edges they share. Click them in the viewport.', label: 'Surfaces', accepts: ['body'], multiple: true, required: true, pick: true, default: [] },
    { type: 'number', key: 'tolerance', help: 'Edges closer together than this get joined, in mm. Raise it if the surfaces have small gaps; keep it small so it cannot join edges that should stay apart.', label: 'Tolerance', unit: 'mm', min: 0.0001, step: 0.01, default: 0.01 },
    { type: 'bool', key: 'solid', help: 'When the stitched surfaces close up completely, make a solid. Off keeps a closed surface.', label: 'Make a solid when closed', default: true },
  ],
}

registerSurfaceTool({
  type: 'surfaceStitch',
  label: 'Stitch',
  icon: Needle,
  schema: surfaceStitchSchema,
  filter: 'body',
  async build(p, env) {
    const bodies = surfaceBodies(p.surfaces as string[], env, 'the surfaces to stitch')
    const [first, ...rest] = bodies
    const args: SurfaceStitchArgs = { id: first.id, name: first.name, keys: bodies.map((b) => b.key), tolerance: p.tolerance as number, solid: !!p.solid }
    const out = await call<Body>(env, 'surfaceStitch', args)
    const open = out.surface ? out.freeEdges ?? 0 : 0
    const warning = open ? `${plural(open, 'open edge')} left: raise the tolerance or add the missing surface` : undefined
    return { bodies: [out], remove: rest.map((b) => b.id), warning }
  },
})

export const surfaceUnstitchSchema: ParamSchema = {
  id: 'surfaceUnstitch',
  title: 'Unstitch',
  params: [
    { type: 'selection-ref', key: 'source', help: 'A whole body to split into one surface per face, or just some faces to pull off as surfaces of their own (the rest stays together).', label: 'Body or faces', accepts: ['body', 'face'], multiple: true, required: true, pick: true, default: [] },
  ],
}

registerSurfaceTool({
  type: 'surfaceUnstitch',
  label: 'Unstitch',
  icon: LinkBreak,
  schema: surfaceUnstitchSchema,
  filter: 'body',
  async build(p, env, report) {
    const refs = p.source as string[]
    const wholes = bodyIdsOf(refs.filter((s) => decodeRef(s)?.kind === 'body'))
    const faceGroups = refs.some((s) => decodeRef(s)?.kind === 'face') ? facesOf(refs, env, report) : []
    const jobs: { body: Body; faces?: number[] }[] = []
    for (const id of wholes) {
      const b = env.bodies.find((x) => x.id === id)
      if (b) jobs.push({ body: b })
    }
    for (const g of faceGroups) if (!jobs.some((j) => j.body.id === g.body.id)) jobs.push({ body: g.body, faces: g.faces.map((f) => f.index) })
    if (!jobs.length) throw new RefError(refs.length ? 'What you picked no longer exists (an edit upstream removed it). Pick it again.' : 'Select a body or some faces to unstitch', report.lostRefs)
    const bodies: Body[] = [], remove: string[] = []
    for (const [n, j] of jobs.entries()) {
      if (j.body.kind !== 'brep') throw new Error('Unstitch needs a B-rep body, not a mesh')
      const args: SurfaceUnstitchArgs = { id: n ? `${env.fid}.s${n}` : env.newId(), name: j.body.name, key: j.body.key, ...(j.faces ? { faces: j.faces } : {}) }
      bodies.push(...(await call<Body[]>(env, 'surfaceUnstitch', args)))
      remove.push(j.body.id)
    }
    return { bodies, remove }
  },
})

// ------------------------------------------------------------------------------------------------ thicken

export const surfaceThickenSchema: ParamSchema = {
  id: 'surfaceThicken',
  title: 'Thicken',
  params: [
    { type: 'selection-ref', key: 'surfaces', help: 'The surfaces to give a thickness. Click them in the viewport. A closed surface becomes a hollow solid (front: grows outward, back: inward).', label: 'Surfaces', accepts: ['body'], multiple: true, required: true, pick: true, default: [] },
    { type: 'number', key: 'distance', help: 'The thickness of the solid, in mm. You can also drag the arrow in the viewport.', label: 'Thickness', unit: 'mm', min: 0.001, step: 0.5, default: 2 },
    {
      type: 'enum', key: 'side', help: 'Front grows the way the surface faces, back the other way, symmetric puts half the thickness on each side.', label: 'Side', display: 'segmented', default: 'front',
      options: [{ value: 'front', label: 'Front' }, { value: 'back', label: 'Back' }, { value: 'sym', label: 'Symmetric' }],
    },
    { type: 'bool', key: 'keep', help: 'Keep the surface as well, and make the solid a new body. Off: the surface turns into the solid.', label: 'Keep the surface', default: false },
  ],
}

registerSurfaceTool({
  type: 'surfaceThicken',
  label: 'Thicken',
  icon: Rows,
  schema: surfaceThickenSchema,
  filter: 'body',
  async build(p, env) {
    const bodies = surfaceBodies(p.surfaces as string[], env, 'the surfaces to thicken')
    const out: Body[] = []
    for (const [n, b] of bodies.entries()) {
      const d = p.distance as number
      const args: SurfaceThickenArgs = { id: p.keep ? env.newId(n) : b.id, name: p.keep ? `${b.name} solid` : b.name, key: b.key, distance: p.side === 'back' ? -d : d, sym: p.side === 'sym' }
      out.push(await call<Body>(env, 'surfaceThicken', args))
    }
    return { bodies: out, ...(p.keep ? { kind: 'add' as const, dim: [] } : {}) }
  },
  async manip(p, env) {
    const [b] = surfaceBodies(p.surfaces as string[], env, 'the surfaces to thicken')
    const sg = faceSigs(b)[0]
    if (!sg) return null
    return { origin: sg.centroid, dir: mul3(sg.normal, p.side === 'back' ? -1 : 1), key: 'distance', factor: p.side === 'sym' ? 2 : 1 }
  },
})

// ------------------------------------------------------------------------------------------------ delete face

export const surfaceDeleteFaceSchema: ParamSchema = {
  id: 'surfaceDeleteFace',
  title: 'Delete Face',
  params: [
    { type: 'selection-ref', key: 'faces', help: 'The faces to remove. A solid becomes an open surface (the faces left are kept as they are); a surface just loses them.', label: 'Faces', accepts: ['face'], multiple: true, required: true, pick: true, default: [] },
  ],
}

registerSurfaceTool({
  type: 'surfaceDeleteFace',
  label: 'Delete Face',
  icon: Eraser,
  schema: surfaceDeleteFaceSchema,
  filter: 'face',
  async build(p, env, report) {
    const bodies: Body[] = []
    for (const g of facesOf(p.faces as string[], env, report)) {
      if (g.body.kind !== 'brep') throw new Error('Delete Face needs a B-rep body, not a mesh')
      const args: SurfaceDeleteFaceArgs = { id: g.body.id, name: g.body.name, key: g.body.key, faces: g.faces.map((f) => f.index) }
      bodies.push(await call<Body>(env, 'surfaceDeleteFace', args))
    }
    return { bodies }
  },
})

// ------------------------------------------------------------------------------------------------ replace face

export const surfaceReplaceFaceSchema: ParamSchema = {
  id: 'surfaceReplaceFace',
  title: 'Fit Face to Surface',
  params: [
    { type: 'selection-ref', key: 'faces', help: 'The faces of the solid to move onto the target. Click them in the viewport. The faces next to them are extended or cut back to meet the new surface.', label: 'Faces', accepts: ['face'], multiple: true, required: true, pick: true, default: [] },
    { type: 'selection-ref', key: 'target', help: 'The surface to move onto: a surface body, a plane or construction plane, or a face of another body. Seen along the face it has to reach over all of it (a plane always does).', label: 'Replace with', accepts: ['body', 'face', 'plane'], multiple: true, required: true, pick: true, default: [] },
    { type: 'bool', key: 'keep', help: 'Keep the target surface in the document. Off: a target that is a surface body is used up (removed). A plane or a face of another body always stays.', label: 'Keep the target surface', default: true },
  ],
}

registerSurfaceTool({
  type: 'surfaceReplaceFace',
  label: 'Fit to Surface',
  icon: Swap,
  schema: surfaceReplaceFaceSchema,
  filter: 'face',
  async build(p, env, report) {
    const groups = facesOf(p.faces as string[], env, report)
    if (groups.length > 1) throw new Error('Pick the faces of one solid at a time')
    const [g] = groups
    if (g.body.kind !== 'brep' || g.body.surface) throw new Error(`${g.body.name} is a ${g.body.kind === 'mesh' ? 'mesh' : 'surface'}: Fit to Surface moves the faces of a solid`)
    const refs = p.target as string[]
    const first = refs[0]
    const faceRef = first.startsWith('{') && decodeRef(first)?.kind === 'face'
    let target: TrimTool
    let used: Body | undefined
    if (faceRef) {
      const tg = facesOf(refs, env, report)
      if (tg.length > 1) throw new Error('Pick the target faces of one body')
      if (tg[0].body.id === g.body.id) throw new Error('A solid cannot move its own face onto another one of its faces: pick a face of another body, a surface or a plane')
      target = { kind: 'faces', key: tg[0].body.key, faces: tg[0].faces.map((f) => f.index) }
    } else {
      const body = env.bodies.find((b) => b.id === first)
      if (body) {
        if (body.id === g.body.id) throw new Error('Pick a different body as the target: a solid cannot be moved onto itself')
        if (body.kind !== 'brep' || !body.surface) throw new Error(`${body.name} is a ${body.kind === 'mesh' ? 'mesh' : 'solid'}: pick a surface body, a plane or a face of it`)
        target = { kind: 'body', key: body.key }
        used = body
      } else {
        const pl = await resolvePlane(first, env, report)
        target = { kind: 'plane', origin: pl.origin, normal: pl.normal }
      }
    }
    const args: SurfaceReplaceFaceArgs = { id: g.body.id, name: g.body.name, key: g.body.key, faces: g.faces.map((f) => f.index), target }
    const out = await call<Body>(env, 'surfaceReplaceFace', args)
    return { bodies: [out], remove: used && !p.keep ? [used.id] : undefined }
  },
})

