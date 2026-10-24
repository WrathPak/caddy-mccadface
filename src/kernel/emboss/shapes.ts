/** Flat artwork (text, SVG, bitmaps) as polygon loops in millimetres, y up, centred on the origin. */

export type V2 = [number, number]

export interface Shape2D {
  /** closed loops; with the fill rule they describe the filled area */
  loops: V2[][]
  rule: 'NonZero' | 'EvenOdd'
}

export const bounds = (loops: V2[][]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const l of loops) for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }
}

/** Move the artwork so the middle of its bounding box is the origin. */
export function centred(s: Shape2D): Shape2D {
  const b = bounds(s.loops)
  if (!isFinite(b.w)) return s
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2
  return { rule: s.rule, loops: s.loops.map((l) => l.map(([x, y]) => [x - cx, y - cy] as V2)) }
}

/** Scale uniformly so the bounding box is `width` wide (or `height` tall when `width` is 0). */
export function fitted(s: Shape2D, width: number, height = 0): Shape2D {
  const b = bounds(s.loops)
  if (!isFinite(b.w) || b.w <= 0) return s
  const k = width > 0 ? width / b.w : height / b.h
  return { rule: s.rule, loops: s.loops.map((l) => l.map(([x, y]) => [x * k, y * k] as V2)) }
}

/** Points of a quadratic bezier after the start point. */
export function flattenQuad(p0: V2, p1: V2, p2: V2, tol: number, out: V2[]) {
  const dev = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]) / 4
  const n = Math.max(1, Math.min(48, Math.ceil(Math.sqrt(dev / tol))))
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]])
  }
}

/** Points of a cubic bezier after the start point. */
export function flattenCubic(p0: V2, p1: V2, p2: V2, p3: V2, tol: number, out: V2[]) {
  const d1 = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1])
  const d2 = Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1])
  const n = Math.max(1, Math.min(64, Math.ceil(Math.sqrt((0.75 * Math.max(d1, d2)) / tol))))
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ])
  }
}

/** Drop repeated points and the duplicated closing point of a loop. */
export function cleanLoop(l: V2[]): V2[] {
  const out: V2[] = []
  for (const p of l) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p)
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-6) out.pop()
  return out
}

/** Signed area of a loop (counter-clockwise is positive). */
export const loopArea = (l: V2[]) => {
  let a = 0
  for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1] }
  return a / 2
}

export interface Stroke { points: V2[]; closed: boolean; width: number }

/** Everything an artwork draws: filled parts (each with its own fill rule) and stroked lines. */
export interface Artwork { parts: Shape2D[]; strokes: Stroke[] }

export const artworkBounds = (a: Artwork) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of a.parts) for (const l of p.loops) for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  for (const s of a.strokes) for (const [x, y] of s.points) { x0 = Math.min(x0, x - s.width / 2); y0 = Math.min(y0, y - s.width / 2); x1 = Math.max(x1, x + s.width / 2); y1 = Math.max(y1, y + s.width / 2) }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }
}

/** Move to the origin (middle of the bounding box) and scale uniformly so the width is `width` mm (`height` when width is 0). */
export function fitArtwork(a: Artwork, width: number, height = 0): Artwork {
  const b = artworkBounds(a)
  if (!isFinite(b.w) || b.w <= 0 || b.h <= 0) return a
  const k = width > 0 ? width / b.w : height / b.h
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2
  const t = (p: V2): V2 => [(p[0] - cx) * k, (p[1] - cy) * k]
  return {
    parts: a.parts.map((p) => ({ rule: p.rule, loops: p.loops.map((l) => l.map(t)) })),
    strokes: a.strokes.map((s) => ({ points: s.points.map(t), closed: s.closed, width: s.width * k })),
  }
}
