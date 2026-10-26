/** Render settings: the shape, the defaults and the sanitiser (pure, no store). */
import { ENVIRONMENTS } from './envmap'

export type Engine = 'auto' | 'pathtracer' | 'raster'
export type Backdrop = 'color' | 'environment'

export interface RenderSettings {
  env: string
  backdrop: Backdrop
  backdropColor: string
  /** ground plane under the model: soft shadow and a mirror image */
  shadow: boolean
  reflection: boolean
  /** 35 mm equivalent focal length, mm */
  focalMm: number
  dof: boolean
  /** aperture, f-number */
  fStop: number
  /** distance from the camera to the plane in focus, mm */
  focusDistance: number
  exposure: number
  engine: Engine
  samples: number
  denoise: boolean
  denoiseStrength: number
  width: number
  height: number
  turntable: { seconds: number; fps: number; width: number; height: number }
}

export const DEFAULT_SETTINGS: RenderSettings = {
  env: 'studio', backdrop: 'color', backdropColor: '#c9ced6', shadow: true, reflection: false,
  focalMm: 50, dof: false, fStop: 4, focusDistance: 200, exposure: 1,
  engine: 'auto', samples: 64, denoise: true, denoiseStrength: 0.5, width: 1280, height: 720,
  turntable: { seconds: 4, fps: 24, width: 640, height: 360 },
}

export const LIMITS = {
  focalMm: [14, 200], fStop: [0.7, 32], samples: [1, 4096], size: [16, 4096], seconds: [1, 30], fps: [4, 60], exposure: [0.1, 4],
} as const

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(hi, Math.max(lo, n))
}
const HEX = /^#[0-9a-f]{6}$/i

/** Sanitise stored / incoming settings: unknown fields are dropped, bad values fall back to the defaults. */
export function normalizeSettings(raw: unknown): RenderSettings {
  const d = DEFAULT_SETTINGS
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const t = (r.turntable && typeof r.turntable === 'object' ? r.turntable : {}) as Record<string, unknown>
  return {
    env: ENVIRONMENTS.some((e) => e.id === r.env) ? (r.env as string) : d.env,
    backdrop: r.backdrop === 'environment' ? 'environment' : 'color',
    backdropColor: typeof r.backdropColor === 'string' && HEX.test(r.backdropColor) ? r.backdropColor : d.backdropColor,
    shadow: typeof r.shadow === 'boolean' ? r.shadow : d.shadow,
    reflection: typeof r.reflection === 'boolean' ? r.reflection : d.reflection,
    focalMm: clamp(r.focalMm, ...LIMITS.focalMm, d.focalMm),
    dof: typeof r.dof === 'boolean' ? r.dof : d.dof,
    fStop: clamp(r.fStop, ...LIMITS.fStop, d.fStop),
    focusDistance: clamp(r.focusDistance, 1, 1e6, d.focusDistance),
    exposure: clamp(r.exposure, ...LIMITS.exposure, d.exposure),
    engine: r.engine === 'pathtracer' || r.engine === 'raster' ? r.engine : 'auto',
    samples: Math.round(clamp(r.samples, ...LIMITS.samples, d.samples)),
    denoise: typeof r.denoise === 'boolean' ? r.denoise : d.denoise,
    denoiseStrength: clamp(r.denoiseStrength, 0, 1, d.denoiseStrength),
    width: Math.round(clamp(r.width, ...LIMITS.size, d.width)),
    height: Math.round(clamp(r.height, ...LIMITS.size, d.height)),
    turntable: {
      seconds: clamp(t.seconds, ...LIMITS.seconds, d.turntable.seconds),
      fps: Math.round(clamp(t.fps, ...LIMITS.fps, d.turntable.fps)),
      width: Math.round(clamp(t.width, ...LIMITS.size, d.turntable.width)),
      height: Math.round(clamp(t.height, ...LIMITS.size, d.turntable.height)),
    },
  }
}

/** Vertical field of view (deg) of a full frame sensor (36 x 24 mm) at this focal length. */
export const fovForFocal = (focalMm: number) => (2 * Math.atan(12 / focalMm) * 180) / Math.PI

/** Settings are only written into the project once they differ from the defaults. */
export const settingsToJson = (s: RenderSettings): RenderSettings | null => (JSON.stringify(s) === JSON.stringify(DEFAULT_SETTINGS) ? null : s)
