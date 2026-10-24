/** Fur: short, dense, tapered strands. A preset configuration of the hair pipeline (it shares all of its sampling, styling and walls). */
import type { HairParams } from '../../features/hair/schema'
import { generateHair, type HairGen, type HairInput } from '../hair-core'
import { hairParams } from './layout'
import type { FurParams } from './params'

/** The hair parameters a fur setting stands for. `areaCm2` turns "clumps per cm2" into a bundle count. */
export function furToHair(P: FurParams, areaCm2: number): HairParams {
  const common: Partial<HairParams> = {
    length: P.length, width: P.thickness, thickness: P.thickness, section: 'round', density: P.density, densityMode: 'density',
    taper: P.taper, rootFlare: 0, curl: P.curl, jitter: P.spread, lengthVar: P.lengthVar, seed: P.seed, edgeMargin: P.edgeMargin,
    nozzle: P.nozzle, layerHeight: P.layerHeight, rootSink: P.rootSink, merge: P.merge,
    clumpCount: Math.round(P.clumps * areaCm2), clumpStrength: P.clumpStrength, waveAmp: 0, droop: 0,
  }
  if (P.variant === 'wall') {
    // horizontal strands that end in a thin printed wall: the print-ready comb look, shortened and tapered
    return hairParams({
      ...common, dirMode: 'perFace', distribution: 'rows', section: 'rect', width: Math.max(P.thickness, P.nozzle * 1.4), thickness: P.layerHeight,
      wall: true, wallMode: 'follow', wallThickness: P.wallThickness, tipOverlap: 0.6, printAware: true, snapThickness: true, lengthMode: 'toWall', jitter: Math.min(P.spread, 30),
    })
  }
  if (P.variant === 'upFacing') {
    // strands stand up from the surface (leaning only as far as `follow` allows) and need neither a wall nor support
    return hairParams({
      ...common, dirMode: 'fixed', fixedDir: [0, 0, 1], normalBlend: P.follow, distribution: 'poisson',
      wall: false, printAware: false, snapThickness: false, lengthMode: 'fixed',
    })
  }
  return hairParams({
    ...common, dirMode: 'blend', blendDistance: 2, distribution: 'poisson', wall: false, printAware: false, snapThickness: false, lengthMode: 'fixed',
  })
}

export function surfaceAreaCm2(positions: Float32Array, indices: Uint32Array): number {
  let a = 0
  for (let t = 0; t < indices.length; t += 3) {
    const i = indices[t] * 3, j = indices[t + 1] * 3, k = indices[t + 2] * 3
    const ux = positions[j] - positions[i], uy = positions[j + 1] - positions[i + 1], uz = positions[j + 2] - positions[i + 2]
    const vx = positions[k] - positions[i], vy = positions[k + 1] - positions[i + 1], vz = positions[k + 2] - positions[i + 2]
    a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  return a / 100
}

export function generateFur(P: FurParams, input: Omit<HairInput, 'p' | 'axis'>): { gen: HairGen; hair: HairParams } {
  const hair = furToHair(P, surfaceAreaCm2(input.positions, input.indices))
  return { gen: generateHair({ ...input, p: hair, axis: { o: [0, 0, 0], d: [0, 0, 1] } }), hair }
}
