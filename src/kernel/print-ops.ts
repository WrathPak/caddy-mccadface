/** Worker ops for the Print workspace: split a body (with alignment connectors), hollow a body (with drain holes), and the export mesh with face ids. */
import { basicFaceExtrusion, makeCylinder, makePolygon, measureVolume, Vector, type AnyShape } from 'replicad'
import { fromManifold, initManifold, meshBoolean, toManifold } from './mesh'
import { segmentFaces, weld } from './meshutil'
import { boolNamed, rootNames, shellNamed, type NShape } from './naming'
import { profileFace, planeOf, type ProfileGroup } from './model-ops'
import { tessellate, topoOf, type Shape } from './occ'
import { getStored, registerOp, type OpHelpers } from './store'
import {
  add3, cross3, dot3, layoutLanes, layoutPins, mul3, planeBasis, sectionSegments, sub3, unit3, type Vec2,
} from './print-geom'
import type { Body, TopoMesh, Vec3 } from './types'

// ---------------------------------------------------------------- shared helpers

type Sh = Shape
const volumeOf = (s: AnyShape) => Math.abs(measureVolume(s as never))

/** Planar polygon (3D points, any winding) swept along `dir * dist`, wound so the solid comes out outward-facing. */
function prism(points: Vec3[], dir: Vec3, dist: number): Sh {
  let n: Vec3 = [0, 0, 0]
  for (let i = 0; i < points.length; i++) n = add3(n, cross3(points[i], points[(i + 1) % points.length]))
  const along = dot3(n, dir) * Math.sign(dist) >= 0
  const pts = along ? points : [...points].reverse()
  return basicFaceExtrusion(makePolygon(pts), new Vector(mul3(dir, dist))) as unknown as Sh
}

/** A large block on the positive side of the plane (its in-plane footprint is centred on `near`). */
function halfSpace(origin: Vec3, normal: Vec3, near: Vec3, size: number): Sh {
  const { u, v, n } = planeBasis(normal)
  const foot = sub3(near, mul3(n, dot3(sub3(near, origin), n)))
  const c = (a: number, b: number): Vec3 => add3(foot, add3(mul3(u, a * size), mul3(v, b * size)))
  return prism([c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)], n, size)
}

export type Cutter =
  | { kind: 'plane'; origin: Vec3; normal: Vec3 }
  /** an open path in a plane (world points, two or more, `normal` is the plane's); the part on the left of the path is cut off */
  | { kind: 'path'; points: Vec3[]; normal: Vec3 }
  /** closed sketch profiles, swept both ways through the body */
  | { kind: 'profiles'; groups: ProfileGroup[] }

export interface ConnectorSpec {
  type: 'round' | 'square' | 'dovetail'
  count: number
  /** pin diameter / square side / dovetail neck width, mm */
  size: number
  /** how far the pin or tail goes into the other part, mm */
  depth: number
  /** gap between pin and socket on every side, mm */
  clearance: number
  /** dovetail flank angle, degrees from the sliding direction */
  angle: number
}

export interface SplitArgs {
  id: string
  name: string
  key: string
  /** ids for the resulting bodies, in order (the first replaces the original) */
  ids: string[]
  cutter: Cutter
  connectors?: ConnectorSpec
  fid: string
}

/** Where the first alignment connector stands, for the drag handles of the dialog (all on the cut plane, in world space). */
export interface ConnectorSpot {
  /** the middle of the connector on the cut plane */
  origin: Vec3
  /** into the part the connector goes to */
  down: Vec3
  /** the direction its size is measured along */
  across: Vec3
  /** dovetails only: where the flank starts at the plane, and the axis the flank turns about to flare out */
  flare?: { origin: Vec3; axis: Vec3 }
}
export interface SplitResult { bodies: Body[]; warning?: string; connector?: ConnectorSpot }

function bounds(mesh: TopoMesh) {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], mesh.positions[i + k]); hi[k] = Math.max(hi[k], mesh.positions[i + k])
  }
  return { lo, hi }
}
const centreOf = (m: TopoMesh): Vec3 => {
  const b = bounds(m)
  return mul3(add3(b.lo, b.hi), 0.5)
}

/** Shape tool -> welded mesh (for mesh-body booleans). */
const toTopo = (s: Sh): TopoMesh => {
  const m = tessellate(s, 0.02, 0.1)
  return weld(m.positions, m.indices)
}

/** A tool is an OCC shape; for mesh bodies it may already have been turned into a mesh. */
type Tool = Sh | TopoMesh
const isMesh = (t: Tool): t is TopoMesh => 'indices' in t && 'positions' in t

/** B-rep or mesh operand with the booleans both kinds need. */
interface Solid {
  fuse(tool: Tool, tag: string): Promise<Solid>
  cut(tool: Tool, tag: string): Promise<Solid>
  common(tool: Tool, tag: string): Promise<Solid>
  /** the part of `tool` that lies inside this solid */
  clip(tool: Sh): Promise<Tool>
  topo(): TopoMesh
  empty(): boolean
  /** disconnected solids as separate operands */
  pieces(): Promise<Solid[]>
  body(h: OpHelpers, id: string, name: string): Body
}

function brepSolid(n: NShape, fid: string): Solid {
  const named = (t: Tool, tag: string): NShape => {
    if (isMesh(t)) throw new Error('internal: a mesh tool on a B-rep')
    return { shape: t, faces: rootNames(t as unknown as AnyShape, `${fid}:${tag}`) }
  }
  const self: Solid = {
    fuse: async (t, tag) => brepSolid(boolNamed('fuse', n, named(t, tag), fid), fid),
    cut: async (t, tag) => brepSolid(boolNamed('cut', n, named(t, tag), fid), fid),
    common: async (t, tag) => brepSolid(boolNamed('common', n, named(t, tag), fid), fid),
    clip: async (tool) => tool.intersect(n.shape as unknown as AnyShape) as Sh,
    topo: () => toTopo(n.shape as Sh),
    empty: () => {
      try { return !(volumeOf(n.shape as unknown as AnyShape) > 1e-9) } catch { return true }
    },
    async pieces() {
      const solids = (n.shape as unknown as AnyShape).solids.filter((s) => volumeOf(s) > 1e-6)
      if (solids.length <= 1) return [self]
      const parent = topoOf(n.shape as unknown as AnyShape)
      const byHash = new Map<number, number[]>()
      parent.faceHashes.forEach((h, i) => (byHash.get(h) ?? byHash.set(h, []).get(h)!).push(i))
      return solids.map((s) => {
        const faces = topoOf(s).faces.map((f) => {
          const c = byHash.get(f.hashCode)
          const i = c ? (c.length > 1 ? c.shift()! : c[0]) : -1
          return i >= 0 ? n.faces[i] : [`${fid}:piece`]
        })
        return brepSolid({ shape: s as unknown as Shape, faces }, fid)
      })
    },
    body: (h, id, name) => h.sendBody(h.bodyFromShape(id, name, n.shape, n.faces)),
  }
  return self
}

function meshSolid(t: TopoMesh, crease: number): Solid {
  const op = (o: 'union' | 'subtract' | 'intersect') => async (tool: Tool) => meshSolid(await meshBoolean(o, t, [isMesh(tool) ? tool : toTopo(tool)]), crease)
  const self: Solid = {
    fuse: op('union'),
    cut: op('subtract'),
    common: op('intersect'),
    clip: (tool) => meshBoolean('intersect', toTopo(tool), [t]),
    topo: () => t,
    empty: () => t.indices.length === 0,
    async pieces() {
      const man = await toManifold(t)
      try {
        const parts = man.decompose()
        const out = parts.map((p) => ({ topo: fromManifold(p), vol: p.volume() }))
        parts.forEach((p) => p.delete())
        const keep = out.filter((p) => p.vol > 1e-6)
        return keep.length <= 1 ? [self] : keep.map((p) => meshSolid(p.topo, crease))
      } finally {
        man.delete()
      }
    },
    body: (h, id, name) => h.sendBody(h.bodyFromTopo(id, name, t, crease)),
  }
  return self
}

/** The cutter as a solid, plus the flat cut plane when the cut is flat (oriented so its normal points into the cut-off part). */
function buildCutter(c: Cutter, diag: number, centre: Vec3): { tool: Sh; flat: { origin: Vec3; normal: Vec3 } | null } {
  const L = diag * 2 + 50
  if (c.kind === 'plane') {
    const normal = unit3(c.normal)
    return { tool: halfSpace(c.origin, normal, centre, L), flat: { origin: c.origin, normal } }
  }
  if (c.kind === 'path') {
    const n = unit3(c.normal)
    const pts = c.points
    if (pts.length < 2) throw new Error('The sketch line is too short to split with')
    const dir = (a: Vec3, b: Vec3) => unit3(sub3(b, a))
    const d0 = dir(pts[0], pts[1]), dn = dir(pts[pts.length - 2], pts[pts.length - 1])
    const left = (d: Vec3) => unit3(cross3(n, d))
    const a0 = sub3(pts[0], mul3(d0, L)), an = add3(pts[pts.length - 1], mul3(dn, L))
    const poly = [a0, ...pts, an, add3(an, mul3(left(dn), L)), add3(a0, mul3(left(d0), L))]
    const tool = prism(poly.map((p) => sub3(p, mul3(n, L))), n, 2 * L)
    const straight = pts.every((p, i) => i < 2 || dot3(dir(pts[i - 1], p), d0) > 1 - 1e-7)
    const normal = left(d0)
    return { tool, flat: straight ? { origin: pts[0], normal } : null }
  }
  const parts: Sh[] = []
  for (const g of c.groups) {
    const nrm = unit3(g.plane.normal)
    const shifted = { ...g.plane, origin: sub3(g.plane.origin, mul3(nrm, L)) }
    for (const pr of g.profiles) {
      parts.push(basicFaceExtrusion(profileFace(planeOf(shifted), pr), new Vector(mul3(nrm, 2 * L))) as unknown as Sh)
    }
  }
  if (!parts.length) throw new Error('The sketch has no closed shape to split with')
  return { tool: parts.slice(1).reduce((a, b) => a.fuse(b as AnyShape) as Sh, parts[0]), flat: null }
}

/** Cross-section of a dovetail / pin in the (v, down) plane: narrow at the cut plane, wide at the tip. `lift` starts it above the plane. */
const trapezoid = (origin: Vec3, v: Vec3, down: Vec3, w0: number, w1: number, depth: number, lift: number): Vec3[] => {
  const at = (a: number, d: number): Vec3 => add3(origin, add3(mul3(v, a), mul3(down, d)))
  return [at(-w0 / 2, -lift), at(w0 / 2, -lift), at(w1 / 2, depth), at(-w1 / 2, depth)]
}

/** Pin + socket tool shapes for a flat cut. Pins grow from part A (normal side) into part B; sockets are cut from part B. */
function connectorTools(spec: ConnectorSpec, origin: Vec3, normal: Vec3, section: TopoMesh, depth: number): { pins: Sh[]; sockets: Sh[]; spot?: ConnectorSpot } {
  const { u, v, n } = planeBasis(normal)
  const down = mul3(n, -1)
  const { segs } = sectionSegments(section, origin, n)
  const pins: Sh[] = [], sockets: Sh[] = []
  let spot: ConnectorSpot | undefined
  const lift = 0.2 // the pin starts a little inside part A so the union is solid
  const clr = spec.clearance
  const at2 = (p: Vec2): Vec3 => add3(origin, add3(mul3(u, p[0]), mul3(v, p[1])))
  if (spec.type === 'dovetail') {
    const lanes = layoutLanes(segs, spec.count, spec.size * 2)
    const tan = Math.tan((spec.angle * Math.PI) / 180)
    for (const ln of lanes) {
      const o = add3(origin, mul3(v, ln.v))
      const w0 = spec.size, w1 = spec.size + 2 * depth * tan
      const len = ln.u1 - ln.u0 + 2
      const start = add3(o, mul3(u, ln.u0 - 1))
      if (!spot) {
        const mid = add3(start, mul3(u, len / 2))
        spot = { origin: mid, down, across: v, flare: { origin: add3(mid, mul3(v, w0 / 2)), axis: u } }
      }
      pins.push(prism(trapezoid(start, v, down, w0, w1, depth, lift), u, len))
      // the socket is the same shape grown by the clearance, open at both ends
      sockets.push(prism(trapezoid(start, v, down, w0 + 2 * clr, w1 + 2 * clr * (1 + tan), depth + clr, lift), u, len))
    }
    return { pins, sockets, spot }
  }
  const half = spec.size / 2 + clr
  const margin = Math.max(1, spec.size * 0.5)
  for (const p of layoutPins(segs, spec.count, half + margin)) {
    const top = add3(at2(p), mul3(n, lift))
    spot ??= { origin: at2(p), down, across: u }
    if (spec.type === 'round') {
      pins.push(makeCylinder(spec.size / 2, depth + lift, top, down) as unknown as Sh)
      sockets.push(makeCylinder(spec.size / 2 + clr, depth + lift + clr, top, down) as unknown as Sh)
    } else {
      const sq = (r: number, d: number) => {
        const corner = (a: number, b: number): Vec3 => add3(top, add3(mul3(u, a * r), mul3(v, b * r)))
        return prism([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], down, d)
      }
      pins.push(sq(spec.size / 2, depth + lift))
      sockets.push(sq(spec.size / 2 + clr, depth + lift + clr))
    }
  }
  return { pins, sockets, spot }
}

export const MAX_PARTS = 16

registerOp<SplitArgs, SplitResult>('printSplit', async (a, h) => {
  await initManifold()
  const st = getStored(a.key)
  const topo = h.getTopo(a.key)
  const bb = bounds(topo)
  const diag = Math.hypot(bb.hi[0] - bb.lo[0], bb.hi[1] - bb.lo[1], bb.hi[2] - bb.lo[2])
  const { tool, flat } = buildCutter(a.cutter, diag, centreOf(topo))
  const whole: Solid = st.kind === 'brep' ? brepSolid(h.getNamed(a.key), a.fid) : meshSolid(st.topo, st.crease)
  const inside = await whole.common(tool, 'cutA')
  const outside = await whole.cut(tool, 'cutB')
  if (inside.empty() || outside.empty()) throw new Error('The cut does not go through the body, so there is nothing to split')

  let warning: string | undefined
  let connector: ConnectorSpot | undefined
  let A = inside, B = outside
  const spec = a.connectors
  if (spec && spec.count > 0) {
    if (!flat) throw new Error('Connectors need a flat cut: use a plane or a single straight sketch line')
    // pins grow from part A into part B: the normal points from B towards A
    const origin = flat.origin
    let normal = flat.normal
    if (dot3(sub3(centreOf(A.topo()), origin), normal) < 0) normal = mul3(normal, -1)
    const bTopo = B.topo()
    let thick = 0
    for (let i = 0; i < bTopo.positions.length; i += 3) {
      thick = Math.max(thick, -dot3(sub3([bTopo.positions[i], bTopo.positions[i + 1], bTopo.positions[i + 2]], origin), normal))
    }
    const maxDepth = thick - spec.clearance - 0.8
    if (maxDepth < 0.5) throw new Error('The part behind the cut is too thin for connectors')
    let depth = spec.depth
    if (depth > maxDepth) {
      depth = maxDepth
      warning = `Connector depth reduced to ${+depth.toFixed(2)} mm so it stays inside the part`
    }
    const tools = connectorTools(spec, origin, normal, topo, depth)
    connector = tools.spot
    if (!tools.pins.length) throw new Error('No connector fits on this cut: make them smaller or the cut larger')
    if (tools.pins.length < spec.count) warning = `Only ${tools.pins.length} of ${spec.count} connectors fit${warning ? '; ' + warning : ''}`
    for (let i = 0; i < tools.pins.length; i++) {
      // dovetails run edge to edge, so trim them to the body outline
      const pin = spec.type === 'dovetail' ? await whole.clip(tools.pins[i]) : tools.pins[i]
      A = await A.fuse(pin, `pin${i}`)
      B = await B.cut(tools.sockets[i], `sock${i}`)
    }
  }

  const parts = [...(await A.pieces()), ...(await B.pieces())]
  if (parts.length > Math.min(MAX_PARTS, a.ids.length)) throw new Error(`The cut would make ${parts.length} separate parts; the most allowed is ${Math.min(MAX_PARTS, a.ids.length)}`)
  const out = parts.map((p, i) => p.body(h, a.ids[i], `${a.name} ${i + 1}`))
  return { bodies: h.sendBodies(out) as unknown as Body[], warning, connector }
})

// ---------------------------------------------------------------- hollow

export interface HollowArgs {
  id: string
  name: string
  key: string
  thickness: number
  /** drain holes: a point on the surface and the outward normal there */
  drains: { p: Vec3; n: Vec3 }[]
  diameter: number
  fid: string
}

/** Depth of a drain hole measured from the outer surface: through the wall and a little into the cavity. */
export const drainDepth = (thickness: number) => thickness * 1.5 + 0.6

registerOp<HollowArgs, Body>('printHollow', async (a, h) => {
  const w = await initManifold()
  if (!(a.thickness > 0)) throw new Error('The wall thickness must be greater than zero')
  if (a.drains.length && !(a.diameter > 0)) throw new Error('The drain hole diameter must be greater than zero')
  const st = getStored(a.key)
  const bb = bounds(h.getTopo(a.key))
  const minDim = Math.min(bb.hi[0] - bb.lo[0], bb.hi[1] - bb.lo[1], bb.hi[2] - bb.lo[2])
  if (a.thickness * 2 >= minDim * 0.999) throw new Error(`The wall must be thinner than half the smallest size of the body (${+(minDim / 2).toFixed(2)} mm)`)
  const hole = (d: { p: Vec3; n: Vec3 }): Sh => {
    const n = unit3(d.n)
    return makeCylinder(a.diameter / 2, drainDepth(a.thickness) + 1, add3(d.p, mul3(n, 1)), mul3(n, -1)) as unknown as Sh
  }
  let s: Solid
  if (st.kind === 'brep') {
    // OCC's thick-solid builder with no open face gives the inner offset solid: the cavity
    const src = h.getNamed(a.key)
    let r: NShape
    try {
      const inner = shellNamed(src, [], -a.thickness, 0.001, a.fid)
      if (!(volumeOf(inner.shape as unknown as AnyShape) > 1e-6)) throw new Error('the inside collapses')
      r = boolNamed('cut', src, inner, a.fid)
    } catch (e) {
      throw new Error(`A ${a.thickness} mm wall is not possible here (${e instanceof Error ? e.message : e})`)
    }
    s = brepSolid(r, a.fid)
    if (s.empty()) throw new Error(`A ${a.thickness} mm wall is not possible here`)
  } else {
    // mesh body: the cavity is the body eroded by the wall thickness (minkowski difference with a ball)
    const man = await toManifold(st.topo)
    const ball = w.Manifold.sphere(a.thickness, 24)
    try {
      const cavity = man.minkowskiDifference(ball)
      if (cavity.isEmpty()) { cavity.delete(); throw new Error(`A ${a.thickness} mm wall leaves no room inside; use a thinner wall`) }
      const shell = man.subtract(cavity)
      cavity.delete()
      s = meshSolid(fromManifold(shell), st.crease)
      shell.delete()
    } finally {
      ball.delete()
      man.delete()
    }
  }
  for (let i = 0; i < a.drains.length; i++) s = await s.cut(hole(a.drains[i]), `drain${i}`)
  return s.body(h, a.id, a.name)
})

// ---------------------------------------------------------------- export mesh

export interface ExportMesh { positions: Float32Array; indices: Uint32Array; /** face id per triangle, in the same numbering as the viewport mesh */ faceIds: Uint32Array }

/** Welded print mesh with a face id per triangle (B-rep faces; crease-segmented faces for mesh bodies). */
registerOp<{ keys: string[] }, ExportMesh[]>('printMeshes', (a) => {
  const out: ExportMesh[] = []
  for (const key of a.keys) {
    const st = getStored(key)
    if (st.kind === 'mesh') {
      out.push({ positions: st.topo.positions.slice(), indices: st.topo.indices.slice(), faceIds: segmentFaces(st.topo, st.crease).faceIds })
      continue
    }
    const m = tessellate(st.shape, 0.02, 0.1)
    // weld by position, keeping the face id of every triangle that survives
    const inv = 1e5
    const map = new Map<string, number>()
    const pos: number[] = []
    const remap = (i: number) => {
      const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2]
      const k = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv)
      let id = map.get(k)
      if (id === undefined) { id = pos.length / 3; map.set(k, id); pos.push(x, y, z) }
      return id
    }
    const tri: number[] = [], fid: number[] = []
    for (let t = 0; t < m.indices.length; t += 3) {
      const p = remap(m.indices[t]), q = remap(m.indices[t + 1]), r = remap(m.indices[t + 2])
      if (p !== q && q !== r && p !== r) { tri.push(p, q, r); fid.push(m.faceIds[t / 3]) }
    }
    out.push({ positions: Float32Array.from(pos), indices: Uint32Array.from(tri), faceIds: Uint32Array.from(fid) })
  }
  return out
})
