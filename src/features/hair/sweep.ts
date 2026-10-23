/** Sweeps a cross-section along strand centerlines with rotation-minimising frames into closed tubes. */
import { effWidth, snappedThickness } from './sampling'
import type { HairParams, V3 } from './schema'
import type { Strand } from './strands'
import { add, cross, dot, mul, norm, perp, sub } from './vec'

export interface Tubes {
  positions: Float32Array
  indices: Uint32Array
  /** per strand: [firstVertex, vertexCount, firstIndex, indexCount] */
  ranges: Uint32Array
  strands: number
}

/** Section outline as (thickness-axis, width-axis) coefficients at scale 1. */
export function outline(P: HairParams, sides: number): [number, number][] {
  const a = snappedThickness(P) / 2, b = effWidth(P) / 2
  if (P.section === 'rect') return [[a, b], [-a, b], [-a, -b], [a, -b]]
  if (P.section === 'diamond') return [[a, 0], [0, b], [-a, 0], [0, -b]]
  return Array.from({ length: sides }, (_, k) => [a * Math.cos((2 * Math.PI * k) / sides), b * Math.sin((2 * Math.PI * k) / sides)] as [number, number])
}

export function sweepStrands(strands: Strand[], P: HairParams, sides: number): Tubes {
  const sec = outline(P, sides)
  const S = sec.length
  const pos: number[] = [], idx: number[] = [], ranges: number[] = []
  for (const st of strands) {
    // drop coincident samples
    const keep: number[] = []
    for (let k = 0; k < st.scale.length; k++) {
      const q = k * 3
      if (keep.length) {
        const l = keep[keep.length - 1] * 3
        if (Math.hypot(st.pts[q] - st.pts[l], st.pts[q + 1] - st.pts[l + 1], st.pts[q + 2] - st.pts[l + 2]) < 1e-4) continue
      }
      keep.push(k)
    }
    if (keep.length < 2) continue
    const pt = (i: number): V3 => [st.pts[keep[i] * 3], st.pts[keep[i] * 3 + 1], st.pts[keep[i] * 3 + 2]]
    const n = keep.length
    const v0 = pos.length / 3, i0 = idx.length
    let N: V3 | null = null
    for (let i = 0; i < n; i++) {
      const T = norm(sub(pt(Math.min(n - 1, i + 1)), pt(Math.max(0, i - 1))))
      if (!N) {
        N = sub(st.up, mul(T, dot(st.up, T)))
        N = norm(N).some(Boolean) && Math.hypot(...N) > 1e-3 ? norm(N) : perp(T)
      } else {
        N = sub(N, mul(T, dot(N, T)))
        N = Math.hypot(...N) > 1e-6 ? norm(N) : perp(T)
      }
      const B = cross(T, N)
      const c = pt(i), sc = st.scale[keep[i]]
      for (const [a, b] of sec) {
        const p = add(c, add(mul(N, a * sc), mul(B, b * sc)))
        pos.push(p[0], p[1], p[2])
      }
    }
    for (let i = 0; i + 1 < n; i++) {
      for (let k = 0; k < S; k++) {
        const a = v0 + i * S + k, b = v0 + i * S + ((k + 1) % S), c = a + S, d = b + S
        idx.push(a, b, d, a, d, c)
      }
    }
    for (let k = 1; k + 1 < S; k++) {
      idx.push(v0, v0 + k + 1, v0 + k) // start cap (faces back along the tangent)
      const e = v0 + (n - 1) * S
      idx.push(e, e + k, e + k + 1) // end cap
    }
    ranges.push(v0, pos.length / 3 - v0, i0, idx.length - i0)
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), ranges: new Uint32Array(ranges), strands: ranges.length / 4 }
}
