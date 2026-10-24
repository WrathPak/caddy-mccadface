/** Print workspace: commands, ribbon tab and feature registration. The only hook into the shared code is the import of this file. */
import {
  ArrowsClockwise, Bug, DownloadSimple, Drop, PaintBrush, PaintBucket, PaperPlaneTilt, Printer, Ruler, SplitVertical, Triangle,
} from '@phosphor-icons/react'
import { RIBBON_TABS } from '@/app/ribbon'
import { registerCommand } from '@/app/commands'
import { useSketch } from '@/sketch/store'
import './settings'
import './paint'
import './split'
import './hollow'
import { startPaint } from './paint'
import { startSplit } from './split'
import { startHollow } from './hollow'
import { startAutoOrient } from './orientTool'
import { openPrintSettings } from './settings'
import { exportPlate3mf, sendToSlicer } from './slicer'
import { showMap, usePrintView, type MapKind } from './view'

/** Tools are unavailable while a sketch is open (finish it first). */
const solid = (fn: () => void) => () => { if (!useSketch.getState().active) fn() }

const toggleMap = (kind: MapKind) => () => showMap(usePrintView.getState().kind === kind ? null : kind)

registerCommand({ id: 'print.settings', label: 'Print Settings', tip: 'Printer, layer height, walls, infill, support and the filament colors written into the 3MF', icon: Printer, category: 'Print', run: solid(openPrintSettings) })
registerCommand({ id: 'print.sendBambu', label: 'Bambu Studio', tip: 'Send to Bambu Studio: save the plate as a 3MF to open there', icon: PaperPlaneTilt, category: 'Print', run: () => void sendToSlicer('bambu') })
registerCommand({ id: 'print.sendOrca', label: 'OrcaSlicer', tip: 'Send to OrcaSlicer: save the plate as a 3MF to open there', icon: PaperPlaneTilt, category: 'Print', run: () => void sendToSlicer('orca') })
registerCommand({ id: 'print.export3mf', label: 'Export 3MF', tip: 'Download the plate as a Bambu / Orca 3MF: every visible body is an object, with its filament colors and the print settings', icon: DownloadSimple, category: 'Print', run: () => void exportPlate3mf() })
registerCommand({ id: 'print.paintBody', label: 'Paint Body', tip: 'Give whole bodies a filament color', icon: PaintBucket, category: 'Print', run: solid(() => startPaint('body')) })
registerCommand({ id: 'print.paintFaces', label: 'Paint Faces', tip: 'Paint faces with the brush, the face click or the fill tool', icon: PaintBrush, category: 'Print', run: solid(() => startPaint('faces')) })
registerCommand({ id: 'print.overhang', label: 'Overhangs', tip: 'Show the surfaces that overhang more than an angle and need support', icon: Triangle, category: 'Print', run: toggleMap('overhang') })
registerCommand({ id: 'print.thin', label: 'Thin Walls', tip: 'Show walls thinner than a minimum thickness', icon: Ruler, category: 'Print', run: toggleMap('thin') })
registerCommand({ id: 'print.small', label: 'Small Features', tip: 'Show features narrower than a minimum size', icon: Bug, category: 'Print', run: toggleMap('small') })
registerCommand({ id: 'print.orient', label: 'Auto Orient', tip: 'Find the way up that needs the least support and apply it as a Move', icon: ArrowsClockwise, category: 'Print', run: solid(startAutoOrient) })
registerCommand({ id: 'print.split', label: 'Split Body', tip: 'Cut bodies into parts with a plane or a sketch, with optional alignment pins or dovetails', icon: SplitVertical, category: 'Print', run: solid(startSplit) })
registerCommand({ id: 'print.hollow', label: 'Hollow', tip: 'Hollow a body out to a wall thickness, with drain holes you place by clicking', icon: Drop, category: 'Print', run: solid(startHollow) })

const at = RIBBON_TABS.findIndex((t) => t.id === 'sketch')
RIBBON_TABS.splice(at < 0 ? RIBBON_TABS.length : at, 0, {
  id: 'print',
  label: 'Print',
  groups: [
    { label: 'Slicer', items: [{ cmd: 'print.settings' }, { cmd: 'print.sendBambu' }, { cmd: 'print.sendOrca' }, { cmd: 'print.export3mf' }] },
    { label: 'Color', items: [{ cmd: 'print.paintBody' }, { cmd: 'print.paintFaces' }] },
    { label: 'Analyze', items: [{ cmd: 'print.overhang' }, { cmd: 'print.thin' }, { cmd: 'print.small' }, { cmd: 'print.orient' }] },
    { label: 'Prepare', items: [{ cmd: 'print.split' }, { cmd: 'print.hollow' }] },
  ],
})
