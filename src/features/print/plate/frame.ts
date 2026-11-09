/** Camera framing of the bed: an isometric view from the front left (like Orca), the bed filling most of the free window. */
import { isCompact } from '@/app/device'
import { viewportBus } from '@/viewport/bus'
import type { BedShape } from './model'

const az = (-130 * Math.PI) / 180, el = (35 * Math.PI) / 180
export const BED_DIR: [number, number, number] = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]

/** Fit the bed. The margins are what floats over the view: the top bar and toolbar, and in the preview the slider and summary card. */
export function frameBed(bed: BedShape, stage: 'prepare' | 'preview' = 'prepare') {
  const points = bed.poly.map((p) => [p[0], p[1], 0] as [number, number, number])
  const wide = window.innerWidth >= 1000
  const margin = isCompact()
    ? stage === 'preview' ? { t: 56, b: 230, r: 70 } : { t: 112, b: 70 }
    : stage === 'preview'
      // the legend (left) and the slider column (right) float over the view; the summary card is below the bed's right corner. Narrower
      // windows have the legend folded to a button and the card beside the slider
      ? window.innerWidth >= 1200 ? { t: 56, l: 250, r: 90, b: 64 } : wide ? { t: 56, l: 250, r: 90, b: 150 } : { t: 56, l: 56, r: 90, b: 150 }
      : { t: 112, b: 24 }
  // a short window cannot also show the whole height of the build volume at full size: its top at least stays clear of the bars
  const keep = !isCompact() && stage === 'prepare' && window.innerHeight <= 820 ? bed.poly.map((p) => [p[0], p[1], bed.height] as [number, number, number]) : undefined
  viewportBus.emit('frameFit', { points, keep, dir: BED_DIR, fill: 0.8, margin })
}
