/**
 * World position of bed (0,0,0): the plate moved the bodies' bounding box by some offset to put them on the bed (centred for
 * keep, row layout for arrange), so the bed origin is where the box was minus where it landed. Same answer as -offset for keep.
 */
export function bedOriginOf(original: { positions: Float32Array }[], placed: { positions: Float32Array }[]): [number, number, number] {
  const box = (list: { positions: Float32Array }[]) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const o of list) for (let i = 0; i < o.positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = o.positions[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v }
    return { lo, hi }
  }
  const a = box(original), b = box(placed)
  if (!isFinite(a.lo[0]) || !isFinite(b.lo[0])) return [0, 0, 0]
  return [(a.lo[0] + a.hi[0]) / 2 - (b.lo[0] + b.hi[0]) / 2, (a.lo[1] + a.hi[1]) / 2 - (b.lo[1] + b.hi[1]) / 2, a.lo[2] - b.lo[2]]
}
