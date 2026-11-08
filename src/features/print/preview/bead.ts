/**
 * The shape one extruded segment is drawn with: a bead (a rounded rectangle cross-section pushed along the segment, with
 * rounded or flat ends that overlap at corners so a polyline has no gaps). The vertex shader places it from the two end
 * points, the width and the height; this only builds the unit shape in three levels of detail.
 *
 * Per vertex: `pos` = (x, y, ext): x and y are the cross-section in -1..1 (scaled by half the width / height), ext is how far the
 * vertex sticks out past its end point in units of half the width. `norm` = local normal (x, y, outward along the segment).
 * `end` = 0 at the start point, 1 at the end point.
 */

export type Detail = 'high' | 'mid' | 'low'

export interface BeadShape {
  pos: Float32Array
  norm: Float32Array
  end: Float32Array
  index: Uint16Array
}

interface V { x: number; y: number; ext: number; nx: number; ny: number; nz: number; end: number }

const sgn = (v: number) => (v < 0 ? -1 : 1)

/** Orient a triangle so it faces outward in the shader's mirrored frame (the shader maps x, y, along to a left-handed basis). */
function pushTri(vs: V[], idx: number[], a: number, b: number, c: number) {
  const phys = (v: V) => [v.x, v.y, v.end === 0 ? -v.ext : 10 + v.ext]
  const pa = phys(vs[a]), pb = phys(vs[b]), pc = phys(vs[c])
  const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]
  const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]
  const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  if (Math.hypot(cr[0], cr[1], cr[2]) < 1e-9) return // degenerate (a tip fan)
  const n = [0, 0, 0]
  for (const i of [a, b, c]) {
    const v = vs[i]
    n[0] += v.nx; n[1] += v.ny; n[2] += v.end === 0 ? -v.nz : v.nz
  }
  const facing = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] > 0
  // the shader's basis is mirrored: the outward-CCW order in the physical frame is the reverse on screen
  if (facing) idx.push(a, c, b)
  else idx.push(a, b, c)
}

function finish(vs: V[], idx: number[]): BeadShape {
  const pos = new Float32Array(vs.length * 3), norm = new Float32Array(vs.length * 3), end = new Float32Array(vs.length)
  vs.forEach((v, i) => {
    pos.set([v.x, v.y, v.ext], i * 3)
    norm.set([v.nx, v.ny, v.nz], i * 3)
    end[i] = v.end
  })
  return { pos, norm, end, index: Uint16Array.from(idx) }
}

/** Rounded bead: `ring` points around, `dome` steps per end (0 = flat extended ends). */
function smooth(ring: number, dome: number, power: number): BeadShape {
  const vs: V[] = []
  const idx: number[] = []
  const pts: { x: number; y: number; nx: number; ny: number }[] = []
  for (let i = 0; i < ring; i++) {
    const t = (i / ring) * Math.PI * 2 + (ring % 4 === 0 ? Math.PI / ring : 0)
    const c = Math.cos(t), s = Math.sin(t)
    const x = sgn(c) * Math.pow(Math.abs(c), 2 / power), y = sgn(s) * Math.pow(Math.abs(s), 2 / power)
    const gx = sgn(c) * Math.pow(Math.abs(c), 2 - 2 / power), gy = sgn(s) * Math.pow(Math.abs(s), 2 - 2 / power)
    const l = Math.hypot(gx, gy) || 1
    pts.push({ x, y, nx: gx / l, ny: gy / l })
  }
  // stations along the axis, from the start tip to the end tip: [end, ext, scale, outward normal share]
  const stations: { end: number; ext: number; scale: number; phi: number }[] = []
  const E = 0.9
  for (let k = dome; k >= 1; k--) stations.push({ end: 0, ext: Math.sin((k / dome) * (Math.PI / 2)) * E, scale: Math.cos((k / dome) * (Math.PI / 2)), phi: (k / dome) * (Math.PI / 2) })
  stations.push({ end: 0, ext: 0, scale: 1, phi: 0 })
  stations.push({ end: 1, ext: 0, scale: 1, phi: 0 })
  for (let k = 1; k <= dome; k++) stations.push({ end: 1, ext: Math.sin((k / dome) * (Math.PI / 2)) * E, scale: Math.cos((k / dome) * (Math.PI / 2)), phi: (k / dome) * (Math.PI / 2) })
  const first: number[] = []
  const count: number[] = []
  for (const st of stations) {
    first.push(vs.length)
    if (st.scale < 1e-6) {
      vs.push({ x: 0, y: 0, ext: st.ext, nx: 0, ny: 0, nz: 1, end: st.end })
      count.push(1)
    } else {
      const cp = Math.cos(st.phi), sp = Math.sin(st.phi)
      for (const p of pts) vs.push({ x: p.x * st.scale, y: p.y * st.scale, ext: st.ext, nx: p.nx * cp, ny: p.ny * cp, nz: sp, end: st.end })
      count.push(ring)
    }
  }
  for (let s = 0; s + 1 < stations.length; s++) {
    const a0 = first[s], b0 = first[s + 1]
    for (let i = 0; i < ring; i++) {
      const j = (i + 1) % ring
      const A0 = count[s] === 1 ? a0 : a0 + i, A1 = count[s] === 1 ? a0 : a0 + j
      const B0 = count[s + 1] === 1 ? b0 : b0 + i, B1 = count[s + 1] === 1 ? b0 : b0 + j
      pushTri(vs, idx, A0, A1, B1)
      pushTri(vs, idx, A0, B1, B0)
    }
  }
  return finish(vs, idx)
}

/** The plain box: flat faces, flat ends pushed out half a width so corners overlap. */
function box(): BeadShape {
  const vs: V[] = []
  const idx: number[] = []
  const E = 0.8
  const face = (nx: number, ny: number) => {
    // four corners of a side face
    const tx = -ny, ty = nx
    const base = vs.length
    for (const [e, s] of [[0, -1], [0, 1], [1, 1], [1, -1]] as const) {
      vs.push({ x: nx + tx * s, y: ny + ty * s, ext: E, nx, ny, nz: 0, end: e })
    }
    pushTri(vs, idx, base, base + 1, base + 2)
    pushTri(vs, idx, base, base + 2, base + 3)
  }
  face(1, 0); face(-1, 0); face(0, 1); face(0, -1)
  for (const e of [0, 1]) {
    const base = vs.length
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) vs.push({ x, y, ext: E, nx: 0, ny: 0, nz: 1, end: e })
    pushTri(vs, idx, base, base + 1, base + 2)
    pushTri(vs, idx, base, base + 2, base + 3)
  }
  return finish(vs, idx)
}

const cache = new Map<Detail, BeadShape>()
export function beadShape(d: Detail): BeadShape {
  let s = cache.get(d)
  if (!s) {
    s = d === 'high' ? smooth(8, 2, 4) : d === 'mid' ? smooth(6, 1, 4) : box()
    cache.set(d, s)
  }
  return s
}

/** Triangles per segment at each level of detail. */
export const trianglesPerSegment = (d: Detail) => beadShape(d).index.length / 3

/** Pick the detail from how many segments are drawn: smooth when few, a plain box when a whole big plate is in view. */
export const detailFor = (visible: number): Detail => (visible <= 40_000 ? 'high' : visible <= 250_000 ? 'mid' : 'low')
