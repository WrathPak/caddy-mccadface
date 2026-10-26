/** Commands of the Drawing workspace that are not canvas tools: sheets, the base view dialog, exports. */
import { toast } from '@/ui/Modal'
import { baseViewSchema, openForm, editSheet } from './forms'
import { exportDxf, exportPdf, exportSvg } from './output'
import { createBaseView } from './service'
import { drawingActions, useDrawing } from './store'
import { useViewGeoms } from './views'
import { useTemplateDialog } from './templateDialog'
import { useUi } from '@/store/ui'
import { drawableBodies } from './components'

const fail = (what: string, e: unknown) => toast(`${what}: ${e instanceof Error ? e.message : String(e)}`, 'error')

/** Base view / isometric view: ask what to show and from where, then place it on the active sheet. */
export function startBaseView(orientation = 'front') {
  if (!drawableBodies().length) return toast('There is nothing to draw yet: make a solid body first', 'error')
  const sheetId = drawingActions.ensureSheet()
  openForm({
    schema: baseViewSchema(),
    values: { orientation },
    tool: 'drawing.view.base',
    onOk: (v) => {
      createBaseView(sheetId, {
        choice: String(v.choice), orientation: String(v.orientation), scale: Number(v.scale),
        showHidden: !!v.showHidden, showTangent: !!v.showTangent, showCenter: !!v.showCenter,
      })
        .then((id) => useDrawing.getState().select({ kind: 'view', id }))
        .catch((e) => fail('Could not make the view', e))
    },
  })
}

export function newSheet() {
  drawingActions.addSheet()
}

export function sheetSetup() {
  const s = useDrawing.getState().doc.sheets.find((x) => x.id === useDrawing.getState().doc.active) ?? useDrawing.getState().doc.sheets[0]
  if (!s) return void drawingActions.addSheet()
  editSheet(s)
}

export function openTemplate() {
  useTemplateDialog.getState().set(true)
}

export const doExportPdf = () => exportPdf().catch((e) => fail('PDF export failed', e))
export const doExportSvg = () => exportSvg().catch((e) => fail('SVG export failed', e))
export const doExportDxf = () => exportDxf().catch((e) => fail('DXF export failed', e))

/** Drop the cached geometry (after loading another document the views are recomputed). */
export function resetGeometryCache() {
  useViewGeoms.setState({ geoms: {}, pending: {}, errors: {} })
}

export const inDrawing = () => useUi.getState().workspace === 'drawing'
