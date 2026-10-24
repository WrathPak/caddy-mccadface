/** Dialog schemas of the surface generators (fur, scales, spikes, grass), with presets and plain-language help. */
import type { FurParams, GrassParams, ScaleParams, SpikeParams } from '@/kernel/generators/params'
import type { ParamDef, ParamSchema, ParamValue } from '@/ui/schema'

const REGION: ParamDef = {
  type: 'selection-ref', key: 'region', label: 'Surface', accepts: ['face'], multiple: true, required: true, default: [],
  help: 'The faces to cover. Click faces in the viewport, or use the Face, Brush and Fill tools to paint an area.',
}

const seed = (what: string): ParamDef => ({ type: 'number', key: 'seed', label: 'Seed', step: 1, default: 1, help: `Changes the random layout of the ${what}. The same seed always gives the same result.` })
const edgeMargin: ParamDef = { type: 'number', key: 'edgeMargin', label: 'Edge margin', unit: 'mm', min: 0, step: 0.5, default: 0, help: 'Extra empty border kept clear around the selected faces. Pieces that would hang over an edge are always left out.' }
const rootSink: ParamDef = { type: 'number', key: 'rootSink', label: 'Root depth', unit: 'mm', min: 0, step: 0.1, default: 0, help: 'How deep each piece is buried in the body so it fuses. 0 picks a safe depth automatically (at least 0.6 mm).' }
const merge: ParamDef = { type: 'bool', key: 'merge', label: 'Merge into body', default: true, help: 'Joins the result to the body as one solid. Turn off to get it as a separate body.' }

const printing = (printAwareHelp: string): ParamDef => ({
  type: 'group', id: 'printing', label: 'Printing', collapsed: true, help: 'Settings that keep the result printable.', children: [
    { type: 'bool', key: 'printAware', label: 'Print-aware', default: true, help: printAwareHelp },
    { type: 'number', key: 'nozzle', label: 'Nozzle / line width', unit: 'mm', min: 0.1, step: 0.05, default: 0.4, help: 'Your printer nozzle size. Thin parts are kept at least about this wide so the slicer does not drop them.' },
    { type: 'number', key: 'layerHeight', label: 'Layer height', unit: 'mm', min: 0.02, step: 0.02, default: 0.2, help: 'Your slicer layer height.' },
  ],
})

const presetKeys = <T extends Record<string, ParamValue>>(base: T) => (over: Partial<Record<keyof T, ParamValue>>): Record<string, ParamValue> => ({ ...base, ...over } as Record<string, ParamValue>)

// ---------------------------------------------------------------- spikes

const SPIKE_BASE: Record<string, ParamValue> = {
  shape: 'cone', height: 6, baseWidth: 1.6, tipWidth: 0, sizeVar: 25, density: 20, distribution: 'poisson', tilt: 8, direction: 'normal',
}
const spike = presetKeys(SPIKE_BASE)

export const SPIKE_PRESETS = [
  { id: 'hedgehog', label: 'Hedgehog (dense cones)', help: 'Many slim cones of slightly different sizes, a little tilted, like a hedgehog or a cactus.', values: spike({}) },
  { id: 'pyramids', label: 'Pyramids (regular grid)', help: 'Square pyramids in a neat grid. A classic decorative texture and a grippy surface.', values: spike({ shape: 'square', height: 3, baseWidth: 3, density: 10, distribution: 'grid', sizeVar: 0, tilt: 0 }) },
  { id: 'thorns', label: 'Thorns (tall, sparse)', help: 'A few tall cones of very different sizes.', values: spike({ height: 10, baseWidth: 2.4, density: 3, sizeVar: 40, tilt: 12 }) },
  { id: 'studs', label: 'Studs (blunt tips)', help: 'Short cones with a flat top, like punk studs. Prints without a fragile point.', values: spike({ height: 4, baseWidth: 5, tipWidth: 1.2, density: 4, distribution: 'grid', sizeVar: 0, tilt: 0 }) },
  { id: 'rough', label: 'Rough grip (tiny triangles)', help: 'Very small three-sided spikes that make a rough, grippy surface.', values: spike({ shape: 'tri', height: 1.2, baseWidth: 1.2, density: 80, sizeVar: 20, tilt: 0 }) },
] as const

export const spikeSchema: ParamSchema = {
  id: 'spikes',
  title: 'Spikes',
  warnings: (v) => spikeWarnings(v as unknown as SpikeParams),
  params: [
    REGION,
    { type: 'preset', key: 'preset', label: 'Presets', default: 'hedgehog', presets: SPIKE_PRESETS.map((p) => ({ id: p.id, label: p.label, help: p.help, values: p.values })), help: 'Start from a ready-made look. This fills in the settings below; you can still change any of them.' },
    {
      type: 'group', id: 'shape', label: 'Shape', help: 'What each spike looks like.', children: [
        { type: 'enum', key: 'shape', label: 'Shape', display: 'segmented', default: 'cone', options: [{ value: 'cone', label: 'Cone' }, { value: 'tri', label: '3 sides' }, { value: 'square', label: '4 sides' }, { value: 'hex', label: '6 sides' }], help: 'A round cone, or a pyramid with three, four or six sides.' },
        { type: 'number', key: 'height', label: 'Height', unit: 'mm', min: 0.3, step: 0.5, default: 6, help: 'How far each spike stands out from the surface.' },
        { type: 'number', key: 'baseWidth', label: 'Base width', unit: 'mm', min: 0.3, step: 0.1, default: 1.6, help: 'Width of each spike where it meets the surface.' },
        { type: 'number', key: 'tipWidth', label: 'Tip width', unit: 'mm', min: 0, step: 0.1, default: 0, help: 'Width of a flat top. 0 keeps the tip sharp.' },
        { type: 'number', key: 'sizeVar', label: 'Size variation', unit: '%', min: 0, max: 80, step: 5, default: 25, help: 'Random difference in size between spikes, in percent. 0 makes them all the same.' },
      ],
    },
    {
      type: 'group', id: 'placement', label: 'Placement', help: 'How many spikes there are and where they point.', children: [
        { type: 'number', key: 'density', label: 'Density /cm2', min: 0.1, step: 1, default: 20, help: 'Spikes per square centimetre of surface. Higher is fuller but heavier.' },
        { type: 'enum', key: 'distribution', label: 'Pattern', display: 'segmented', default: 'poisson', options: [{ value: 'poisson', label: 'Random' }, { value: 'grid', label: 'Grid' }], help: 'Random: natural, evenly spread. Grid: regular rows.' },
        { type: 'enum', key: 'direction', label: 'Direction', display: 'segmented', default: 'normal', options: [{ value: 'normal', label: 'Off the surface' }, { value: 'up', label: 'Straight up' }], help: 'Spikes can stand straight out of the surface, or all point up (best for printing on sloped faces).' },
        { type: 'number', key: 'tilt', label: 'Lean', unit: 'deg', min: 0, max: 60, step: 1, default: 8, help: 'Random tilt of each spike, in degrees. 0 makes them perfectly regular.' },
        seed('spikes'),
        edgeMargin,
      ],
    },
    printing('Tilts spikes toward upright so the underside never overhangs more than 45 degrees, and leaves out spikes on faces that point down. Recommended for anything that will be printed.'),
    { type: 'group', id: 'advanced', label: 'Advanced', collapsed: true, help: 'Less common settings.', children: [rootSink, merge] },
  ],
}

export function spikeWarnings(p: SpikeParams): string[] {
  const out: string[] = []
  if (p.tipWidth > 0 && p.tipWidth < p.nozzle) out.push(`A tip ${p.tipWidth} mm wide is narrower than your ${p.nozzle} mm nozzle and will print as a point anyway.`)
  if (p.baseWidth < p.nozzle * 2) out.push(`Spikes ${p.baseWidth} mm wide are under two printed lines (${(p.nozzle * 2).toFixed(1)} mm) and may come out rough.`)
  return out
}

// ---------------------------------------------------------------- scales

const SCALE_BASE: Record<string, ParamValue> = {
  shape: 'round', width: 6, length: 6, height: 1.6, overlap: 35, flow: 'down', flowDir: [0, 0, -1], stagger: true, jitter: 0, sizeVar: 0,
}
const scale = presetKeys(SCALE_BASE)

export const SCALE_PRESETS = [
  { id: 'fish', label: 'Fish scales (round)', help: 'Round scales in staggered rows, each one overlapping the next row.', values: scale({}) },
  { id: 'dragon', label: 'Dragon scales (pointed)', help: 'Larger pointed scales with a high free edge.', values: scale({ shape: 'pointed', width: 8, length: 10, height: 2.5, overlap: 40, jitter: 4, sizeVar: 10 }) },
  { id: 'roof', label: 'Roof tiles (shield)', help: 'Shield shaped tiles with a square back, like slate or clay roof tiles.', values: scale({ shape: 'shield', width: 8, length: 8, height: 1.4, overlap: 50 }) },
  { id: 'armor', label: 'Armor plates (hex)', help: 'Small hexagonal plates close together.', values: scale({ shape: 'hex', width: 6, length: 7, height: 1.2, overlap: 25 }) },
  { id: 'pine', label: 'Pine cone (tall, from below)', help: 'Scales that point up and away, like the scales of a pine cone.', values: scale({ shape: 'pointed', width: 5, length: 6, height: 2, overlap: 30, flow: 'up', jitter: 6, sizeVar: 10 }) },
] as const

export const scaleSchema: ParamSchema = {
  id: 'scales',
  title: 'Scales',
  warnings: (v) => scaleWarnings(v as unknown as ScaleParams),
  params: [
    REGION,
    { type: 'preset', key: 'preset', label: 'Presets', default: 'fish', presets: SCALE_PRESETS.map((p) => ({ id: p.id, label: p.label, help: p.help, values: p.values })), help: 'Start from a ready-made look. This fills in the settings below; you can still change any of them.' },
    {
      type: 'group', id: 'shape', label: 'Shape', help: 'What each scale looks like.', children: [
        { type: 'enum', key: 'shape', label: 'Shape', display: 'select', default: 'round', options: [{ value: 'round', label: 'Round' }, { value: 'pointed', label: 'Pointed' }, { value: 'shield', label: 'Shield' }, { value: 'hex', label: 'Hexagon' }], help: 'The outline of each scale.' },
        { type: 'number', key: 'width', label: 'Width', unit: 'mm', min: 1, step: 0.5, default: 6, help: 'Size of a scale across the flow.' },
        { type: 'number', key: 'length', label: 'Length', unit: 'mm', min: 1, step: 0.5, default: 6, help: 'Size of a scale along the flow.' },
        { type: 'number', key: 'height', label: 'Height', unit: 'mm', min: 0.4, step: 0.2, default: 1.6, help: 'How high the free edge of a scale stands above the surface. The scale slopes down to the surface behind it.' },
        { type: 'number', key: 'sizeVar', label: 'Size variation', unit: '%', min: 0, max: 60, step: 5, default: 0, help: 'Random difference in size between scales, in percent.' },
      ],
    },
    {
      type: 'group', id: 'layout', label: 'Layout', help: 'How the scales are arranged.', children: [
        { type: 'enum', key: 'flow', label: 'Flow', display: 'segmented', default: 'down', options: [{ value: 'down', label: 'Down' }, { value: 'up', label: 'Up' }, { value: 'custom', label: 'Custom' }], help: 'The way the free edges point, like the way water would run off. On a round part the scales follow the cylinder.' },
        { type: 'vector3', key: 'flowDir', label: 'Direction', step: 0.1, default: [0, 0, -1], visibleWhen: (v) => v.flow === 'custom', help: 'The flow direction as X, Y, Z. Only the direction matters, not the size.' },
        { type: 'number', key: 'overlap', label: 'Overlap', unit: '%', min: 0, max: 80, step: 5, default: 35, help: 'How much of its length each scale tucks under the next row. More overlap gives a tighter, more layered look.' },
        { type: 'bool', key: 'stagger', label: 'Stagger rows', default: true, help: 'Shifts every other row by half a scale, like real scales and roof tiles.' },
        { type: 'number', key: 'jitter', label: 'Irregularity', unit: '%', min: 0, max: 50, step: 5, default: 0, help: 'Random shift of each scale, in percent of its size. 0 is perfectly regular.' },
        seed('scales'),
        edgeMargin,
      ],
    },
    printing('Scales are solid wedges that slope down to the surface, so nothing overhangs. Print-aware also warns about parts that are too small to print.'),
    { type: 'group', id: 'advanced', label: 'Advanced', collapsed: true, help: 'Less common settings.', children: [rootSink, merge] },
  ],
}

export function scaleWarnings(p: ScaleParams): string[] {
  const out: string[] = []
  if (p.height < p.layerHeight * 2) out.push(`A height of ${p.height} mm is under two layers (${(p.layerHeight * 2).toFixed(2)} mm); the scales will barely show.`)
  if (Math.min(p.width, p.length) < p.nozzle * 4) out.push(`Scales smaller than four printed lines (${(p.nozzle * 4).toFixed(1)} mm) lose their shape when printed.`)
  return out
}

// ---------------------------------------------------------------- grass

const GRASS_BASE: Record<string, ParamValue> = {
  height: 10, baseWidth: 1, thickness: 0.5, tipWidth: 0.2, density: 12, distribution: 'poisson', bend: 40, bendVar: 40, heightVar: 30, lean: 6, windStrength: 0, windDir: [1, 0, 0], clumpCount: 0, maxLean: 38,
}
const grass = presetKeys(GRASS_BASE)

export const GRASS_PRESETS = [
  { id: 'lawn', label: 'Lawn (short, dense)', help: 'Short, fairly upright blades close together.', values: grass({ height: 6, baseWidth: 0.8, density: 25, bend: 25, heightVar: 25 }) },
  { id: 'meadow', label: 'Meadow (medium, bendy)', help: 'Medium blades that curve in their own direction.', values: grass({}) },
  { id: 'tall', label: 'Tall grass', help: 'Long blades that arch over.', values: grass({ height: 18, baseWidth: 1.2, density: 6, bend: 70, bendVar: 50, heightVar: 35, maxLean: 55 }) },
  { id: 'wind', label: 'Windswept', help: 'Blades that all lean the same way, like grass in a steady wind.', values: grass({ height: 12, bend: 55, bendVar: 20, windStrength: 0.85, windDir: [1, 0, 0], maxLean: 50 }) },
  { id: 'tufts', label: 'Tufts (bunches)', help: 'Blades gathered into bunches.', values: grass({ height: 10, density: 18, bend: 45, clumpCount: 12 }) },
] as const

export const grassSchema: ParamSchema = {
  id: 'grass',
  title: 'Grass',
  warnings: (v) => grassWarnings(v as unknown as GrassParams),
  params: [
    REGION,
    { type: 'preset', key: 'preset', label: 'Presets', default: 'meadow', presets: GRASS_PRESETS.map((p) => ({ id: p.id, label: p.label, help: p.help, values: p.values })), help: 'Start from a ready-made look. This fills in the settings below; you can still change any of them.' },
    {
      type: 'group', id: 'blades', label: 'Blades', help: 'The size and shape of each blade.', children: [
        { type: 'number', key: 'height', label: 'Height', unit: 'mm', min: 1, step: 1, default: 10, help: 'Length of a blade from the surface to its tip.' },
        { type: 'number', key: 'baseWidth', label: 'Width', unit: 'mm', min: 0.1, step: 0.1, default: 1, help: 'Blade width at the root. Blades narrower than 1.4 times your nozzle are widened so they print.' },
        { type: 'number', key: 'thickness', label: 'Thickness', unit: 'mm', min: 0.1, step: 0.1, default: 0.5, help: 'How thick a blade is. Thin blades bend, thick ones look chunky.' },
        { type: 'number', key: 'tipWidth', label: 'Tip width', unit: 'mm', min: 0, step: 0.1, default: 0.2, help: 'Width at the tip. A small value gives a pointed blade.' },
        { type: 'number', key: 'heightVar', label: 'Height variation', unit: '%', min: 0, max: 80, step: 5, default: 30, help: 'Random difference in blade length, in percent.' },
      ],
    },
    {
      type: 'group', id: 'bend', label: 'Bend and wind', help: 'How the blades curve.', children: [
        { type: 'number', key: 'bend', label: 'Bend', unit: 'deg', min: 0, max: 120, step: 5, default: 40, help: 'How far a blade curves between its root and its tip, in degrees. 0 makes straight blades.' },
        { type: 'number', key: 'bendVar', label: 'Bend variation', unit: '%', min: 0, max: 100, step: 5, default: 40, help: 'Random difference in bend between blades, in percent.' },
        { type: 'number', key: 'lean', label: 'Root lean', unit: 'deg', min: 0, max: 40, step: 1, default: 6, help: 'Random tilt of each blade at the root, in degrees.' },
        { type: 'number', key: 'windStrength', label: 'Wind', min: 0, max: 1, step: 0.05, default: 0, help: 'How strongly blades lean the same way (0 to 1). 0 lets every blade choose its own direction.' },
        { type: 'vector3', key: 'windDir', label: 'Wind direction', step: 0.1, default: [1, 0, 0], visibleWhen: (v) => (v.windStrength as number) > 0, help: 'The direction the wind blows, as X, Y, Z.' },
        { type: 'number', key: 'clumpCount', label: 'Bunches', min: 0, max: 100, step: 1, default: 0, help: 'Number of bunches blades gather into. 0 for none.' },
      ],
    },
    {
      type: 'group', id: 'placement', label: 'Placement', help: 'How many blades there are.', children: [
        { type: 'number', key: 'density', label: 'Density /cm2', min: 0.1, step: 1, default: 12, help: 'Blades per square centimetre of surface.' },
        { type: 'enum', key: 'distribution', label: 'Pattern', display: 'segmented', default: 'poisson', options: [{ value: 'poisson', label: 'Random' }, { value: 'grid', label: 'Grid' }], help: 'Random: natural, evenly spread. Grid: regular.' },
        seed('blades'),
        edgeMargin,
      ],
    },
    {
      type: 'group', id: 'printing', label: 'Printing', collapsed: true, help: 'Settings that keep the result printable.', children: [
        { type: 'bool', key: 'printAware', label: 'Print-aware', default: true, help: 'Stops blades from leaning further than the limit below, so the underside of a bent blade never overhangs too much, and leaves out blades on faces that point down.' },
        { type: 'number', key: 'maxLean', label: 'Steepest lean', unit: 'deg', min: 10, max: 80, step: 1, default: 38, visibleWhen: (v) => !!v.printAware, help: 'The most a blade may lean from vertical, in degrees. About 40 prints without support on most printers.' },
        { type: 'number', key: 'nozzle', label: 'Nozzle / line width', unit: 'mm', min: 0.1, step: 0.05, default: 0.4, help: 'Your printer nozzle size.' },
        { type: 'number', key: 'layerHeight', label: 'Layer height', unit: 'mm', min: 0.02, step: 0.02, default: 0.2, help: 'Your slicer layer height.' },
      ],
    },
    { type: 'group', id: 'advanced', label: 'Advanced', collapsed: true, help: 'Less common settings.', children: [rootSink, merge] },
  ],
}

export function grassWarnings(p: GrassParams): string[] {
  const out: string[] = []
  if (p.baseWidth < p.nozzle * 1.4 - 1e-9) out.push(`A width of ${p.baseWidth} mm is below the printable minimum of ${(p.nozzle * 1.4).toFixed(2)} mm for a ${p.nozzle} mm nozzle, so ${(p.nozzle * 1.4).toFixed(2)} mm is used.`)
  if (p.thickness < p.layerHeight - 1e-9) out.push(`A thickness of ${p.thickness} mm is under one layer (${p.layerHeight} mm); blades may not print.`)
  return out
}

// ---------------------------------------------------------------- fur

const FUR_BASE: Record<string, ParamValue> = {
  variant: 'standard', length: 5, thickness: 0.5, density: 60, taper: 55, clumps: 0, clumpStrength: 0.5, curl: 0, spread: 18, lengthVar: 25, follow: 0.3, wallThickness: 0.8,
}
const fur = presetKeys(FUR_BASE)

export const FUR_PRESETS = [
  { id: 'short', label: 'Short fur', help: 'Short, dense, tapered strands that follow the surface. Good all round.', values: fur({}) },
  { id: 'plush', label: 'Plush (clumped)', help: 'Soft looking fur where strands gather into small clumps.', values: fur({ length: 7, thickness: 0.6, density: 45, clumps: 6, clumpStrength: 0.6, curl: 10, spread: 22 }) },
  { id: 'up', label: 'Up-facing fur (no wall)', help: 'For flat tops and gentle slopes: strands stand up, so they print with no wall and no support.', values: fur({ variant: 'upFacing', length: 6, density: 50, follow: 0.3, spread: 12 }) },
  { id: 'wall', label: 'Printable fur with wall', help: 'For side faces: flat horizontal strands that end in a thin sacrificial wall, so they print without support. Cut the wall away afterwards.', values: fur({ variant: 'wall', length: 8, thickness: 0.6, density: 14, taper: 30, spread: 8 }) },
  { id: 'shaggy', label: 'Shaggy (long)', help: 'Long, curly strands. Decorative; best on up-facing surfaces.', values: fur({ variant: 'upFacing', length: 14, thickness: 0.7, density: 20, taper: 70, curl: 40, spread: 30, lengthVar: 40, follow: 0.5, clumps: 3 }) },
] as const

export const furSchema: ParamSchema = {
  id: 'fur',
  title: 'Fur',
  warnings: (v) => furWarnings(v as unknown as FurParams),
  params: [
    REGION,
    { type: 'preset', key: 'preset', label: 'Presets', default: 'short', presets: FUR_PRESETS.map((p) => ({ id: p.id, label: p.label, help: p.help, values: p.values })), help: 'Start from a ready-made look. This fills in the settings below; you can still change any of them.' },
    {
      type: 'group', id: 'type', label: 'Type', help: 'How the fur is made to print.', children: [
        { type: 'enum', key: 'variant', label: 'Variant', display: 'list', default: 'standard', options: [
          { value: 'standard', label: 'Follow the surface', desc: 'Strands grow off each face. For looks; may need support.' },
          { value: 'upFacing', label: 'Up-facing, no wall', desc: 'Strands stand up. Prints without a wall or support.' },
          { value: 'wall', label: 'Side faces, with wall', desc: 'Flat strands ending in a thin sacrificial wall.' },
        ], help: 'Choose by where the fur goes. Up-facing fur needs no wall. Fur on side faces prints best with the sacrificial wall.' },
        { type: 'number', key: 'follow', label: 'Follow surface', min: 0, max: 1, step: 0.05, default: 0.3, visibleWhen: (v) => v.variant === 'upFacing', help: 'How much strands lean with the surface instead of standing straight up (0 to 1).' },
        { type: 'number', key: 'wallThickness', label: 'Wall thickness', unit: 'mm', min: 0.4, step: 0.2, default: 0.8, visibleWhen: (v) => v.variant === 'wall', help: 'Thickness of the sacrificial wall. 0.8 mm is two lines from a 0.4 mm nozzle.' },
      ],
    },
    {
      type: 'group', id: 'strands', label: 'Strands', help: 'How long, thick and dense the fur is.', children: [
        { type: 'number', key: 'length', label: 'Length', unit: 'mm', min: 0.5, step: 0.5, default: 5, help: 'How far strands reach from the surface.' },
        { type: 'number', key: 'thickness', label: 'Thickness', unit: 'mm', min: 0.1, step: 0.05, default: 0.5, help: 'Strand thickness at the root. Strands narrower than 1.4 times your nozzle are widened so they print.' },
        { type: 'number', key: 'density', label: 'Density /cm2', min: 0.1, step: 5, default: 60, help: 'Strands per square centimetre of surface. Higher is fuller but heavier.' },
        { type: 'number', key: 'taper', label: 'Taper', unit: '%', min: 0, max: 90, step: 5, default: 55, help: 'How much thinner the tip is than the root, in percent.' },
        { type: 'number', key: 'lengthVar', label: 'Length variation', unit: '%', min: 0, max: 80, step: 5, default: 25, help: 'Random difference in strand length, in percent.' },
      ],
    },
    {
      type: 'group', id: 'styling', label: 'Styling', collapsed: true, help: 'Natural looking variation.', children: [
        { type: 'number', key: 'spread', label: 'Spread', unit: 'deg', min: 0, max: 60, step: 1, default: 18, help: 'Random tilt of each strand, in degrees.' },
        { type: 'number', key: 'curl', label: 'Curl', unit: 'deg', step: 10, default: 0, help: 'How much each strand bends along its length, in degrees.' },
        { type: 'number', key: 'clumps', label: 'Clumps /cm2', min: 0, max: 50, step: 0.5, default: 0, help: 'Bundles that strands gather into, per square centimetre. 0 for none.' },
        { type: 'number', key: 'clumpStrength', label: 'Clump strength', min: 0, max: 1, step: 0.05, default: 0.5, visibleWhen: (v) => (v.clumps as number) > 0, help: 'How strongly strands pull toward the centre of their clump (0 to 1).' },
        seed('fur'),
        edgeMargin,
      ],
    },
    printing('Keeps strands thick enough for your nozzle. The wall variant also keeps strands flat and horizontal and snaps them to your layers.'),
    { type: 'group', id: 'advanced', label: 'Advanced', collapsed: true, help: 'Less common settings.', children: [rootSink, merge] },
  ],
}

export function furWarnings(p: FurParams): string[] {
  const out: string[] = []
  const minW = p.nozzle * 1.4
  if (p.thickness < minW - 1e-9) out.push(`Thickness ${p.thickness} mm is below the printable minimum of ${minW.toFixed(2)} mm for a ${p.nozzle} mm nozzle, so ${minW.toFixed(2)} mm is used.`)
  if (p.variant === 'wall' && p.wallThickness < p.nozzle * 1.9) out.push(`Wall thickness ${p.wallThickness} mm is under two printed lines (${(p.nozzle * 2).toFixed(1)} mm); it may be dropped by the slicer.`)
  return out
}

export const GEN_SCHEMAS = { fur: furSchema, scales: scaleSchema, spikes: spikeSchema, grass: grassSchema } as const
