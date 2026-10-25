/** Drawing workspace: commands and the ribbon tab. The only hooks into the shared code are the import of this file and the overlay in the viewport. */
import {
  Angle, ArrowBendUpRight, ArrowsHorizontal, ArrowUpRight, Circle, CircleDashed, Cube, CubeTransparent, FileCode, FilePdf, FilePlus, FileSvg,
  Check, Hash, ListNumbers, MagnifyingGlassPlus, NumberCircleOne, NotePencil, Ruler, Scissors, Sliders, Stack, Table, Target, BoundingBox,
} from '@phosphor-icons/react'
import { RIBBON_TABS } from '@/app/ribbon'
import { registerCommand } from '@/app/commands'
import { useSketch } from '@/sketch/store'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import { doExportDxf, doExportPdf, doExportSvg, newSheet, openTemplate, sheetSetup, startBaseView } from './actions'
import { startTool, type ToolId } from './tools'
import { activeSheet, drawingActions } from './store'

const free = (fn: () => void) => () => {
  if (useSketch.getState().active) return
  useUi.getState().setWorkspace('drawing')
  fn()
}
/** A tool that works on views already on the sheet. */
const onView = (id: ToolId) => free(() => {
  const s = activeSheet()
  if (!s?.views.length) return toast('Add a base view first', 'error')
  startTool(id)
})
/** A tool that works on the sheet itself. */
const onSheet = (id: ToolId) => free(() => {
  drawingActions.ensureSheet()
  startTool(id)
})

const cmd = (id: string, label: string, tip: string, icon: typeof Cube, run: () => void) =>
  registerCommand({ id, label, tip, icon, category: 'Drawing', run })

cmd('drawing.sheet.new', 'New Sheet', 'Add a sheet to the drawing', FilePlus, free(newSheet))
cmd('drawing.sheet.setup', 'Sheet Setup', 'Paper size, projection, scale and the text in the title block', Sliders, free(sheetSetup))
cmd('drawing.template', 'Title Block', 'Edit the title block layout: add, move and rename its fields', Table, free(openTemplate))

cmd('drawing.view.base', 'Base View', 'A view of the model or one of its parts, from the front, top, right or any other side', Cube, free(() => startBaseView('front')))
cmd('drawing.view.iso', 'Isometric', 'An isometric view of the model', CubeTransparent, free(() => startBaseView('iso')))
cmd('drawing.view.projected', 'Projected', 'A view projected from another one, placed beside or above it (first or third angle)', BoundingBox, onView('view.projected'))
cmd('drawing.view.section', 'Section', 'Cut the model along a line to show what is inside, with hatching', Scissors, onView('view.section'))
cmd('drawing.view.detail', 'Detail', 'Draw a circle around a small feature and show it at a larger scale', MagnifyingGlassPlus, onView('view.detail'))

cmd('drawing.dim.linear', 'Linear', 'Horizontal or vertical distance between two points', ArrowsHorizontal, onView('dim.linear'))
cmd('drawing.dim.aligned', 'Aligned', 'True distance between two points', ArrowUpRight, onView('dim.aligned'))
cmd('drawing.dim.angular', 'Angular', 'Angle between two lines meeting at a corner', Angle, onView('dim.angular'))
cmd('drawing.dim.radius', 'Radius', 'Radius of a circle or an arc', Circle, onView('dim.radius'))
cmd('drawing.dim.diameter', 'Diameter', 'Diameter of a circle', CircleDashed, onView('dim.diameter'))
cmd('drawing.dim.ordinate', 'Ordinate', 'Distance from an origin point along one axis', Ruler, onView('dim.ordinate'))
cmd('drawing.dim.baseline', 'Baseline', 'Several distances measured from the same point, stacked', Stack, onView('dim.baseline'))

cmd('drawing.ann.note', 'Note', 'A block of text', NotePencil, onSheet('ann.note'))
cmd('drawing.ann.leader', 'Leader', 'Text with an arrow pointing at a feature', ArrowBendUpRight, onSheet('ann.leader'))
cmd('drawing.ann.gdt', 'GD&T', 'A geometric tolerance frame: position, flatness, parallelism and the rest', Target, onSheet('ann.gdt'))
cmd('drawing.ann.datum', 'Datum', 'A datum feature symbol (A, B, C)', Hash, onSheet('ann.datum'))
cmd('drawing.ann.finish', 'Surface Finish', 'A surface roughness symbol', Check, onSheet('ann.finish'))
cmd('drawing.ann.balloon', 'Balloon', 'A numbered balloon that points at a part, with the number from the parts list', NumberCircleOne, onSheet('ann.balloon'))
cmd('drawing.ann.partsList', 'Parts List', 'A table of the parts of the model with their quantities', ListNumbers, onSheet('ann.partsList'))

cmd('drawing.export.pdf', 'PDF', 'Vector PDF of every sheet, with real text', FilePdf, free(() => void doExportPdf()))
cmd('drawing.export.dxf', 'DXF', 'DXF of the active sheet, with layers and linetypes, for CAM and other CAD programs', FileCode, free(() => void doExportDxf()))
cmd('drawing.export.svg', 'SVG', 'SVG of the active sheet', FileSvg, free(() => void doExportSvg()))

const at = RIBBON_TABS.findIndex((t) => t.id === 'sketch')
RIBBON_TABS.splice(at < 0 ? RIBBON_TABS.length : at, 0, {
  id: 'drawing',
  label: 'Drawing',
  groups: [
    { label: 'Sheet', items: [{ cmd: 'drawing.sheet.new' }, { cmd: 'drawing.sheet.setup' }, { cmd: 'drawing.template' }] },
    { label: 'Views', items: [{ cmd: 'drawing.view.base' }, { cmd: 'drawing.view.projected' }, { cmd: 'drawing.view.section' }, { cmd: 'drawing.view.detail' }, { cmd: 'drawing.view.iso' }] },
    {
      label: 'Dimension',
      items: [
        { stack: ['drawing.dim.linear', 'drawing.dim.aligned', 'drawing.dim.angular'] },
        { stack: ['drawing.dim.radius', 'drawing.dim.diameter', 'drawing.dim.ordinate'] },
        { cmd: 'drawing.dim.baseline' },
      ],
    },
    {
      label: 'Annotate',
      items: [
        { stack: ['drawing.ann.note', 'drawing.ann.leader', 'drawing.ann.gdt'] },
        { stack: ['drawing.ann.datum', 'drawing.ann.finish', 'drawing.ann.balloon'] },
        { cmd: 'drawing.ann.partsList' },
      ],
    },
    { label: 'Export', items: [{ cmd: 'drawing.export.pdf' }, { cmd: 'drawing.export.dxf' }, { cmd: 'drawing.export.svg' }] },
  ],
})
