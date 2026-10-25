/** Shared helpers for the assembly specs: build components and joints through the debug handle (the UI paths have their own specs). */
import type { App } from './helpers'

export async function addBox(app: App, name: string, size: [number, number, number], position: [number, number, number] = [0, 0, 0]) {
  const id = await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size[0], depth: a.size[1], height: a.size[2], position: a.position }, a.name), { name, size, position })
  await app.idle()
  return id as string
}

/** A 40 x 40 x 4 plate and a 30 x 6 x 6 bar beside it, each a component (occurrences o1 and o2). */
export async function plateAndBar(app: App) {
  await addBox(app, 'Plate', [40, 40, 4])
  await addBox(app, 'Bar', [30, 6, 6], [45, 0, 0])
  const ids = await app.ev((c) => c.doc.getState().geometry.map((b: { id: string }) => b.id))
  await app.ev((c, ids) => c.assembly.actions.componentsFromBodies(ids), ids)
  await app.idle()
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
}

export interface JointRow { id: string; name: string; type: string; flip: boolean; values: Record<string, number>; a: { occ: string }; b: { occ: string }; asBuilt?: boolean }
export const jointsOf = (app: App) => app.ev((c) => JSON.parse(JSON.stringify(c.doc.getState().assembly.joints))) as Promise<JointRow[]>

export const bodyIdNamed = async (app: App, name: string) =>
  (await app.ev((c) => c.doc.getState().geometry.map((b: { id: string; name: string }) => [b.id, b.name]))).find((x: string[]) => x[1] === name)[0] as string
export const barId = (app: App) => bodyIdNamed(app, 'Bar')

/** World bounds of one body (its first instance) as drawn now. */
export const worldBox = (app: App, body: string) => app.ev((c, id) => {
  const i = c.assembly.place.currentInstances().find((x: { body: { id: string } }) => x.body.id === id)
  const p = i.body.mesh.positions, m = i.world
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let k = 0; k < p.length; k += 3) {
    const w = [0, 1, 2].map((r) => m[r] * p[k] + m[4 + r] * p[k + 1] + m[8 + r] * p[k + 2] + m[12 + r])
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], w[a]); hi[a] = Math.max(hi[a], w[a]) }
  }
  return { lo: lo.map((v) => +v.toFixed(4)), hi: hi.map((v) => +v.toFixed(4)) }
}, body) as Promise<{ lo: number[]; hi: number[] }>

export interface JointInput { name: string; type: string; a: string; b: string; fa: [number, number, number]; fb: [number, number, number]; extra?: Record<string, unknown> }
/** A joint between two instances with frames whose axes are the world Z axis (in each component's own space), added without the UI. */
export function addJoint(app: App, j: JointInput) {
  return app.ev((c, j) => {
    const frame = (o: number[]) => ({ origin: o, z: [0, 0, 1], x: [1, 0, 0] })
    const defaults = c.assembly.actions.newJointDefaults(j.type)
    return c.assembly.actions.addJoint({ name: j.name, type: j.type, a: { occ: j.a, frame: frame(j.fa) }, b: { occ: j.b, frame: frame(j.fb) }, flip: false, offset: [0, 0, 0], angle: 0, ...defaults, ...(j.extra ?? {}) })
  }, j) as Promise<string>
}

export const solved = (app: App) => app.ev((c) => {
  const s = c.assembly.place.currentPlacement().solve
  return { values: s.values, errors: s.errors, over: s.overConstrained }
}) as Promise<{ values: Record<string, Record<string, number>>; errors: Record<string, string>; over: boolean }>
