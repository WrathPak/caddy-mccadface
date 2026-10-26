/** Procedural textures as plain pixel arrays (deterministic, no canvas, no network). They tile seamlessly. */

export interface PixelMap { size: number; /** RGBA8 */ data: Uint8Array }

/** integer hash -> [0, 1) */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** value noise that repeats every `period` cells */
function tiledNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y)
  const fx = x - xi, fy = y - yi
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const w = (i: number) => ((i % period) + period) % period
  const a = hash2(w(xi), w(yi), seed), b = hash2(w(xi + 1), w(yi), seed)
  const c = hash2(w(xi), w(yi + 1), seed), d = hash2(w(xi + 1), w(yi + 1), seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)))

/** Oak: long grain along u with slow ring bands and fine pores. */
export function woodTexture(size = 256): PixelMap {
  const data = new Uint8Array(size * size * 4)
  const light = [0.78, 0.6, 0.38], dark = [0.45, 0.3, 0.16]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size
      // rings: a warped sine of v, the warp repeats across u so the tile wraps
      const warp = tiledNoise(u * 4, v * 8, 4, 11) * 1.6 + tiledNoise(u * 12, v * 24, 12, 23) * 0.4
      const ring = 0.5 + 0.5 * Math.sin((v * 9 + warp) * Math.PI * 2)
      const pores = tiledNoise(u * 6, v * 96, 6, 37)
      const fine = tiledNoise(u * 24, v * 192, 24, 51)
      const t = Math.min(1, Math.max(0, ring * 0.7 + (pores - 0.5) * 0.35 + (fine - 0.5) * 0.15))
      const i = (y * size + x) * 4
      for (let k = 0; k < 3; k++) data[i + k] = clamp8(255 * (dark[k] + (light[k] - dark[k]) * t))
      data[i + 3] = 255
    }
  }
  return { size, data }
}

/** Height of a 2x2 twill weave, 0..1 (tile = 4 x 4 cells of one tow each). */
function twillHeight(u: number, v: number): number {
  const cells = 8
  const cx = Math.floor(u * cells), cy = Math.floor(v * cells)
  const fx = u * cells - cx, fy = v * cells - cy
  // twill: the warp is on top where (cx + cy) % 4 is 0 or 1
  const warpOnTop = ((cx + cy) & 3) < 2
  const rise = (t: number) => Math.sin(Math.PI * t) // tow cross section
  return warpOnTop ? 0.55 + 0.45 * rise(fx) : 0.55 + 0.45 * rise(fy)
}

/** Carbon twill: a color map and a tangent-space normal map of the weave. */
export function carbonTexture(size = 256): { color: PixelMap; normal: PixelMap } {
  const color = new Uint8Array(size * size * 4)
  const normal = new Uint8Array(size * size * 4)
  const h = new Float32Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size
    h[y * size + x] = twillHeight(u, v) + (hash2(x, y, 5) - 0.5) * 0.03
  }
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)]
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4
    const hv = at(x, y)
    const dx = (at(x + 1, y) - at(x - 1, y)) * 3, dy = (at(x, y + 1) - at(x, y - 1)) * 3
    const l = Math.hypot(dx, dy, 1)
    normal[i] = clamp8((-dx / l * 0.5 + 0.5) * 255)
    normal[i + 1] = clamp8((-dy / l * 0.5 + 0.5) * 255)
    normal[i + 2] = clamp8((1 / l * 0.5 + 0.5) * 255)
    normal[i + 3] = 255
    const shade = 0.05 + 0.2 * hv
    color[i] = clamp8(255 * shade)
    color[i + 1] = clamp8(255 * shade * 1.02)
    color[i + 2] = clamp8(255 * shade * 1.1)
    color[i + 3] = 255
  }
  return { color: { size, data: color }, normal: { size, data: normal } }
}
