/**
 * Worker ops behind the plugin API's kernel calls: the primitives the existing ops do not offer on their own (a cylinder,
 * a sphere, a polygon prism) and `pluginFinalize`, which gives the body a plugin feature built its final id and name.
 */
import { Plane, draw, makeCylinder, makeSphere } from 'replicad'
import { initOcc, type Shape } from './occ'
import { registerOp } from './store'
import type { Body, Vec3 } from './types'

type Vec2 = [number, number]
interface Common { id: string; name: string }

const finite = (v: number, what: string) => {
  if (!Number.isFinite(v)) throw new Error(`${what} must be a number`)
  return v
}
const positive = (v: number, what: string) => {
  if (!(finite(v, what) > 0)) throw new Error(`${what} must be greater than zero`)
  return v
}
const vec3 = (v: Vec3 | undefined, what: string, d: Vec3 = [0, 0, 0]): Vec3 => {
  if (v === undefined) return d
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${what} must be three numbers`)
  return [finite(v[0], what), finite(v[1], what), finite(v[2], what)]
}

registerOp<Common & { radius: number; height: number; position?: Vec3 }, Body>('pluginCylinder', async (a, h) => {
  await initOcc()
  const p = vec3(a.position, 'position')
  const s = makeCylinder(positive(a.radius, 'radius'), positive(a.height, 'height'), p, [0, 0, 1]) as unknown as Shape
  return h.sendBody(h.bodyFromShape(a.id, a.name, s))
})

registerOp<Common & { radius: number; center?: Vec3 }, Body>('pluginSphere', async (a, h) => {
  await initOcc()
  const c = vec3(a.center, 'center')
  const s = (makeSphere(positive(a.radius, 'radius')) as unknown as Shape).translate(c[0], c[1], c[2]) as Shape
  return h.sendBody(h.bodyFromShape(a.id, a.name, s))
})

const PLANES = {
  XY: { xDir: [1, 0, 0], normal: [0, 0, 1] },
  XZ: { xDir: [1, 0, 0], normal: [0, -1, 0] },
  YZ: { xDir: [0, 1, 0], normal: [1, 0, 0] },
} as const

const signedArea = (pts: Vec2[]) => pts.reduce((s, p, i) => s + (p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1]), 0) / 2

function polygon(points: Vec2[], what: string): Vec2[] {
  if (!Array.isArray(points) || points.length < 3) throw new Error(`${what} needs at least three points`)
  const pts = points.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) throw new Error(`${what} point ${i + 1} must be [x, y]`)
    return [finite(p[0], what), finite(p[1], what)] as Vec2
  })
  if (Math.abs(signedArea(pts)) < 1e-12) throw new Error(`${what} has no area`)
  return pts
}

function prism(plane: Plane, pts: Vec2[], height: number): Shape {
  // counter-clockwise outlines extrude along the plane's normal
  const ccw = signedArea(pts) >= 0 ? pts : [...pts].reverse()
  let pen = draw(ccw[0])
  for (let i = 1; i < ccw.length; i++) pen = pen.lineTo(ccw[i])
  return (pen.close().sketchOnPlane(plane) as unknown as { extrude(d: number): Shape }).extrude(height)
}

registerOp<Common & { outline: Vec2[]; holes?: Vec2[][]; height: number; plane?: keyof typeof PLANES; origin?: Vec3 }, Body>('pluginExtrude', async (a, h) => {
  await initOcc()
  const def = PLANES[a.plane ?? 'XY']
  if (!def) throw new Error('plane must be XY, XZ or YZ')
  const height = positive(a.height, 'height')
  const plane = new Plane(vec3(a.origin, 'origin'), def.xDir as unknown as Vec3, def.normal as unknown as Vec3)
  let solid = prism(plane, polygon(a.outline, 'outline'), height)
  for (const [i, hole] of (a.holes ?? []).entries()) {
    // the cutter is a little taller than the solid on both sides, so the cut goes all the way through
    const pts = polygon(hole, `hole ${i + 1}`)
    const lift = new Plane(
      [plane.origin.x - def.normal[0] * 0.5, plane.origin.y - def.normal[1] * 0.5, plane.origin.z - def.normal[2] * 0.5] as Vec3,
      def.xDir as unknown as Vec3, def.normal as unknown as Vec3,
    )
    solid = solid.cut(prism(lift, pts, height + 1)) as Shape
  }
  return h.sendBody(h.bodyFromShape(a.id, a.name, solid))
})

registerOp<Common & { key: string }, Body>('pluginFinalize', (a, h) => {
  // a solid keeps its exact shape and face names; a mesh is stored again under the new id
  let named: ReturnType<typeof h.getNamed> | null = null
  try { named = h.getNamed(a.key) } catch { named = null }
  if (named) return h.sendBody(h.bodyFromShape(a.id, a.name, named.shape, named.faces))
  return h.sendBody(h.bodyFromTopo(a.id, a.name, h.getTopo(a.key)))
})

export {}
