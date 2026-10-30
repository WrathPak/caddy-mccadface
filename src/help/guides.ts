/**
 * Workspace guides: one page per ribbon tab, written as plain numbered steps. This is the content of Help > Workspace guides
 * and of the "?" in the Inspector header. Everything here is local text; nothing is fetched.
 */

export interface GuideSection {
  /** anchor: the Inspector "?" opens the guide scrolled to this section */
  id: string
  title: string
  /** a sentence or two before the steps */
  intro?: string
  steps: string[]
  /** a closing hint */
  note?: string
}

export interface Guide {
  /** matches the ribbon tab id */
  id: string
  title: string
  /** what the workspace is for, in one sentence (also the tooltip of its ribbon tab) */
  summary: string
  sections: GuideSection[]
}

export const GUIDES: Guide[] = [
  {
    id: 'solid',
    title: 'Solid',
    summary: 'Build exact, editable parts from sketches: extrude, revolve, fillet and combine.',
    sections: [
      {
        id: 'flow',
        title: 'The usual flow',
        intro: 'Most parts start as a flat drawing that you turn into a shape. Every step is saved in the timeline at the bottom, so you can come back and change any of it.',
        steps: [
          'Click Create Sketch, then click a plane in the viewport (XY is the floor) or a flat face of a part.',
          'Draw with Line, Rectangle or Circle. Use Sketch Dimension (D) to type exact sizes. A sketch with a closed outline is called a profile.',
          'Click Finish Sketch. The sketch appears in the timeline.',
          'Click Extrude (E), pick the profile, set a distance and press OK or Enter.',
          'Add details: Fillet rounds an edge, Chamfer bevels it, Hole drills a hole, Shell hollows the part out.',
          'Save with Ctrl+S. To print, use Export and choose STL or 3MF.',
        ],
        note: 'Double-click any step in the timeline to change its numbers. Everything after it rebuilds on its own.',
      },
      {
        id: 'sketch',
        title: 'Sketching',
        steps: [
          'Pick a drawing tool from the Sketch tab that appears while you are sketching.',
          'Click to place points. Small hints show when a point lines up with another one; click there to snap to it.',
          'Add constraints (Horizontal, Parallel, Tangent and so on) to make the sketch keep its shape when something changes.',
          'The bar in the viewport says if the sketch is fully constrained, still has freedom, or has a conflict.',
        ],
      },
      {
        id: 'extrude',
        title: 'Extrude',
        intro: 'Pushes a profile into a solid.',
        steps: [
          'Click Extrude and pick one or more profiles (they highlight as you hover).',
          'Set the distance, or choose a direction such as both sides or two distances.',
          'Choose what it does to existing bodies: join to them, cut out of them, intersect, or make a new body.',
        ],
        note: 'You can also Extrude a flat face of an existing body to push or pull it.',
      },
      {
        id: 'revolve',
        title: 'Revolve',
        intro: 'Spins a profile around a line, for round parts like knobs, wheels and vases.',
        steps: [
          'Sketch half of the part\'s outline, next to a line that will be the center.',
          'Click Revolve, pick the profile, then pick the line (or an axis) to spin around.',
          'Set the angle. 360 degrees makes a full round part.',
        ],
      },
      {
        id: 'sweep-loft',
        title: 'Sweep and Loft',
        steps: [
          'Sweep: draw a profile and a separate path curve on different sketches. Click Sweep, pick the profile, then the path.',
          'Loft: draw two or more profiles on different planes (use Offset Plane to make planes). Click Loft and pick them in order. Turn on Ruled for straight, angular transitions.',
        ],
      },
      {
        id: 'edges',
        title: 'Fillet, Chamfer and Shell',
        steps: [
          'Fillet: click Fillet, click the edges to round (or a face for all its edges), set the radius.',
          'Chamfer: the same, but it cuts a flat bevel instead of a round.',
          'Shell: click Shell, pick the faces that should be open, set the wall thickness. The rest of the part is hollowed out.',
        ],
        note: 'Rounds and bevels are best added late. If you add them early, the steps after them can break when you change the shape.',
      },
      {
        id: 'combine',
        title: 'Combine, Move and Mirror',
        steps: [
          'Combine: pick a target body and tool bodies, then choose Join, Cut or Intersect.',
          'Move: pick bodies and type distances and angles, or drag the arrows. Choose Copy to leave the original.',
          'Pattern and Mirror: repeat or mirror features, faces or whole bodies.',
        ],
      },
      {
        id: 'holes',
        title: 'Holes and threads',
        steps: [
          'Hole: click Hole, pick a face, click where each hole goes, then choose the type and a screw size.',
          'Threads live in the Detail workspace. Thread adds a real thread to a round face.',
        ],
      },
      {
        id: 'measure',
        title: 'Measure and Section',
        steps: [
          'Measure (I): click two things to see the distance or angle between them.',
          'Section Analysis: slice the view with a plane to look inside. It only changes the view.',
        ],
      },
      {
        id: 'direct',
        title: 'Direct edits',
        intro: 'These work straight on faces, without going back to a sketch.',
        steps: [
          'Press/Pull: drag a face in or out, or drag an edge to round it.',
          'Offset Face, Delete Face, Replace Face, Split Face, Split Body and Draft are in the Modify group.',
        ],
      },
      {
        id: 'construct',
        title: 'Construction planes, axes and points',
        steps: [
          'Offset Plane makes a new plane next to a plane or face. Sketches can sit on it.',
          'The menus in the Construct group make planes at an angle or through three points, axes, and points.',
        ],
      },
      {
        id: 'params',
        title: 'Parameters and configurations',
        steps: [
          'Parameters: name a number (for example wall = 2 mm), then type the name into any size field.',
          'Change the parameter once and every feature that uses it follows.',
          'Configurations: save sets of parameter values, such as Small and Large, and switch between them.',
        ],
      },
    ],
  },
  {
    id: 'sketch',
    title: 'Sketch',
    summary: 'Draw 2D shapes on a plane and hold them in place with constraints and dimensions.',
    sections: [
      {
        id: 'flow',
        title: 'Drawing a shape',
        steps: [
          'Click Create Sketch in a workspace and click a plane or a flat face. The Sketch tab appears.',
          'Choose a tool: Line (L), Rectangle (R), Circle (C), Arc (A) and more in the Create group.',
          'Click to place points. Press Enter to finish a chain of lines, and Esc to cancel the tool.',
          'Click Finish Sketch when the outline is closed. Closed outlines become profiles.',
        ],
      },
      {
        id: 'constraints',
        title: 'Constraints',
        intro: 'A constraint is a rule the sketch keeps, such as "these two lines stay parallel".',
        steps: [
          'Select the lines or points the rule is about, then click a constraint in the Constraints group.',
          'Coincident joins points. Horizontal and Vertical level a line. Parallel, Perpendicular, Tangent and Equal relate two shapes.',
          'Fix locks something in place.',
        ],
      },
      {
        id: 'dimensions',
        title: 'Dimensions',
        steps: [
          'Click Sketch Dimension (D), click a line, a circle, or two points.',
          'Type the size and press Enter. The sketch changes to match it.',
        ],
        note: 'A fully constrained sketch is easy to trust. The bar in the viewport tells you where you stand.',
      },
      {
        id: 'modify',
        title: 'Trim, Offset and Construction',
        steps: [
          'Trim (T): click the piece of a curve between two crossings to remove it.',
          'Offset: select a chain of curves, then give a distance.',
          'Construction (X): turn selected curves into guide lines that are ignored when you extrude.',
          'Project / Include: bring edges of existing bodies into the sketch.',
        ],
      },
    ],
  },
  {
    id: 'assemble',
    title: 'Assemble',
    summary: 'Put parts together as components, connect them with joints and make them move.',
    sections: [
      {
        id: 'flow',
        title: 'The usual flow',
        steps: [
          'Click New Component to make a part holder, or select bodies and use Components from Bodies.',
          'Bring in other projects with Insert Linked (follows the file) or Insert Embedded Copy.',
          'Click Ground on the part that should not move.',
          'Click Joint, snap to a face, edge, circle or corner on the first part, then the second.',
          'Click Drive Joints to move the joints with sliders, or drag a part with Move Component.',
        ],
      },
      {
        id: 'components',
        title: 'Components',
        steps: [
          'The part you are editing is the active component. New features go into it.',
          'Click Activate Root to go back to the top level.',
          'Copy Component and Paste as Instance add more of the same part. Instances share their shape.',
          'Right-click a component and choose Material and description. The parts list of a drawing shows them, and counts every instance of the component.',
        ],
      },
      {
        id: 'joints',
        title: 'Joints',
        steps: [
          'Joint connects two components at points you snap. The joint can be rigid, hinged (revolute), sliding and so on.',
          'As-built Joint connects parts right where they are now, without moving them.',
          'Motion Link makes one joint follow another by a ratio, for gears, racks and screws.',
        ],
      },
      {
        id: 'motion',
        title: 'Motion, checks and exploded views',
        steps: [
          'Motion Study: record joint values at keyframes and play them back.',
          'Interference shows parts that overlap in red. Clearance measures the gap between two parts.',
          'Explode Steps builds an exploded view. Explode / Collapse plays it.',
        ],
      },
    ],
  },
  {
    id: 'surface',
    title: 'Surface',
    summary: 'Shape free-form skins from curves, join them up and thicken them into solids.',
    sections: [
      {
        id: 'flow',
        title: 'The usual flow',
        intro: 'A surface is a skin with no thickness. You build the skin first, close it up, then give it thickness.',
        steps: [
          'Draw curves with Create Sketch. They can be open (a line or a spline) or closed.',
          'Make surfaces from them with Extrude, Revolve, Sweep, Loft or Patch in the Create group.',
          'Fix up the edges with Trim and Extend.',
          'Click Stitch to sew surfaces together along shared edges. If they close up completely, you get a solid.',
          'If the result is still a skin, click Thicken to give it a wall thickness. That makes a solid.',
        ],
        note: 'Delete Face and Unstitch take a solid or surface apart again.',
      },
      {
        id: 'create',
        title: 'Making surfaces',
        steps: [
          'Extrude, Revolve and Sweep turn sketch curves into surfaces the same way their solid versions do.',
          'Loft blends a surface through two or more curves.',
          'Patch fills a closed loop of curves or edges with a surface. It can follow the neighbouring faces for a smooth join.',
          'Offset copies a surface at a distance.',
        ],
      },
      {
        id: 'stitch',
        title: 'Stitch and Thicken',
        steps: [
          'Stitch: select two or more surfaces that touch along edges. A fully closed set becomes a solid body.',
          'Thicken: select a surface and pick the side(s) to grow. The result is a solid. A closed surface (a stitched box or sphere, say) becomes a hollow solid: Front grows outward, Back inward, Symmetric both.',
        ],
        note: 'If Stitch will not close, the edges are probably not touching. Use Extend or Trim to meet them.',
      },
      {
        id: 'trim',
        title: 'Trim, Extend, Delete Face and Fit to Surface',
        steps: [
          'Trim: pick the surface, then the plane, face, surface or solid to cut it with, and choose which side to keep.',
          'Extend: pick open edges and set how far to push them. Pick edges that meet at a corner together and the corner is filled in (an inside corner is mitred where the two strips meet), so you get one connected sheet with no gap or overlap.',
          'Delete Face: remove faces from a solid or a surface, leaving an open skin.',
          'Fit to Surface: pick faces of a solid, then a surface, plane or face. The solid grows or gets cut back so those faces sit on it, and flat walls next to them carry on to meet it.',
        ],
      },
    ],
  },
  {
    id: 'mesh',
    title: 'Mesh',
    summary: 'Clean up, shrink, cut and repair triangle meshes from STL and 3MF files.',
    sections: [
      {
        id: 'flow',
        title: 'The usual flow',
        steps: [
          'Click Import Mesh and pick an STL or 3MF file. Very large files load in the background.',
          'Click Repair first if the mesh has holes. Slicers need a closed (watertight) mesh.',
          'Use Reduce to make a heavy mesh lighter, and Smooth to soften a noisy one.',
          'Use Plane Cut to slice a model into parts that fit your printer.',
          'Export as STL or 3MF.',
        ],
        note: 'Meshes are made of triangles, so they cannot be edited with solid tools like Fillet. Convert to Mesh turns a solid into a mesh, but it cannot go back.',
      },
      {
        id: 'reduce',
        title: 'Reduce, Refine and Smooth',
        steps: [
          'Reduce merges triangles to cut the file size while keeping the shape.',
          'Refine splits long triangles so a coarse mesh has more to work with.',
          'Smooth evens out bumps. Refine first if the result looks blocky.',
        ],
      },
      {
        id: 'cut',
        title: 'Plane Cut',
        steps: [
          'Click Plane Cut and pick the mesh and a plane.',
          'Choose to keep one side or both.',
        ],
      },
      {
        id: 'repair',
        title: 'Repair',
        steps: [
          'Select the mesh and click Repair. It closes holes and fixes broken triangles.',
          'Check the result with Measure or Section Analysis.',
        ],
      },
    ],
  },
  {
    id: 'hair',
    title: 'Hair',
    summary: 'Grow printable strands of hair or fur on a model, held by a thin wall you cut away after printing.',
    sections: [
      {
        id: 'flow',
        title: 'The usual flow',
        intro: 'Hair is printed as thin flat lines. A thin sacrificial wall holds the strand tips so they print in place. After printing you cut the strands off the wall with scissors.',
        steps: [
          'Click Select Faces and paint the faces the hair should grow from: Brush paints, Fill grabs a whole flat area, Face picks single faces. Hold Shift to erase, and press [ or ] to change the brush size.',
          'Click Create Hair. Start with a preset (Printable comb is a good one) and choose how the strands point in the Direction group.',
          'Leave the wall on. Set the length, width, thickness and density. The preview updates as you type.',
          'Click OK. Hair is added to the timeline like any other feature.',
          'Export as STL or 3MF (or send the plate through the Print tab) and slice it. Print the hair and wall with the body.',
          'After printing, cut the strands off the wall with scissors. The wall is only there to hold them while they print.',
        ],
      },
      {
        id: 'direction',
        title: 'Direction',
        steps: [
          'Perpendicular to each face: each face keeps its own direction, with a clean gap at corners.',
          'Blend across faces: directions fan smoothly around corners.',
          'Fan from axis, Fixed direction and Toward / away from point give you control over the flow.',
          'Spread tilts strands a little at random so it looks natural.',
        ],
      },
      {
        id: 'strands',
        title: 'Strands',
        steps: [
          'Length, Width and Thickness set the size of each strand. Print-aware mode rounds them to whole layers so the slicer keeps them.',
          'Density sets how many strands per square centimetre. Pattern and edges lets you use Spacing instead.',
          'Taper, Wave size, Curl and Clumps add styling. Print-aware strands stay flat and horizontal.',
        ],
      },
      {
        id: 'wall',
        title: 'The sacrificial wall',
        steps: [
          'Enable wall adds a thin wall at the tips. It holds the strands while printing.',
          'Shape picks how the wall is formed: follow the faces, go through the tips, or be a flat plane.',
          'Thickness of 0.8 mm is two lines of a 0.4 mm nozzle: thin and easy to remove.',
          'Separate wall keeps it as its own body so you can hide or delete it before exporting.',
        ],
      },
      {
        id: 'printing',
        title: 'Printing settings',
        steps: [
          'Enter your nozzle size and layer height in the Printing group. Strands thinner than 1.4 times the nozzle are made wider so they are not dropped.',
          'The yellow notes at the bottom of the dialog warn when a setting is too small to print.',
        ],
      },
    ],
  },
  {
    id: 'detail',
    title: 'Detail',
    summary: 'Add text, logos, textures, fur, scales and threads to faces.',
    sections: [
      {
        id: 'flow',
        title: 'The usual flow',
        steps: [
          'Click a tool in the Detail tab, for example Text.',
          'Pick the face (or faces) it should go on.',
          'Set the size, depth and whether it is raised or cut in. The preview updates as you type.',
          'Click OK.',
        ],
      },
      {
        id: 'text',
        title: 'Text and logos',
        steps: [
          'Text: type your words, pick a font, a size and a depth. Works on curved faces too.',
          'Logo: choose an SVG or an image file. It is stored inside the project.',
          'Choose emboss (raised) or engrave (cut into the face).',
        ],
      },
      {
        id: 'texture',
        title: 'Textures',
        steps: [
          'Pick the faces and a pattern: knurl, leather, hexagon, wood, carbon fiber, or your own picture.',
          'Set the size and the depth of the pattern.',
        ],
        note: 'Textures add a lot of triangles. Apply them last.',
      },
      {
        id: 'generators',
        title: 'Fur, scales, spikes and grass',
        steps: [
          'Pick the faces, then set the size, density and direction.',
          'For long hair that prints cleanly, use the Hair workspace instead.',
        ],
      },
      {
        id: 'thread',
        title: 'Thread',
        steps: [
          'Click Thread and pick a round face: the outside of a bolt or the inside of a hole.',
          'Choose an ISO metric size or set your own.',
          'Set a clearance so a printed nut still turns on a printed bolt.',
        ],
      },
    ],
  },
  {
    id: 'print',
    title: 'Print',
    summary: 'Get the model ready for the printer: colors, support checks, splitting, hollowing and a 3MF for your slicer.',
    sections: [
      {
        id: 'flow',
        title: 'The usual flow',
        steps: [
          'Click Print Settings and enter your printer, layer height, walls, infill and filament colors.',
          'Run Overhangs, Thin Walls and Small Features to color the places that may go wrong.',
          'Click Auto Orient to find the way up that needs the least support.',
          'Color the parts: Paint Body for whole bodies, Paint Faces for details.',
          'If it is too big for your printer, use Split Body.',
          'Click Export 3MF, or Bambu Studio / OrcaSlicer, to save the plate. Open the file in your slicer.',
        ],
        note: 'Everything that is visible becomes one object on the plate. Hide a body to leave it off.',
      },
      {
        id: 'settings',
        title: 'Print settings',
        steps: [
          'The settings are written into the 3MF, so your slicer starts from them.',
          'You can still change everything in the slicer.',
        ],
      },
      {
        id: 'paint',
        title: 'Painting colors',
        steps: [
          'Paint Body: pick bodies and a filament color.',
          'Paint Faces: pick a color, then paint with the brush, click a face, or use the fill tool. Hold Shift to erase.',
        ],
      },
      {
        id: 'analyze',
        title: 'Overhangs, thin walls and small features',
        steps: [
          'Overhangs colors surfaces that lean out more than the angle you set. Those usually need support.',
          'Thin Walls colors walls under a minimum thickness. Small Features colors details the nozzle may not reproduce.',
          'Click the same button again to hide the colors.',
        ],
      },
      {
        id: 'prepare',
        title: 'Split and Hollow',
        steps: [
          'Split Body: pick a body and a plane or sketch. Turn on pins or dovetails so the parts fit back together.',
          'Hollow: set a wall thickness and click where drain holes should go.',
        ],
      },
    ],
  },
  {
    id: 'drawing',
    title: 'Drawing',
    summary: 'Make 2D sheets of the model with views, dimensions and notes, and export them as PDF, DXF or SVG.',
    sections: [
      {
        id: 'flow',
        title: 'The usual flow',
        steps: [
          'Click Setup to choose the paper size, scale and projection style.',
          'Click Base View and place a front, top or right view of the model.',
          'Add Projected, Section or Detail views from the first one.',
          'Add dimensions with the tools in the Dimension group. Click a view, then the points to measure.',
          'Add notes, datums, balloons and a parts list in the Annotate group. For an assembly the parts list has one row per component.',
          'Export as PDF, DXF or SVG.',
        ],
      },
      {
        id: 'views',
        title: 'Views',
        steps: [
          'Base View: the first view. Choose which side and which parts.',
          'Projected: unfolded from a view, beside it or above it.',
          'Section: draw a line across a view to cut through the part.',
          'Detail: circle a small feature to show it enlarged.',
        ],
      },
      {
        id: 'dimensions',
        title: 'Dimensions',
        steps: [
          'Linear and Aligned measure between two points. Angular measures an angle between two lines.',
          'Radius and Diameter work on circles and arcs.',
          'Ordinate and Baseline keep many dimensions tidy by measuring from one starting point.',
        ],
      },
      {
        id: 'annotate',
        title: 'Notes, symbols and parts lists',
        steps: [
          'Note and Leader place text. Leader adds an arrow.',
          'GD&T, Datum and Finish place tolerance and surface symbols.',
          'Parts List places a table of the parts of the model: item number, quantity, part name, material and description. In an assembly each component is one row, and copies of the same component are counted together.',
          'Balloon points at a part and shows its item number from the parts list. Pick the part in the balloon dialog.',
          'The table follows the model: add, remove or copy a component and the rows and quantities change. Material and description come from the component: right-click it in the Browser and choose Material and description.',
        ],
      },
      {
        id: 'export',
        title: 'Exporting',
        steps: [
          'PDF saves every sheet with real, selectable text.',
          'DXF saves the active sheet with layers, for CAM and other CAD programs.',
          'SVG saves the active sheet as a picture.',
        ],
      },
    ],
  },
  {
    id: 'render',
    title: 'Render',
    summary: 'Give the model materials and make realistic pictures or a turntable video.',
    sections: [
      {
        id: 'flow',
        title: 'The usual flow',
        steps: [
          'Click Appearance, pick bodies or faces and choose a material from the library.',
          'Frame the view you like with the mouse or the ViewCube.',
          'Use the Render panel to set the image size and quality.',
          'Click Focus and Depth of Field if you want a blurred background.',
          'Click Render Image to save a PNG, or Turntable for a video.',
        ],
        note: 'Rendering is slower than normal viewing, because it follows the path of light the way a real camera sees.',
      },
      {
        id: 'materials',
        title: 'Materials',
        steps: [
          'Appearance picks a material from the library for the bodies or faces you choose.',
          'Materials only change how renders look. They do not change print colors. Use the Print tab for those.',
        ],
      },
      {
        id: 'output',
        title: 'Images and video',
        steps: [
          'Render Image makes one picture at the size set in the panel and saves it as a PNG.',
          'Turntable records the model turning once around and saves a WebM video.',
        ],
      },
    ],
  },
]

export const guideById = (id: string) => GUIDES.find((g) => g.id === id)

/**
 * The Inspector "?" link: which guide and section explain a feature dialog (by feature / schema id). Every feature has one.
 */
export const FEATURE_GUIDE: Record<string, { guide: string; section: string }> = {
  // solid
  box: { guide: 'solid', section: 'flow' },
  cylinder: { guide: 'solid', section: 'flow' },
  sketch: { guide: 'sketch', section: 'flow' },
  extrude: { guide: 'solid', section: 'extrude' },
  revolve: { guide: 'solid', section: 'revolve' },
  sweep: { guide: 'solid', section: 'sweep-loft' },
  loft: { guide: 'solid', section: 'sweep-loft' },
  fillet: { guide: 'solid', section: 'edges' },
  chamfer: { guide: 'solid', section: 'edges' },
  shell: { guide: 'solid', section: 'edges' },
  combine: { guide: 'solid', section: 'combine' },
  move: { guide: 'solid', section: 'combine' },
  pattern: { guide: 'solid', section: 'combine' },
  mirror: { guide: 'solid', section: 'combine' },
  hole: { guide: 'solid', section: 'holes' },
  delete: { guide: 'solid', section: 'flow' },
  pressPull: { guide: 'solid', section: 'direct' },
  offsetFace: { guide: 'solid', section: 'direct' },
  deleteFace: { guide: 'solid', section: 'direct' },
  replaceFace: { guide: 'solid', section: 'direct' },
  splitFace: { guide: 'solid', section: 'direct' },
  splitBody: { guide: 'solid', section: 'direct' },
  draft: { guide: 'solid', section: 'direct' },
  offsetPlane: { guide: 'solid', section: 'construct' },
  constructPlane: { guide: 'solid', section: 'construct' },
  constructAxis: { guide: 'solid', section: 'construct' },
  constructPoint: { guide: 'solid', section: 'construct' },
  measure: { guide: 'solid', section: 'measure' },
  section: { guide: 'solid', section: 'measure' },
  export: { guide: 'solid', section: 'flow' },
  // surface
  surfaceExtrude: { guide: 'surface', section: 'create' },
  surfaceRevolve: { guide: 'surface', section: 'create' },
  surfaceSweep: { guide: 'surface', section: 'create' },
  surfaceLoft: { guide: 'surface', section: 'create' },
  surfacePatch: { guide: 'surface', section: 'create' },
  surfaceOffset: { guide: 'surface', section: 'create' },
  surfaceTrim: { guide: 'surface', section: 'trim' },
  surfaceExtend: { guide: 'surface', section: 'trim' },
  surfaceDeleteFace: { guide: 'surface', section: 'trim' },
  surfaceReplaceFace: { guide: 'surface', section: 'trim' },
  surfaceStitch: { guide: 'surface', section: 'stitch' },
  surfaceUnstitch: { guide: 'surface', section: 'stitch' },
  surfaceThicken: { guide: 'surface', section: 'stitch' },
  // mesh
  importMesh: { guide: 'mesh', section: 'flow' },
  importStep: { guide: 'solid', section: 'flow' },
  meshPlaneCut: { guide: 'mesh', section: 'cut' },
  meshReduce: { guide: 'mesh', section: 'reduce' },
  meshRefine: { guide: 'mesh', section: 'reduce' },
  meshSmooth: { guide: 'mesh', section: 'reduce' },
  meshRepair: { guide: 'mesh', section: 'repair' },
  meshConvert: { guide: 'mesh', section: 'flow' },
  // hair
  hair: { guide: 'hair', section: 'flow' },
  // detail
  emboss: { guide: 'detail', section: 'text' },
  texture: { guide: 'detail', section: 'texture' },
  fur: { guide: 'detail', section: 'generators' },
  scales: { guide: 'detail', section: 'generators' },
  spikes: { guide: 'detail', section: 'generators' },
  grass: { guide: 'detail', section: 'generators' },
  thread: { guide: 'detail', section: 'thread' },
  // print
  printSettings: { guide: 'print', section: 'settings' },
  paint: { guide: 'print', section: 'paint' },
  split: { guide: 'print', section: 'prepare' },
  hollow: { guide: 'print', section: 'prepare' },
  // render
  appearance: { guide: 'render', section: 'materials' },
}
