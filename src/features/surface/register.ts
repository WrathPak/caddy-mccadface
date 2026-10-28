/**
 * Surface workspace: the tools' features, their commands and what a click on the ribbon preselects. The ribbon tab itself is in
 * app/ribbon.ts. The only hook into the shared code is the import of this file (app/docCommands.ts).
 */
import { ArrowFatLineUp, ArrowLineRight, ArrowsClockwise, Eraser, LinkBreak, Needle, Path, Rows, Scissors, SelectionBackground, Shapes, Stack, Swap } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { registerCommand } from '@/app/commands'
import { createFeature } from '@/doc/editor'
import { encodeSelection } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { chainsOf, curveRef } from './curves'
import { useSketchData } from '@/sketch/draw'
import { useSketch } from '@/sketch/store'
import { useUi } from '@/store/ui'
import type { ParamValues } from '@/ui/schema'
import './create'
import './modify'

/** Surface tools are unavailable while a sketch is open (finish it first). */
const outside = (fn: () => void) => () => { if (!useSketch.getState().active) fn() }

function cmd(id: string, label: string, icon: Icon, run: () => void, tip: string) {
  registerCommand({ id, label, icon, category: 'Surface', run: outside(run), tip })
}

// ---- what the selection (or the lone sketch / surface in the document) gives a tool to start with

const selection = () => useUi.getState().selection
const geometry = () => useDoc.getState().geometry
const surfaces = () => geometry().filter((b) => b.kind === 'brep' && b.surface)

/** Curve refs of everything picked: runs of sketch curves, whole sketches, edges. A lone curve in the document is taken when nothing is picked. */
function pickedCurves(): string[] {
  const refs = [
    ...selection().filter((r) => r.kind === 'curve').map((r) => r.id),
    ...selection().filter((r) => r.kind === 'sketch').map((r) => r.id),
    ...encodeSelection(selection().filter((r) => r.kind === 'edge'), geometry()),
  ]
  if (refs.length) return refs
  const doc = useDoc.getState()
  const data = useSketchData.getState().data
  const all = doc.features
    .filter((f, i) => f.type === 'sketch' && i < doc.rollback && !f.suppressed && data[f.id])
    .flatMap((f) => chainsOf(data[f.id]).map((c) => curveRef(f.id, c)))
  return all.length === 1 ? all : []
}

/** Surface bodies picked, or the only surface when there is just one. */
function pickedSurfaces(fallback: 'lone' | 'all' = 'lone'): string[] {
  const ids = [...new Set(selection().filter((r) => r.kind === 'body').map((r) => r.id))].filter((id) => surfaces().some((b) => b.id === id))
  if (ids.length) return ids
  const all = surfaces().map((b) => b.id)
  return fallback === 'all' ? all : all.length === 1 ? all : []
}

const pickedFaces = () => encodeSelection(selection().filter((r) => r.kind === 'face'), geometry())

function start(type: string, tool: string, init: ParamValues) {
  createFeature(type, init, tool)
}

cmd('surface.extrude', 'Extrude', ArrowFatLineUp, () => start('surfaceExtrude', 'surface.extrude', { curves: pickedCurves() }),
  'Extrude sketch curves or edges into a surface: open curves make an open surface')
cmd('surface.revolve', 'Revolve', ArrowsClockwise, () => start('surfaceRevolve', 'surface.revolve', { curves: pickedCurves() }),
  'Spin sketch curves or edges around an axis into a surface')
cmd('surface.sweep', 'Sweep', Path, () => start('surfaceSweep', 'surface.sweep', { profiles: pickedCurves() }),
  'Drag curves along a path into a surface')
cmd('surface.loft', 'Loft', Shapes, () => start('surfaceLoft', 'surface.loft', { sections: pickedCurves() }),
  'Blend a surface through two or more open or closed sections')
cmd('surface.patch', 'Patch', SelectionBackground, () => start('surfacePatch', 'surface.patch', { boundary: pickedCurves() }),
  'Fill a closed boundary of sketch curves or surface edges with a surface, optionally following the neighbouring faces')
cmd('surface.offset', 'Offset Surface', Stack, () => start('surfaceOffset', 'surface.offset', { faces: [...pickedFaces(), ...pickedSurfaces()] }),
  'Copy surfaces or faces at a distance as a new surface')
cmd('surface.trim', 'Trim', Scissors, () => {
  const [target] = pickedSurfaces()
  const tool = [...pickedFaces(), ...selection().filter((r) => r.kind === 'plane').map((r) => r.id)]
  start('surfaceTrim', 'surface.trim', { target: target ? [target] : [], tool })
}, 'Cut a surface with a plane, another surface, a face or a solid and keep one side')
cmd('surface.extend', 'Extend', ArrowLineRight, () => start('surfaceExtend', 'surface.extend', { edges: encodeSelection(selection().filter((r) => r.kind === 'edge'), geometry()) }),
  'Push the open edges of a surface outward, following the surface or straight along its tangent')
cmd('surface.stitch', 'Stitch', Needle, () => start('surfaceStitch', 'surface.stitch', { surfaces: pickedSurfaces('all') }),
  'Sew surfaces together along shared edges; a closed result becomes a solid')
cmd('surface.unstitch', 'Unstitch', LinkBreak, () => {
  const faces = pickedFaces()
  start('surfaceUnstitch', 'surface.unstitch', { source: faces.length ? faces : pickedSurfaces() })
}, 'Split a body into one surface per face, or pull chosen faces off as surfaces')
cmd('surface.thicken', 'Thicken', Rows, () => start('surfaceThicken', 'surface.thicken', { surfaces: pickedSurfaces() }),
  'Give a surface a thickness on one side or both: the result is a solid')
cmd('surface.deleteFace', 'Delete Face', Eraser, () => start('surfaceDeleteFace', 'surface.deleteFace', { faces: pickedFaces() }),
  'Remove faces from a solid or a surface, leaving an open surface')
cmd('surface.replaceFace', 'Fit to Surface', Swap, () => {
  const solidFaces = selection().filter((r) => r.kind === 'face' && !geometry().find((b) => b.id === r.id)?.surface)
  const target = [...pickedSurfaces(), ...selection().filter((r) => r.kind === 'plane').map((r) => r.id)]
  start('surfaceReplaceFace', 'surface.replaceFace', { faces: encodeSelection(solidFaces, geometry()), target })
}, 'Move faces of a solid onto a surface, plane or face of any shape: the flat faces next to them carry on or cut back to meet it. Select the faces first, then pick the surface.')
