/** Which snap point the pointer means: the nearest one, with vertices and centers winning over midpoints and face centers when close. */
import type { Vec3 } from '@/kernel/types'
import { dist } from './matrix'
import type { SnapPoint } from './snaps'
import type { SnapKind } from './types'

const WEIGHT: Record<SnapKind, number> = { vertex: 0.7, circle: 0.8, edgeMid: 0.9, face: 1 }

/** Index of the point the pointer (in the body's space) picks, and the indices of the points close enough to show as candidates. */
export function nearestSnaps(points: SnapPoint[], at: Vec3, maxNear = 14): { nearest: number; near: number[] } | null {
  if (!points.length) return null
  const scored = points.map((p, i) => ({ i, d: dist(p.pos, at) * WEIGHT[p.kind] })).sort((a, b) => a.d - b.d)
  const best = scored[0].d
  const near = scored.filter((s) => s.d <= Math.max(best * 2.5, best + 1)).slice(0, maxNear).map((s) => s.i)
  return { nearest: scored[0].i, near }
}
