/** Hair feature: parameter schema and the resolved (numeric) parameter shape shared with the worker. */
import type { ParamSchema } from '@/ui/schema'

export type V3 = [number, number, number]

export interface HairParams {
  // distribution
  distribution: 'poisson' | 'grid' | 'rows'
  densityMode: 'density' | 'spacing'
  density: number
  spacing: number
  seed: number
  edgeMargin: number
  layerHeight: number
  // direction
  dirMode: 'normal' | 'fixed' | 'radial' | 'point'
  fixedDir: V3
  axisMode: 'worldX' | 'worldY' | 'worldZ' | 'edge' | 'points'
  axisP1: V3
  axisP2: V3
  targetPoint: V3
  normalBlend: number
  printAware: boolean
  // shape
  lengthMode: 'fixed' | 'toWall'
  length: number
  section: 'rect' | 'round' | 'diamond'
  width: number
  thickness: number
  snapThickness: boolean
  taper: number
  rootFlare: number
  // styling
  waveAmp: number
  waveFreq: number
  curl: number
  jitter: number
  clumpCount: number
  clumpStrength: number
  droop: number
  lengthVar: number
  // wall
  wall: boolean
  wallMode: 'follow' | 'planar' | 'cylindrical'
  wallThickness: number
  tipOverlap: number
  wallDir: V3
  wallTop: number
  wallBottom: number
  wallSeparate: boolean
  // output
  merge: boolean
}

export interface HairValues extends HairParams {
  region: string[]
  axisEdge: string[]
}

export const hairSchema: ParamSchema = {
  id: 'hair',
  title: 'Hair',
  params: [
    { type: 'selection-ref', key: 'region', label: 'Surface', accepts: ['face'], multiple: true, default: [] },
    {
      type: 'group', label: 'Distribution', children: [
        { type: 'enum', key: 'distribution', label: 'Pattern', display: 'segmented', default: 'poisson', options: [{ value: 'poisson', label: 'Poisson' }, { value: 'grid', label: 'Grid' }, { value: 'rows', label: 'Rows' }] },
        { type: 'enum', key: 'densityMode', label: 'Control', display: 'segmented', default: 'density', options: [{ value: 'density', label: 'Density' }, { value: 'spacing', label: 'Spacing' }] },
        { type: 'number', key: 'density', label: 'Density /cm2', min: 0.05, step: 1, default: 20, visibleWhen: (v) => v.densityMode === 'density' },
        { type: 'number', key: 'spacing', label: 'Spacing', unit: 'mm', min: 0.1, step: 0.1, default: 2.2, visibleWhen: (v) => v.densityMode === 'spacing' },
        { type: 'number', key: 'seed', label: 'Seed', step: 1, default: 1 },
        { type: 'number', key: 'edgeMargin', label: 'Edge margin', unit: 'mm', min: 0, step: 0.5, default: 0 },
      ],
    },
    {
      type: 'group', label: 'Direction', children: [
        { type: 'enum', key: 'dirMode', label: 'Mode', display: 'select', default: 'normal', options: [{ value: 'normal', label: 'Surface normal' }, { value: 'fixed', label: 'Fixed vector' }, { value: 'radial', label: 'Radial from axis' }, { value: 'point', label: 'Toward point' }] },
        { type: 'vector3', key: 'fixedDir', label: 'Vector', step: 0.1, default: [0, 1, 0], visibleWhen: (v) => v.dirMode === 'fixed' },
        { type: 'enum', key: 'axisMode', label: 'Axis', display: 'select', default: 'worldZ', visibleWhen: (v) => v.dirMode === 'radial', options: [{ value: 'worldX', label: 'World X' }, { value: 'worldY', label: 'World Y' }, { value: 'worldZ', label: 'World Z' }, { value: 'edge', label: 'Edge' }, { value: 'points', label: '2 points' }] },
        { type: 'selection-ref', key: 'axisEdge', label: 'Axis edge', accepts: ['edge'], default: [], visibleWhen: (v) => v.dirMode === 'radial' && v.axisMode === 'edge' },
        { type: 'vector3', key: 'axisP1', label: 'Point 1', unit: 'mm', step: 1, default: [0, 0, 0], visibleWhen: (v) => v.dirMode === 'radial' && v.axisMode === 'points' },
        { type: 'vector3', key: 'axisP2', label: 'Point 2', unit: 'mm', step: 1, default: [0, 0, 10], visibleWhen: (v) => v.dirMode === 'radial' && v.axisMode === 'points' },
        { type: 'vector3', key: 'targetPoint', label: 'Target', unit: 'mm', step: 1, default: [0, 0, 0], visibleWhen: (v) => v.dirMode === 'point' },
        { type: 'number', key: 'normalBlend', label: 'Normal blend', min: 0, max: 1, step: 0.05, default: 0, visibleWhen: (v) => v.dirMode !== 'normal' },
        { type: 'bool', key: 'printAware', label: 'Print-aware (horizontal)', default: false },
      ],
    },
    {
      type: 'group', label: 'Shape', children: [
        { type: 'enum', key: 'lengthMode', label: 'Length', display: 'segmented', default: 'fixed', options: [{ value: 'fixed', label: 'Fixed' }, { value: 'toWall', label: 'To wall' }] },
        { type: 'number', key: 'length', label: 'Length', unit: 'mm', min: 0.5, step: 1, default: 25 },
        { type: 'enum', key: 'section', label: 'Section', display: 'segmented', default: 'rect', options: [{ value: 'rect', label: 'Rect' }, { value: 'round', label: 'Round' }, { value: 'diamond', label: 'Diamond' }] },
        { type: 'number', key: 'width', label: 'Width', unit: 'mm', min: 0.05, step: 0.05, default: 0.4 },
        { type: 'number', key: 'thickness', label: 'Thickness', unit: 'mm', min: 0.05, step: 0.05, default: 0.2 },
        { type: 'number', key: 'layerHeight', label: 'Layer height', unit: 'mm', min: 0.02, step: 0.02, default: 0.2 },
        { type: 'bool', key: 'snapThickness', label: 'Snap to layer height', default: true },
        { type: 'number', key: 'taper', label: 'Taper', unit: '%', min: 0, max: 90, step: 5, default: 30 },
        { type: 'number', key: 'rootFlare', label: 'Root flare', unit: '%', min: 0, max: 300, step: 10, default: 0 },
      ],
    },
    {
      type: 'group', label: 'Styling', collapsed: true, children: [
        { type: 'number', key: 'waveAmp', label: 'Wave amplitude', unit: 'mm', min: 0, step: 0.1, default: 0 },
        { type: 'number', key: 'waveFreq', label: 'Wave freq /10mm', min: 0, step: 0.1, default: 1, visibleWhen: (v) => (v.waveAmp as number) > 0 },
        { type: 'number', key: 'curl', label: 'Curl', unit: 'deg', step: 10, default: 0 },
        { type: 'number', key: 'jitter', label: 'Jitter angle', unit: 'deg', min: 0, max: 90, step: 1, default: 0 },
        { type: 'number', key: 'clumpCount', label: 'Clumps', min: 0, max: 200, step: 1, default: 0 },
        { type: 'number', key: 'clumpStrength', label: 'Clump strength', min: 0, max: 1, step: 0.05, default: 0.5, visibleWhen: (v) => (v.clumpCount as number) > 0 },
        { type: 'number', key: 'droop', label: 'Gravity droop', unit: 'mm', min: 0, step: 0.5, default: 0, visibleWhen: (v) => !v.printAware },
        { type: 'number', key: 'lengthVar', label: 'Length variation', unit: '%', min: 0, max: 90, step: 5, default: 0 },
      ],
    },
    {
      type: 'group', label: 'Sacrificial wall', children: [
        { type: 'bool', key: 'wall', label: 'Enable wall', default: true },
        { type: 'enum', key: 'wallMode', label: 'Mode', display: 'segmented', default: 'follow', visibleWhen: (v) => !!v.wall, options: [{ value: 'follow', label: 'Follow' }, { value: 'planar', label: 'Planar' }, { value: 'cylindrical', label: 'Cyl.' }] },
        { type: 'vector3', key: 'wallDir', label: 'Plane normal', step: 0.1, default: [0, 0, 0], visibleWhen: (v) => !!v.wall && v.wallMode === 'planar' },
        { type: 'number', key: 'wallThickness', label: 'Thickness', unit: 'mm', min: 0.4, step: 0.2, default: 2, visibleWhen: (v) => !!v.wall },
        { type: 'number', key: 'tipOverlap', label: 'Tip overlap', unit: 'mm', min: 0, step: 0.1, default: 0.6, visibleWhen: (v) => !!v.wall },
        { type: 'number', key: 'wallTop', label: 'Top margin', unit: 'mm', min: 0, step: 1, default: 2, visibleWhen: (v) => !!v.wall },
        { type: 'number', key: 'wallBottom', label: 'Bottom margin', unit: 'mm', min: 0, step: 1, default: 2, visibleWhen: (v) => !!v.wall },
        { type: 'bool', key: 'wallSeparate', label: 'Keep wall as own body', default: false, visibleWhen: (v) => !!v.wall },
      ],
    },
    {
      type: 'group', label: 'Output', children: [
        { type: 'bool', key: 'merge', label: 'Merge into target body', default: true },
      ],
    },
  ],
}
