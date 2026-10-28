/**
 * Adaptive minor / major grid shared by the 3D ground grid and the sketch grid.
 *
 * Lines sit at integer multiples of a step measured from the origin, so the grid is aligned with the origin (or the sketch
 * origin) at every zoom. A major line falls on every 10th minor line. As the view zooms by a decade the layers cross-fade:
 * the finest layer fades out, the next one becomes the minor grid and a new major layer fades in, so spacing never pops.
 */

/** Smallest comfortable minor cell on screen, in pixels (cells are between TARGET / 10 and TARGET px while they fade). */
export let GRID_TARGET_PX = 12

/** The Settings choice: how close together the grid lines are allowed to get on screen. */
export type GridDensity = 'fine' | 'normal' | 'coarse'
const DENSITY_PX: Record<GridDensity, number> = { fine: 6, normal: 12, coarse: 24 }
export function setGridDensity(d: GridDensity) {
  GRID_TARGET_PX = DENSITY_PX[d]
}

/** `step`: the finest layer's spacing (10^n); `blend` 0..1: how far this layer has faded out (0 = full strength). */
export function gridLevels(worldPerPixel: number): { step: number; blend: number } {
  const x = Math.log10(Math.max(worldPerPixel, 1e-9) * GRID_TARGET_PX)
  const f = Math.floor(x)
  return { step: Math.pow(10, f), blend: x - f }
}

/** Spacing the sketch snaps to: the finest layer while its cells are still about 8 px or more, else the next one up (8..80 px). */
export function gridSnapStep(worldPerPixel: number): number {
  const { step, blend } = gridLevels(worldPerPixel)
  return blend <= 0.18 ? step : step * 10
}

/**
 * Where the grid fades out: fully visible up to `start`, gone at `end` (distance from the camera, or depth for an orthographic
 * camera). Tied to the camera far plane, which already follows the scene size and the camera distance, so the grid is always
 * invisible before the far plane could clip it into a hard edge.
 */
export function gridFadeRange(far: number, ortho: boolean): { start: number; end: number } {
  return ortho ? { start: far * 0.5, end: far * 0.95 } : { start: far * 0.1, end: far * 0.9 }
}

/**
 * GLSL: `float gridStrength(vec2 p, float step, float blend, float fade)` -> 0..1, and `gridColor(strength, minor, major)`.
 * Needs derivatives. `fade` (0..1) is the distance fade: the finest layer follows it cubed, the next one squared and the
 * coarsest linearly, so the minor lines are gone before the major ones. Each layer also fades out by itself once its cells
 * shrink below a few pixels (per line direction, so a grazing view loses the foreshortened lines instead of smearing them
 * into moire).
 */
export const GRID_GLSL = /* glsl */ `
float gridLine(vec2 p, float size) {
  vec2 q = p / size;
  vec2 w = fwidth(q);
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(w, vec2(1e-6));
  vec2 l = 1.0 - min(g, vec2(1.0));
  vec2 vis = 1.0 - smoothstep(vec2(0.18), vec2(0.45), w);
  return max(l.x * vis.x, l.y * vis.y);
}
float gridStrength(vec2 p, float step, float blend, float fade) {
  float k0 = 0.55 * (1.0 - smoothstep(0.1, 0.45, blend)) * fade * fade * fade;
  float k1 = mix(1.0, 0.55, smoothstep(0.0, 0.5, blend)) * fade * fade;
  // the ladder: fine (fading out) < minor 0.55 < major 1.0; every layer coarser than the major stays at the major strength
  return max(max(gridLine(p, step) * k0, gridLine(p, step * 10.0) * k1), gridLine(p, step * 100.0) * fade);
}
vec3 gridColor(float k, vec3 minor, vec3 major) {
  return mix(minor, major, clamp((k - 0.3) / 0.7, 0.0, 1.0));
}
`
