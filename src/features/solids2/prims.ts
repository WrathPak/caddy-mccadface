/** Sphere, Torus, Coil and Pipe: primitives of the Create group. */
import { Circle, CircleNotch, Pipe as PipeIcon, Spiral } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { registerFeature } from '@/doc/registry'
import { getKernel } from '@/kernel/client'
import type { CoilArgs, PipeArgs, SectionKind } from '@/kernel/solids2-ops'
import type { Body, Vec3 } from '@/kernel/types'
import { originPlane } from '@/sketch/plane'
import { useUi } from '@/store/ui'
import type { ParamDef, ParamSchema, ParamValues } from '@/ui/schema'
import { showArrows } from '../handleKit'
import { combine, ctxEnv, liveEnv, type Env } from '../modeling'
import { bodyPreview, OP_OPTIONS, SECTION_OPTIONS, sketchDataOf, sketchPath } from './kit'

const planeParam: ParamDef = { type: 'enum', key: 'plane', help: 'The plane the shape stands on: XY makes the axis point up (Z), XZ along Y, YZ along X.', label: 'Base plane', display: 'segmented', default: 'XY', options: [{ value: 'XY', label: 'XY' }, { value: 'XZ', label: 'XZ' }, { value: 'YZ', label: 'YZ' }] }

// ---------------------------------------------------------------- Sphere

export const sphereSchema: ParamSchema = {
  id: 'sphere',
  title: 'Sphere',
  params: [
    { type: 'vector3', key: 'position', help: 'Where the middle of the sphere sits, as X, Y, Z in mm.', label: 'Center', unit: 'mm', step: 1, default: [0, 0, 0] },
    { type: 'number', key: 'radius', help: 'Radius of the sphere, in mm (half the diameter).', label: 'Radius', unit: 'mm', min: 0.001, step: 1, default: 10 },
  ],
}
const sphereArgs = (p: ParamValues, id: string, name: string) => ({ id, name, radius: p.radius as number, origin: p.position as Vec3 })
registerFeature({
  type: 'sphere',
  label: 'Sphere',
  icon: Circle,
  schema: sphereSchema,
  async compute(ctx, p) {
    return { bodies: [(await ctx.kernel.call('sphereTool', sphereArgs(p, ctx.newBodyId(), ctx.feature.name))) as Body] }
  },
  preview: (ctx) => bodyPreview(sphereSchema, (p) => getKernel().call('sphereTool', sphereArgs(p, 'preview', 'preview')) as Promise<Body>, ctx, {
    handles: (p, apply) => { showArrows([{ origin: p.position as Vec3, dir: [1, 0, 0], key: 'radius', min: 0.001 }], p, apply) },
  }),
})

// ---------------------------------------------------------------- Torus

export const torusSchema: ParamSchema = {
  id: 'torus',
  title: 'Torus',
  params: [
    planeParam,
    { type: 'vector3', key: 'position', help: 'Where the middle of the ring sits, as X, Y, Z in mm.', label: 'Center', unit: 'mm', step: 1, default: [0, 0, 0] },
    { type: 'number', key: 'major', help: 'Radius of the ring: from the middle of the torus to the middle of the tube, in mm.', label: 'Ring radius', unit: 'mm', min: 0.001, step: 1, default: 20 },
    { type: 'number', key: 'minor', help: 'Radius of the tube itself, in mm. It must be smaller than the ring radius.', label: 'Tube radius', unit: 'mm', min: 0.001, step: 0.5, default: 5 },
  ],
}
const torusArgs = (p: ParamValues, id: string, name: string) => ({ id, name, major: p.major as number, minor: p.minor as number, origin: p.position as Vec3, dir: originPlane((p.plane as 'XY' | 'XZ' | 'YZ') ?? 'XY').normal })
registerFeature({
  type: 'torus',
  label: 'Torus',
  icon: CircleNotch,
  schema: torusSchema,
  async compute(ctx, p) {
    return { bodies: [(await ctx.kernel.call('torusTool', torusArgs(p, ctx.newBodyId(), ctx.feature.name))) as Body] }
  },
  preview: (ctx) => bodyPreview(torusSchema, (p) => getKernel().call('torusTool', torusArgs(p, 'preview', 'preview')) as Promise<Body>, ctx, {
    handles: (p, apply) => {
      const c = p.position as Vec3
      showArrows([
        { origin: c, dir: [1, 0, 0], key: 'major', min: 0.001 },
        { origin: [c[0] + (p.major as number), c[1], c[2]], dir: [0, 0, 1], key: 'minor', min: 0.001 },
      ], p, apply)
    },
  }),
})

// ---------------------------------------------------------------- Coil

const coilType = (v: ParamValues) => v.coilType as string
export const coilSchema: ParamSchema = {
  id: 'coil',
  title: 'Coil',
  params: [
    planeParam,
    { type: 'vector3', key: 'position', help: 'Where the middle of the coil base sits, as X, Y, Z in mm.', label: 'Base center', unit: 'mm', step: 1, default: [0, 0, 0] },
    { type: 'number', key: 'diameter', help: 'Diameter of the coil, measured to the middle of the section, in mm.', label: 'Diameter', unit: 'mm', min: 0.01, step: 1, default: 30 },
    {
      type: 'enum', key: 'coilType', help: 'Which two of revolutions, height and pitch you set; the third follows from them.', label: 'Size by', display: 'select', default: 'revH',
      options: [{ value: 'revH', label: 'Revolutions and height' }, { value: 'revP', label: 'Revolutions and pitch' }, { value: 'hP', label: 'Height and pitch' }],
    },
    { type: 'number', key: 'revolutions', help: 'How many full turns the coil makes.', label: 'Revolutions', min: 0.05, step: 0.5, default: 5, visibleWhen: (v) => coilType(v) !== 'hP' },
    { type: 'number', key: 'height', help: 'Total height of the coil along its axis, in mm.', label: 'Height', unit: 'mm', min: 0.01, step: 1, default: 40, visibleWhen: (v) => coilType(v) !== 'revP' },
    { type: 'number', key: 'pitch', help: 'Distance along the axis from one turn to the next, in mm.', label: 'Pitch', unit: 'mm', min: 0.01, step: 0.5, default: 8, visibleWhen: (v) => coilType(v) !== 'revH' },
    { type: 'info', key: 'derived', help: 'The values worked out from the two you set.', label: 'Result', default: '', text: (v) => coilNumbers(v).text },
    { type: 'enum', key: 'section', help: 'The shape of the wire that is wound: circular, square or triangular.', label: 'Section', display: 'segmented', default: 'circle', options: SECTION_OPTIONS },
    { type: 'number', key: 'size', help: 'Diameter of a circular section, or the side of a square or triangular one, in mm.', label: 'Section size', unit: 'mm', min: 0.01, step: 0.5, default: 4 },
    { type: 'bool', key: 'hollow', help: 'Make the wire a tube.', label: 'Hollow', default: false },
    { type: 'number', key: 'wall', help: 'Wall thickness of a hollow coil, in mm.', label: 'Wall thickness', unit: 'mm', min: 0.01, step: 0.25, default: 1, visibleWhen: (v) => !!v.hollow },
    { type: 'bool', key: 'leftHand', help: 'Wind the coil the other way round (left handed).', label: 'Left handed', default: false },
    { type: 'enum', key: 'operation', help: 'Join: add to a body it touches. Cut: remove material. Intersect: keep only the overlap. New body: make a separate body.', label: 'Operation', display: 'select', default: 'new', options: OP_OPTIONS },
    { type: 'selection-ref', key: 'targets', help: 'The bodies to join to, cut or intersect. Leave empty to use every body the coil touches.', label: 'Target bodies', accepts: ['body'], multiple: true, default: [], visibleWhen: (v) => v.operation !== 'new' },
  ],
}

/** Revolutions, height and pitch from the two the dialog takes. */
export function coilNumbers(v: ParamValues): { rev: number; height: number; pitch: number; text: string } {
  let rev = v.revolutions as number, height = v.height as number, pitch = v.pitch as number
  if (coilType(v) === 'revH') pitch = height / rev
  else if (coilType(v) === 'revP') height = rev * pitch
  else rev = height / pitch
  const f = (n: number) => String(+n.toFixed(3))
  return { rev, height, pitch, text: `${f(rev)} turns, height ${f(height)} mm, pitch ${f(pitch)} mm` }
}
const coilArgs = (p: ParamValues, id: string, name: string): CoilArgs => {
  const n = coilNumbers(p)
  return {
    id, name, origin: p.position as Vec3, dir: originPlane((p.plane as 'XY' | 'XZ' | 'YZ') ?? 'XY').normal, diameter: p.diameter as number, pitch: n.pitch, height: n.height,
    section: p.section as SectionKind, size: p.size as number, hollow: !!p.hollow, wall: p.wall as number, leftHand: !!p.leftHand,
  }
}
registerFeature({
  type: 'coil',
  label: 'Coil',
  icon: Spiral,
  schema: coilSchema,
  async compute(ctx, p) {
    const tool = (await ctx.kernel.call('coilTool', coilArgs(p, ctx.newBodyId(), ctx.feature.name))) as Body
    return combine(ctx, tool, p.operation as string, p.targets as string[])
  },
  preview: (ctx) => bodyPreview(coilSchema, (p) => getKernel().call('coilTool', coilArgs(p, 'preview', 'preview')) as Promise<Body>, ctx, {
    kind: (p) => (p.operation === 'cut' ? 'cut' : 'add'),
    handles: (p, apply) => {
      const c = p.position as Vec3, n = originPlane((p.plane as 'XY' | 'XZ' | 'YZ') ?? 'XY').normal
      const side: Vec3 = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0]
      showArrows([
        coilType(p) === 'revP' ? null : { origin: c, dir: n, key: 'height', min: 0.01 },
        { origin: c, dir: side, key: 'diameter', factor: 2, min: 0.01 },
      ], p, apply)
    },
  }),
})

// ---------------------------------------------------------------- Pipe

export const pipeSchema: ParamSchema = {
  id: 'pipe',
  title: 'Pipe',
  params: [
    { type: 'selection-ref', key: 'path', help: 'The sketch line or curve the pipe follows. Click it in the viewport.', label: 'Path', accepts: ['sketch'], required: true, pick: true, default: [] },
    { type: 'enum', key: 'section', help: 'The cross-section of the pipe: circular, square or triangular.', label: 'Section', display: 'segmented', default: 'circle', options: SECTION_OPTIONS },
    { type: 'number', key: 'size', help: 'Outside diameter of a circular pipe, or the side of a square or triangular one, in mm.', label: 'Section size', unit: 'mm', min: 0.01, step: 0.5, default: 10 },
    { type: 'bool', key: 'hollow', help: 'Make the pipe a tube with a bore through its whole length.', label: 'Hollow', default: false },
    { type: 'number', key: 'wall', help: 'Wall thickness of a hollow pipe, in mm.', label: 'Wall thickness', unit: 'mm', min: 0.01, step: 0.25, default: 1, visibleWhen: (v) => !!v.hollow },
    { type: 'enum', key: 'operation', help: 'Join: add to a body it touches. Cut: remove material. Intersect: keep only the overlap. New body: make a separate body.', label: 'Operation', display: 'select', default: 'new', options: OP_OPTIONS },
    { type: 'selection-ref', key: 'targets', help: 'The bodies to join to, cut or intersect. Leave empty to use every body the pipe touches.', label: 'Target bodies', accepts: ['body'], multiple: true, default: [], visibleWhen: (v) => v.operation !== 'new' },
  ],
}
function pipeArgs(p: ParamValues, env: Env, id: string, name: string): PipeArgs {
  const data = sketchDataOf(p.path as string[], env, 'path')
  return { id, name, path: sketchPath(data), section: p.section as SectionKind, size: p.size as number, hollow: !!p.hollow, wall: p.wall as number }
}
registerFeature({
  type: 'pipe',
  label: 'Pipe',
  icon: PipeIcon,
  schema: pipeSchema,
  async compute(ctx, p) {
    const tool = (await ctx.kernel.call('pipeTool', pipeArgs(p, ctxEnv(ctx), ctx.newBodyId(), ctx.feature.name))) as Body
    return combine(ctx, tool, p.operation as string, p.targets as string[])
  },
  preview: (ctx) => bodyPreview(pipeSchema, (p) => getKernel().call('pipeTool', pipeArgs(p, liveEnv(), 'preview', 'preview')) as Promise<Body>, ctx, { kind: (p) => (p.operation === 'cut' ? 'cut' : 'add') }),
})

// ---------------------------------------------------------------- commands

export const startSphere = () => createFeature('sphere', {}, 'solid.sphere')
export const startTorus = () => createFeature('torus', {}, 'solid.torus')
export const startCoil = () => createFeature('coil', {}, 'solid.coil')

/** Pipe starts from the selected sketch. */
export function startPipe() {
  const sel = useUi.getState().selection.filter((r) => r.kind === 'sketch').map((r) => r.id)
  createFeature('pipe', { path: sel.slice(0, 1) }, 'solid.pipe')
}
