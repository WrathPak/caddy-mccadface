/**
 * Adaptive minor / major grid shared by the 3D ground grid and the sketch grid.
 *
 * Lines sit at integer multiples of a step measured from the origin, so the grid is aligned with the origin (or the sketch
 * origin) at every zoom. A major line falls on every 10th minor line. As the view zooms by a decade the layers cross-fade:
 * the finest layer fades out, the next one becomes the minor grid and a new major layer fades in, so spacing never pops.
 */

/** Smallest comfortable minor cell on screen, in pixels (cells are between TARGET / 10 and TARGET px while they fade). */
export const GRID_TARGET_PX = 12

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

/** GLSL: `float gridStrength(vec2 p, float step, float blend)` -> 0..1, and `gridColor(strength, minor, major)`. Needs derivatives. */
export const GRID_GLSL = /* glsl */ `
float gridLine(vec2 p, float size) {
  vec2 q = p / size;
  vec2 w = fwidth(q);
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(w, vec2(1e-6));
  return 1.0 - min(min(g.x, g.y), 1.0);
}
float gridStrength(vec2 p, float step, float blend) {
  float k0 = 0.55 * (1.0 - smoothstep(0.1, 0.45, blend));
  float k1 = mix(1.0, 0.55, smoothstep(0.0, 0.5, blend));
  // the ladder: fine (fading out) < minor 0.55 < major 1.0; every layer coarser than the major stays at the major strength
  return max(max(gridLine(p, step) * k0, gridLine(p, step * 10.0) * k1), gridLine(p, step * 100.0));
}
vec3 gridColor(float k, vec3 minor, vec3 major) {
  return mix(minor, major, clamp((k - 0.3) / 0.7, 0.0, 1.0));
}
`
