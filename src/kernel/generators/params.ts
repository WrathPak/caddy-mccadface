/** Parameter shapes of the surface generators (the dialogs in features/detail/generators.ts fill these). */
import type { V3 } from '../../features/hair/schema'

export interface CommonGen {
  seed: number
  /** extra empty border kept clear around the selected faces, mm */
  edgeMargin: number
  /** join the result to the body (off: the instances come out as a separate body) */
  merge: boolean
  /** printer nozzle and layer height, used to keep features printable */
  nozzle: number
  layerHeight: number
  printAware: boolean
  /** how deep the instance roots are buried in the body (mm), 0 = automatic */
  rootSink: number
}

export interface SpikeParams extends CommonGen {
  shape: 'cone' | 'tri' | 'square' | 'hex'
  height: number
  /** diameter of the base, mm */
  baseWidth: number
  /** random size difference, percent */
  sizeVar: number
  /** spikes per cm2 */
  density: number
  distribution: 'poisson' | 'grid'
  /** random lean, degrees */
  tilt: number
  direction: 'normal' | 'up'
  /** diameter of a flat tip, mm (0 keeps the point sharp) */
  tipWidth: number
}

export interface ScaleParams extends CommonGen {
  shape: 'round' | 'pointed' | 'hex' | 'shield'
  /** across the flow, mm */
  width: number
  /** along the flow, mm */
  length: number
  /** how high the free edge stands above the surface, mm */
  height: number
  /** how much each scale covers of the next one, percent of its length */
  overlap: number
  flow: 'down' | 'up' | 'custom'
  flowDir: V3
  stagger: boolean
  /** random shift of each scale, percent of its size */
  jitter: number
  sizeVar: number
}

export interface GrassParams extends CommonGen {
  height: number
  /** blade width at the root, mm */
  baseWidth: number
  /** blade thickness at the root, mm */
  thickness: number
  density: number
  distribution: 'poisson' | 'grid'
  /** total bend of a blade from root to tip, degrees */
  bend: number
  bendVar: number
  heightVar: number
  /** random tilt of the blade root, degrees */
  lean: number
  /** blades lean toward this direction (0 = every blade picks its own) */
  windStrength: number
  windDir: V3
  clumpCount: number
  /** the steepest a blade may lean from vertical, degrees (print-aware) */
  maxLean: number
  tipWidth: number
}

export interface FurParams extends CommonGen {
  variant: 'standard' | 'upFacing' | 'wall'
  length: number
  /** strand diameter at the root, mm */
  thickness: number
  density: number
  taper: number
  /** strands gathered into this many bundles per cm2 of surface (0 = none) */
  clumps: number
  clumpStrength: number
  curl: number
  /** random lean, degrees */
  spread: number
  lengthVar: number
  /** up-facing variant: how much strands follow the surface instead of standing straight up (0 to 1) */
  follow: number
  wallThickness: number
}

export type GenKind = 'fur' | 'scales' | 'spikes' | 'grass'
