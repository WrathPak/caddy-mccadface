/** Bitmap logos to outline loops: marching squares on the darkness (or brightness) of the image, then line simplification. */
import { loopArea, type Artwork, type V2 } from './shapes'

export interface RasterOptions {
  /** 0 to 1: the level that separates shape from background */
  threshold: number
  /** false: dark pixels are the shape (a black logo on white). true: light pixels are the shape */
  invert: boolean
  /** corner smoothing tolerance, in pixels */
  simplify: number
}

/** Foreground strength 0..1 of every pixel, with a one pixel empty border so every contour closes. */
function field(rgba: ArrayLike<number>, w: number, h: number, invert: boolean): { f: Float32Array; W: number; H: number } {
  const W = w + 2, H = h + 2
  const f = new Float32Array(W * H)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255
      const a = rgba[i + 3] / 255
      f[(y + 1) * W + x + 1] = a * (invert ? lum : 1 - lum)
    }
  }
  return { f, W, H }
}

/** Ramer-Douglas-Peucker on a closed loop. */
function simplifyLoop(pts: V2[], tol: number): V2[] {
  if (pts.length < 8 || tol <= 0) return pts
  const dist = (p: V2, a: V2, b: V2) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
    if (l2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1])
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)
  }
  const rdp = (lo: number, hi: number, keep: Uint8Array) => {
    let best = 0, at = -1
    for (let i = lo + 1; i < hi; i++) { const d = dist(pts[i], pts[lo], pts[hi]); if (d > best) { best = d; at = i } }
    if (at >= 0 && best > tol) { keep[at] = 1; rdp(lo, at, keep); rdp(at, hi, keep) }
  }
  // split the closed loop at two far apart points
  let far = 0, fd = 0
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i } }
  const keep = new Uint8Array(pts.length)
  keep[0] = 1; keep[far] = 1
  rdp(0, far, keep)
  const rest = pts.slice(far).concat([pts[0]])
  const keep2 = new Uint8Array(rest.length)
  keep2[0] = 1; keep2[rest.length - 1] = 1
  const rdp2 = (lo: number, hi: number) => {
    let best = 0, at = -1
    for (let i = lo + 1; i < hi; i++) { const d = dist(rest[i], rest[lo], rest[hi]); if (d > best) { best = d; at = i } }
    if (at >= 0 && best > tol) { keep2[at] = 1; rdp2(lo, at); rdp2(at, hi) }
  }
  rdp2(0, rest.length - 1)
  const out: V2[] = []
  for (let i = 0; i < far; i++) if (keep[i]) out.push(pts[i])
  for (let i = 0; i < rest.length - 1; i++) if (keep2[i]) out.push(rest[i])
  return out
}

export function rasterArtwork(rgba: ArrayLike<number>, w: number, h: number, o: RasterOptions): Artwork {
  if (w < 2 || h < 2 || rgba.length < w * h * 4) throw new Error('The image is empty')
  const { f, W, H } = field(rgba, w, h, o.invert)
  const t = Math.min(0.95, Math.max(0.05, o.threshold))
  // edge crossing points, keyed by edge id
  const pointOf = new Map<number, V2>()
  const hKey = (x: number, y: number) => (y * W + x) * 2
  const vKey = (x: number, y: number) => (y * W + x) * 2 + 1
  const cross = (key: number, x0: number, y0: number, x1: number, y1: number, v0: number, v1: number) => {
    if (!pointOf.has(key)) {
      const k = (t - v0) / (v1 - v0)
      pointOf.set(key, [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k])
    }
    return key
  }
  const segs: [number, number][] = []
  for (let y = 0; y + 1 < H; y++) {
    for (let x = 0; x + 1 < W; x++) {
      const tl = f[y * W + x], tr = f[y * W + x + 1], br = f[(y + 1) * W + x + 1], bl = f[(y + 1) * W + x]
      const idx = (tl >= t ? 8 : 0) | (tr >= t ? 4 : 0) | (br >= t ? 2 : 0) | (bl >= t ? 1 : 0)
      if (idx === 0 || idx === 15) continue
      const top = () => cross(hKey(x, y), x, y, x + 1, y, tl, tr)
      const bottom = () => cross(hKey(x, y + 1), x, y + 1, x + 1, y + 1, bl, br)
      const left = () => cross(vKey(x, y), x, y, x, y + 1, tl, bl)
      const right = () => cross(vKey(x + 1, y), x + 1, y, x + 1, y + 1, tr, br)
      switch (idx) {
        case 1: case 14: segs.push([left(), bottom()]); break
        case 2: case 13: segs.push([bottom(), right()]); break
        case 3: case 12: segs.push([left(), right()]); break
        case 4: case 11: segs.push([top(), right()]); break
        case 6: case 9: segs.push([top(), bottom()]); break
        case 7: case 8: segs.push([left(), top()]); break
        case 5: case 10: {
          const mid = (tl + tr + br + bl) / 4 >= t
          if ((idx === 5) === mid) { segs.push([left(), top()], [bottom(), right()]) } else { segs.push([left(), bottom()], [top(), right()]) }
          break
        }
      }
    }
  }
  const adj = new Map<number, number[]>()
  segs.forEach(([a, b], i) => { for (const k of [a, b]) { const l = adj.get(k); if (l) l.push(i); else adj.set(k, [i]) } })
  const used = new Uint8Array(segs.length)
  const loops: V2[][] = []
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue
    const pts: V2[] = []
    let seg = s
    let key = segs[s][0]
    while (seg >= 0 && !used[seg]) {
      used[seg] = 1
      pts.push(pointOf.get(key)!)
      const [a, b] = segs[seg]
      key = key === a ? b : a
      seg = (adj.get(key) ?? []).find((x) => !used[x]) ?? -1
    }
    if (pts.length >= 3) loops.push(pts)
  }
  const flipped = loops
    .map((l) => simplifyLoop(l, o.simplify))
    .filter((l) => l.length >= 3 && Math.abs(loopArea(l)) > 1.5)
    .map((l) => l.map(([x, y]) => [x - 1, -(y - 1)] as V2))
  if (!flipped.length) throw new Error('No shape was found in the image: try Invert, or change the threshold')
  return { parts: [{ loops: flipped, rule: 'EvenOdd' }], strokes: [] }
}
