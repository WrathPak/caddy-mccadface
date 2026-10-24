/**
 * Registers the modeling tools: patterns, mirror, holes, construction geometry, direct edits, the newer sketch tools and
 * configurations. Everything is added from here (features, commands, ribbon items) so the shared files stay untouched.
 */
import {
  ArrowsOutLineVertical, Circle, CircleDashed, DotOutline, Eraser, FlipHorizontal, GridFour, Knife, LineSegment, Magnet, Parallelogram,
  Polygon, PushPin, Scissors, SplitVertical, SquaresFour, TextT, TrendDown, UploadSimple, Waves, Rows, Hexagon, Table, Path,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { registerCommand } from '@/app/commands'
import { RIBBON_TABS, type RibbonGroup } from '@/app/ribbon'
import { useSketch, setTool, type ToolId } from '@/sketch/store'
import { useSnapUi } from '@/sketch/SnapPopover'
import { useSnapFlags } from '@/sketch/snapSettings'
import { chooseImportFile, splineHandlesCommand, useSketchOpts } from '@/sketch/toolsUi'
import { useConstruct } from './geo'
import { useMarkers } from './markers'
import { useLastPick } from '@/viewport/lastPick'
import { useConfigDialog } from './ConfigUi'
import './pattern'
import './mirror'
import './hole'
import './construct'
import './direct'
import { startPattern } from './pattern'
import { startMirror } from './mirror'
import { startHole } from './hole'
import { startConstruct } from './construct'
import { startDirect } from './direct'

const sketching = () => useSketch.getState().active
/** Solid tools are unavailable while a sketch is open (finish it first). */
const solid = (fn: () => void) => () => { if (!sketching()) fn() }

function cmd(id: string, label: string, icon: Icon, category: string, run: () => void, tip?: string, shortcut?: string) {
  registerCommand({ id, label, icon, category, run, tip, shortcut })
}

// ---- solid
cmd('solid.pattern', 'Pattern', GridFour, 'Create', solid(startPattern), 'Repeat features, faces or bodies in a grid, round an axis or along a path; click an instance to skip it')
cmd('solid.mirror', 'Mirror', FlipHorizontal, 'Create', solid(startMirror), 'Mirror features, faces or bodies across a plane or flat face')
cmd('solid.hole', 'Hole', CircleDashed, 'Create', solid(startHole), 'Simple, counterbore, countersink and tapped holes at clicked points or sketch points, with common screw sizes and heat-set inserts')
cmd('solid.pressPull', 'Press/Pull', PushPin, 'Modify', solid(() => startDirect('pressPull', 'solid.pressPull')), 'Push or pull a face, or round an edge, by dragging')
cmd('solid.offsetFace', 'Offset Face', ArrowsOutLineVertical, 'Modify', solid(() => startDirect('offsetFace', 'solid.offsetFace')), 'Move faces along their normals')
cmd('solid.deleteFace', 'Delete Face', Eraser, 'Modify', solid(() => startDirect('deleteFace', 'solid.deleteFace')), 'Remove faces and heal the gap (fillets, holes, bosses)')
cmd('solid.replaceFace', 'Replace Face', SplitVertical, 'Modify', solid(() => startDirect('replaceFace', 'solid.replaceFace')), 'Move faces onto a plane or another face')
cmd('solid.splitFace', 'Split Face', Scissors, 'Modify', solid(() => startDirect('splitFace', 'solid.splitFace')), 'Divide faces with a plane, face or body without splitting the body')
cmd('solid.splitBody', 'Split Body', Knife, 'Modify', solid(() => startDirect('splitBody', 'solid.splitBody')), 'Cut bodies into pieces with a plane, face or body')
cmd('solid.draft', 'Draft', TrendDown, 'Modify', solid(() => startDirect('draft', 'solid.draft')), 'Tilt faces by a draft angle about a neutral plane')
cmd('construct.planeAngle', 'Plane at Angle', Parallelogram, 'Construct', solid(() => startConstruct('constructPlane', 'angle')), 'A plane turned about an axis or edge')
cmd('construct.planeTangent', 'Tangent Plane', Parallelogram, 'Construct', solid(() => startConstruct('constructPlane', 'tangent')), 'A plane touching a cylinder or sphere')
cmd('construct.planeMid', 'Midplane', Parallelogram, 'Construct', solid(() => startConstruct('constructPlane', 'midplane')), 'A plane halfway between two parallel planes or faces')
cmd('construct.plane3', 'Plane Through 3 Points', Parallelogram, 'Construct', solid(() => startConstruct('constructPlane', 'threePoints')), 'A plane through three points')
cmd('construct.axis', 'Axis', LineSegment, 'Construct', solid(() => startConstruct('constructAxis', 'edge')), 'An axis through an edge, two points, normal to a face, or along a cylinder')
cmd('construct.axisPoints', 'Axis Through 2 Points', LineSegment, 'Construct', solid(() => startConstruct('constructAxis', 'twoPoints')))
cmd('construct.axisNormal', 'Axis Normal to Face', LineSegment, 'Construct', solid(() => startConstruct('constructAxis', 'normal')))
cmd('construct.axisCyl', 'Axis of Cylinder', LineSegment, 'Construct', solid(() => startConstruct('constructAxis', 'cylinder')))
cmd('construct.point', 'Point', DotOutline, 'Construct', solid(() => startConstruct('constructPoint', 'coords')), 'A point at coordinates, a vertex, a centre, or where an axis meets a plane')
cmd('construct.pointVertex', 'Point at Vertex', DotOutline, 'Construct', solid(() => startConstruct('constructPoint', 'vertex')))
cmd('construct.pointCenter', 'Point at Centre', DotOutline, 'Construct', solid(() => startConstruct('constructPoint', 'center')))
cmd('construct.pointAxisPlane', 'Point at Axis and Plane', DotOutline, 'Construct', solid(() => startConstruct('constructPoint', 'axisPlane')))
cmd('doc.configs', 'Configurations', Table, 'Document', () => useConfigDialog.getState().set(true), 'Sets of parameter values (sizes S, M, L) to switch between and export')

// ---- sketch
const tool = (id: string, t: ToolId, label: string, icon: Icon, tip?: string) => cmd(id, label, icon, 'Sketch', () => { if (sketching()) setTool(t) }, tip)
tool('sketch.spline', 'spline', 'Fit Point Spline', Waves, 'A smooth curve through the points you click')
tool('sketch.splineC', 'splineC', 'Control Point Spline', Waves, 'A curve shaped by control points')
tool('sketch.ellipse', 'ellipse', 'Ellipse', Circle, 'Centre, long axis end, short radius')
tool('sketch.slotCC', 'slotCC', 'Centre to Centre Slot', Rows, 'A slot between two centres')
tool('sketch.slotOv', 'slotOv', 'Overall Slot', Rows, 'A slot of a given overall length')
tool('sketch.slotArc', 'slotArc', 'Centre Point Arc Slot', Rows, 'A slot that follows an arc')
tool('sketch.polygon', 'polygon', 'Polygon', Hexagon, 'Inscribed, circumscribed or edge polygon')
tool('sketch.fillet', 'fillet', 'Sketch Fillet', Circle, 'Round the corner of two lines')
tool('sketch.chamfer', 'chamfer', 'Sketch Chamfer', Polygon, 'Cut the corner of two lines')
tool('sketch.mirror', 'mirror', 'Sketch Mirror', FlipHorizontal, 'Mirror the selected curves across a line, kept constrained')
tool('sketch.patternR', 'patternR', 'Rectangular Pattern', GridFour, 'Repeat the selected curves in a grid, kept constrained')
tool('sketch.patternC', 'patternC', 'Circular Pattern', SquaresFour, 'Repeat the selected curves round a point, kept constrained')
tool('sketch.text', 'text', 'Text', TextT, 'Text whose outlines are profiles')
cmd('sketch.handles', 'Tangent Handles', Path, 'Sketch', () => { if (sketching()) splineHandlesCommand() }, 'Show draggable tangent handles at the ends of the selected fit point splines')
cmd('sketch.import', 'Import SVG / DXF', UploadSimple, 'Sketch', () => { if (sketching()) chooseImportFile() }, 'Put the shapes of an SVG or DXF file into the sketch')
cmd('sketch.snapSettings', 'Snap Settings', Magnet, 'Sketch', () => useSnapUi.getState().setOpen(true), 'Choose which snaps and inferences (parallel, perpendicular, tangent ...) are offered while drawing')

// ---- ribbon: added here so the shared layout file does not change
function group(tab: string, label: string): RibbonGroup {
  const t = RIBBON_TABS.find((x) => x.id === tab)!
  let g = t.groups.find((x) => x.label === label)
  if (!g) { g = { label, items: [] }; t.groups.push(g) }
  return g
}
group('solid', 'Create').items.push({ cmd: 'solid.hole' }, { cmd: 'solid.pattern', menu: ['solid.pattern', 'solid.mirror'] })
group('solid', 'Modify').items.push({ cmd: 'solid.pressPull', menu: ['solid.pressPull', 'solid.offsetFace', 'solid.deleteFace', 'solid.replaceFace', 'solid.splitFace', 'solid.splitBody', 'solid.draft'] })
{
  const c = group('solid', 'Construct')
  c.items = [
    { cmd: 'construct.plane', menu: ['construct.plane', 'construct.planeAngle', 'construct.planeTangent', 'construct.planeMid', 'construct.plane3'] },
    { cmd: 'construct.axis', menu: ['construct.axis', 'construct.axisPoints', 'construct.axisNormal', 'construct.axisCyl'] },
    { cmd: 'construct.point', menu: ['construct.point', 'construct.pointVertex', 'construct.pointCenter', 'construct.pointAxisPlane'] },
  ]
}
group('solid', 'Document').items.push({ cmd: 'doc.configs' })
{
  const create = group('sketch', 'Create')
  create.items.push(
    { cmd: 'sketch.spline', menu: ['sketch.spline', 'sketch.splineC'] }, { cmd: 'sketch.ellipse' },
    { cmd: 'sketch.slotCC', menu: ['sketch.slotCC', 'sketch.slotOv', 'sketch.slotArc'] }, { cmd: 'sketch.polygon' }, { cmd: 'sketch.text' }, { cmd: 'sketch.import' },
  )
  const modify = group('sketch', 'Modify')
  modify.items.push({ cmd: 'sketch.fillet', menu: ['sketch.fillet', 'sketch.chamfer'] }, { cmd: 'sketch.mirror' }, { cmd: 'sketch.patternR', menu: ['sketch.patternR', 'sketch.patternC'] }, { cmd: 'sketch.handles' })
  group('sketch', 'Snap').items.push({ cmd: 'sketch.snapSettings' })
}

// ---- handles for the Playwright specs (dev builds only read them)
;(window as unknown as { __caddyExtra?: object }).__caddyExtra = {
  construct: useConstruct, markers: useMarkers, snapFlags: useSnapFlags, sketchOpts: useSketchOpts, lastPick: useLastPick,
}
