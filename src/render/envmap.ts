/**
 * Studio environments, generated in code as equirectangular HDR pixels (linear RGB floats, +Y up, laid out the way
 * three.js samples equirect maps). A little gradient for the room plus soft light panels.
 */
export type EnvId = 'studio' | 'overcast' | 'sunset' | 'gallery' | 'highkey'

type V3 = [number, number, number]
interface Panel { dir: V3; /** angular radius, rad */ size: number; /** edge softness, rad */ soft: number; color: V3; power: number }
interface EnvDef {
  id: EnvId
  label: string
  /** sky color at the zenith, horizon and nadir (linear) */
  top: V3; horizon: V3; bottom: V3
  panels: Panel[]
  /** direction (Y up) and strength of the light that casts the raster shadow */
  key: { dir: V3; intensity: number }
}

const norm = (v: V3): V3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l] }

export const ENVIRONMENTS: EnvDef[] = [
  {
    id: 'studio', label: 'Studio softbox', top: [0.1, 0.1, 0.11], horizon: [0.06, 0.06, 0.07], bottom: [0.03, 0.03, 0.035],
    panels: [
      { dir: norm([-0.6, 0.8, 0.55]), size: 0.5, soft: 0.25, color: [1, 0.97, 0.92], power: 9 },
      { dir: norm([0.9, 0.25, 0.4]), size: 0.35, soft: 0.3, color: [0.9, 0.95, 1], power: 3.5 },
      { dir: norm([0.1, 0.5, -1]), size: 0.3, soft: 0.2, color: [1, 1, 1], power: 6 },
    ],
    key: { dir: norm([-0.6, 0.8, 0.55]), intensity: 2.2 },
  },
  {
    id: 'overcast', label: 'Overcast sky', top: [1.1, 1.15, 1.25], horizon: [0.75, 0.78, 0.82], bottom: [0.18, 0.18, 0.17],
    panels: [], key: { dir: norm([0.2, 1, 0.3]), intensity: 0.9 },
  },
  {
    id: 'sunset', label: 'Warm sunset', top: [0.12, 0.18, 0.36], horizon: [0.95, 0.5, 0.25], bottom: [0.08, 0.06, 0.06],
    panels: [{ dir: norm([0.7, 0.18, -0.7]), size: 0.09, soft: 0.12, color: [1, 0.72, 0.42], power: 70 }],
    key: { dir: norm([0.7, 0.18, -0.7]), intensity: 3.4 },
  },
  {
    id: 'gallery', label: 'Dark gallery', top: [0.015, 0.015, 0.02], horizon: [0.01, 0.01, 0.012], bottom: [0.005, 0.005, 0.006],
    panels: [
      { dir: norm([-0.8, 0.6, 0.2]), size: 0.18, soft: 0.1, color: [1, 0.95, 0.85], power: 22 },
      { dir: norm([0.8, 0.6, -0.2]), size: 0.18, soft: 0.1, color: [0.85, 0.92, 1], power: 22 },
    ],
    key: { dir: norm([-0.8, 0.6, 0.2]), intensity: 2.4 },
  },
  {
    id: 'highkey', label: 'High key white', top: [1.5, 1.5, 1.5], horizon: [1.25, 1.25, 1.25], bottom: [0.9, 0.9, 0.9],
    panels: [{ dir: norm([0, 1, 0.1]), size: 0.9, soft: 0.5, color: [1, 1, 1], power: 3 }], key: { dir: norm([-0.3, 1, 0.4]), intensity: 1.2 },
  },
]

export const envById = (id: string): EnvDef => ENVIRONMENTS.find((e) => e.id === id) ?? ENVIRONMENTS[0]

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** Radiance seen along a unit direction (Y up). */
export function envRadiance(env: EnvDef, d: V3): V3 {
  const t = d[1]
  const k = t >= 0 ? Math.pow(t, 0.6) : Math.pow(-t, 0.6)
  const from = t >= 0 ? env.horizon : env.horizon, to = t >= 0 ? env.top : env.bottom
  let r = from[0] + (to[0] - from[0]) * k, g = from[1] + (to[1] - from[1]) * k, b = from[2] + (to[2] - from[2]) * k
  for (const p of env.panels) {
    const ang = Math.acos(Math.min(1, Math.max(-1, d[0] * p.dir[0] + d[1] * p.dir[1] + d[2] * p.dir[2])))
    const f = 1 - smooth(p.size - p.soft, p.size + p.soft, ang)
    if (f > 0) { r += p.color[0] * p.power * f; g += p.color[1] * p.power * f; b += p.color[2] * p.power * f }
  }
  return [r, g, b]
}

/** `width` x `height` RGBA float pixels of the environment. */
export function envPixels(id: string, width = 256, height = 128): Float32Array {
  const env = envById(id)
  const out = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    // row 0 is the bottom of a DataTexture (v = 0), so theta runs from the nadir up
    const theta = (1 - (y + 0.5) / height) * Math.PI
    for (let x = 0; x < width; x++) {
      const phi = ((x + 0.5) / width) * Math.PI * 2 - Math.PI
      // three.js equirect: u = atan2(dir.z, dir.x) / 2pi + 0.5
      const d: V3 = [Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)]
      const c = envRadiance(env, d)
      const i = (y * width + x) * 4
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 1
    }
  }
  return out
}
