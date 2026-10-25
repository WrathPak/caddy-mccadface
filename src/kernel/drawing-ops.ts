/**
 * Worker op for the Drawing workspace: hidden line removal (OpenCascade HLRBRep_Algo) of one or more B-rep bodies for a
 * view direction, optionally cut by a section plane first. Results are polylines in the view plane (x right, y up).
 */
import { basicFaceExtrusion, cast, getOC, makePolygon, Vector, type AnyShape, type Edge, type Face } from 'replicad'
import { getBrep, registerOp } from './store'
import type { Shape } from './occ'
import { add3, cross3, dot3, mul3, planeBasis, sub3, unit3 } from './print-geom'
import type { Vec3 } from './types'

export type EdgeClass = 'visible' | 'hidden' | 'tangent'
/** flat [x0, y0, x1, y1, ...] */
export type Poly2 = number[]

export interface HlrArgs {
  /** kernel handles (Body.key) of the bodies to project */
  keys: string[]
  /** unit vector from the model towards the viewer */
  eye: Vec3
  /** unit vector pointing to the right of the view */
  right: Vec3
  /** cut the bodies with this plane first and keep what lies behind it (opposite to `normal`) */
  section?: { origin: Vec3; normal: Vec3 }
}

export interface HlrResult {
  visible: Poly2[]
  hidden: Poly2[]
  tangent: Poly2[]
  /** section faces (cut plane), each a list of loops (first is the outer one) */
  cut: Poly2[][]
  /** 2D bounds of everything that was projected */
  bounds: [number, number, number, number] | null
}

/** world -> view plane for the projector built from (eye, right) */
export function viewBasis(eye: Vec3, right: Vec3): { x: Vec3; y: Vec3; z: Vec3 } {
  const z = unit3(eye)
  const x = unit3(sub3(right, mul3(z, dot3(right, z))))
  const y = cross3(z, x)
  return { x, y, z }
}

function bigPrism(origin: Vec3, normal: Vec3, size: number): Shape {
  const { u, v, n } = planeBasis(normal)
  const c = (a: number, b: number): Vec3 => add3(origin, add3(mul3(u, a * size), mul3(v, b * size)))
  const pts = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)]
  return basicFaceExtrusion(makePolygon(pts), new Vector(mul3(n, size))) as unknown as Shape
}

function sampleEdge(e: Edge): Poly2 {
  const p0 = e.startPoint, p1 = e.endPoint
  if (e.geomType === 'LINE') return [p0.x, p0.y, p1.x, p1.y]
  const len = e.length
  const n = Math.max(12, Math.min(360, Math.ceil(len / 0.7)))
  const out: number[] = []
  for (let i = 0; i <= n; i++) {
    const p = e.pointAt(i / n)
    out.push(p.x, p.y)
  }
  return out
}

function edgesOf(compound: unknown): Poly2[] {
  if (!compound) return []
  const raw = compound as { IsNull(): boolean }
  if (raw.IsNull()) return []
  const sh = cast(compound as never) as unknown as AnyShape
  const out: Poly2[] = []
  for (const e of sh.edges) {
    const pl = sampleEdge(e)
    if (pl.length >= 4 && Math.hypot(pl[pl.length - 2] - pl[0], pl[pl.length - 1] - pl[1]) + polyLen(pl) > 1e-7) out.push(pl)
  }
  return out
}

const polyLen = (p: Poly2) => {
  let l = 0
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])
  return l
}

/** distance from (px, py) to the nearest segment of the polylines */
function nearest(px: number, py: number, polys: Poly2[]): number {
  let best = Infinity
  for (const p of polys) {
    for (let i = 2; i < p.length; i += 2) {
      const ax = p[i - 2], ay = p[i - 1], bx = p[i], by = p[i + 1]
      const dx = bx - ax, dy = by - ay
      const l2 = dx * dx + dy * dy
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
      const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
      if (d < best) best = d
    }
  }
  return best
}

/** Hidden lines that lie exactly under a visible line (the far edge of a prism seen end on) are not drawn dashed on top of it. */
function dropCovered(hidden: Poly2[], visible: Poly2[]): Poly2[] {
  return hidden.filter((h) => {
    const total = polyLen(h)
    if (total < 1e-9) return false
    // test points spread along the line (the ends often touch other edges, so they say nothing)
    for (const t of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
      let want = total * t
      for (let i = 2; i < h.length; i += 2) {
        const seg = Math.hypot(h[i] - h[i - 2], h[i + 1] - h[i - 1])
        if (want <= seg || i === h.length - 2) {
          const k = seg > 0 ? Math.min(1, want / seg) : 0
          if (nearest(h[i - 2] + (h[i] - h[i - 2]) * k, h[i - 1] + (h[i + 1] - h[i - 1]) * k, visible) > 1e-4) return true
          break
        }
        want -= seg
      }
    }
    return false
  })
}

function toView(p: Vec3, b: { x: Vec3; y: Vec3 }): [number, number] {
  return [dot3(p, b.x), dot3(p, b.y)]
}

/** discretised loops of the planar faces lying in the cut plane, in view coordinates */
function cutFaces(shape: AnyShape, origin: Vec3, normal: Vec3, basis: { x: Vec3; y: Vec3 }): Poly2[][] {
  const n = unit3(normal)
  const out: Poly2[][] = []
  for (const f of shape.faces as Face[]) {
    if (f.geomType !== 'PLANE') continue
    const fn = f.normalAt()
    const nv: Vec3 = [fn.x, fn.y, fn.z]
    if (Math.abs(Math.abs(dot3(nv, n)) - 1) > 1e-6) continue
    const c = f.center
    if (Math.abs(dot3(sub3([c.x, c.y, c.z], origin), n)) > 1e-5) continue
    const loops: Poly2[] = []
    for (const w of f.wires) {
      const poly: number[] = []
      for (const e of w.edges) {
        const pts: Vec3[] = []
        if (e.geomType === 'LINE') pts.push([e.startPoint.x, e.startPoint.y, e.startPoint.z])
        else {
          const k = Math.max(12, Math.min(360, Math.ceil(e.length / 0.7)))
          for (let i = 0; i < k; i++) { const p = e.pointAt(i / k); pts.push([p.x, p.y, p.z]) }
        }
        for (const p of pts) poly.push(...toView(p, basis))
      }
      loops.push(poly)
    }
    // the outer loop is the one that encloses the most area
    const area = (p: Poly2) => {
      let s = 0
      for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length; s += p[i] * p[j + 1] - p[j] * p[i + 1] }
      return Math.abs(s) / 2
    }
    loops.sort((a, b) => area(b) - area(a))
    out.push(loops)
  }
  return out
}

registerOp<HlrArgs, HlrResult>('drawingHlr', (a) => {
  const oc = getOC() as unknown as Record<string, new (...args: unknown[]) => any> // eslint-disable-line
  const b = viewBasis(a.eye, a.right)
  const result: HlrResult = { visible: [], hidden: [], tangent: [], cut: [], bounds: null }
  const created: { delete(): void }[] = []
  try {
    let shapes: Shape[] = a.keys.map((k) => getBrep(k))
    if (a.section) {
      const sec = a.section
      const cutter = bigPrism(sec.origin, sec.normal, 1e5)
      shapes = shapes.map((s) => {
        const r = s.cut(cutter as never) as unknown as Shape
        return r
      })
      for (const s of shapes) result.cut.push(...cutFaces(s as unknown as AnyShape, sec.origin, sec.normal, b))
    }
    const algo = new oc.HLRBRep_Algo()
    created.push(algo)
    const ax = new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(b.z[0], b.z[1], b.z[2]), new oc.gp_Dir(b.x[0], b.x[1], b.x[2]))
    const proj = new oc.HLRAlgo_Projector(ax)
    created.push(ax, proj)
    for (const s of shapes) algo.Add((s as unknown as { wrapped: unknown }).wrapped, 0)
    algo.Projector(proj)
    algo.Update()
    algo.Hide()
    const to = new oc.HLRBRep_HLRToShape(algo)
    created.push(to)
    result.visible.push(...edgesOf(to.VCompound()), ...edgesOf(to.OutLineVCompound()))
    result.hidden.push(...dropCovered([...edgesOf(to.HCompound()), ...edgesOf(to.OutLineHCompound())], result.visible))
    result.tangent.push(...edgesOf(to.Rg1LineVCompound()), ...edgesOf(to.RgNLineVCompound()))
  } finally {
    for (const o of created) { try { o.delete() } catch { /* already released */ } }
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const group of [result.visible, result.hidden, result.tangent]) {
    for (const p of group) for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1])
    }
  }
  if (Number.isFinite(x0)) result.bounds = [x0, y0, x1, y1]
  return result
})
