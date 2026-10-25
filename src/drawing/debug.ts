/** Handles for the browser specs (reachable as `__caddy.drawing` in dev builds). */
import { drawingActions, useDrawing } from './store'
import { pdfBytes, svgText, dxfText, sheetOutput } from './output'
import * as service from './service'
import { useTool } from './tools'
import { useViewGeoms } from './views'
import { camHandle } from './Canvas'

export const drawingDebug = {
  store: useDrawing,
  geoms: useViewGeoms,
  tool: useTool,
  actions: drawingActions,
  service,
  pdfBytes,
  svgText,
  dxfText,
  sheetOutput,
  camera: camHandle,
}
