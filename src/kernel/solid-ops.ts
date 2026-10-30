/** Worker ops for the primitive and advanced solid tools: cylinder, sweep, loft and shell. */
import { assembleWire, cast, getOC, isShape3D, makeCylinder, makeLine, makeThreePointArc, measureVolume, type AnyShape, type Wire, makeBezierCurve } from 'replicad'
import { registerOp } from './store'
import { boolNamed, eachInList, finalize, fuseNamed, indexer, shellNamed, type NShape } from './naming'
import { topoOf, type Shape } from './occ'
import { labelEdges, planeOf, profileWires, type ProfileGroup, type ProfileIn } from './model-ops'
import { profileIdOf, type PlaneDef, type Vec3 } from '../sketch/types'

type Sh = Shape

export interface CylinderArgs { id: string; name: string; radius: number; height: number; origin: Vec3; dir: Vec3 }
registerOp<CylinderArgs>('cylinderTool', (a, h) => {
  if (!(a.radius > 0) || !(a.height > 0)) throw new Error('Radius and height must be greater than zero')
  const cyl = makeCylinder(a.radius, a.height, a.origin, a.dir) as unknown as Sh
  // caps by the side of the axis they face, the wall is the only curved face
  const d = a.dir
  const claims = topoOf(cyl as unknown as AnyShape).faces.map((f) => {
    if (f.geomType !== 'PLANE') return [`${a.id}:side`]
    const nv = f.normalAt()
    return [`${a.id}:${nv.x * d[0] + nv.y * d[1] + nv.z * d[2] > 0 ? 'top' : 'bottom'}`]
  })
  return h.sendBody(h.bodyFromShape(a.id, a.name, cyl, finalize(cyl as unknown as AnyShape, claims, a.id)))
})

/** A world-space path segment (lines and three-point arcs). */
export type PathSeg = ({ k: 'l'; a: Vec3; b: Vec3 } | { k: 'a'; a: Vec3; m: Vec3; b: Vec3 } | { k: 'b'; a: Vec3; c1: Vec3; c2: Vec3; b: Vec3 }) & { /** the sketch entity the segment came from (names the walls swept along it) */ id?: string }

export interface SweepArgs { id: string; name: string; groups: ProfileGroup[]; path: PathSeg[] }

export function pathWire(path: PathSeg[]): Wire {
  if (!path.length) throw new Error('The sweep path is empty')
  // lines, arcs and splines each become their own exact edge (a spline piece is a true cubic Bezier curve, not a polyline)
  return assembleWire(path.map((s) => (s.k === 'l' ? makeLine(s.a, s.b) : s.k === 'b' ? makeBezierCurve([s.a, s.c1, s.c2, s.b]) : makeThreePointArc(s.a, s.m, s.b))))
}

const valid = (s: Sh) => Math.abs(measureVolume(s as never)) > 1e-9

/** One profile wire swept along the path, with persistent names: walls = profile edge label + path segment id, caps = profile id. */
function sweepNamed(wire: Wire, edgeLabels: string[], a: SweepArgs, pid: string): NShape {
  const oc = getOC() as unknown as {
    BRepOffsetAPI_MakePipeShell: new (w: unknown) => {
      SetTransitionMode(m: unknown): void; Add(w: unknown, c: boolean, k: boolean): void; Build(): void; MakeSolid(): boolean
      Shape(): never; FirstShape(): never; LastShape(): never; Generated(s: never): never; delete(): void
    }
    BRepBuilderAPI_TransitionMode: { BRepBuilderAPI_RightCorner: unknown }
  }
  const edges = wire.edges
  const mk = new oc.BRepOffsetAPI_MakePipeShell(pathWire(a.path).wrapped)
  try {
    mk.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner)
    mk.Add(wire.wrapped, false, false)
    mk.Build()
    mk.MakeSolid()
    const shape = cast(mk.Shape()) as unknown as Sh
    if (!isShape3D(shape as never)) throw new Error('Could not sweep to a 3d shape')
    const topo = topoOf(shape as unknown as AnyShape)
    const find = indexer(topo.faces, topo.faceHashes)
    const claims: string[][] = topo.faces.map(() => [])
    const f0 = find(mk.FirstShape()), f1 = find(mk.LastShape())
    if (f0 >= 0) claims[f0].push(`${a.id}:start:${pid}`)
    if (f1 >= 0) claims[f1].push(`${a.id}:end:${pid}`)
    edges.forEach((e, i) => {
      const hit: number[] = []
      eachInList(mk.Generated(e.wrapped as never) as never, (sh) => hit.push(find(sh)))
      hit.forEach((j, k) => {
        // the faces of one profile edge come back in path order: one per path segment
        const seg = hit.length === a.path.length ? a.path[k].id ?? String(k) : String(k)
        if (j >= 0) claims[j].push(`${a.id}:side:${edgeLabels[i] || 'e' + i}:${seg}`)
      })
    })
    return { shape, faces: claims }
  } finally {
    mk.delete()
  }
}

registerOp<SweepArgs>('sweepTool', (a, h) => {
  const parts: NShape[] = []
  const named = (p: NShape, tag: string): NShape => ({ shape: p.shape, faces: finalize(p.shape as unknown as AnyShape, p.faces, a.id, tag) })
  for (const g of a.groups) {
    const plane = planeOf(g.plane)
    for (const pr of g.profiles) {
      // the spine and profiles are consumed by the sweep, so build fresh wires each time
      const { outer, holes } = profileWires(plane, pr)
      const pid = profileIdOf(pr.outer) || 'p'
      let solid = named(sweepNamed(outer, labelEdges(g.plane, outer.edges, pr), a, pid), 'o')
      for (const hw of holes) {
        const cutter = named(sweepNamed(hw, labelEdges(g.plane, hw.edges, pr), a, pid), 'h')
        solid = boolNamed('cut', solid, cutter, a.id)
      }
      if (!valid(solid.shape)) throw new Error('The sweep produced no solid; check that the profile touches the path start')
      parts.push(named(solid, 'p' + parts.length))
    }
  }
  if (!parts.length) throw new Error('Nothing to sweep')
  const r = fuseNamed(parts, a.id)
  return h.sendBody(h.bodyFromShape(a.id, a.name, r.shape, r.faces))
})

export interface LoftSection { plane: PlaneDef; profile: ProfileIn }
export interface LoftArgs { id: string; name: string; sections: LoftSection[]; ruled: boolean }

/** Loft through the given wires with names: walls = first-section edge label (+ section pair when ruled), caps = first / last profile id. */
function loftNamed(wires: Wire[], labels: string[], a: LoftArgs, startId: string, endId: string): NShape {
  const oc = getOC() as unknown as {
    BRepOffsetAPI_ThruSections: new (solid: boolean, ruled: boolean, pres: number) => {
      AddWire(w: unknown): void; Build(): void; Shape(): never; FirstShape(): never; LastShape(): never; Generated(s: never): never
      SetMutableInput(b: boolean): void; delete(): void
    }
  }
  const edges = wires[0].edges
  const mk = new oc.BRepOffsetAPI_ThruSections(true, a.ruled, 1e-6)
  try {
    mk.SetMutableInput(false)
    wires.forEach((w) => mk.AddWire(w.wrapped))
    mk.Build()
    const shape = cast(mk.Shape()) as unknown as Sh
    if (!isShape3D(shape as never)) throw new Error('Could not loft to a 3d shape')
    const topo = topoOf(shape as unknown as AnyShape)
    const find = indexer(topo.faces, topo.faceHashes)
    const claims: string[][] = topo.faces.map(() => [])
    const f0 = find(mk.FirstShape()), f1 = find(mk.LastShape())
    if (f0 >= 0) claims[f0].push(`${a.id}:start:${startId}`)
    if (f1 >= 0 && f1 !== f0) claims[f1].push(`${a.id}:end:${endId}`)
    edges.forEach((e, i) => {
      const hit: number[] = []
      eachInList(mk.Generated(e.wrapped as never) as never, (sh) => hit.push(find(sh)))
      hit.forEach((j, k) => { if (j >= 0) claims[j].push(`${a.id}:side:${labels[i] || 'e' + i}${hit.length > 1 ? ':s' + k : ''}`) })
    })
    return { shape, faces: claims }
  } finally {
    mk.delete()
  }
}

registerOp<LoftArgs>('loftTool', (a, h) => {
  if (a.sections.length < 2) throw new Error('A loft needs at least two profiles')
  const sets = a.sections.map((s) => profileWires(planeOf(s.plane), s.profile))
  const first = a.sections[0], last = a.sections[a.sections.length - 1]
  const startId = profileIdOf(first.profile.outer) || 'p', endId = profileIdOf(last.profile.outer) || 'p'
  const named = (p: NShape, tag: string): NShape => ({ shape: p.shape, faces: finalize(p.shape as unknown as AnyShape, p.faces, a.id, tag) })
  const labelsOf = (w: Wire) => labelEdges(first.plane, w.edges, first.profile)
  let solid = named(loftNamed(sets.map((s) => s.outer), labelsOf(sets[0].outer), a, startId, endId), 'o')
  const holeCount = sets[0].holes.length
  if (sets.some((s) => s.holes.length !== holeCount)) throw new Error('All loft profiles must have the same number of holes')
  for (let i = 0; i < holeCount; i++) {
    const cutter = named(loftNamed(sets.map((s) => s.holes[i]), labelsOf(sets[0].holes[i]), a, startId, endId), 'h')
    solid = boolNamed('cut', solid, cutter, a.id)
  }
  if (!valid(solid.shape)) throw new Error('The loft produced no solid; check the profile order and positions')
  return h.sendBody(h.bodyFromShape(a.id, a.name, solid.shape, solid.faces))
})

export interface ShellArgs {
  id: string
  name: string
  key: string
  /** B-rep face indices to remove (positions in `topoOf(shape).faces`) */
  faces: number[]
  thickness: number
  /** 'inside' keeps the outer surface, 'outside' grows the wall outwards */
  side: 'inside' | 'outside'
  /** the feature running the op (names of the faces it creates are rooted there) */
  fid?: string
}

registerOp<ShellArgs>('shellOp', (a, h) => {
  if (!(a.thickness > 0)) throw new Error('Thickness must be greater than zero')
  const shape = h.getBrep(a.key)
  const all = topoOf(shape as unknown as AnyShape).faces
  const list = a.faces.map((i) => all[i]).filter(Boolean)
  // no faces: the whole body is hollowed into a closed solid with a sealed void
  if (list.length !== a.faces.length) throw new Error('Some of the selected faces no longer exist')
  if (a.side === 'inside') {
    const [lo, hi] = (shape as unknown as { boundingBox: { bounds: [Vec3, Vec3] } }).boundingBox.bounds
    const minDim = Math.min(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    if (a.thickness * 2 >= minDim * 0.995) throw new Error(`The thickness must be less than half the smallest dimension of the body (${+(minDim / 2).toFixed(3)} mm)`)
  }
  let out: { shape: Sh; faces: string[][] }
  try {
    // OCC offsets towards the outside for a positive value; 'inside' therefore passes -thickness
    const src = h.getNamed(a.key)
    const fid = a.fid ?? a.id
    if (!a.faces.length) {
      // nothing to open: OCC's thick solid then gives only the offset solid, so the wall is the body minus its inner offset (or the outer offset minus the body)
      if (a.side === 'inside') out = boolNamed('cut', src, shellNamed(src, [], -a.thickness, 0.001, fid), fid)
      else out = boolNamed('cut', shellNamed(src, [], a.thickness, 0.001, fid), src, fid)
    } else out = shellNamed(src, a.faces, a.side === 'inside' ? -a.thickness : a.thickness, 0.001, fid)
  } catch (e) {
    throw new Error(`A shell of ${a.thickness} mm is not possible here (${e instanceof Error ? e.message : e})`)
  }
  if (!valid(out.shape)) throw new Error(`A shell of ${a.thickness} mm is not possible here`)
  return h.sendBody(h.bodyFromShape(a.id, a.name, out.shape, out.faces))
})
