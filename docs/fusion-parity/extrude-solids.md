# Fusion 360 extrude and sketching on solids vs CADdy McCADFace

Same format as `sketch.md`. Fusion behaviour is from daily-use knowledge of Fusion, not from this app's code. Status marks come from driving the app (real clicks, keys, typed values) at 1600x900 on a 60 x 40 x 10 plate (corner on the world origin, top face at z = 10) and the same plate with a 10 mm hole at (20, 12).

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
- [GAP] The face outer edges are projected into the new sketch at once. Ours opens empty: 0 entities, "0 profiles", and the user has to start the Project tool and click the face (`Sketch on a face: the face outer edges are projected ...`)
- [GAP] Same for the edges of holes in the face (`Sketch on a face: the edges of a hole ...`). Nothing is projected, so there is no hole to snap to or dimension to until Project is run
- [GAP] Sketch origin. Ours sits at the face centroid (30, 20, 10 on the plate), so a sketch point (0, 0) is the middle of the face, and it moves when the face outline changes. Fusion's origin is the projected world origin (0, 0, 10), stable under edits (`Sketch on a face: the sketch origin is the world origin ...`)
- [GAP] Projected curves are drawn purple in Fusion. Ours are the grey of dim text (`--text-dim`) with a 1.6 px width, hard to tell from construction geometry (`Sketch on a face: projected curves are drawn purple`)

## 2. Project

Fusion: Create > Project / Include > Project (P). Pick faces, edges or bodies, any number, with the dialog listing the picks. Edges perpendicular to the sketch plane project as points, faces edge on project as lines. Other options in the same menu: Intersect, Project to Surface, Include 3D Geometry.

- [OK] Project is in the Sketch ribbon. Clicking a body face under the sketch puts its boundary in as fixed reference curves (`ref`), the hole included, associative (re-projected when the body changes). 4 lines for the plate (`Project: the Project tool on the face under the sketch ...`)
- [OK] The projected loops bound profiles: the plate with its hole as one profile with a hole in it, the hole as a region of its own, and a line drawn from edge to edge splits the plate region (same test)
- [PARTIAL] A projected hole is two half arcs (two separate arc entities, two centre points), not one circle. It has no diameter and its seam points snap as extra ends (`Project: a projected hole is one circle ...`)
- [GAP] P starts Project. Ours has no key for it (pressing P leaves the Line tool on) (`Project: P starts the Project tool`)
- [GAP] A side face of the body, edge on to the sketch, projects as a line in Fusion. Ours says nothing and adds nothing (`Project: a side face of the body ...`)
- [GAP] A click on one body edge projects just that edge. Ours only accepts faces (the filter is Face), so a click on the plate's top edge projected the whole top face, 4 lines (`Project: a click on a single body edge ...`)
- [GAP] Intersect (curves where the sketch plane cuts a body). No such tool (`Project: Intersect ...`)
- [GAP] Include 3D Geometry. No such tool (`Project: Include 3D Geometry ...`)
- Not tested: Project to Surface; projecting whole bodies or several faces in one go (the code takes them); selecting by dialog and Apply.

## 3. Snaps, dimensions and constraints to projected geometry

- [OK] A circle clicked on the middle of a projected hole is tied to the hole's centre (coincident to the arc centre point). A circle on the middle of a projected edge gets a midpoint constraint with it. A line started on a projected corner is coincident with it (`Projected geometry: a circle centres on a projected hole ...`)
- [OK] A new circle can be dimensioned to a projected edge, and the dimension drives the circle. The projected corner points do not move (they are fixed) (`Projected geometry: a new circle can be dimensioned to a projected edge ...`)
- [PARTIAL] Dimensioning the projected hole itself gives a radius of 5 (it is an arc), Fusion shows a diameter of 10 as a reference dimension (`Projected geometry: the diameter of a projected hole ...`)
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
- [PARTIAL] The step before that needs the Project tool run by hand (see section 1); Fusion has the hole region as soon as the sketch is opened.

## 6. Extrude

Fusion's dialog: Profiles, Start (Profile Plane / Offset / From Object), Direction (One Side / Two Sides / Symmetric), Extent Type (Distance / To Object / All), Distance, Taper Angle, Operation (Join / Cut / Intersect / New Body / New Component), Objects to cut / join.

- [OK] One side, Symmetric (whole length), Two sides with a second distance, negative distance goes the other way (no Flip button in Fusion either: negative or dragging the arrow back), Taper angle, all editable from the timeline (`Extrude: one side, symmetric, two sides ...`)
- [OK] Typed expressions in the distance (`5 * 3` gives 15) (same test)
- [GAP] Extent type. Only Distance exists. No To Object, no All / Through All (`Extrude: Extent type All ...`, `Extrude: Extent type To Object ...`)
- [GAP] Start: Offset (begin a distance from the profile plane) (`Extrude: Start can be Offset`)
- [GAP] Start: From Object (begin at a picked face) (`Extrude: Start can be From Object`)
- [PARTIAL] Operations: Join, Cut, Intersect, New body are there. New Component is not (assemblies are made in the Assemble tab) (`Extrude: from a face going up ...`)
- [OK] Auto cut: with one profile, or two, drawn on a face, a negative distance into the body switches the operation to Cut by itself (`Extrude: from a face going up joins ...`, `Extrude: with several profiles from a face picked ...`). Going up stays Join.
- [OK] Auto cut also works for the four round profiles of the mounting plate on a face sketch with projected edges (`60 Mounting plate`)
- [OK] Live preview while the dialog is open (`Extrude: the live preview ...`)
- [OK] Drag arrow in the view (distance follows the pointer) (`Extrude: the live preview ...`)
- [OK] Press/Pull with the top face selected first, then a distance, moves the face (`Press/Pull: with the top face selected first ...`)
- [PARTIAL] Press/Pull started first, then a click on the face: the face is selected in the view but the dialog's face list stays empty (Fusion takes the click) (`Press/Pull: start the tool, then click a face ...`)

## 7. Hole on a face

- [OK] Hole tool, click on a face places a hole at the click, drilled through (`Hole: a click on the top face ...`). The preset sizes the hole to the part (a small one on a 60 x 40 plate)
- [GAP] A click at the rim of an existing hole snaps to its centre so the new hole is concentric. Ours would keep the raw click point (`Hole: a click right at the rim of an existing hole ...`). Fusion also offers concentric by picking the circular edge; unsure how close to the edge Fusion snaps.
- Note: a click inside an existing hole (on nothing) adds no hole at all; Fusion is the same.

## 8. Real parts (`e2e/60-solids-real-parts.spec.ts`)

Each part is built from a blank document by mouse and keyboard. Where Fusion auto-projects face edges the part runs the Project tool on the face first (one extra click, the [GAP] in section 1), and where Fusion would pick Extent: All the depth is typed past the plate (the [GAP] in section 6).

- Mounting plate (80 x 50 x 8, four 6 mm holes each dimensioned to the projected left and bottom edges, fully constrained, cut through): completes (Cut is picked by the auto cut when the negative depth is typed)
- Plate with a boss (20 mm circle dimensioned to the projected edges, joined 15 up): completes
- Counterbore (circle on the projected hole, centre tied to the hole centre, cut 3): completes
- Hole region (the region inside the hole loop of a face, extruded up as a new body): completes
- Timeline edit of the first extrude (10 to 16): the boss sketch moves to the new face height, the circle keeps its dimensions to the projected edges, the boss follows: completes

Two catches met while writing these: the first profile pick makes the Extrude dialog turn the view square to the profiles (an animation), so a second click aimed before it ends can land on a body face and put that face in the list instead of the profile. And a circle centred exactly on the face centroid snaps to the sketch origin (which is the centroid here), so the first dimension was made to the origin instead of the edge. This follows from the origin gap in section 1.

## Not checked this pass

Revolve, Sweep, Loft on faces, extrude of splines and text profiles, assembly-level extrudes, sketch on a non-planar face, offset-plane sketches on faces, Project with several faces at once, New Component extrudes, undo of a projection.
