/**
 * Tileable height patterns. Each takes tile coordinates (one tile = one repeat, in both directions) and returns a height
 * between 0 (lowest) and 1 (highest). Image heightmaps sample a brightness grid the same way.
 */

export type PatternId = 'knurl' | 'diamond' | 'leather' | 'hex' | 'wood' | 'carbon' | 'scales'

export interface PatternDef {
  id: PatternId
  label: string
  help: string
  /** size of one tile along v relative to u (1 = square tiles) */
  aspect: number
  /** smallest size of a feature relative to the tile, used to choose the mesh detail */
  feature: number
  height: (u: number, v: number) => number
}

const fract = (x: number) => x - Math.floor(x)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t) }
const TAU = Math.PI * 2

/** Hash of integer lattice coordinates (with wrap) to [0,1). */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Periodic value noise with `n` cells per tile. */
function valueNoise(u: number, v: number, n: number, seed: number): number {
  const x = fract(u) * n, y = fract(v) * n
  const xi = Math.floor(x), yi = Math.floor(y)
  const fx = x - xi, fy = y - yi
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const w = (i: number, j: number) => hash2(((i % n) + n) % n, ((j % n) + n) % n, seed)
  const a = w(xi, yi), b = w(xi + 1, yi), c = w(xi, yi + 1), d = w(xi + 1, yi + 1)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/** Periodic cellular noise with `n` cells per tile: [nearest distance, second nearest distance] in cell units. */
function worley(u: number, v: number, n: number, seed: number): [number, number] {
  const x = fract(u) * n, y = fract(v) * n
  const xi = Math.floor(x), yi = Math.floor(y)
  let d1 = 9, d2 = 9
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j
      const wx = ((cx % n) + n) % n, wy = ((cy % n) + n) % n
      const px = cx + 0.15 + 0.7 * hash2(wx, wy, seed), py = cy + 0.15 + 0.7 * hash2(wx, wy, seed + 7919)
      const d = Math.hypot(px - x, py - y)
      if (d < d1) { d2 = d1; d1 = d } else if (d < d2) d2 = d
    }
  }
  return [d1, d2]
}

/** Crossed 45 degree grooves leave a field of square pyramids. */
function knurl(u: number, v: number): number {
  const a = u + v, b = u - v
  const da = Math.abs(a - Math.round(a)), db = Math.abs(b - Math.round(b))
  return clamp01(Math.min(da, db) * 2)
}

/** Raised lozenges, rows turned a quarter turn against each other, like diamond plate. */
function diamond(u: number, v: number): number {
  const x = fract(u), y = fract(v)
  let best = 0
  const lozenge = (cx: number, cy: number, rx: number, ry: number) => {
    // periodic distance to the centre
    let dx = Math.abs(x - cx), dy = Math.abs(y - cy)
    dx = Math.min(dx, 1 - dx); dy = Math.min(dy, 1 - dy)
    const d = dx / rx + dy / ry
    return smooth(1, 0.55, d) * (0.8 + 0.2 * (1 - Math.min(1, d)))
  }
  best = Math.max(best, lozenge(0.25, 0.25, 0.23, 0.12), lozenge(0.75, 0.75, 0.23, 0.12))
  best = Math.max(best, lozenge(0.75, 0.25, 0.12, 0.23), lozenge(0.25, 0.75, 0.12, 0.23))
  return clamp01(best)
}

/** Cellular leather: domed cells with creases between them and a little fine grain. */
function leather(u: number, v: number): number {
  const [d1, d2] = worley(u, v, 5, 11)
  const crease = smooth(0, 0.42, d2 - d1)
  const dome = 1 - smooth(0, 0.9, d1) * 0.25
  const grain = valueNoise(u, v, 20, 3) * 0.08
  return clamp01(crease * dome * 0.92 + grain)
}

/** Hexagonal plateaus separated by grooves (tile is one hex wide and sqrt(3) hexes tall in v). */
const SQ3 = Math.sqrt(3)
function hex(u: number, v: number): number {
  // v is in tiles of height sqrt(3) hex widths
  const x = fract(u), y = fract(v) * SQ3
  let best = 9
  for (let j = -1; j <= 2; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = i + (j % 2 !== 0 ? 0.5 : 0), cy = j * (SQ3 / 2)
      const dx = Math.abs(x - cx), dy = Math.abs(y - cy)
      // hexagon with flat sides left / right: distance in "apothem" units
      const d = Math.max(dx * 1, dx * 0.5 + dy * (SQ3 / 2))
      best = Math.min(best, d)
    }
  }
  // best runs 0 at the centre to 0.5 at the hexagon border
  return clamp01(smooth(0.5, 0.4, best) * (0.85 + 0.15 * (1 - best * 2)))
}

/** Wood grain: rings stretched along v, warped by noise, with fine pores. */
function wood(u: number, v: number): number {
  const warp = valueNoise(u, v, 3, 5) * 0.6 + valueNoise(u, v, 8, 9) * 0.12
  const ring = fract(u * 5 + warp)
  const r = Math.sin(ring * Math.PI)
  const early = smooth(0.05, 0.9, r)
  const pores = valueNoise(u * 1, v * 6, 24, 17)
  return clamp01(0.15 + 0.7 * early * (0.85 + 0.15 * pores) + 0.15 * pores * (1 - early))
}

/** Plain weave of tows that pass over and under each other (carbon fibre look). */
function carbon(u: number, v: number): number {
  const fu = fract(u * 2), fv = fract(v * 2)
  const i = Math.floor(fract(u) * 2), j = Math.floor(fract(v) * 2)
  const pu = Math.pow(Math.sin(Math.PI * fu), 0.55), pv = Math.pow(Math.sin(Math.PI * fv), 0.55)
  const zh = 0.5 + 0.5 * Math.cos(TAU * (u - 0.25) + Math.PI * j)
  const zv = 0.5 + 0.5 * Math.cos(TAU * (v - 0.25) + Math.PI * (i + 1))
  return clamp01(Math.max(pv * (0.3 + 0.7 * zh), pu * (0.3 + 0.7 * zv)))
}

/** Overlapping round scales in staggered rows, each row above the one before. */
function scales(u: number, v: number): number {
  const x = fract(u), y = fract(v)
  let best = -1, height = 0
  for (let j = -1; j <= 2; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = i + (((j % 2) + 2) % 2 ? 0.5 : 0) + 0.5 * 0 + 0.5, cy = j * 0.5
      const d = Math.hypot(x - cx, (y - cy) * 1)
      if (d < 0.5 && j > best) {
        best = j
        const edge = smooth(0.5, 0.36, d)
        height = 0.45 + 0.55 * (1 - d / 0.5) ** 0.7
        height *= edge * 0.5 + 0.5
      }
    }
  }
  return best < 0 ? 0 : clamp01(height)
}

export const PATTERNS: PatternDef[] = [
  { id: 'knurl', label: 'Knurl', help: 'Diamond knurling: a field of small square pyramids, the grip pattern on tool handles and knobs.', aspect: 1, feature: 0.25, height: knurl },
  { id: 'diamond', label: 'Diamond plate', help: 'Raised lozenges, each row turned a quarter turn against the next, like steel tread plate.', aspect: 1, feature: 0.12, height: diamond },
  { id: 'leather', label: 'Leather', help: 'Cell-like leather grain with small creases between the cells.', aspect: 1, feature: 0.1, height: leather },
  { id: 'hex', label: 'Hexagons', help: 'Raised hexagons with narrow grooves between them, like a honeycomb.', aspect: SQ3, feature: 0.08, height: hex },
  { id: 'wood', label: 'Wood grain', help: 'Long wavy grain lines with fine pores. The grain runs along the V direction.', aspect: 1, feature: 0.04, height: wood },
  { id: 'carbon', label: 'Carbon weave', help: 'Woven tows passing over and under each other, like carbon fibre cloth.', aspect: 1, feature: 0.12, height: carbon },
  { id: 'scales', label: 'Scales', help: 'Rows of rounded, overlapping scales as a surface texture (for real scale shapes use the Scales tool).', aspect: 1, feature: 0.1, height: scales },
]

export const patternById = (id: string): PatternDef => PATTERNS.find((p) => p.id === id) ?? PATTERNS[0]

/** A heightmap taken from a picture: brightness 0..1 per pixel. */
export interface HeightImage { w: number; h: number; data: Float32Array }

/** Convert RGBA pixels to brightness (transparent pixels count as the low level). */
export function heightImageOf(rgba: ArrayLike<number>, w: number, h: number, invert: boolean): HeightImage {
  const data = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const lum = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255
    const a = rgba[i * 4 + 3] / 255
    const v = lum * a
    data[i] = invert ? 1 - v : v
  }
  return { w, h, data }
}

/** Bilinear sample of an image as a pattern. `mirror` flips every other tile so the picture tiles without seams. */
export function imageHeight(img: HeightImage, mirror: boolean) {
  return (u: number, v: number): number => {
    let x = u, y = v
    if (mirror) {
      x = Math.abs(((x % 2) + 2) % 2 - 1) ; x = 1 - x
      y = Math.abs(((y % 2) + 2) % 2 - 1) ; y = 1 - y
    } else { x = fract(x); y = fract(y) }
    const fx = x * img.w - 0.5, fy = (1 - y) * img.h - 0.5
    const x0 = Math.floor(fx), y0 = Math.floor(fy)
    const tx = fx - x0, ty = fy - y0
    const at = (i: number, j: number) => img.data[((((j % img.h) + img.h) % img.h) * img.w) + (((i % img.w) + img.w) % img.w)]
    return clamp01(at(x0, y0) * (1 - tx) * (1 - ty) + at(x0 + 1, y0) * tx * (1 - ty) + at(x0, y0 + 1) * (1 - tx) * ty + at(x0 + 1, y0 + 1) * tx * ty)
  }
}
