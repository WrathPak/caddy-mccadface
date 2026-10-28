/** Text of the Getting started and About pages. Local content only. */

export interface InfoSection { title: string; paragraphs?: string[]; steps?: string[]; rows?: [string, string][] }

export const GETTING_STARTED: InfoSection[] = [
  {
    title: 'What this is',
    paragraphs: [
      'CADdy McCADFace is a CAD program that runs in your browser. You draw shapes, turn them into solid parts, and export them for 3D printing or other programs. Your files stay on your computer: nothing is uploaded and there is no account.',
    ],
  },
  {
    title: 'Never used CAD? Make your first part',
    steps: [
      'Click Create Sketch on the Solid tab, then click the highlighted floor plane (XY) in the viewport.',
      'Pick Rectangle (R) and click two corners. Then click Sketch Dimension (D), click a side and type a size.',
      'Click Finish Sketch. Your drawing is now a step in the timeline at the bottom.',
      'Click Extrude (E), click the rectangle, type a distance and press Enter. You have a solid block.',
      'Click Fillet, click an edge, set a radius and press Enter to round it off.',
      'Press Ctrl+S to save, or use File > Export to get an STL for your printer.',
    ],
  },
  {
    title: 'Finding your way around',
    rows: [
      ['Ribbon (top)', 'Tools grouped into workspaces. Hover a button to learn what it does.'],
      ['Browser (left)', 'Everything in the document: bodies, sketches, planes, components.'],
      ['Viewport (middle)', 'The 3D view. Use the cube in the corner to jump to standard views.'],
      ['Timeline (bottom)', 'Each step you took. Double-click one to change it, drag the marker to roll back.'],
      ['Inspector (right)', 'The settings of the tool you are using. Press Enter to accept, Esc to cancel.'],
      ['Command palette', 'Press S and type to search every command by name.'],
    ],
  },
  {
    title: 'Coming from Fusion 360?',
    paragraphs: [
      'The layout will feel familiar: a ribbon of tools, a Browser, a parametric timeline with a rollback marker, sketches with constraints and joints for assemblies. The default mouse style is Fusion\'s (see Settings > Navigation, which also has SolidWorks, Blender and touchpad styles).',
    ],
    rows: [
      ['Workspaces', 'The Design, Surface and Mesh workspaces from Fusion map to the Solid, Surface and Mesh tabs. Print, Drawing and Render have tabs too.'],
      ['Press Pull', 'Press/Pull in the Modify group works straight on faces.'],
      ['Parameters', 'The Parameters button in the Document group. Type a name into any size field.'],
      ['Configurations', 'Sets of parameter values, under the Document group.'],
      ['Joints', 'Assemble tab: Joint, As-built Joint, Motion Link, Drive Joints.'],
      ['Hair', 'A tab of its own: grow printable strands on a model, with a sacrificial wall.'],
      ['What is different', 'There is no cloud and no account. Files are .caddy files on your disk, and every save keeps a version inside the file (History panel).'],
    ],
  },
  {
    title: 'Good to know',
    steps: [
      'Undo is Ctrl+Z, redo is Ctrl+Y. Undo goes back as far as you like.',
      'If the browser closes by accident, the app offers to recover your last autosave next time.',
      'Settings (the gear at the bottom right) has units, theme, mouse style and help options. Everything you change there is remembered.',
      'Every workspace has a short guide under Help > Workspace guides.',
    ],
  },
]

export const ABOUT: InfoSection[] = [
  {
    title: 'CADdy McCADFace',
    paragraphs: [
      'Browser CAD that runs on your machine. No accounts, no cloud, no network requests: you can host it anywhere static and your files still never leave your computer.',
      'It started as a way to get printable hair onto figures without fighting a big CAD package, and grew into a general parametric modeler.',
    ],
  },
  {
    title: 'Built with',
    rows: [
      ['OpenCascade (via replicad)', 'Exact solid modeling'],
      ['manifold-3d', 'Fast mesh operations'],
      ['planegcs', 'The sketch constraint solver'],
      ['three.js', 'The 3D viewport'],
      ['React, Radix UI, dockview', 'The interface'],
    ],
  },
  {
    title: 'License',
    paragraphs: ['MIT licensed. The source and the plugin guide are in the project repository (docs/plugins.md).'],
  },
]
