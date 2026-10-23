/** Declarative ribbon layout. Items reference command ids from commands.ts. */
export interface RibbonItem {
  /** large button: icon above label */
  cmd?: string
  /** dropdown menu entries (command ids) shown via the caret */
  menu?: string[]
  /** a vertical stack of small buttons */
  stack?: string[]
}
export interface RibbonGroup { label: string; items: RibbonItem[] }
export interface RibbonTab { id: string; label: string; disabled?: boolean; contextual?: boolean; groups: RibbonGroup[] }

export const RIBBON_TABS: RibbonTab[] = [
  {
    id: 'solid',
    label: 'Solid',
    groups: [
      { label: 'File', items: [{ stack: ['file.new', 'file.open', 'file.save'] }, { cmd: 'file.import' }, { cmd: 'file.export' }] },
      {
        label: 'Create',
        items: [
          { cmd: 'sketch.create' },
          { cmd: 'solid.extrude' },
          { cmd: 'solid.revolve' },
          { cmd: 'solid.sweep', menu: ['solid.sweep', 'solid.loft'] },
          { cmd: 'solid.box', menu: ['solid.box', 'solid.cylinder'] },
        ],
      },
      {
        label: 'Modify',
        items: [{ cmd: 'solid.fillet' }, { cmd: 'solid.chamfer' }, { cmd: 'solid.shell' }, { cmd: 'solid.move' }, { cmd: 'solid.combine', menu: ['solid.join', 'solid.cut', 'solid.intersect'] }],
      },
      { label: 'Construct', items: [{ cmd: 'construct.plane' }, { cmd: 'construct.axis' }] },
      { label: 'Inspect', items: [{ cmd: 'inspect.measure' }, { cmd: 'inspect.section' }] },
    ],
  },
  { id: 'surface', label: 'Surface', disabled: true, groups: [] },
  {
    id: 'mesh',
    label: 'Mesh',
    groups: [
      { label: 'Import', items: [{ cmd: 'mesh.import' }] },
      { label: 'Modify', items: [{ cmd: 'mesh.remesh' }, { cmd: 'mesh.smooth' }, { cmd: 'mesh.reduce' }, { cmd: 'mesh.planeCut' }] },
      { label: 'Prepare', items: [{ cmd: 'mesh.repair' }, { cmd: 'mesh.makeSolid' }] },
      { label: 'Inspect', items: [{ cmd: 'inspect.measure' }, { cmd: 'inspect.section' }] },
    ],
  },
  {
    id: 'hair',
    label: 'Hair',
    groups: [
      { label: 'Create', items: [{ cmd: 'hair.create' }, { cmd: 'hair.faces' }] },
      { label: 'Sacrificial wall', items: [{ cmd: 'hair.wall' }] },
      { label: 'Preview', items: [{ cmd: 'hair.preview' }] },
    ],
  },
  {
    id: 'sketch',
    label: 'Sketch',
    contextual: true,
    groups: [
      { label: 'Create', items: [{ cmd: 'sketch.line' }, { cmd: 'sketch.rect' }, { cmd: 'sketch.circle' }, { cmd: 'sketch.arc' }] },
      { label: 'Modify', items: [{ cmd: 'sketch.trim' }, { cmd: 'sketch.offset' }] },
      {
        label: 'Constraints',
        items: [
          { stack: ['sketch.coincident', 'sketch.horizontal', 'sketch.parallel'] },
          { stack: ['sketch.perpendicular', 'sketch.tangent', 'sketch.equal'] },
          { cmd: 'sketch.fix' },
        ],
      },
      { label: 'Dimension', items: [{ cmd: 'sketch.dimension' }, { cmd: 'sketch.project' }] },
      { label: 'Finish', items: [{ cmd: 'sketch.finish' }] },
    ],
  },
]
