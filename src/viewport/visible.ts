/**
 * The 3D view runs edge to edge behind the glass panels, but the part a person can see is the window the panels leave open. The dock
 * publishes that window's distance from each edge of the canvas; the camera treats the window as its viewport (its centre is the centre
 * of the view, its height sets the scale), so a model framed "to fit" fits between the panels, and a point 50 mm from the origin lands
 * the same number of pixels from the middle as it would in a viewport that size.
 */
import { viewportBus } from './bus'

export interface Insets { l: number; r: number; t: number; b: number }
const ZERO: Insets = { l: 0, r: 0, t: 0, b: 0 }
let insets: Insets = ZERO

export function setInsets(next: Insets) {
  const same = next.l === insets.l && next.r === insets.r && next.t === insets.t && next.b === insets.b
  insets = next.l === 0 && next.r === 0 && next.t === 0 && next.b === 0 ? ZERO : next
  if (!same) viewportBus.emit('redraw', undefined)
}
export const getInsets = () => insets

/** The visible window inside a canvas of this size: its left / top offset and its size, in CSS pixels. */
export function visibleOf(size: { width: number; height: number }) {
  const { l, r, t, b } = insets
  const w = size.width - l - r, h = size.height - t - b
  // a window squeezed to nothing (or a canvas that has not been measured yet) means no inset
  if (!(w >= 120 && h >= 120)) return { l: 0, t: 0, w: Math.max(1, size.width), h: Math.max(1, size.height), inset: false }
  return { l, t, w, h, inset: l !== 0 || r !== 0 || t !== 0 || b !== 0 }
}

/** The height the camera's field of view is spread over, in pixels: what "pixels per world unit" is measured against. */
export const visH = (size: { width: number; height: number }) => visibleOf(size).h
