/** Area-weighted normal and middle of some triangles of a display mesh. */
import type { Body, Vec3 } from '@/kernel/types'

export function regionFrame(b: Body, set: Set<number>): { normal: Vec3; centre: Vec3 } {
  const P = b.mesh.positions, I = b.mesh.indices
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, w = 0
  for (const t of set) {
    const a = I[t * 3] * 3, bb = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3
    const ux = P[bb] - P[a], uy = P[bb + 1] - P[a + 1], uz = P[bb + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    nx += x; ny += y; nz += z
    const ar = Math.hypot(x, y, z) / 2
    cx += ((P[a] + P[bb] + P[c]) / 3) * ar; cy += ((P[a + 1] + P[bb + 1] + P[c + 1]) / 3) * ar; cz += ((P[a + 2] + P[bb + 2] + P[c + 2]) / 3) * ar
    w += ar
  }
  const l = Math.hypot(nx, ny, nz) || 1
  return { normal: [nx / l, ny / l, nz / l], centre: w ? [cx / w, cy / w, cz / w] : [0, 0, 0] }
}

/** The triangles of the given face groups of a mesh body. */
export function trisOfFaces(b: Body, faces: number[]): Set<number> {
  const want = new Set(faces)
  const out = new Set<number>()
  const ids = b.mesh.faceIds
  for (let t = 0; t < ids.length; t++) if (want.has(ids[t])) out.add(t)
  return out
}
