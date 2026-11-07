/** Commands of the Mesh tab that features/mesh adds (ribbon buttons, palette entries). */
import { ArrowsOutCardinal, Cardholder, Eraser, Funnel, GridFour, Intersect, PaintBrush, Scissors, SelectionPlus, SelectionSlash, SplitVertical, Stack, Trash, Gauge } from '@phosphor-icons/react'
import { registerCommand, getCommand, type Command } from '@/app/commands'
import { useSketch } from '@/sketch/store'
import { startMesh2 } from './tools'
import { startSectionSketch } from './sectionSketch'
import { growSelection, shrinkSelection, toggleBrush } from './select'
import { toggleMeshStats } from './stats'

const solid = (fn: () => void) => () => { if (!useSketch.getState().active) fn() }
const add = (c: Omit<Command, 'category'>) => registerCommand({ category: 'Mesh', ...c })

add({ id: 'mesh.planeCut', label: 'Plane Cut', icon: Scissors, run: solid(() => startMesh2('meshPlaneCut')), tip: 'Slice a mesh with a plane and keep one side or both.' })
add({ id: 'mesh.reduce', label: 'Reduce', icon: Funnel, run: solid(() => startMesh2('meshReduce')), tip: 'Make a mesh lighter by merging triangles.' })
add({ id: 'mesh.remesh', label: 'Refine / Remesh', icon: GridFour, run: solid(() => startMesh2('meshRefine')), tip: 'Split long edges, or rebuild the mesh with even triangles.' })
add({ id: 'mesh.faceGroups', label: 'Face Groups', icon: Stack, run: solid(() => startMesh2('meshFaceGroups')), tip: 'Generate face groups: cut the mesh into faces you can pick, fast or accurate. The arrow has Combine and Separate.' })
add({ id: 'mesh.generateGroups', label: 'Generate Face Groups', icon: Stack, run: solid(() => startMesh2('meshFaceGroups')), tip: 'Cut the mesh into face groups you can pick, fast or accurate.' })
add({ id: 'mesh.combineGroups', label: 'Combine Face Groups', icon: Intersect, run: solid(() => startMesh2('meshCombineGroups')), tip: 'Join several face groups into one.' })
add({ id: 'mesh.separateGroups', label: 'Separate Face Groups', icon: SplitVertical, run: solid(() => startMesh2('meshSeparateGroups')), tip: 'Cut some triangles out of their face group into a group of their own.' })
add({ id: 'mesh.deleteFaces', label: 'Delete Faces', icon: Trash, run: solid(() => startMesh2('meshDeleteFaces2')), tip: 'Remove faces from a mesh and leave the hole open.' })
add({ id: 'mesh.eraseFill', label: 'Erase And Fill', icon: Eraser, run: solid(() => startMesh2('meshEraseFill')), tip: 'Remove faces and close the gap with a smooth patch.' })
add({ id: 'mesh.moveFaces', label: 'Move Faces', icon: ArrowsOutCardinal, run: solid(() => startMesh2('meshMoveFaces')), tip: 'Push or pull a face group; the triangles around it stretch to follow.' })
add({ id: 'mesh.sectionSketch', label: 'Section Sketch', icon: Cardholder, run: solid(startSectionSketch), tip: 'Turn the outline a plane cuts out of a mesh into a sketch.' })
add({ id: 'mesh.stats', label: 'Mesh Stats', icon: Gauge, run: toggleMeshStats, tip: 'Show triangles, open edges, volume and whether the mesh is closed.' })
add({ id: 'mesh.brush', label: 'Brush Select', icon: PaintBrush, run: solid(toggleBrush), tip: 'Paint triangles with a brush to select them.' })
add({ id: 'mesh.grow', label: 'Grow', icon: SelectionPlus, run: growSelection, tip: 'Add the ring of triangles around the selection.' })
add({ id: 'mesh.shrink', label: 'Shrink', icon: SelectionSlash, run: shrinkSelection, tip: 'Take the outer ring of triangles off the selection.' })
void getCommand
