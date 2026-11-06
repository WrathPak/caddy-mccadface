# Fusion 360 extrude and sketching on solids vs CADdy McCADFace

Same format as `sketch.md`. Fusion behaviour is from daily-use knowledge of Fusion, not from this app's code. Status marks come from driving the app (real clicks, keys, typed values) at 1600x900 on a 60 x 40 x 10 plate (corner on the world origin, top face at z = 10) and the same plate with a 10 mm hole at (20, 12).

Second pass: every `[GAP]` and `[PARTIAL]` the first pass found is built and now reads `[OK]`, and the four items left after it (New Component, a curved face for To Object, a separate extent for each side of Two sides, Project to Surface with vertex pick) are built too. The specs that were `test.fail()` are plain tests now.

- `[OK]` matches Fusion
- `[GAP]` Fusion does it, we do not. Failing spec in `e2e/59-solids-parity.spec.ts` (marked `test.fail()`, flips when fixed)
- `[PARTIAL]` works but differs. Spec named
- Real parts built from a blank document: `e2e/60-solids-real-parts.spec.ts`
- Shared helpers: `e2e/solids-kit.ts`

Spec names are the start of the test title in `59` unless a file is given. Where the plate is only the starting point of a test it is made with `addSketch` (a hidden precondition); everything under test is mouse and keyboard.

## 1. Sketch on a face

Fusion: Create Sketch, click a planar face. The view turns square to the face. The face's edges (outer loop and the loops of any holes) are put into the sketch at once as projected curves: purple, fixed, they snap and take dimensions, and they close profiles. The sketch origin is the world origin projected onto the face plane, so coordinates match the model.

- [OK] Sketch button, then a click on a planar body face opens a sketch on that face, view turns to look straight at it (`Sketch on a face: Sketch, then a click on the top face`)
- [OK] A face that is not planar is refused with "Select a planar face" (read in `create.ts`; not driven)
- [OK] The face outer edges are projected into the new sketch at once, fixed, as reference curves (`Sketch on a face: the face outer edges are projected ...`). Settings > Sketch > "Auto project face edges" (on by default) turns it off, and the sketch then starts empty as before
- [OK] Same for the edges of holes in the face (`Sketch on a face: the edges of a hole ...`): a fresh sketch on the plate with a hole has two profiles, the plate with the hole in it and the hole
- [OK] Sketch origin is the world origin projected onto the face plane ((0, 0, 10) on the plate), stable when the face outline changes (`Sketch on a face: the sketch origin is the world origin ...`). Only new sketches change: a sketch stored with the face centroid as its origin keeps it
- [OK] Projected curves are drawn purple (token `--sk-ref`: a light purple in the dark theme, a deeper one in the light theme), 2 px wide (`Sketch on a face: projected curves are drawn purple`)

## 2. Project

Fusion: Create > Project / Include > Project (P). Pick faces, edges or bodies, any number, with the dialog listing the picks. Edges perpendicular to the sketch plane project as points, faces edge on project as lines. Other options in the same menu: Intersect, Project to Surface, Include 3D Geometry.

- [OK] Project is in the Sketch ribbon (and on P). Clicking a body face under the sketch puts its boundary in as fixed reference curves (`ref`), the hole included, associative (re-projected when the body changes). 4 lines for the plate (`Project: the Project tool on the face under the sketch ...`)
- [OK] The projected loops bound profiles: the plate with its hole as one profile with a hole in it, the hole as a region of its own, and a line drawn from edge to edge splits the plate region (same test)
- [OK] A projected hole comes in as one circle (one centre, a diameter), not two half arcs (`Project: a projected hole is one circle ...`). Projections stored before this keep the half arcs they were made with, so dimensions on them still work
- [OK] P starts Project (`Project: P starts the Project tool`)
- [OK] A side face of the body, edge on to the sketch, projects as a line (its top and bottom edges land on one line and come in once); an edge square to the plane projects as a point (`Project: a side face of the body ...`, and the kernel test "a side face seen edge on")
- [OK] A click on one body edge projects just that edge: with the Project tool on, edges are picked as well as faces, and an edge near the pointer wins over the face behind it (`Project: a click on a single body edge ...`)
- [OK] Intersect: the curves where the sketch plane cuts the picked faces or body, as reference curves that follow the body like any projection (`Project: Intersect ...`)
- [OK] Include 3D Geometry, the closest honest version, because a sketch here is flat: the picked body, face or edge comes in as reference geometry, its edges flattened onto the sketch plane plus a reference point at every vertex, so they can be snapped to and dimensioned. The height of the edges above the plane is not kept (`Project: Include 3D Geometry ...`)
- [OK] Vertex pick: the Project tool shows the corners of the bodies as dots; a click on one brings it in as a reference point (`Project: the Project tool takes a vertex of a body ...`).
- [OK] Project to Surface, in the form a flat sketch allows. Select sketch curves, start Project to Surface, click a face (flat or curved). Looking along the sketch normal (both ways) from points along the curves, the parts that have the face in view come in as purple guide curves (lines as lines, circles and arcs as arcs, a circle wholly over the face stays a circle), not part of any profile, and the message gives the face's distance from the sketch plane there. They follow the face and the source curves when the model changes. A sketch is flat, so the curves are NOT wrapped onto the face: a 3D curve lying on a curved face cannot live in a 2D sketch. To carry a profile onto a curved face, extrude it To Object with that face. Splines, ellipses and text are left out (counted in the message) (`Project to Surface: curves come in as guides ...`, `src/sketch/surface.test.ts`).
- Not built: picking by dialog with Apply. Whole bodies and several faces in one go work (the code takes them).

## 3. Snaps, dimensions and constraints to projected geometry

- [OK] A circle clicked on the middle of a projected hole is tied to the hole's centre (coincident to the arc centre point). A circle on the middle of a projected edge gets a midpoint constraint with it. A line started on a projected corner is coincident with it (`Projected geometry: a circle centres on a projected hole ...`)
- [OK] A new circle can be dimensioned to a projected edge, and the dimension drives the circle. The projected corner points do not move (they are fixed) (`Projected geometry: a new circle can be dimensioned to a projected edge ...`)
- [OK] Dimensioning the projected hole itself gives a diameter of 10 as a reference dimension (in brackets, no value box: the hole is fixed) (`Projected geometry: the diameter of a projected hole ...`)
- Not checked: Fusion makes dimensions on fixed projected geometry reference (driven); we show one for geometry that is already solved (see `sketch.md` section 6).

## 4. Associativity: the sketch follows its face

Fusion: a sketch on a face stays on it, projected curves follow edits upstream, a lost source turns the curves red.

- [OK] Editing the extrude height from the timeline moves the sketch up with the face, the projected edges stay (`Editing the extrude: a sketch on its top face follows ...`)
- [OK] Adding a taper to the extrude shrinks the top face and the projected edges follow it (same test)
- [OK] A projection whose source is gone is flagged red with a warning instead of failing the sketch (`project.ts` / `features/sketch`, not driven)

## 5. Profiles

- [OK] Several profiles in one Extrude: click two regions, both are picked (`Profiles: two regions picked in one Extrude`)
- [OK] Nested loops: a rectangle with a circle in it gives the plate region (with a hole) and the disc as separate profiles, each selectable (`Project: ...`, `60 Hole region`)
- [OK] A planar body face picked directly in the viewport is an extrude profile (Select Face filter); a plate face with a hole keeps its hole (`Profiles: the face of a plate with a hole ...`)
- [OK] After projecting the face, the region inside the hole loop is a profile you can click and extrude, e.g. as a new body (`60 Hole region`)
- [OK] The hole region is there as soon as the sketch is opened (section 1).

## 6. Extrude

Fusion's dialog: Profiles, Start (Profile Plane / Offset / From Object), Direction (One Side / Two Sides / Symmetric), Extent Type (Distance / To Object / All), Distance, Taper Angle, Operation (Join / Cut / Intersect / New Body / New Component), Objects to cut / join.

- [OK] One side, Symmetric (whole length), Two sides with a second distance, negative distance goes the other way (no Flip button in Fusion either: negative or dragging the arrow back), Taper angle, all editable from the timeline (`Extrude: one side, symmetric, two sides ...`)
- [OK] Typed expressions in the distance (`5 * 3` gives 15) (same test)
- [OK] Extent type: Distance, To Object and All. To Object takes a flat face, a plane or a vertex, with an Object offset (positive goes past it, negative stops short); a flat face that is not parallel to the profile ends the extrude at a slant, and a cylinder or sphere face ends it at the curved surface: the extrude runs past the face and is cut at it (OpenCascade split with the surface the face lies on). For a curved face the end is the first place the extrude meets that cylinder or sphere (the whole surface it lies on, not only the picked patch), and the Object offset moves the end past the face (positive) or short of it (negative), as for a flat one; other curved kinds (cones, B-spline faces) are refused with a message (`Extrude: Extent To Object works with a curved face ...`). All goes through every body (or the Target bodies): Symmetric and Two sides go both ways, One side has a Flip direction box. With Two sides the second side has its own extent type (Distance, To Object or All, with its own object and offset), and runs against the first (`Extrude: Two sides, each side has its own extent ...`). All and To Object choose the direction and the operation by themselves, as the arrow does for a Distance: a sketch on a face goes into the body and becomes a Cut. Preview, OK and editing from the timeline share one code path (`Extrude: Extent type All ...`, `Extrude: Extent All goes both ways ...`, `Extrude: Extent type To Object ...`, `src/features/extrude/extent.test.ts`, and the kernel tests)
- [OK] Start: Offset (begin a distance from the profile plane, on either side) (`Extrude: Start can be Offset`)
- [OK] Start: From Object (begin at a picked flat face or plane parallel to the profile) (`Extrude: Start can be From Object`)
- [OK] Operations: Join, Cut, Intersect, New body and New Component. New Component makes a new component (the same as the Assemble tab's New Component) and puts the new body in it; accepting the dialog creates the component, and it becomes the active one for a new extrude, as in Fusion. Editing the extrude from the timeline keeps its component (`Extrude: New Component ...`, `Extrude: from a face going up ...`)
- [OK] Auto cut: with one profile, or two, drawn on a face, a negative distance into the body switches the operation to Cut by itself (`Extrude: from a face going up joins ...`, `Extrude: with several profiles from a face picked ...`). Going up stays Join.
- [OK] Auto cut also works for the four round profiles of the mounting plate on a face sketch with projected edges (`60 Mounting plate`)
- [OK] Live preview while the dialog is open (`Extrude: the live preview ...`)
- [OK] Drag arrow in the view (distance follows the pointer) (`Extrude: the live preview ...`)
- [OK] Press/Pull with the top face selected first, then a distance, moves the face (`Press/Pull: with the top face selected first ...`)
- [OK] Press/Pull started first, then a click on the face: the dialog's face list takes it, the same as selecting first. (The first pass read it as empty because the spec looked at the values the dialog opened with, not the ones its form holds now. The dialog now reports its live values, and the spec also types a distance and checks the face moved) (`Press/Pull: start the tool, then click a face ...`)

## 7. Hole on a face

- [OK] Hole tool, click on a face places a hole at the click, drilled through (`Hole: a click on the top face ...`). The preset sizes the hole to the part (a small one on a 60 x 40 plate)
- [OK] A click at the rim of an existing hole snaps to its centre so the new hole is concentric: within the larger of 1 mm and a fifth of the radius of the rim, either side. A click on the corner marker where the round edge starts (its seam) does the same (`Hole: a click right at the rim of an existing hole ...`)
- Note: a click inside an existing hole (on nothing) adds no hole at all; Fusion is the same.

## 8. Real parts (`e2e/60-solids-real-parts.spec.ts`)

Each part is built from a blank document by mouse and keyboard. The Fusion way: a sketch on a face has its edges projected already (no Project step), and a through cut uses Extent: All.

- Mounting plate (80 x 50 x 8, four 6 mm holes each dimensioned to the projected left and bottom edges, fully constrained, cut through): completes (Extent: All, which picks Cut and the direction into the plate by itself)
- Plate with a boss (20 mm circle in the middle of the plate, 40 from the left edge and 25 from the bottom edge, joined 15 up): completes
- Counterbore (circle on the projected hole, centre tied to the hole centre, cut 3): completes
- Hole region (the region inside the hole loop of a face, extruded up as a new body): completes
- Timeline edit of the first extrude (10 to 16): the boss sketch moves to the new face height, the circle keeps its dimensions to the projected edges (still 40 and 25), the boss follows: completes

The two catches of the first pass are gone. The first profile pick still turns the view square to the profiles (an animation, so the specs wait for it before the second click), but a circle on the middle of the face no longer snaps to the sketch origin, because the origin is the world origin projected onto the face (the plate's corner), not the face centroid.

## Not checked

Revolve, Sweep, Loft on faces, extrude of splines and text profiles, assembly-level extrudes, sketch on a non-planar face, offset-plane sketches on faces, New Component extrudes, undo of a projection. Not built: To Object on a cone or a free-form face (flat faces, planes, vertices, cylinders and spheres are supported), and a curved end whose first meeting with the surface is not the picked patch.
