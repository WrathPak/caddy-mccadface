/** Line widths and dash patterns (mm on the sheet) shared by the screen, SVG, DXF and PDF output. */
import type { LineStyle } from './types'

export interface LineSpec {
  width: number
  /** dash pattern: on, off, on, off... (mm). Empty is a continuous line. */
  dash: number[]
  /** DXF layer and linetype */
  layer: string
  ltype: string
  /** DXF colour index */
  aci: number
}

export const LINE_STYLES: Record<LineStyle, LineSpec> = {
  visible: { width: 0.5, dash: [], layer: 'VISIBLE', ltype: 'CONTINUOUS', aci: 7 },
  hidden: { width: 0.25, dash: [3, 1.5], layer: 'HIDDEN', ltype: 'HIDDEN', aci: 4 },
  tangent: { width: 0.18, dash: [], layer: 'TANGENT', ltype: 'CONTINUOUS', aci: 8 },
  center: { width: 0.18, dash: [10, 1.5, 1.5, 1.5], layer: 'CENTER', ltype: 'CENTER', aci: 1 },
  thin: { width: 0.18, dash: [], layer: 'ANNOTATION', ltype: 'CONTINUOUS', aci: 7 },
  cut: { width: 0.7, dash: [], layer: 'CUTLINE', ltype: 'CONTINUOUS', aci: 7 },
  dim: { width: 0.18, dash: [], layer: 'DIMENSION', ltype: 'CONTINUOUS', aci: 3 },
  border: { width: 0.7, dash: [], layer: 'BORDER', ltype: 'CONTINUOUS', aci: 7 },
  hatch: { width: 0.18, dash: [], layer: 'HATCH', ltype: 'CONTINUOUS', aci: 8 },
  phantom: { width: 0.25, dash: [12, 2, 2, 2, 2, 2], layer: 'CUTLINE', ltype: 'PHANTOM', aci: 7 },
  fill: { width: 0.18, dash: [], layer: 'ANNOTATION', ltype: 'CONTINUOUS', aci: 7 },
}

/** Font used by SVG output (the PDF embeds its own). */
export const FONT_STACK = "Inter, 'Helvetica Neue', Arial, sans-serif"
