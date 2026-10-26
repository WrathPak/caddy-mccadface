/** Mesh builders shared by the unit tests. */
import type { TopoMesh } from './types'

/** Indexed bumpy heightfield with n x n cells (2 n^2 triangles). */
export function heightfield(n: number, size = 100): TopoMesh {
  const w = n + 1
  const positions = new Float32Array(w * w * 3)
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
    const x = (i / n) * size, y = (j / n) * size
    positions.set([x, y, 4 * Math.sin(x / 9) * Math.cos(y / 7)], (j * w + i) * 3)
  }
  const idx = new Uint32Array(n * n * 6)
  let k = 0
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * w + i, b = a + 1, c = a + w, d = c + 1
    idx.set([a, b, d, a, d, c], k)
    k += 6
  }
  return { positions, indices: idx }
}

/** The same mesh as an unindexed triangle soup. */
export function soupOf(t: TopoMesh): Float32Array {
  const s = new Float32Array(t.indices.length * 3)
  for (let i = 0; i < t.indices.length; i++) s.set(t.positions.subarray(t.indices[i] * 3, t.indices[i] * 3 + 3), i * 3)
  return s
}

