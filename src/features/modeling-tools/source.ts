/**
 * What Pattern and Mirror repeat: earlier features, faces, or whole bodies. `repeat` applies a list of transforms to that
 * selection and returns the bodies to put into the document.
 */
import { RefError, RefReport, bodyIdsOf, decodeRef, faceSigs, nameOf, resolveFace } from '@/doc/refs'
import type { Body, Vec3 } from '@/kernel/types'
import type { Xf } from '@/kernel/xform'
import { bbox } from '@/kernel/types'
import type { RefEnv } from './geo'

export type SourceKind = 'features' | 'faces' | 'bodies'
export interface Source { kind: SourceKind; features: string[]; faces: string[]; bodies: string[] }

export interface RepeatEnv extends RefEnv {
  /** the bodies before and after an earlier feature */
  around(id: string): { before: Body[]; after: Body[] } | undefined
  fid: string
  /** id of the n-th new body this feature makes */
  newId(n: number): string
}

export interface Repeated {
  /** bodies to add or replace */
  bodies: Body[]
  /** a point at the place the original sits (anchors the instance markers) */
  anchor: Vec3 | null
  warning?: string
}

export interface FaceArg { index: number; names: string[] }
const namesAt = (b: Body, i: number): string[] => b.mesh.faceNames?.[i] ?? []

/** Group face refs by body, resolved against the bodies in `env`. */
export function facesOf(refs: string[], env: { bodies: Body[] }, report: RefReport): { body: Body; faces: FaceArg[]; centers: Vec3[] }[] {
  const by = new Map<string, { body: Body; faces: FaceArg[]; centers: Vec3[] }>()
  for (const s of refs) {
    const ref = decodeRef(s)
    if (!ref || ref.kind !== 'face') continue
    const hit = resolveFace(ref, env.bodies, report)
    if (!hit) continue
    const g = by.get(hit.body.id) ?? by.set(hit.body.id, { body: hit.body, faces: [], centers: [] }).get(hit.body.id)!
    if (g.faces.some((f) => f.index === hit.index)) continue
    g.faces.push({ index: hit.index, names: namesAt(hit.body, hit.index) })
    g.centers.push(faceSigs(hit.body)[hit.index].centroid)
  }
  if (!by.size) throw new RefError(refs.length ? 'The selected faces no longer exist (an edit upstream removed them). Pick them again.' : 'Select the faces first', report.lostRefs)
  return [...by.values()]
}

export const centerOfBody = (b: Body): Vec3 => {
  const { min, max } = bbox(b.mesh.positions)
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
}

const mean = (pts: Vec3[]): Vec3 => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length) as Vec3

/** Repeat the selection once per transform. */
export async function repeat(env: RepeatEnv, src: Source, xforms: Xf[], operation: 'new' | 'join', report: RefReport): Promise<Repeated> {
  const out = new Map<string, Body>()
  const extra: Body[] = []
  const anchors: Vec3[] = []
  const alive = new Map(env.bodies.map((b) => [b.id, b]))
  const call = async <T>(op: string, args: unknown) => (await env.kernel.call(op, args)) as T
  let nextNew = 1
  const copies = async (b: Body, tagBase: string) => {
    const made: Body[] = []
    for (let k = 0; k < xforms.length; k++) {
      made.push(await call<Body>('copyBody', { id: env.newId(nextNew++), name: `${b.name} ${k + 1}`, key: b.key, xform: xforms[k], tag: `${tagBase}.${k + 1}` }))
    }
    return made
  }

  if (src.kind === 'features') {
    if (!src.features.length) throw new Error('Select the features to repeat')
    for (const fid of src.features) {
      const st = env.around(fid)
      if (!st) throw new Error('A selected feature is not part of the model any more (it was deleted, suppressed or comes later in the timeline)')
      for (const after of st.after) {
        const before = st.before.find((b) => b.id === after.id)
        if (before && before.key === after.key) continue
        if (!before) {
          // the feature made a new body: its copies are new bodies
          extra.push(...(await copies(out.get(after.id) ?? after, `${env.fid}`)))
          anchors.push(centerOfBody(after))
          continue
        }
        if (after.kind !== 'brep' || before.kind !== 'brep') throw new Error('Patterns and mirrors need solid (B-rep) bodies')
        const current = out.get(after.id) ?? alive.get(after.id)
        if (!current) continue
        const c = await call<Vec3 | null>('deltaCenter', { before: before.key, after: after.key, fid: env.fid })
        if (c) anchors.push(c)
        out.set(after.id, await call<Body>('patternApply', { id: after.id, name: current.name, fid: env.fid, current: current.key, before: before.key, after: after.key, xforms }))
      }
    }
    if (!out.size && !extra.length) throw new Error('The selected features did not change any body, so there is nothing to repeat')
  } else if (src.kind === 'faces') {
    for (const g of facesOf(src.faces, env, report)) {
      if (g.body.kind !== 'brep') throw new Error('Patterns and mirrors need solid (B-rep) bodies')
      const current = out.get(g.body.id) ?? g.body
      anchors.push(mean(g.centers))
      out.set(g.body.id, await call<Body>('patternApply', { id: g.body.id, name: g.body.name, fid: env.fid, current: current.key, faces: g.faces.map((f) => f.index), xforms }))
    }
  } else {
    const ids = bodyIdsOf(src.bodies)
    const bodies = ids.map((id) => alive.get(id)).filter((b): b is Body => !!b)
    if (!bodies.length) throw new RefError(src.bodies.length ? 'The selected bodies no longer exist. Pick them again.' : 'Select the bodies first', src.bodies)
    for (const b of bodies) {
      if (b.kind !== 'brep') throw new Error('Patterns and mirrors need solid (B-rep) bodies')
      anchors.push(centerOfBody(b))
      const made = await copies(b, env.fid)
      if (operation === 'join') {
        out.set(b.id, await call<Body>('joinBodies', { id: b.id, name: b.name, keys: [b.key, ...made.map((m) => m.key)], fid: env.fid }))
      } else extra.push(...made)
    }
  }
  void nameOf
  return { bodies: [...out.values(), ...extra], anchor: anchors.length ? mean(anchors) : null }
}
