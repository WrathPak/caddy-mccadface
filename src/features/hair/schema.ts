/** Hair feature: parameter schema and the resolved (numeric) parameter shape shared with the worker. */
import type { ParamSchema, ParamValue } from '@/ui/schema'

export type V3 = [number, number, number]

export interface HairParams {
  // direction
  /** 'normal' is the legacy name of 'blend' (older projects) */
  dirMode: 'perFace' | 'blend' | 'radial' | 'fixed' | 'point' | 'normal'
  blendDistance: number
  fixedDir: V3
  axisMode: 'worldX' | 'worldY' | 'worldZ' | 'edge' | 'points'
  axisP1: V3
  axisP2: V3
  targetPoint: V3
  pointAway: boolean
  normalBlend: number
  jitter: number
  // strands
  length: number
  width: number
  thickness: number
  density: number
  // wall
  wall: boolean
  wallMode: 'follow' | 'tips' | 'planar' | 'cylindrical'
  wallCorner: 'miter' | 'round'
  wallThickness: number
  tipOverlap: number
  wallDir: V3
  wallTop: number
  wallBottom: number
  wallSeparate: boolean
  // printing
  printAware: boolean
  nozzle: number
  layerHeight: number
  firstLayer: number
  snapThickness: boolean
  // pattern and shape
  distribution: 'poisson' | 'grid' | 'rows'
  densityMode: 'density' | 'spacing'
  spacing: number
  seed: number
  edgeMargin: number
  lengthMode: 'fixed' | 'toWall'
  section: 'rect' | 'round' | 'diamond'
  taper: number
  rootFlare: number
  /** depth the strand root is buried in the body (mm along the surface normal); 0 = automatic */
  rootSink: number
  // styling
  waveAmp: number
  waveFreq: number
  curl: number
  clumpCount: number
  clumpStrength: number
  droop: number
  lengthVar: number
  // output
  merge: boolean
  /** computed by the pipeline, not a user setting: height of the lowest point of the model (the print bed) */
  bedZ?: number
}

export interface HairValues extends HairParams {
  region: string[]
  axisEdge: string[]
  preset?: string
}

/** Presets fill many settings at once. Every preset sets the same keys so switching between them is lossless. */
const BASE_PRESET: Record<string, ParamValue> = {
  dirMode: 'perFace', blendDistance: 3, jitter: 0, normalBlend: 0, pointAway: false,
  length: 20, width: 0.6, thickness: 0.2, density: 12,
  wall: true, wallMode: 'follow', wallCorner: 'miter', wallThickness: 0.8, tipOverlap: 0.6,
  printAware: true, snapThickness: true, lengthMode: 'toWall', distribution: 'rows', section: 'rect',
  taper: 0, rootFlare: 0, waveAmp: 0, waveFreq: 1, curl: 0, clumpCount: 0, clumpStrength: 0.5, droop: 0, lengthVar: 0,
}
const preset = (over: Record<string, ParamValue>) => ({ ...BASE_PRESET, ...over })

export const HAIR_PRESETS = [
  { id: 'comb', label: 'Printable comb (horizontal, to wall)', help: 'Flat, horizontal teeth that end in a thin printed wall. Prints without supports on most printers.', values: preset({}) },
  { id: 'fur', label: 'Short fur', help: 'Dense, short, slightly tapered strands that follow the surface shape. No wall, so they are best for decoration.', values: preset({ dirMode: 'blend', length: 6, width: 0.6, thickness: 0.3, density: 40, wall: false, printAware: false, snapThickness: false, lengthMode: 'fixed', distribution: 'poisson', taper: 40, jitter: 15 }) },
  { id: 'spiky', label: 'Spiky', help: 'Thick, sharp spikes standing straight off each face.', values: preset({ length: 10, width: 1, thickness: 1, density: 6, wall: false, printAware: false, snapThickness: false, lengthMode: 'fixed', distribution: 'poisson', section: 'diamond', taper: 85, jitter: 6 }) },
  { id: 'wavy', label: 'Wavy locks', help: 'Long strands that wave sideways. Still horizontal, so they print cleanly onto a wall.', values: preset({ length: 25, density: 8, waveAmp: 1.5, waveFreq: 1.5, jitter: 4, lengthVar: 15, distribution: 'poisson' }) },
] as const

const dirOptions = [
  { value: 'perFace', label: 'Perpendicular to each face', desc: 'Each face keeps its own direction. Clean gap at corners.', icon: 'perFace' },
  { value: 'blend', label: 'Blend across faces', desc: 'Directions fan smoothly around corners.', icon: 'blend' },
  { value: 'radial', label: 'Fan from axis', desc: 'Strands point away from a line, like spokes.', icon: 'radial' },
  { value: 'fixed', label: 'Fixed direction', desc: 'Every strand points the same way.', icon: 'fixed' },
  { value: 'point', label: 'Toward / away from point', desc: 'Strands aim at (or away from) a point.', icon: 'point' },
]

export const hairSchema: ParamSchema = {
  id: 'hair',
  title: 'Hair',
  warnings: (v) => hairWarnings(v as unknown as HairParams),
  params: [
    { type: 'selection-ref', key: 'region', label: 'Surface', accepts: ['face'], multiple: true, required: true, default: [], help: 'The faces strands grow from. Click faces in the viewport, or use the Brush and Fill tools to paint an area.' },
    { type: 'preset', key: 'preset', label: 'Presets', default: 'comb', presets: HAIR_PRESETS.map((p) => ({ id: p.id, label: p.label, help: p.help, values: p.values })), help: 'Start from a ready-made look. This fills in the settings below; you can still change any of them.' },
    {
      type: 'group', id: 'direction', label: 'Direction', help: 'Which way the strands point as they leave the surface.', children: [
        { type: 'enum', key: 'dirMode', label: 'Direction', display: 'list', default: 'perFace', aliases: { normal: 'blend' }, options: dirOptions, help: 'How each strand picks the way it points. Arrows on the selected faces preview the result.' },
        { type: 'number', key: 'blendDistance', label: 'Blend distance', unit: 'mm', min: 0, step: 0.5, default: 3, visibleWhen: (v) => v.dirMode === 'blend' || v.dirMode === 'normal', help: 'How far from a corner the directions change gradually. 0 is a sharp switch between faces; larger values give a wider fan.' },
        { type: 'enum', key: 'axisMode', label: 'Axis', display: 'select', default: 'worldZ', visibleWhen: (v) => v.dirMode === 'radial', options: [{ value: 'worldX', label: 'World X' }, { value: 'worldY', label: 'World Y' }, { value: 'worldZ', label: 'World Z (up)' }, { value: 'edge', label: 'Pick an edge' }, { value: 'points', label: 'Two points' }], help: 'The line strands fan away from. Pick a world axis, a model edge, or two points.' },
        { type: 'selection-ref', key: 'axisEdge', label: 'Axis edge', accepts: ['edge'], required: true, default: [], visibleWhen: (v) => v.dirMode === 'radial' && v.axisMode === 'edge', help: 'Click the edge in the viewport that strands should fan away from.' },
        { type: 'vector3', key: 'axisP1', label: 'Point 1', unit: 'mm', step: 1, default: [0, 0, 0], visibleWhen: (v) => v.dirMode === 'radial' && v.axisMode === 'points', help: 'First point of the axis line (X, Y, Z in mm).' },
        { type: 'vector3', key: 'axisP2', label: 'Point 2', unit: 'mm', step: 1, default: [0, 0, 10], visibleWhen: (v) => v.dirMode === 'radial' && v.axisMode === 'points', help: 'Second point of the axis line (X, Y, Z in mm).' },
        { type: 'vector3', key: 'fixedDir', label: 'Direction', step: 0.1, default: [0, 1, 0], visibleWhen: (v) => v.dirMode === 'fixed', help: 'The direction every strand points, as X, Y, Z. Only the direction matters, not the size. Drag the arrow in the viewport to aim it.' },
        { type: 'vector3', key: 'targetPoint', label: 'Point', unit: 'mm', step: 1, default: [0, 0, 0], visibleWhen: (v) => v.dirMode === 'point', help: 'The point strands aim at (X, Y, Z in mm).' },
        { type: 'bool', key: 'pointAway', label: 'Away from point', default: false, visibleWhen: (v) => v.dirMode === 'point', help: 'Turn on to make strands point away from the point instead of toward it.' },
        { type: 'number', key: 'normalBlend', label: 'Follow surface', min: 0, max: 1, step: 0.05, default: 0, visibleWhen: (v) => v.dirMode === 'radial' || v.dirMode === 'fixed' || v.dirMode === 'point', help: 'Mixes the chosen direction with the way the surface faces. 0 uses only your direction; 1 follows the surface.' },
        { type: 'number', key: 'jitter', label: 'Spread', unit: 'deg', min: 0, max: 90, step: 1, default: 0, help: 'Random tilt added to each strand, in degrees. 0 makes all strands perfectly regular; 10 to 20 looks more natural.' },
      ],
    },
    {
      type: 'group', id: 'strands', label: 'Strands', help: 'How long, thick and dense the strands are.', children: [
        { type: 'number', key: 'length', label: 'Length', unit: 'mm', min: 0.5, step: 1, default: 20, help: 'How far strands reach from the surface. With a wall following the faces, the wall sits this far away.' },
        { type: 'number', key: 'width', label: 'Width', unit: 'mm', min: 0.05, step: 0.05, default: 0.6, help: 'Strand width across the surface. Printable strands need at least 1.4 times your nozzle size (0.56 mm for a 0.4 mm nozzle); thinner ones are raised to that.' },
        { type: 'number', key: 'thickness', label: 'Thickness', unit: 'mm', min: 0.05, step: 0.05, default: 0.2, help: 'Strand height (print-aware mode rounds it to whole layers). One layer, such as 0.2 mm, gives the finest printable strand.' },
        { type: 'number', key: 'density', label: 'Density /cm2', min: 0.05, step: 1, default: 12, visibleWhen: (v) => v.densityMode === 'density', help: 'Strands per square centimetre of surface. Higher is fuller but heavier. Use Spacing in Pattern settings to set it as a distance instead.' },
      ],
    },
    {
      type: 'group', id: 'wall', label: 'Wall', help: 'A thin printed wall the strand tips attach to, so the hair prints in place. Cut it away after printing.', children: [
        { type: 'bool', key: 'wall', label: 'Enable wall', default: true, help: 'Adds a thin sacrificial wall at the tips. It holds the strands while printing and is removed afterwards. Off leaves loose strand ends.' },
        { type: 'enum', key: 'wallMode', label: 'Shape', display: 'select', default: 'follow', visibleWhen: (v) => !!v.wall, options: [{ value: 'follow', label: 'Follow faces' }, { value: 'tips', label: 'Through tips' }, { value: 'planar', label: 'Flat plane' }, { value: 'cylindrical', label: 'Cylinder' }], help: 'Follow faces: copies the selected faces, set out by the strand length. Through tips: a smooth surface fitted to the strand ends. Flat plane / Cylinder: simple shapes.' },
        { type: 'enum', key: 'wallCorner', label: 'Corners', display: 'segmented', default: 'miter', visibleWhen: (v) => !!v.wall && v.wallMode === 'follow' && v.dirMode === 'perFace', options: [{ value: 'miter', label: 'Sharp' }, { value: 'round', label: 'Rounded' }], help: 'How the wall turns a corner between two faces: a sharp mitered edge, or a rounded one.' },
        { type: 'number', key: 'wallThickness', label: 'Thickness', unit: 'mm', min: 0.4, step: 0.2, default: 0.8, visibleWhen: (v) => !!v.wall, help: 'Wall thickness. 0.8 mm is two lines from a 0.4 mm nozzle: thin and easy to remove.' },
        { type: 'number', key: 'tipOverlap', label: 'Overlap', unit: 'mm', min: 0, step: 0.1, default: 0.6, visibleWhen: (v) => !!v.wall, help: 'How far each strand end sinks into the wall so they fuse. At least half the wall thickness and one line width is always used.' },
      ],
    },
    {
      type: 'group', id: 'printing', label: 'Printing', collapsed: true, help: 'Makes the hair slice and print reliably.', children: [
        { type: 'bool', key: 'printAware', label: 'Print-aware', default: true, help: 'Keeps strands flat and horizontal and snaps them to your layers, so each one prints as a clean line. Recommended for hair that will be printed.' },
        { type: 'number', key: 'nozzle', label: 'Nozzle / line width', unit: 'mm', min: 0.1, step: 0.05, default: 0.4, help: 'Your printer nozzle size. Strands narrower than 1.4 times this are made wider so the slicer does not drop them.' },
        { type: 'number', key: 'layerHeight', label: 'Layer height', unit: 'mm', min: 0.02, step: 0.02, default: 0.2, help: 'Your slicer layer height. Strands are placed on whole layers.' },
        { type: 'number', key: 'firstLayer', label: 'First layer height', unit: 'mm', min: 0.02, step: 0.02, default: 0.2, help: 'Your slicer first layer height. Layers are counted up from the lowest point of the model, which the slicer places on the bed.' },
        { type: 'bool', key: 'snapThickness', label: 'Snap to layers', default: true, help: 'Rounds strand thickness to a whole number of layers. Always on in print-aware mode.' },
      ],
    },
    {
      type: 'group', id: 'pattern', label: 'Pattern and edges', collapsed: true, help: 'Where strands are rooted and how they are shaped.', children: [
        { type: 'enum', key: 'distribution', label: 'Pattern', display: 'segmented', default: 'rows', options: [{ value: 'poisson', label: 'Random' }, { value: 'grid', label: 'Grid' }, { value: 'rows', label: 'Rows' }], help: 'Random: natural, evenly spread. Grid: regular. Rows: neat horizontal rows on print layers, best for combs.' },
        { type: 'enum', key: 'densityMode', label: 'Control', display: 'segmented', default: 'density', options: [{ value: 'density', label: 'Density' }, { value: 'spacing', label: 'Spacing' }], help: 'Set how many strands there are either by density (per square cm) or by the distance between strands.' },
        { type: 'number', key: 'spacing', label: 'Spacing', unit: 'mm', min: 0.1, step: 0.1, default: 2.2, visibleWhen: (v) => v.densityMode === 'spacing', help: 'Approximate distance between neighbouring strands.' },
        { type: 'number', key: 'seed', label: 'Seed', step: 1, default: 1, help: 'Changes the random layout. The same seed always gives the same hair.' },
        { type: 'number', key: 'edgeMargin', label: 'Edge margin', unit: 'mm', min: 0, step: 0.5, default: 0, help: 'Extra empty border kept clear around the selected faces. Strands are always kept at least their own width away from an edge.' },
        { type: 'enum', key: 'lengthMode', label: 'Length mode', display: 'segmented', default: 'toWall', options: [{ value: 'fixed', label: 'Fixed' }, { value: 'toWall', label: 'To wall' }], help: 'Fixed: every strand is as long as set. To wall: strands are extended or shortened to meet the wall.' },
        { type: 'enum', key: 'section', label: 'Section', display: 'segmented', default: 'rect', options: [{ value: 'rect', label: 'Flat' }, { value: 'round', label: 'Round' }, { value: 'diamond', label: 'Diamond' }], help: 'Cross-section shape of a strand. Flat prints best.' },
        { type: 'number', key: 'taper', label: 'Taper', unit: '%', min: 0, max: 90, step: 5, default: 0, help: 'How much thinner the tip is than the root, in percent. 0 keeps the strand the same size all along.' },
        { type: 'number', key: 'rootFlare', label: 'Root flare', unit: '%', min: 0, max: 300, step: 10, default: 0, help: 'Makes each strand wider where it meets the surface, for a stronger join.' },
        { type: 'number', key: 'rootSink', label: 'Root depth', unit: 'mm', min: 0, step: 0.1, default: 0, help: 'How deep each strand root is buried in the body so it fuses. 0 picks a safe depth automatically (at least 0.6 mm).' },
      ],
    },
    {
      type: 'group', id: 'styling', label: 'Styling', collapsed: true, help: 'Natural-looking variation.', children: [
        { type: 'number', key: 'waveAmp', label: 'Wave size', unit: 'mm', min: 0, step: 0.1, default: 0, help: 'Sideways wiggle of each strand, in mm. 0 is straight.' },
        { type: 'number', key: 'waveFreq', label: 'Wave count', min: 0, step: 0.1, default: 1, visibleWhen: (v) => (v.waveAmp as number) > 0, help: 'Wiggles per 10 mm of strand length.' },
        { type: 'number', key: 'curl', label: 'Curl', unit: 'deg', step: 10, default: 0, help: 'How much each strand bends along its length, in degrees. Negative curls the other way.' },
        { type: 'number', key: 'clumpCount', label: 'Clumps', min: 0, max: 200, step: 1, default: 0, help: 'Number of bundles strands gather into. 0 for none.' },
        { type: 'number', key: 'clumpStrength', label: 'Clump strength', min: 0, max: 1, step: 0.05, default: 0.5, visibleWhen: (v) => (v.clumpCount as number) > 0, help: 'How strongly strands pull toward the centre of their bundle (0 to 1).' },
        { type: 'number', key: 'droop', label: 'Gravity droop', unit: 'mm', min: 0, step: 0.5, default: 0, visibleWhen: (v) => !v.printAware, help: 'How far the strand tips sag downward, in mm.' },
        { type: 'number', key: 'lengthVar', label: 'Length variation', unit: '%', min: 0, max: 90, step: 5, default: 0, help: 'Random difference in strand length, in percent of the length.' },
      ],
    },
    {
      type: 'group', id: 'advanced', label: 'Advanced', collapsed: true, help: 'Less common settings.', children: [
        { type: 'vector3', key: 'wallDir', label: 'Plane normal', step: 0.1, default: [0, 0, 0], visibleWhen: (v) => !!v.wall && v.wallMode === 'planar', help: 'Direction the flat wall faces (X, Y, Z). 0, 0, 0 picks it from the strand directions.' },
        { type: 'number', key: 'wallTop', label: 'Wall top margin', unit: 'mm', min: 0, step: 1, default: 2, visibleWhen: (v) => !!v.wall, help: 'How far the wall extends above the highest strand. The top is cut flat.' },
        { type: 'number', key: 'wallBottom', label: 'Wall bottom margin', unit: 'mm', min: 0, step: 1, default: 2, visibleWhen: (v) => !!v.wall, help: 'How far the wall extends below the lowest strand. The bottom is cut flat.' },
        { type: 'bool', key: 'wallSeparate', label: 'Separate wall', default: false, visibleWhen: (v) => !!v.wall, help: 'Keeps the wall as its own body so you can hide or delete it before exporting.' },
        { type: 'bool', key: 'merge', label: 'Merge into body', default: true, help: 'Joins the hair to the body as one solid. Turn off to get the hair as a separate body.' },
      ],
    },
  ],
}

/** Plain-language advice shown in the dialog (never blocks OK). */
export function hairWarnings(p: HairParams): string[] {
  const out: string[] = []
  const minW = p.nozzle * 1.4
  if (p.width < minW - 1e-9) out.push(`Width ${p.width} mm is below the printable minimum of ${minW.toFixed(2)} mm for a ${p.nozzle} mm nozzle, so ${minW.toFixed(2)} mm is used. Thinner strands are dropped by slicers.`)
  if (p.thickness < p.layerHeight - 1e-9 && !p.printAware) out.push(`Thickness ${p.thickness} mm is below one layer (${p.layerHeight} mm); it may not print.`)
  if (p.wall && p.wallThickness < p.nozzle * 1.9) out.push(`Wall thickness ${p.wallThickness} mm is under two printed lines (${(p.nozzle * 2).toFixed(1)} mm); it may be dropped by the slicer.`)
  return out
}
