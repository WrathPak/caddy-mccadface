/** Worker ops of the DETAIL workspace: emboss / engrave, surface texture, surface generators and threads. */
import * as Comlink from 'comlink'
import { getOC, measureVolume, type AnyShape, type Face } from 'replicad'
import type { Manifold } from 'manifold-3d'
import type { Mesh3 } from '../features/hair/wall'
import { buildGenSolids, generateSurface, type GenInput } from './generators/generate'
import { solidOf, topoOfManifold } from './generators/solids'
import { buildEmbossTool, type EmbossInput } from './emboss/emboss'
import { rasterArtwork } from './emboss/raster'
import { artworkBounds, fitArtwork, type Artwork } from './emboss/shapes'
import { parseSvg } from './emboss/svg'
import { textShape, type TextOptions } from './emboss/text'
import { initManifold } from './mesh'
import { boolNamed, rootNames, type NShape } from './naming'
import { tessellate, topoOf, type Shape } from './occ'
import { registerOp } from './store'
import { applyTexture, type TextureInput } from './texture/displace'
import type { HeightImage, PatternId } from './texture/patterns'
import { boreRadius, checkProfile, coreRadius, helixSolid, placeOnAxis, polarOutline, recessionFor, ringSolid, type Fit, type ThreadProfile } from './threads'
import type { Body, MeshData, TopoMesh, Vec3 } from './types'

const buffers = (m: MeshData): ArrayBuffer[] =>
  [m.positions.buffer, m.normals.buffer, m.indices.buffer, m.faceIds.buffer, m.edges.buffer, m.edgeIds?.buffer, m.faceHashes?.buffer, m.edgeHashes?.buffer].filter((b): b is ArrayBuffer => !!b)

const send = <T extends { bodies: Body[] }>(r: T) => Comlink.transfer(r, r.bodies.flatMap((b) => buffers(b.mesh)))

/** Frees every manifold / cross section registered with it. */
function scope() {
  const list: { delete(): void }[] = []
  const own = <T extends { delete(): void }>(x: T): T => (list.push(x), x)
  return { own, free: () => { for (const x of list) { try { x.delete() } catch { /* already freed */ } } } }
}

// ---------------------------------------------------------------- emboss

export type EmbossSource =
  | { source: 'text'; text: string; font: ArrayBuffer; size: number; letterSpacing: number; lineSpacing: number; align: TextOptions['align'] }
  | { source: 'svg'; svg: string; width: number }
  | { source: 'image'; rgba: Uint8ClampedArray; w: number; h: number; width: number; threshold: number; invert: boolean }

export interface EmbossOpArgs extends Omit<EmbossInput, 'art'> {
  art: EmbossSource
  mode: 'emboss' | 'engrave'
  preview: boolean
  /** final only */
  targetKey?: string
  id?: string
  name?: string
}

export function artworkOf(s: EmbossSource): { art: Artwork; notes: string[] } {
  if (s.source === 'text') {
    if (!s.text.trim()) throw new Error('Type the text to emboss')
    const t = textShape(s.font, s.text, { size: s.size, letterSpacing: s.letterSpacing, lineSpacing: s.lineSpacing, align: s.align })
    const notes = t.missing.length ? [`The font has no ${t.missing.map((c) => `"${c}"`).join(', ')}; ${t.missing.length === 1 ? 'it was' : 'they were'} left out`] : []
    if (!t.shape.loops.length) throw new Error('This text has no visible letters in the chosen font')
    return { art: { parts: [t.shape], strokes: [] }, notes }
  }
  if (s.source === 'svg') return { art: fitArtwork(parseSvg(s.svg), s.width), notes: [] }
  return { art: fitArtwork(rasterArtwork(s.rgba, s.w, s.h, { threshold: s.threshold, invert: s.invert, simplify: 0.7 }), s.width), notes: [] }
}

export interface EmbossPreview { mesh: TopoMesh; warnings: string[]; point: Vec3; normal: Vec3; wrapped: 'project' | 'cylinder'; width: number; height: number }

registerOp<EmbossOpArgs>('embossFace', async (a, h) => {
  const W = await initManifold()
  const { own, free } = scope()
  try {
    const { art, notes } = artworkOf(a.art)
    const t = buildEmbossTool(W, { ...a, art, sink: a.sink }, own)
    const warnings = [...notes, ...t.warnings]
    if (a.preview) {
      // size of the artwork itself (before it is turned or laid on the surface), for the handle in the viewport
      const ab = artworkBounds(art)
      const mesh = topoOfManifold(t.tool)
      const out: EmbossPreview = { mesh, warnings, point: t.point, normal: t.normal, wrapped: t.wrapped, width: ab.w + 2 * a.weight, height: ab.h + 2 * a.weight }
      return Comlink.transfer(out, [mesh.positions.buffer, mesh.indices.buffer] as ArrayBuffer[])
    }
    const target = solidOf(W, h.getTopo(a.targetKey!), 'The target body', own)
    const res = own(a.mode === 'emboss' ? target.add(t.tool) : target.subtract(t.tool))
    if (res.status() !== 'NoError' || res.isEmpty()) throw new Error('The result is not a valid solid; try a different depth or position')
    if (a.mode === 'engrave' && Math.abs(res.volume() - target.volume()) < 1e-6) warnings.push('The engraving did not cut into the body; check that it sits on the surface')
    const body = h.bodyFromTopo(a.id!, a.name!, topoOfManifold(res))
    return send({ bodies: [body], warnings })
  } finally {
    free()
  }
})

// ---------------------------------------------------------------- texture

export interface TextureOpArgs extends Omit<TextureInput, 'positions' | 'indices' | 'region' | 'pattern'> {
  pattern: { id: PatternId } | { image: HeightImage; mirror: boolean }
  key: string
  kind: 'brep' | 'mesh'
  /** B-rep face ids, or mesh triangle ids */
  region: number[]
  preview: boolean
  id?: string
  name?: string
}

/** Welded triangle mesh with the tag of every surviving triangle (the same welding as meshutil.weld, which drops degenerate triangles). */
function weldTagged(positions: ArrayLike<number>, indices: ArrayLike<number>, tags: ArrayLike<number>): { mesh: TopoMesh; tags: Uint32Array } {
  const inv = 1e5
  const map = new Map<string, number>()
  const out: number[] = []
  const remap = (i: number) => {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    const k = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv)
    let id = map.get(k)
    if (id === undefined) { id = out.length / 3; map.set(k, id); out.push(x, y, z) }
    return id
  }
  const tri: number[] = [], tg: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap(indices[t]), b = remap(indices[t + 1]), c = remap(indices[t + 2])
    if (a !== b && b !== c && a !== c) { tri.push(a, b, c); tg.push(tags[t / 3]) }
  }
  return { mesh: { positions: new Float32Array(out), indices: new Uint32Array(tri) }, tags: Uint32Array.from(tg) }
}

export interface TexturePreview { mesh: TopoMesh; region: Uint8Array; stats: ReturnType<typeof applyTexture>['stats']; warnings: string[] }

const PREVIEW_TRIS = 70_000

registerOp<TextureOpArgs>('textureFace', async (a, h) => {
  const W = await initManifold()
  const { own, free } = scope()
  try {
    let mesh: TopoMesh
    const region = new Set(a.region)
    let flags: Uint8Array
    if (a.kind === 'brep') {
      const shape = h.getBrep(a.key)
      const m = tessellate(shape as unknown as Shape, 0.02, 0.1)
      const w = weldTagged(m.positions, m.indices, m.faceIds)
      mesh = w.mesh
      flags = new Uint8Array(w.tags.length)
      for (let t = 0; t < flags.length; t++) flags[t] = region.has(w.tags[t]) ? 1 : 0
    } else {
      mesh = h.getTopo(a.key)
      flags = new Uint8Array(mesh.indices.length / 3)
      for (const t of region) if (t < flags.length) flags[t] = 1
    }
    const input: TextureInput = { ...a, positions: mesh.positions, indices: mesh.indices, region: flags }
    // a preview works on a coarse version of the model, the final result at the requested detail
    if (a.preview) { input.maxTris = Math.min(a.maxTris, PREVIEW_TRIS); input.coarsen = 2 }
    const r = applyTexture(input)
    const check = solidOf(W, r.mesh, 'The textured model', own)
    if (check.genus() < 0) throw new Error('The textured model is not valid')
    if (a.preview) {
      const out: TexturePreview = { mesh: r.mesh, region: r.region, stats: r.stats, warnings: r.warnings }
      return Comlink.transfer(out, [r.mesh.positions.buffer, r.mesh.indices.buffer, r.region.buffer] as ArrayBuffer[])
    }
    const body = h.bodyFromTopo(a.id!, a.name!, r.mesh)
    return send({ bodies: [body], warnings: r.warnings })
  } finally {
    free()
  }
})

// ---------------------------------------------------------------- generators

export interface GenOpArgs extends GenInput {
  mode: 'preview' | 'final'
  targetKey?: string
  ids?: { target: string; targetName: string; hair: string; wall: string }
  wallSeparate?: boolean
}

export interface GenPreview {
  positions: Float32Array
  indices: Uint32Array
  wall: Mesh3 | null
  stats: ReturnType<typeof generateSurface>['stats'] & { triangles: number; ms: number }
}

registerOp<GenOpArgs>('surfaceGenerate', async (a, h) => {
  const t0 = performance.now()
  const g = generateSurface({ ...a, sides: a.mode === 'final' ? 8 : 6 })
  if (a.mode === 'preview') {
    const out: GenPreview = {
      positions: g.set.positions, indices: g.set.indices, wall: g.wall,
      stats: { ...g.stats, triangles: (g.set.indices.length + (g.wall?.indices.length ?? 0)) / 3, ms: Math.round(performance.now() - t0) },
    }
    const bufs = [out.positions.buffer, out.indices.buffer, g.wall?.positions.buffer, g.wall?.indices.buffer]
    return Comlink.transfer(out, bufs.filter((b): b is ArrayBuffer => !!b))
  }
  const W = await initManifold()
  const { own, free } = scope()
  try {
    const ids = a.ids!
    const target = g.merge && a.targetKey ? h.getTopo(a.targetKey) : null
    const s = buildGenSolids(W, g, target, own as (m: Manifold) => Manifold)
    const bodyOf = (m: Manifold, id: string, name: string) => h.bodyFromTopo(id, name, topoOfManifold(m))
    const out: Body[] = []
    const label = ({ fur: 'Fur', scales: 'Scales', spikes: 'Spikes', grass: 'Grass' } as const)[a.kind]
    if (s.merged) out.push(bodyOf(s.merged, ids.target, ids.targetName))
    else out.push(bodyOf(s.wall && !a.wallSeparate ? own(W.Manifold.union([s.hair, s.wall])) : s.hair, ids.hair, label))
    if (s.wall && a.wallSeparate) out.push(bodyOf(s.wall, ids.wall, 'Sacrificial wall'))
    return send({ bodies: out, warnings: s.badTubes ? [`${s.badTubes} pieces were not valid solids and were left out`] : [] })
  } finally {
    free()
  }
})

// ---------------------------------------------------------------- threads

export interface ThreadOpArgs {
  id: string
  name: string
  key: string
  /** topology index of the cylindrical face */
  face: number
  kind: 'auto' | 'external' | 'internal'
  profile: ThreadProfile
  /** total gap between a bolt thread and a nut thread, mm */
  clearance: number
  /** length of the threaded stretch (0 = the whole face) */
  length: number
  fromEnd: 'start' | 'end'
  leftHand: boolean
  /** who gets the clearance: this part in full (default for the dialog), the bolt or the nut only, or half each */
  fit?: Fit
  /** preview only: build just this many turns */
  previewTurns?: number
}

export interface CylinderOfFace { origin: Vec3; dir: Vec3; radius: number; v0: number; v1: number; external: boolean; fullTurn: boolean }

/** Axis, radius, axial extent and facing of a cylindrical face of a B-rep. */
export function cylinderOfFace(shape: AnyShape, faceIndex: number): CylinderOfFace {
  const face: Face = shape.faces[faceIndex]
  if (!face) throw new Error('The selected face no longer exists')
  if (face.geomType !== 'CYLINDRE') throw new Error('Select a cylindrical face (a round shaft or a round hole)')
  const oc = getOC() as unknown as { BRepAdaptor_Surface: new (f: unknown, r: boolean) => AdaptorSurface }
  interface Pt { X(): number; Y(): number; Z(): number; delete(): void }
  interface AdaptorSurface {
    Cylinder(): { Axis(): { Location(): Pt; Direction(): Pt; delete(): void }; Radius(): number; delete(): void }
    FirstUParameter(): number; LastUParameter(): number; FirstVParameter(): number; LastVParameter(): number; delete(): void
  }
  const surf = new oc.BRepAdaptor_Surface(face.wrapped, true)
  try {
    const cyl = surf.Cylinder()
    const ax = cyl.Axis()
    const loc = ax.Location(), dir = ax.Direction()
    const origin: Vec3 = [loc.X(), loc.Y(), loc.Z()]
    let d: Vec3 = [dir.X(), dir.Y(), dir.Z()]
    const radius = cyl.Radius()
    loc.delete(); dir.delete(); ax.delete(); cyl.delete()
    const l = Math.hypot(...d)
    d = [d[0] / l, d[1] / l, d[2] / l]
    const v0 = surf.FirstVParameter(), v1 = surf.LastVParameter()
    // does the face go all the way round? (the angular gaps between its tessellation vertices tell)
    const verts = (face as unknown as Shape).mesh({ tolerance: 0.05, angularTolerance: 0.3 }).vertices
    const ref: Vec3 = Math.abs(d[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]
    const e1: Vec3 = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]]
    const e1l = Math.hypot(...e1)
    const u1: Vec3 = [e1[0] / e1l, e1[1] / e1l, e1[2] / e1l]
    const u2: Vec3 = [d[1] * u1[2] - d[2] * u1[1], d[2] * u1[0] - d[0] * u1[2], d[0] * u1[1] - d[1] * u1[0]]
    const angles: number[] = []
    for (let i = 0; i < verts.length; i += 3) {
      const q: Vec3 = [verts[i] - origin[0], verts[i + 1] - origin[1], verts[i + 2] - origin[2]]
      angles.push(Math.atan2(q[0] * u2[0] + q[1] * u2[1] + q[2] * u2[2], q[0] * u1[0] + q[1] * u1[1] + q[2] * u1[2]))
    }
    angles.sort((a, b) => a - b)
    let gap = angles.length ? angles[0] + 2 * Math.PI - angles[angles.length - 1] : 2 * Math.PI
    for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1])
    const fullTurn = gap < 0.9
    // facing: does the face normal point away from the axis (a shaft) or toward it (a hole)?
    const e: Vec3 = Math.abs(d[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]
    const k: Vec3 = [d[1] * e[2] - d[2] * e[1], d[2] * e[0] - d[0] * e[2], d[0] * e[1] - d[1] * e[0]]
    const kl = Math.hypot(...k)
    const rad: Vec3 = [k[0] / kl, k[1] / kl, k[2] / kl]
    const vm = (v0 + v1) / 2
    const p: Vec3 = [origin[0] + d[0] * vm + rad[0] * radius, origin[1] + d[1] * vm + rad[1] * radius, origin[2] + d[2] * vm + rad[2] * radius]
    const n = face.normalAt(p)
    const external = n.x * rad[0] + n.y * rad[1] + n.z * rad[2] > 0
    return { origin, dir: d, radius, v0, v1, external, fullTurn }
  } finally {
    surf.delete()
  }
}

/** What the dialog needs to know about the face before it picks a size: radius, facing and extent. */
registerOp<{ key: string; face: number }, CylinderOfFace>('threadInfo', (a, h) => cylinderOfFace(h.getBrep(a.key) as unknown as AnyShape, a.face))

/** Column-major matrix taking +Z to `dir` and the origin to `o`. */
function axisMatrix(o: Vec3, dir: Vec3): number[] {
  const l = Math.hypot(...dir)
  const z: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l]
  const ref: Vec3 = Math.abs(z[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]
  const x0: Vec3 = [z[1] * ref[2] - z[2] * ref[1], z[2] * ref[0] - z[0] * ref[2], z[0] * ref[1] - z[1] * ref[0]]
  const xl = Math.hypot(...x0)
  const x: Vec3 = [x0[0] / xl, x0[1] / xl, x0[2] / xl]
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  return [...x, 0, ...y, 0, ...z, 0, ...o, 1]
}

/**
 * The same thread as a mesh, built with manifold in milliseconds (the profile outline is twist-extruded about the axis): used for
 * the live preview. The B-rep thread of `threadFace` is built only when the dialog is accepted.
 */
registerOp<ThreadOpArgs>('threadPreview', async (a, h) => {
  const err = checkProfile(a.profile)
  if (err) throw new Error(err)
  const W = await initManifold()
  const { own, free } = scope()
  try {
    const shape = h.getBrep(a.key) as unknown as AnyShape
    const cyl = cylinderOfFace(shape, a.face)
    if (!cyl.fullTurn) throw new Error('A thread needs a full round face; this face is only part of a cylinder')
    const kind = a.kind === 'auto' ? (cyl.external ? 'external' : 'internal') : a.kind
    if ((kind === 'external') !== cyl.external) throw new Error(cyl.external ? 'This is a shaft, so it can only get an external thread' : 'This is a hole, so it can only get an internal thread')
    const span = cyl.v1 - cyl.v0
    const length = a.length > 0 ? Math.min(a.length, span) : span
    if (!(length > a.profile.pitch * 0.5)) throw new Error(`The threaded stretch (${length.toFixed(2)} mm) is shorter than half a pitch; use a longer face or a smaller pitch`)
    const build = { kind, radius: cyl.radius, profile: a.profile, clearance: 2 * recessionFor(a.fit ?? 'split', kind, Math.max(0, a.clearance)), length, leftHand: a.leftHand } as const
    const fromEnd = a.fromEnd === 'end'
    const at = (v: number): Vec3 => [cyl.origin[0] + cyl.dir[0] * v, cyl.origin[1] + cyl.dir[1] * v, cyl.origin[2] + cyl.dir[2] * v]
    const mat = axisMatrix(at(fromEnd ? cyl.v1 : cyl.v0), fromEnd ? [-cyl.dir[0], -cyl.dir[1], -cyl.dir[2]] : cyl.dir)
    const place = (m: Manifold) => own(m.transform(mat as never))
    const body = solidOf(W, h.getTopo(a.key), 'The body', own)
    const twist = (a.leftHand ? -1 : 1) * (360 * length) / a.profile.pitch
    const div = Math.max(8, Math.ceil((length / a.profile.pitch) * 10))
    const outline = polarOutline(build, 144)
    const disc = (r: number, n = 96) => Array.from({ length: n }, (_, k) => [r * Math.cos((2 * Math.PI * k) / n), r * Math.sin((2 * Math.PI * k) / n)] as [number, number])
    const cyls = (r: number) => own(W.Manifold.cylinder(length, r, r, 64))
    let res: Manifold
    if (kind === 'external') {
      const core = coreRadius(build)
      const rod = own(own(W.CrossSection.ofPolygons([outline], 'NonZero')).extrude(length, div, twist))
      const turned = own(body.subtract(place(own(cyls(cyl.radius + 1.5).subtract(cyls(core))))))
      res = own(turned.add(place(rod)))
    } else {
      const tube = own(own(W.CrossSection.ofPolygons([disc(cyl.radius + build.clearance / 2 + 0.3), outline], 'EvenOdd')).extrude(length, div, twist))
      const opened = own(body.subtract(place(cyls(cyl.radius + build.clearance / 2))))
      res = own(opened.add(place(tube)))
    }
    if (res.status() !== 'NoError' || res.isEmpty()) throw new Error('The thread preview could not be built on this face')
    const mesh = topoOfManifold(res)
    return Comlink.transfer(mesh, [mesh.positions.buffer, mesh.indices.buffer] as ArrayBuffer[])
  } finally {
    free()
  }
})
/**
 * Where the tooth sits on the start angle (fraction of a turn), tried in turn. A nut and a bolt mesh whatever their phases (the nut is simply
 * turned), but the OCC boolean of a helix against the flat ends of a face quietly does nothing for some of them.
 */
const PHASES = [0, 0.37, 0.12, 0.62, 0.87, 0.5, 0.25, 0.75]

registerOp<ThreadOpArgs>('threadFace', (a, h) => {
  const err = checkProfile(a.profile)
  if (err) throw new Error(err)
  const named = h.getNamed(a.key)
  const cyl = cylinderOfFace(named.shape as unknown as AnyShape, a.face)
  if (!cyl.fullTurn) throw new Error('A thread needs a full round face; this face is only part of a cylinder')
  const kind = a.kind === 'auto' ? (cyl.external ? 'external' : 'internal') : a.kind
  if (a.kind !== 'auto' && (kind === 'external') !== cyl.external) {
    throw new Error(cyl.external ? 'This is a shaft, so it can only get an external thread' : 'This is a hole, so it can only get an internal thread')
  }
  const span = cyl.v1 - cyl.v0
  let length = a.length > 0 ? Math.min(a.length, span) : span
  // a preview only builds the first turns: the full thread is the same sweep, just longer
  if (a.previewTurns && a.previewTurns > 0) length = Math.min(length, a.previewTurns * a.profile.pitch)
  if (!(length > a.profile.pitch * 0.5)) throw new Error(`The threaded stretch (${length.toFixed(2)} mm) is shorter than half a pitch; use a longer face or a smaller pitch`)
  const base = { kind, radius: cyl.radius, profile: a.profile, clearance: 2 * recessionFor(a.fit ?? 'split', kind, Math.max(0, a.clearance)), length, leftHand: a.leftHand } as const
  // the thread starts at the chosen end of the face and runs along the axis
  const fromEnd = a.fromEnd === 'end'
  const at = (v: number): Vec3 => [cyl.origin[0] + cyl.dir[0] * v, cyl.origin[1] + cyl.dir[1] * v, cyl.origin[2] + cyl.dir[2] * v]
  const o = at(fromEnd ? cyl.v1 : cyl.v0)
  const d: Vec3 = fromEnd ? [-cyl.dir[0], -cyl.dir[1], -cyl.dir[2]] : cyl.dir
  const tool = (s: AnyShape): NShape => {
    const placed = placeOnAxis(s, o, d) as unknown as Shape
    return { shape: placed, faces: rootNames(placed as unknown as AnyShape, a.id + ':thread') }
  }
  const volume = (s: NShape) => Math.abs(measureVolume(s.shape as never))
  const v0 = volume(named)
  if (kind === 'external' && coreRadius(base) < 0.3) throw new Error('The thread is too deep for this shaft; use a smaller pitch or a larger diameter')

  /** One try at a given phase of the helix; null when the boolean quietly did nothing (it does for some phases of a helix against flat ends). */
  const attempt = (phase: number): NShape | null => {
    const build = { ...base, phase }
    if (kind === 'external') {
      // turn the shaft down to the root of the thread, then grow the tooth on it
      const turned = boolNamed('cut', named, tool(ringSolid(coreRadius(build), cyl.radius + 1.5, length)), a.id)
      const toothShape = tool(helixSolid(build, true))
      const tooth = volume(toothShape)
      const grown = boolNamed('fuse', turned, toothShape, a.id)
      return volume(grown) > volume(turned) + 0.15 * tooth ? grown : null
    }
    // close the hole in to the crest of the nut thread, then cut the groove outward into the wall
    const closed = boolNamed('fuse', named, tool(ringSolid(boreRadius(build), cyl.radius + 0.6, length)), a.id)
    const grooveShape = tool(helixSolid(build, true))
    const groove = volume(grooveShape)
    const cut = boolNamed('cut', closed, grooveShape, a.id)
    return volume(cut) < volume(closed) - 0.1 * groove ? cut : null
  }
  let body: NShape | null = null
  for (const phase of PHASES) { body = attempt(phase); if (body) break }
  if (!body) throw new Error('The thread could not be built on this face. Try a different pitch or depth, or a longer or wider face')
  const v1 = volume(body)
  if (kind === 'external' ? !(v1 < v0 * 1.0001 && v1 > v0 * 0.3) : !(v1 > v0 * 0.8 && v1 < v0 * 3)) {
    throw new Error('The thread could not be built on this face. Try a different pitch or depth, or a longer or wider face')
  }  return h.sendBody(h.bodyFromShape(a.id, a.name, body.shape, body.faces))
})