/**
 * Edge preserving denoise for a rendered RGBA8 image: a few passes of an a-trous bilateral filter (the taps spread out
 * by 1, 2, 4 pixels) whose weights fall off with color distance, so flat noisy areas are smoothed and edges stay sharp.
 * Deterministic and independent of the GPU.
 */
export interface Pixels { width: number; height: number; data: Uint8ClampedArray | Uint8Array }

const K = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16]

/** `strength` 0..1 scales how much color difference still counts as the same surface. */
export function denoise(img: Pixels, strength = 0.5, passes = 3): Uint8ClampedArray {
  const { width: w, height: h } = img
  let src = new Float32Array(w * h * 3)
  for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) { src[j] = img.data[i] / 255; src[j + 1] = img.data[i + 1] / 255; src[j + 2] = img.data[i + 2] / 255 }
  let dst = new Float32Array(src.length)
  const s = Math.max(0.01, Math.min(1, strength))
  for (let p = 0; p < passes; p++) {
    const step = 1 << p
    // sigma shrinks with every pass: the first pass takes out most of the noise, later ones only smooth what is left
    const sigma = 0.02 + 0.22 * s / (p + 1)
    const inv = 1 / (2 * sigma * sigma)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = (y * w + x) * 3
      const r0 = src[c], g0 = src[c + 1], b0 = src[c + 2]
      let r = 0, g = 0, b = 0, ws = 0
      for (let ky = -2; ky <= 2; ky++) {
        const yy = Math.min(h - 1, Math.max(0, y + ky * step))
        for (let kx = -2; kx <= 2; kx++) {
          const xx = Math.min(w - 1, Math.max(0, x + kx * step))
          const q = (yy * w + xx) * 3
          const dr = src[q] - r0, dg = src[q + 1] - g0, db = src[q + 2] - b0
          const wt = K[kx + 2] * K[ky + 2] * Math.exp(-(dr * dr + dg * dg + db * db) * inv)
          r += src[q] * wt; g += src[q + 1] * wt; b += src[q + 2] * wt; ws += wt
        }
      }
      dst[c] = r / ws; dst[c + 1] = g / ws; dst[c + 2] = b / ws
    }
    ;[src, dst] = [dst, src]
  }
  const out = new Uint8ClampedArray(img.data.length)
  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    out[i] = Math.round(src[j] * 255); out[i + 1] = Math.round(src[j + 1] * 255); out[i + 2] = Math.round(src[j + 2] * 255)
    out[i + 3] = img.data[i + 3]
  }
  return out
}
