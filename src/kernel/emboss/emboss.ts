/**
 * Emboss / engrave: flat artwork becomes a thin solid that is laid onto the selected surface. On curved faces every vertex of
 * the (refined) solid is moved by a warp: either straight along the surface normal at the anchor (the artwork is projected onto
 * the surface like a stencil) or, on a cylinder, wrapped around it without distortion.
 */
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d'
import { prepSurface } from '../../features/hair/sampling'
import type { V3 } from '../../features/hair/schema'
import { cross, dot, mul, norm, sub } from '../../features/hair/vec'
import { fitPatch } from '../generators/param'
import { frameAt, SurfaceProbe, toWorld } from '../generators/surface'
import type { Artwork, Stroke, V2 } from './shapes'

export interface EmbossInput {
  art: Artwork
  mode: 'emboss' | 'engrave'
  depth: number
  /** how far an embossed shape is buried in the body so it fuses, mm */
  sink: number
  /** where the artwork's centre goes; snapped to the nearest point of the selected faces */
  pos: V3
  /** counter-clockwise rotation about the surface normal, degrees */
  rotation: number
  wrap: 'project' | 'cylinder'
  /** grow (positive) or shrink (negative) the outline, mm: a poor man's font weight */
  weight: number
  /** triangle edge length of the solid on curved surfaces, mm */
  detail: number
  /** selected region triangles */
  positions: Float32Array
  indices: Uint32Array
}

export interface EmbossTool {
  tool: Manifold
  point: V3
  normal: V3
  wrapped: 'project' | 'cylinder'
  /** fraction (0 to 1) of the artwork that lies off the selected faces */
  offSurface: number
  warnings: string[]
}

const MAX_TRIS = 260_000
const ENGRAVE_OVERSHOOT = 0.5

function circlePoly(c: V2, r: number, n = 14): V2[] {
  return Array.from({ length: n }, (_, k) => [c[0] + r * Math.cos((2 * Math.PI * k) / n), c[1] + r * Math.sin((2 * Math.PI * k) / n)] as V2)
}

/** A stroked line as the union of a rectangle per segment and a disc per vertex. */
function strokeCross(W: ManifoldToplevel, s: Stroke, own: <T extends { delete(): void }>(x: T) => T): CrossSection {
  const parts: CrossSection[] = []
  const pts = s.closed ? [...s.points, s.points[0]] : s.points
  const r = s.width / 2
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy)
    if (l < 1e-9) continue
    const nx = (-dy / l) * r, ny = (dx / l) * r
    parts.push(own(W.CrossSection.ofPolygons([[[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]], 'NonZero')))
  }
  for (const p of pts) parts.push(own(W.CrossSection.ofPolygons([circlePoly(p, r)], 'NonZero')))
  return own(W.CrossSection.union(parts))
}

/** Union of everything the artwork draws as one cross section. */
export function artworkCross(W: ManifoldToplevel, art: Artwork, own: <T extends { delete(): void }>(x: T) => T): CrossSection {
  const parts: CrossSection[] = []
  for (const p of art.parts) if (p.loops.length) parts.push(own(W.CrossSection.ofPolygons(p.loops, p.rule)))
  for (const s of art.strokes) parts.push(strokeCross(W, s, own))
  if (!parts.length) throw new Error('There is nothing to emboss')
  return own(W.CrossSection.union(parts))
}

export function buildEmbossTool(W: ManifoldToplevel, a: EmbossInput, own: <T extends { delete(): void }>(x: T) => T): EmbossTool {
  const s = prepSurface(a.positions, a.indices)
  const probe = new SurfaceProbe(s)
  const near = probe.closest(a.pos)
  const normal = probe.normal(near.tri, near.point)
  const up: V3 = [0, 0, 1]
  const frame = frameAt(near.point, normal, up)
  const warnings: string[] = []

  let cs = artworkCross(W, a.art, own)
  if (a.weight !== 0) cs = own(cs.offset(a.weight, 'Round', 2, 12))
  if (a.rotation) cs = own(cs.rotate(a.rotation))
  if (cs.isEmpty()) throw new Error('There is nothing left of the artwork (the weight is too negative)')
  const bb = cs.bounds()
  const size = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1])
  if (size > 600) throw new Error('The artwork is larger than 600 mm; reduce its size')

  const z0 = a.mode === 'emboss' ? -Math.max(0.05, a.sink) : -a.depth
  const z1 = a.mode === 'emboss' ? a.depth : ENGRAVE_OVERSHOOT

  // how the surface is covered: a flat patch needs no refinement, a curved one does
  let wrapped: 'project' | 'cylinder' = 'project'
  type Map3 = (x: number, y: number, z: number) => V3
  let map: Map3
  let curved = false
  let off = 0, total = 0
  if (a.wrap === 'cylinder') {
    const all = Array.from({ length: s.idx.length / 3 }, (_, i) => i)
    const fit = fitPatch(s, all, frame.y)
    if (fit?.kind === 'cylinder') {
      wrapped = 'cylinder'
      let ax = fit.a
      if (dot(ax, frame.y) < 0) ax = mul(ax, -1)
      const q = sub(near.point, fit.o)
      const t0 = dot(q, ax)
      const rad0 = norm(sub(q, mul(ax, t0)))
      const e1 = rad0, e2 = cross(ax, e1)
      const sgn = dot(normal, rad0) >= 0 ? 1 : -1
      const r = fit.r
      map = (x, y, z) => {
        const th = (sgn * x) / r
        const c = Math.cos(th), sn = Math.sin(th)
        const rad: V3 = [e1[0] * c + e2[0] * sn, e1[1] * c + e2[1] * sn, e1[2] * c + e2[2] * sn]
        const rr = r + sgn * z
        return [fit.o[0] + ax[0] * (t0 + y) + rad[0] * rr, fit.o[1] + ax[1] * (t0 + y) + rad[1] * rr, fit.o[2] + ax[2] * (t0 + y) + rad[2] * rr]
      }
      curved = true
    } else warnings.push('The selected faces are not a cylinder, so the artwork is projected along the surface normal instead')
  }
  if (wrapped === 'project') {
    // sample the surface under the artwork's bounding box
    const lo = [Infinity, -Infinity]
    let allIn = true
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const h = probe.height(frame, bb.min[0] + ((bb.max[0] - bb.min[0]) * i) / 8, bb.min[1] + ((bb.max[1] - bb.min[1]) * j) / 8)
        lo[0] = Math.min(lo[0], h.h); lo[1] = Math.max(lo[1], h.h)
        if (!h.inside) allIn = false
      }
    }
    curved = lo[1] - lo[0] > 0.002 || !allIn
    const cache = new Map<string, { h: number; inside: boolean; counted: boolean }>()
    map = (x, y, z) => {
      const key = x.toFixed(4) + ',' + y.toFixed(4)
      let h = cache.get(key)
      if (!h) {
        const r = probe.height(frame, x, y, 0)
        h = { h: r.h, inside: r.inside, counted: false }
        cache.set(key, h)
      }
      if (!h.counted && z <= z0 + 1e-6) { h.counted = true; total++; if (!h.inside) off++ }
      return toWorld(frame, x, y, h.h + z)
    }
  }

  const area = cs.area()
  let tool = own(cs.extrude(z1 - z0)).translate(0, 0, z0)
  own(tool)
  if (curved) {
    const len = Math.max(a.detail, Math.sqrt((2 * area) / (0.43 * (MAX_TRIS / 2))))
    const refined = own(tool.refineToLength(len))
    tool = own(refined.warp((v) => { const p = map(v[0], v[1], v[2]); v[0] = p[0]; v[1] = p[1]; v[2] = p[2] }))
  } else {
    tool = own(tool.warp((v) => { const p = map(v[0], v[1], v[2]); v[0] = p[0]; v[1] = p[1]; v[2] = p[2] }))
  }
  if (tool.status() !== 'NoError' || tool.isEmpty() || tool.volume() <= 0) throw new Error('The shape could not be built on this surface; try a larger detail value or a flatter area')
  const offSurface = total ? off / total : 0
  if (offSurface > 0.02) warnings.push(`${Math.round(offSurface * 100)}% of the artwork lies off the selected faces, where it follows the nearest edge. Select more faces or move it.`)
  return { tool, point: near.point, normal, wrapped, offSurface, warnings }
}
