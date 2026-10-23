/**
 * Central command registry. Every ribbon button, menu item, palette entry and shortcut
 * dispatches through here. Later agents replace a stub by calling `registerCommand` again
 * with the same id (last registration wins) or by editing the entry below.
 */
import type { Icon } from '@phosphor-icons/react'
import {
  ArrowArcRight, ArrowsClockwise, ArrowsOutCardinal, ArrowUUpLeft, ArrowUUpRight, BoundingBox, Circle,
  Crosshair, Cube, Cylinder, DownloadSimple, Equals, Exclude, Eye, FilePlus, FloppyDisk, FolderOpen,
  FrameCorners, Funnel, GridFour, Hash, House, Intersect, Knife, LineSegment, Moon, MagicWand, Package,
  Path, PencilSimpleLine, Polygon, Ruler, Scissors, Spiral, Square, Stack, Subtract, Sun, Target, Trash,
  Unite, UploadSimple, Wall, Waves, Parallelogram, Angle, Check, Lock, Selection, Planet, Shapes, ArrowFatLineUp,
} from '@phosphor-icons/react'
import { useUi } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { demoExtrudeSchema, schemaDefaults } from '@/ui/schema'
import { viewportBus } from '@/viewport/bus'
import { selectionBounds } from '@/viewport/selectionBounds'

export interface Command {
  id: string
  label: string
  /** longer tooltip text (e.g. the supported formats); falls back to the label */
  tip?: string
  icon: Icon
  /** e.g. 'E', 'Ctrl+Z', 'Shift+F', 'F6', 'Delete' */
  shortcut?: string
  /** palette grouping */
  category: string
  /** keep out of the palette (alternate shortcut bindings) */
  hidden?: boolean
  /** true for placeholder implementations that a later agent replaces */
  stub?: boolean
  run: () => void
}

const registry = new Map<string, Command>()

export function registerCommand(c: Command) {
  registry.set(c.id, c)
}
export function getCommand(id: string) {
  return registry.get(id)
}
export function allCommands() {
  return [...registry.values()]
}
export function runCommand(id: string) {
  const c = registry.get(id)
  if (!c) return console.warn('[commands] unknown', id)
  c.run()
}

/** Placeholder behaviour: marks the tool active and logs. */
const stubRun = (id: string) => () => {
  const ui = useUi.getState()
  ui.setActiveTool(ui.activeTool === id ? null : id)
  console.info(`[stub] command ${id}`)
}

function def(id: string, label: string, icon: Icon, category: string, shortcut?: string, run?: () => void, tip?: string) {
  registerCommand({ id, label, tip, icon, category, shortcut, stub: !run, run: run ?? stubRun(id) })
}

/** Opens the schema-driven Inspector with the demo Extrude schema. */
function openExtrudeDemo() {
  const ui = useUi.getState()
  ui.setActiveTool('solid.extrude')
  ui.openInspector({
    schema: demoExtrudeSchema,
    values: schemaDefaults(demoExtrudeSchema),
    onOk: (v) => {
      console.info('[inspector] OK', v)
      useUi.getState().closeInspector()
      useUi.getState().setActiveTool(null)
    },
    onCancel: () => {
      useUi.getState().closeInspector()
      useUi.getState().setActiveTool(null)
    },
  })
}

// ---- File / edit
def('file.new', 'New Document', FilePlus, 'File', 'Ctrl+N')
def('file.open', 'Open...', FolderOpen, 'File', 'Ctrl+O')
def('file.save', 'Save', FloppyDisk, 'File', 'Ctrl+S')
def('file.import', 'Import', UploadSimple, 'File', undefined, undefined, 'Import a model: STL, 3MF, STEP or a .caddy project')
def('file.export', 'Export', DownloadSimple, 'File', undefined, undefined, 'Export bodies as STL, 3MF or STEP')
def('edit.undo', 'Undo', ArrowUUpLeft, 'Edit', 'Ctrl+Z')
def('edit.redo', 'Redo', ArrowUUpRight, 'Edit', 'Ctrl+Y')
def('edit.delete', 'Delete', Trash, 'Edit', 'Delete')
// Enter: feature dialogs handle it themselves (Inspector); the sketcher ends the polyline / tool / sketch (sketch/commands.ts)
registerCommand({ id: 'edit.accept', label: 'Accept', icon: Check, category: 'Edit', shortcut: 'Enter', hidden: true, run: () => {} })
def('edit.escape', 'Cancel / Clear Selection', Check, 'Edit', 'Escape', () => {
  const ui = useUi.getState()
  if (ui.inspector) return ui.inspector.onCancel()
  if (ui.activeTool) return ui.setActiveTool(null)
  ui.clearSelection()
})

// ---- Solid: create
def('sketch.create', 'Create Sketch', PencilSimpleLine, 'Create', undefined, () => {
  const ui = useUi.getState()
  ui.setSketchMode(true)
  ui.setActiveTool('sketch.line')
})
def('solid.extrude', 'Extrude', ArrowFatLineUp, 'Create', 'E', openExtrudeDemo)
def('solid.revolve', 'Revolve', ArrowsClockwise, 'Create')
def('solid.sweep', 'Sweep', Path, 'Create')
def('solid.loft', 'Loft', Shapes, 'Create')
def('solid.box', 'Box', Cube, 'Create')
def('solid.cylinder', 'Cylinder', Cylinder, 'Create')
// ---- Solid: modify
def('solid.fillet', 'Fillet', Circle, 'Modify', 'Shift+F')
def('solid.chamfer', 'Chamfer', Polygon, 'Modify')
def('solid.shell', 'Shell', Package, 'Modify')
def('solid.move', 'Move / Copy', ArrowsOutCardinal, 'Modify', 'M')
def('solid.combine', 'Combine', Unite, 'Modify')
def('solid.join', 'Join', Unite, 'Modify')
def('solid.cut', 'Cut', Subtract, 'Modify')
def('solid.intersect', 'Intersect', Intersect, 'Modify')
// ---- Construct / inspect
def('construct.plane', 'Offset Plane', Parallelogram, 'Construct', undefined, undefined, 'Create a plane parallel to an origin plane or a planar face, at a distance')
def('inspect.measure', 'Measure', Ruler, 'Inspect', 'I')
def('inspect.section', 'Section Analysis', Knife, 'Inspect')
// ---- Mesh
def('mesh.import', 'Import Mesh', UploadSimple, 'Mesh')
def('mesh.remesh', 'Refine', GridFour, 'Mesh', undefined, undefined, 'Split long triangle edges until none is longer than the target length')
def('mesh.smooth', 'Smooth', Waves, 'Mesh')
def('mesh.planeCut', 'Plane Cut', Scissors, 'Mesh')
def('mesh.convert', 'Convert to Mesh', Cube, 'Mesh', undefined, undefined, 'Turn a solid (B-rep) body into a triangle mesh body')
def('mesh.reduce', 'Reduce', Funnel, 'Mesh')
def('mesh.repair', 'Repair', MagicWand, 'Mesh')
// ---- Hair
def('hair.create', 'Create Hair', Spiral, 'Hair')
def('hair.faces', 'Select Faces', Selection, 'Hair')
def('hair.wall', 'Sacrificial Wall', Wall, 'Hair')
def('hair.preview', 'Preview Strands', Eye, 'Hair')
// ---- Sketch
def('sketch.finish', 'Finish Sketch', Check, 'Sketch', undefined, () => {
  const ui = useUi.getState()
  ui.setSketchMode(false)
  ui.setActiveTool(null)
})
def('sketch.line', 'Line', LineSegment, 'Sketch', 'L')
def('sketch.rect', 'Rectangle', Square, 'Sketch', 'R')
def('sketch.circle', 'Circle', Circle, 'Sketch', 'C')
def('sketch.arc', 'Arc', ArrowArcRight, 'Sketch', 'A')
def('sketch.dimension', 'Sketch Dimension', Ruler, 'Sketch', 'D')
def('sketch.coincident', 'Coincident', Crosshair, 'Sketch')
def('sketch.horizontal', 'Horizontal / Vertical', Equals, 'Sketch')
def('sketch.parallel', 'Parallel', Hash, 'Sketch')
def('sketch.perpendicular', 'Perpendicular', Angle, 'Sketch')
def('sketch.tangent', 'Tangent', Target, 'Sketch')
def('sketch.equal', 'Equal', Equals, 'Sketch')
def('sketch.fix', 'Fix / Lock', Lock, 'Sketch')
def('sketch.trim', 'Trim', Scissors, 'Sketch', 'T')
def('sketch.offset', 'Offset', Stack, 'Sketch')
def('sketch.project', 'Project / Include', Exclude, 'Sketch')

// ---- View
def('view.frame', 'Frame All', FrameCorners, 'View', 'F6', () => viewportBus.emit('frame', undefined))
def('view.frameSelection', 'Frame Selection', FrameCorners, 'View', 'F', () => {
  const b = selectionBounds(useUi.getState().selection, useDoc.getState().geometry)
  if (!b) return viewportBus.emit('frame', undefined)
  viewportBus.emit('frameBox', { min: b.min.toArray(), max: b.max.toArray() })
}, 'Fit the view to the selected faces, edges or bodies (everything when nothing is selected)')
def('view.home', 'Home View', House, 'View', undefined, () => viewportBus.emit('view', 'home'))
def('view.top', 'View Top', BoundingBox, 'View', undefined, () => viewportBus.emit('view', 'top'))
def('view.front', 'View Front', BoundingBox, 'View', undefined, () => viewportBus.emit('view', 'front'))
def('view.right', 'View Right', BoundingBox, 'View', undefined, () => viewportBus.emit('view', 'right'))
def('view.ortho', 'Toggle Orthographic / Perspective', Planet, 'View', 'Shift+P', () => {
  const ui = useUi.getState()
  ui.setProjection(ui.projection === 'perspective' ? 'orthographic' : 'perspective')
})
def('view.shaded', 'Display: Shaded', Cube, 'View', undefined, () => useUi.getState().setDisplayMode('shaded'))
def('view.shadedEdges', 'Display: Shaded + Edges', Cube, 'View', undefined, () => useUi.getState().setDisplayMode('shadedEdges'))
def('view.wireframe', 'Display: Wireframe', BoundingBox, 'View', undefined, () => useUi.getState().setDisplayMode('wireframe'))
def('view.xray', 'Display: X-Ray', Eye, 'View', undefined, () => useUi.getState().setDisplayMode('xray'))
def('view.ssao', 'Toggle Ambient Occlusion', Sun, 'View', undefined, () => useUi.getState().toggleSsao())
def('view.theme', 'Toggle Light / Dark Theme', Moon, 'View', undefined, () => useUi.getState().toggleTheme())
def('app.palette', 'Command Palette', MagicWand, 'App', 'S', () => useUi.getState().setPaletteOpen(true))
def('doc.suppress', 'Suppress / Unsuppress Feature', Eye, 'Timeline', undefined, () => {
  const d = useDoc.getState()
  if (d.selectedFeatureId) d.toggleSuppress(d.selectedFeatureId)
})
