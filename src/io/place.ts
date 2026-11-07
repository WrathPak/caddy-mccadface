/** Where an inserted mesh lands: where its file put it, centred on the origin, or standing on the ground plane (z = 0) centred in X and Y. Units are millimetres per file unit. */
export type Placement = 'keep' | 'center' | 'ground'
export const UNIT_FACTOR: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }

/** The shift that puts the union of the position arrays where `place` says. */
export function placementShift(parts: ArrayLike<number>[], place: Placement): [number, number, number] {
  if (place === 'keep') return [0, 0, 0]
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) for (let i = 0; i + 2 < p.length; i += 3) for (let k = 0; k < 3; k++) { const x = p[i + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x }
  if (!Number.isFinite(lo[0])) return [0, 0, 0]
  return [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, place === 'ground' ? -lo[2] : -(lo[2] + hi[2]) / 2]
}

export function shiftAll(p: Float32Array, d: [number, number, number]) {
  if (!d[0] && !d[1] && !d[2]) return
  for (let i = 0; i + 2 < p.length; i += 3) { p[i] += d[0]; p[i + 1] += d[1]; p[i + 2] += d[2] }
}
