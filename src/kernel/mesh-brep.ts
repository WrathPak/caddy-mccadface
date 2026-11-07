/**
 * Convert Mesh to B-rep. Prismatic: face groups that are flat become one planar face each (with holes), everything else is
 * kept as one flat face per triangle. Faceted: every triangle becomes a face. The faces are sewn into a shell and made a solid,
 * so Fillet, Shell, Hole and Press/Pull work on the result. Worker-only (OpenCascade through replicad).
 */
import { cast, getOC, makeFace, makePolygon, measureVolume, iterTopo, type AnyShape, type Face } from 'replicad'
import { registerOp } from './store'
import { segmentFaces } from './meshutil'
import { topoVolume } from './meshutil'
import { bodyFromShape } from './store'
import type { Body, TopoMesh } from './types'
import type { Shape } from './occ'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oc = () => getOC() as any

export interface MeshToBrepArgs {
  id: string
  name: string
  key: string
  mode: 'prismatic' | 'faceted'
  /** angle (deg) that separates face groups (Prismatic) */
  crease: number
  /** how far a face group may be from flat and still become a plane (mm) */
  tolerance: number
  /** most flat triangle faces the result may have */
  maxTris: number
}
export interface MeshToBrepResult { body: Body; report: { mode: string; planes: number; triangleFaces: number; faces: number; volumeError: number } }

type P3 = [number, number, number]

/** Sew faces into one solid; throws a sentence the user can act on. */
function solidFromFaces(faces: Face[], tol: number): Shape {
  const sew = new (oc().BRepBuilderAPI_Sewing)(tol, true, true, true, false)
  try {
    for (const f of faces) sew.Add((f as unknown as { wrapped: unknown }).wrapped)
    sew.Perform()
    const raw = sew.SewedShape()
    if (raw.IsNull()) throw new Error('Nothing could be sewn')
    const free = sew.NbFreeEdges()
    if (free > 0) throw new Error(`The mesh is not closed (${free} open edge${free > 1 ? 's' : ''} left after sewing): run Repair first, then convert`)
    const shells = Array.from(iterTopo(raw as never, 'shell'))
    if (shells.length !== 1) throw new Error(`The mesh has ${shells.length} separate shells: split it into bodies or run Repair > Remove first`)
    const fix = new (oc().ShapeFix_Solid)()
    try {
      const solid = cast(fix.SolidFromShell(shells[0])) as unknown as Shape
      if (!(Math.abs(measureVolume(solid as never)) > 1e-9)) throw new Error('The shell does not enclose any volume')
      return solid
    } finally { fix.delete() }
  } finally {
    sew.delete()
  }
}

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const crossP = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export function convertMeshToBrep(topo: TopoMesh, a: Omit<MeshToBrepArgs, 'id' | 'name' | 'key'>): { shape: Shape; report: MeshToBrepResult['report'] } {
  const p = topo.positions, ix = topo.indices
  const T = ix.length / 3
  const P = (v: number): P3 => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]
  const tri = (t: number): Face => makePolygon([P(ix[t * 3]), P(ix[t * 3 + 1]), P(ix[t * 3 + 2])]) as unknown as Face
  const vol = topoVolume(topo)
  if (a.mode === 'faceted') {
    if (T > a.maxTris) throw new Error(`This mesh has ${T} triangles; Faceted conversion builds one face per triangle and is limited to ${a.maxTris}. Reduce the mesh first, or use Prismatic`)
    const faces: Face[] = []
    for (let t = 0; t < T; t++) faces.push(tri(t))
    const shape = solidFromFaces(faces, 1e-4)
    const v = Math.abs(measureVolume(shape as never))
    return { shape, report: { mode: 'faceted', planes: 0, triangleFaces: T, faces: T, volumeError: Math.abs(v - Math.abs(vol)) / Math.max(Math.abs(vol), 1e-12) } }
  }
  // ---- prismatic
  const seg = segmentFaces(topo, a.crease)
  const G = seg.faceCount
  const byGroup: number[][] = Array.from({ length: G }, () => [])
  for (let t = 0; t < T; t++) byGroup[seg.faceIds[t]].push(t)
  // plane fit per group
  const planar = new Uint8Array(G)
  const plane: { n: P3; c: P3 }[] = []
  for (let g = 0; g < G; g++) {
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, w = 0
    for (const t of byGroup[g]) {
      const A = P(ix[t * 3]), B = P(ix[t * 3 + 1]), C = P(ix[t * 3 + 2])
      const n = crossP(sub(B, A), sub(C, A))
      const ar = Math.hypot(...n) / 2
      nx += n[0] / 2; ny += n[1] / 2; nz += n[2] / 2
      cx += ((A[0] + B[0] + C[0]) / 3) * ar; cy += ((A[1] + B[1] + C[1]) / 3) * ar; cz += ((A[2] + B[2] + C[2]) / 3) * ar
      w += ar
    }
    const l = Math.hypot(nx, ny, nz)
    plane.push({ n: l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 1], c: w > 0 ? [cx / w, cy / w, cz / w] : [0, 0, 0] })
    if (l < 1e-12) continue
    let ok = true
    for (const t of byGroup[g]) {
      for (let k = 0; k < 3 && ok; k++) if (Math.abs(dot(sub(P(ix[t * 3 + k]), plane[g].c), plane[g].n)) > a.tolerance) ok = false
      if (!ok) break
    }
    planar[g] = ok ? 1 : 0
  }
  // vertex -> groups, boundary edges
  const nv = p.length / 3
  const vg: Set<number>[] = Array.from({ length: nv }, () => new Set<number>())
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) vg[ix[t * 3 + k]].add(seg.faceIds[t])
  const bEdges: { a: number; b: number; ga: number; gb: number }[] = []
  const bAt: number[][] = Array.from({ length: nv }, () => [])
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const o = seg.adj[t * 3 + k]
    if (o >= 0 && seg.faceIds[o] === seg.faceIds[t]) continue
    const u = ix[t * 3 + k], v = ix[t * 3 + ((k + 1) % 3)]
    const e = bEdges.length
    bEdges.push({ a: u, b: v, ga: seg.faceIds[t], gb: o >= 0 ? seg.faceIds[o] : -1 })
    bAt[u].push(e); bAt[v].push(e)
  }
  // a vertex on a straight run between the same two flat groups can go: both faces drop it, so their edges still meet
  const removable = new Uint8Array(nv)
  // each shared edge shows up twice in bEdges (once per side): work on the distinct ones
  const uniq = new Map<number, { a: number; b: number; key: string }>()
  const uAt: number[][] = Array.from({ length: nv }, () => [])
  for (const e of bEdges) {
    const k = e.a < e.b ? e.a * nv + e.b : e.b * nv + e.a
    if (uniq.has(k)) continue
    uniq.set(k, { a: e.a, b: e.b, key: e.ga < e.gb ? e.ga + ',' + e.gb : e.gb + ',' + e.ga })
    uAt[e.a].push(k); uAt[e.b].push(k)
  }
  for (let v = 0; v < nv; v++) {
    const es = uAt[v]
    if (es.length !== 2) continue
    const [e0, e1] = es.map((k) => uniq.get(k)!)
    if (e0.key !== e1.key || e0.key.includes('-1')) continue
    if ([...vg[v]].some((g) => !planar[g])) continue
    const o0 = e0.a === v ? e0.b : e0.a, o1 = e1.a === v ? e1.b : e1.a
    const d0 = sub(P(o0), P(v)), d1 = sub(P(o1), P(v))
    const l0 = Math.hypot(...d0), l1 = Math.hypot(...d1)
    if (l0 < 1e-12 || l1 < 1e-12) continue
    const cr = Math.hypot(...crossP(d0, d1)) / (l0 * l1)
    if (dot(d0, d1) < 0 && cr < 1e-4) removable[v] = 1
  }
  // faces
  const faces: Face[] = []
  let planes = 0, triFaces = 0
  const loopsOf = (g: number): number[][] => {
    const outs = new Map<number, number[]>()
    for (const e of bEdges) if (e.ga === g) (outs.get(e.a) ?? outs.set(e.a, []).get(e.a)!).push(e.b)
    const loops: number[][] = []
    const used = new Set<string>()
    for (const [s] of outs) {
      for (const first of outs.get(s)!) {
        if (used.has(s + '>' + first)) continue
        const loop = [s]
        let cur = s, nxt = first
        for (let guard = 0; guard < 1e6; guard++) {
          used.add(cur + '>' + nxt)
          if (nxt === s) break
          loop.push(nxt)
          cur = nxt
          const cand = outs.get(cur)?.filter((q) => !used.has(cur + '>' + q))
          if (!cand?.length) { loop.length = 0; break }
          nxt = cand[0]
        }
        if (loop.length >= 3) loops.push(loop)
      }
    }
    return loops
  }
  for (let g = 0; g < G; g++) {
    if (!planar[g]) {
      for (const t of byGroup[g]) { faces.push(tri(t)); triFaces++ }
      continue
    }
    const { n, c } = plane[g]
    const proj = (v: number): P3 => { const q = P(v); const d = dot(sub(q, c), n); return [q[0] - n[0] * d, q[1] - n[1] * d, q[2] - n[2] * d] }
    const loops = loopsOf(g).map((l) => l.filter((v) => !removable[v])).filter((l) => l.length >= 3)
    if (!loops.length) { for (const t of byGroup[g]) { faces.push(tri(t)); triFaces++ }; continue }
    // signed area about the plane normal: positive loops are outlines, negative ones holes
    const ax = Math.abs(n[0]) < 0.9 ? ([1, 0, 0] as P3) : ([0, 1, 0] as P3)
    const u = crossP(n, ax); const ul = Math.hypot(...u); const U: P3 = [u[0] / ul, u[1] / ul, u[2] / ul]
    const V = crossP(n, U)
    const to2 = (v: number): [number, number] => { const q = sub(P(v), c); return [dot(q, U), dot(q, V)] }
    const area = (l: number[]) => { let s = 0; for (let i = 0; i < l.length; i++) { const A = to2(l[i]), B = to2(l[(i + 1) % l.length]); s += A[0] * B[1] - B[0] * A[1] } return s / 2 }
    const inside = (pt: [number, number], l: number[]) => {
      let ins = false
      for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
        const A = to2(l[i]), B = to2(l[j])
        if ((A[1] > pt[1]) !== (B[1] > pt[1]) && pt[0] < ((B[0] - A[0]) * (pt[1] - A[1])) / (B[1] - A[1]) + A[0]) ins = !ins
      }
      return ins
    }
    const outers = loops.filter((l) => area(l) > 0), holes = loops.filter((l) => area(l) <= 0)
    if (!outers.length) { for (const t of byGroup[g]) { faces.push(tri(t)); triFaces++ }; continue }
    const wire = (l: number[]) => (makePolygon(l.map(proj)) as unknown as { outerWire(): never }).outerWire()
    let built = true
    const made: Face[] = []
    try {
      for (const o of outers) {
        const mine = holes.filter((h) => inside(to2(h[0]), o) && (outers.length === 1 || true))
        made.push(makeFace(wire(o), mine.map(wire)))
      }
    } catch { built = false }
    if (built) { faces.push(...made); planes++ } else { for (const t of byGroup[g]) { faces.push(tri(t)); triFaces++ } }
  }
  if (triFaces > a.maxTris) throw new Error(`${triFaces} triangles sit in curved face groups and each becomes a flat face; the limit is ${a.maxTris}. Reduce the mesh first, raise the Face split angle on Insert, or use a larger Tolerance`)
  const shape = solidFromFaces(faces, Math.max(a.tolerance * 3, 1e-3))
  const v = Math.abs(measureVolume(shape as never))
  return { shape, report: { mode: 'prismatic', planes, triangleFaces: triFaces, faces: faces.length, volumeError: Math.abs(v - Math.abs(vol)) / Math.max(Math.abs(vol), 1e-12) } }
}

registerOp<MeshToBrepArgs, MeshToBrepResult>('meshToBrep', (a, h) => {
  const topo = h.getTopo(a.key)
  const { shape, report } = convertMeshToBrep(topo, a)
  if (report.volumeError > 0.02) throw new Error(`The B-rep does not match the mesh (volume off by ${(report.volumeError * 100).toFixed(1)} percent). Run Repair first or try Faceted`)
  return { body: h.sendBody(bodyFromShape(a.id, a.name, shape)), report }
})
