# Fusion 360 Solid tab (minus Extrude) vs CADdy McCADFace

Same format as `extrude-solids.md`. Fusion behaviour is from daily-use knowledge of Fusion, not from this app's code. Status marks come from driving the app (real clicks, keys, typed values) at 1600x900 on a 60 x 40 x 10 plate (corner on the world origin, volume 24000, top face at z = 10) and on seeded boxes.

- `[OK]` matches Fusion
- `[GAP]` Fusion does it, we do not (or we get it wrong). Spec in `e2e/61-solids-tools-parity.spec.ts`, marked `test.fail()` with a comment naming the gap; it flips when the gap is closed
- `[PARTIAL]` works but differs. Spec named, marked `test.fail()` for the part that differs
- Real parts: `e2e/62-solids-tools-real-parts.spec.ts` (section 15)
- Shared helpers: `e2e/solids-kit.ts`

Spec names are the start of the test title in `61`. Preconditions that are not under test (a sketch, a seeded box) are added without the UI; everything under test is mouse and keyboard.

The one thing a Fusion user will hit first: selecting a face and pressing Delete. Section 1.

## 1. Delete on a selected face (Fusion: Delete removes the face and heals it)

Fusion: select a face (a fillet, a chamfer, a hole wall, a boss) and press Delete. Fusion runs Delete Face (Modify > Delete) with Heal: the round goes, the sharp corner comes back, a hole fills. It adds a "Delete" step to the timeline that can be edited and undone. It works on any B-rep face, whether or not a Fillet feature made it (imported STEP, a rounded sketch corner).

What this app does today: Delete with a face selected deletes the whole body. It adds a `delete` step (the whole body goes). The Delete Face tool exists (Modify > Press/Pull menu > Delete Face, kernel op heals fillets, holes and bosses) but Delete does not use it.

- [GAP] One fillet face selected, Delete: the body must stay with the corner sharp again (24000 mm3). Today the body vanishes (`Delete on a selected fillet face heals it`)
- [GAP] The timeline gets an editable Delete Face step, not a `delete` of the body (`Delete on a fillet face adds an editable Delete Face step`)
- [GAP] Ctrl+Z after that brings the round back (`Delete on a fillet face can be undone`)
- [GAP] A chain of fillet faces (the top edge round and its corner round, three faces, shift-click) heals all of them (`Delete on a chain of fillet faces`)
- [GAP] A chamfer face heals the same way (`Delete on a chamfer face`)
- [GAP] The wall of a hole is a face; Delete fills the hole (`Delete on the wall of a hole fills the hole`)
- [GAP] A fillet in a body that has no Fillet feature (a rounded corner in an extruded sketch, as an imported STEP would be): Delete heals it (`Delete on a fillet face of a body that was never filleted`)
- [OK] The Delete Face tool itself (menu entry present, kernel heals fillets, holes and bosses: `src/kernel/modeling-ops.test.ts`)

## 2. Fillet

Fusion's dialog: Edges (with Tangent Chain on by default), Type (Rolling ball / Chord length / Setback), Radius, per-edge Variable radius, corner Setback, Rule fillet, G2, a radius manipulator in the canvas, live preview.

- [OK] Click an edge, type the radius, live preview, OK (`Fillet: click an edge, type the radius`)
- [OK] A drag arrow stands in the viewport for the radius (`Fillet: a drag arrow stands in the viewport`)
- [OK] Picking a face takes all of its edges, picking it again lets them go (`48-tool-feel`, not repeated here)
- [OK] A radius too large for the part is reported and the body is not lost (`Fillet: a radius too large`)
- [OK] A zero or negative radius is not accepted (`Fillet: a negative or zero radius`)
- [OK] Edit the radius from the timeline, then change the extrude below it: the fillet follows and stays `ok` (`Fillet: edit the radius from the timeline`, `Fillet: the extrude shortened under a fillet`)
- [GAP] Tangent Chain: clicking one edge of a tangent chain (line, arc, line) takes the whole chain. Here each edge is clicked on its own (`Fillet: clicking one edge of a tangent chain`)
- [OK] Variable radius: a radius at each end, an optional middle radius and a Swap ends box (`Fillet: Variable radius`). Kernel: `edgeModAdv`, spec `src/kernel/solids2-ops.test.ts`
- [OK] Setback and Rule fillet in the dialog (`Fillet: Setback corner type and Rule fillet`). Setback is the nearest OpenCascade can do: at a corner where rounded edges meet, the radius eases up over the setback length (OpenCascade has no true vertex setback blend). Rule rounds, besides the picked edges, every edge of their faces, or every convex / concave / sharp edge of the body
- [OK] Chord length (the radius is worked out from the chord and the angle of each edge, exact) and G2 (asks OpenCascade for a C2 round surface; its join to the faces stays tangent, G1, so this is a smoother surface and not a curvature-continuous join)

## 3. Chamfer

- [OK] Equal distance on an edge (`Chamfer: equal distance on an edge`)
- [OK] A distance too large is reported, the body is not lost (`Chamfer: a distance too large`)
- [OK] Two distances (with Flip side) and Distance and angle (`Chamfer: Two distances and Distance and angle`)

## 4. Shell

Fusion: Faces to remove, Inside / Outside / Both sides, Thickness, Tangent chain, Individual thickness per face.

- [OK] Remove the top face, inside, 2 mm wall: exact volume (`Shell: remove the top face`)
- [OK] A face selected before starting the tool is the face to remove (`Shell: the face picked before the tool starts`)
- [OK] Outside grows the wall outward and keeps the inner size (`Shell: Outside grows the wall outward`)
- [PARTIAL] Outside rounds the outer corners and bottom edges (offset with rounded joins, about 2.3% less volume than the sharp 64 x 44 x 12 box) where Fusion keeps them sharp (`Shell: Outside keeps the outer corners ... sharp`)
- [OK] A zero or negative thickness is not accepted (`Shell: a zero or negative thickness`)
- [OK] A wall thicker than half the part is reported and the body stays (`Shell: a wall thicker than half the part`)
- [OK] Several faces can be removed (`Shell: several faces can be removed`)
- [OK] Edit the extrude under the shell to a size the shell cannot fit, then back: the shell recovers (`Shell: extrude under it cut down ...`)
- [GAP] After a fillet on the top edges the shell gives the wrong wall: box 80 x 50 x 30 with R3 top edges, top face removed, 1.5 mm: 52845 mm3 where the wall is about 17000. The same shell without the fillet is exact (16858). This is the classic enclosure order in Fusion (fillet, then shell) (`Shell: after a fillet on the top edges the shell is the right wall`)
- [GAP] A wall thicker than the fillet radius gives a Shell step that is `ok` with the body unchanged and no message; Fusion says the shell failed (`Shell: a wall thicker than the outside fillet radius reports an error`)
- [OK] Individual (per-face) thickness: pick flat faces and give them a thickness of their own; every other face keeps the Thickness (`Shell: a different thickness for a chosen face`). A face that is not flat keeps the base thickness (the kernel refuses it with a message)

## 5. Revolve

Fusion: Profile, Axis (a sketch line or edge or construction axis), Type (Angle / To / Full), Direction (One side / Two sides / Symmetric), Operation.

- [OK] A profile against its axis, a full turn, live preview, OK (`Revolve: a profile against its axis`)
- [OK] A typed angle of 90 makes a quarter (`Revolve: a typed angle of 90`)
- [OK] Join / Cut / Intersect / New body are offered (`Revolve: Cut, Intersect and New body`). The axis it picks by itself, and a selected edge as axis: `48-tool-feel`; the angle arc handle: `48-tool-feel` (Revolve has a rotary handle)
- [OK] Direction One side / Symmetric / Two sides (a second angle), and Extent To object for a flat face or a plane (`Revolve: Symmetric, Two sides and To object extents`). To object stops where the profile's farthest point reaches the plane; curved faces are not offered

## 6. Sweep, Loft, Rib, Web

- [OK] Sweep: the profile is taken, a click on the path line sets the path, live preview, right volume (`Sweep: the profile is taken`)
- [OK] Sweep: Orientation (perpendicular / parallel), Taper angle (the profile scales about its centre, a circle tapers exactly by the angle), Twist angle (a steering curve that turns along the path) and Guide rail (a second sketch curve that steers the profile) (`Sweep: Orientation, Taper angle, Twist angle and Guide rail`)
- [OK] Loft: two profiles at different heights blend into a frustum with the right volume, live preview. Both sketches are taken in order at once (`Loft: two profiles at different heights`)
- [OK] Loft: Guide rails, Center line and start / end conditions (`Loft: guide rails, a centre line and end conditions`). Free, Normal to profile (the loft holds square to the profile for a weighted distance, the nearest to tangent OpenCascade's loft allows) and Smooth (C2 surface). Rails and a center line go through a pipe shell: the profiles must sit at the ends (or corners) of the line, a loft on rails needs a corner at every profile in between
- [OK] Rib: a sketch line thickened into a wall (thickness, symmetric or one side, in plane or normal, flip, to next or a distance) that grows up to the faces it meets and is joined to the body (`Rib and Web exist in the Create menu`)
- [OK] Web: the same for every line of a sketch, normal to the sketch plane by default, with Both ways

## 7. Primitives, Thread

- [OK] Box with typed width, depth and height (`Box: typed width, depth and height`). Drag arrows: `50-drag-handles`
- [OK] Cylinder from the Box menu with radius and height (`Cylinder from the Box menu`). Drag arrows: `50-drag-handles`
- [OK] Sphere (`Sphere primitive is in the Create menu`)
- [OK] Torus (`Torus primitive ...`)
- [OK] Coil: revolutions and height, revolutions and pitch, or height and pitch; round, square or triangular wire; hollow; left handed (`Coil primitive ...`)
- [OK] Pipe: follows a sketch path; round, square or triangular section, hollow with a wall (`Pipe primitive ...`)
- [OK] Thread is a button in the Create group of the Solid tab, as well as in the Detail tab (`Thread is in the Solid tab Create group`)

## 8. Hole

- [OK] Click a point on a face, type the diameter, Through all (`Hole: click a point on a face`)
- [OK] Counterbore with bore diameter and depth (`Hole: counterbore`)
- [OK] Countersink has a diameter and an angle (`Hole: countersink has a diameter and an angle`)
- [PARTIAL] The countersink diameter keeps its own default of 4: a 5 mm hole typed over it fails with "The countersink must be wider than the hole". Fusion widens the cone with the hole (`Hole: a countersink follows the hole diameter`)
- [PARTIAL] Tapped gives a cosmetic thread mark only; there is no Modeled thread option (`Hole: Tapped offers a modeled thread`)
- [OK] Position from edges: pick Edge 1 (and Edge 2) of the face after the click and type the offsets; the first hole moves to that spot (`Hole: an exact position from an edge`)
- [OK] Through all follows an edit of the plate thickness under it (`Hole: through all follows an edit of the plate thickness`)
- [OK] Drag arrows for depth, diameter and angles: `50-drag-handles`; presets, concentric snap: `21-modeling-tools`, `59`

## 9. Pattern and Mirror

- [OK] Rectangular pattern of a body, quantity and distance typed (`Pattern: a rectangular pattern of a body`)
- [OK] Circular pattern of a body (axis field) and Path type offered (`Pattern: circular and along-a-path types`)
- [OK] Distance type (Spacing / Extent), Symmetric, Flip and a Second direction (`Pattern: Fusion pattern extents`)
- [OK] Feature pattern with a skipped instance and an upstream edit: `21-modeling-tools`
- [OK] Mirror a body across a plane, joined: `21-modeling-tools`; mirror takes the selected body and plane: `49-tool-defaults`
- [OK] Pattern and Mirror drag arrows: `50-drag-handles`

## 10. Press/Pull, direct edits, Draft, Scale

- [OK] Press/Pull: pick the top face, type a distance, the plate grows (`Press/Pull: pick the top face`)
- [OK] Menu has Offset Face, Delete Face, Replace Face, Split Face, Split Body and Draft (`Direct-edit menu`). Replace Face and Split Face are checked at kernel level only (`src/features/modeling-tools/tools.test.ts`), not driven here
- [OK] Draft: a side face tilted about the top face as the neutral plane changes the part (`Draft: a side face tilted`). Angle arc: `50-drag-handles`
- [PARTIAL] Draft: a click on the top face for the neutral plane picks the XZ origin plane drawn across the view, not the face (`Draft: a click on the top face picks that face`)
- [OK] Draft types Parting line (the faces are split at the level of a picked edge and each half tilts away from it, as the two halves of a mould) and Step (only the half on the pull side tilts) (`Draft: Parting line and Step draft types`)
- [OK] Split Body: a plane through the middle makes two bodies (`Split Body: a plane through the middle`)
- [OK] Scale: a uniform factor of 2 in the Move gizmo doubles the part (`Scale: a uniform scale factor of 2`)
- [OK] Modify > Scale: Uniform factor or Non-uniform X / Y / Z, with a scale point (`Scale: a separate Scale command`). A non-uniform scale gives a mesh body: this OpenCascade build has no general transform for a solid

## 11. Move / Copy, Align

- [OK] Translate by a typed amount (`Move: translate X by 25`)
- [OK] Rotate 90 degrees about Z (`Move: rotate 90 degrees`)
- [OK] Create copy checkbox: the original stays, a moved copy is made (`Move: a Create copy option`)
- [OK] Move type: Free move, Point to point, Point to position, Translate along axis, Rotate about axis (with a pivot point) (`Move: Point to point`)
- [OK] Align: a face, edge or corner of one body onto the same kind of feature of another, with Flip, Angle and Offset (`Align: align a body to another`)

## 12. Combine

Fusion picks the target and tools by clicking bodies in the canvas.

- [OK] Join two overlapping blocks into one body (`Combine: Join two overlapping blocks`)
- [OK] Cut (`Combine: Cut`), Intersect (`Combine: Intersect`)
- [OK] Keep tools leaves the tool body after a Cut (`Combine: Keep tools`)
- [PARTIAL] With Combine open a click on a body in the viewport selects nothing; bodies are picked from the Browser tree (`Combine: clicking a body in the viewport`)

## 13. Construct, Inspect, material

- [OK] Offset plane (the Construct group has Plane at Angle, Tangent Plane, Midplane, Plane Through 3 Points, Axis through 2 points / normal to face / of cylinder, Point at vertex / centre / axis and plane) (`Construct menus ...`). Drags: `50-drag-handles`; angle plane, axis and point driving: `21-modeling-tools`
- [OK] Offset Plane from the top face selected first, with a typed distance (`Offset Plane: with the top face selected first`)
- [PARTIAL] Offset Plane: a face clicked after the tool has started is selected but the dialog keeps the XY origin plane as its base (`Offset Plane: a face clicked after the tool has started`)
- [OK] Plane at Angle has plane, axis and angle (`Plane at Angle`)
- [OK] Measure: the distance between two faces at different heights (`Measure`)
- [OK] Section Analysis: plane normal, offset and flip; arrow for the offset: `50-drag-handles` (`Section Analysis: plane normal, offset and flip`)
- [PARTIAL] Section plane cannot be picked from an origin plane or a face (`Section Analysis: the section plane is picked`)
- [OK] Interference is in the Inspect group of the Solid tab (`Interference of solid bodies`)
- [OK] Physical Material with a material list; the density drives the mass, area and centre of gravity that Measure shows for a body (`Physical Material`)
- [OK] Appearance is in the Modify group of the Solid tab (`Appearance is in the Solid tab`)

## 14. Break it

Each is a spec in `61`; all pass as written unless a gap above says otherwise.

- [OK] Escape in the Fillet dialog cancels: no step, no preview (`Escape in the Fillet dialog`)
- [OK] Ctrl+Z / Ctrl+Y while the Fillet dialog is open leave the document whole (`Ctrl+Z while the Fillet dialog is open`)
- [OK] Undo and redo after a fillet put back exactly the fillet, stray Escapes included (`Undo and redo after a fillet`)
- [OK] Deleting the sketch under an extruded, filleted part does not crash and undo brings it back (`Deleting the sketch under`)
- [PARTIAL] Two sketches on one plane (80 x 50 and a 72 x 42 inside it): a click in the middle of Extrude picks the bigger, earlier profile; Fusion offers the innermost (`Extrude: a click in the middle of two overlapping sketches`)
- [GAP] A rectangle that shares an edge with the projected outline of a face does not give the strip as a profile (only the 2160 remainder of 2400 appears), so a wall drawn against the back edge cannot be extruded (`Sketch on a face: a rectangle that shares an edge`)
- [GAP] Shell after fillet gives the wrong body, and a wall thicker than the fillet is an `ok` no-op: section 4
- [GAP] Delete on a face deletes the body: section 1

## 15. Real parts (`e2e/62-solids-tools-real-parts.spec.ts`)

Each is built from a blank document with the mouse and keyboard.

- Enclosure (80 x 50 x 30 box, 2 mm shell open at the top, an R1 fillet on the outer rim edges, an offset plane 5 above, a lid with a lip as one body): completes with workarounds
  - WORKAROUND: Shell first, then Fillet. Fillet then Shell (the Fusion order) gives a wrong body (section 4)
  - WORKAROUND: only the rim edges the camera sees were filleted (clicked one by one: no tangent chain, and the hidden edges need an orbit)
  - WORKAROUND: the lip was drawn and extruded before the lid. Two sketches on one plane overlap and a click in the middle picks the bigger, earlier profile (section 14)
  - WORKAROUND: the plane is Offset Plane from the XY origin plane typed 35 up. Clicking the rim face after the tool started does not set it as the base (section 13)
- Knob (revolved profile drawn with the Line tool on XZ, a groove sketched on the top face and cut with a negative distance, circular pattern of 12): the revolve and the cut work; the test is `test.fail()` because the pattern of the cut removes 3834 mm3 where 12 copies of the groove (18 mm3) should remove about 216, and the single cut step shows a "warning" state: GAP
  - WORKAROUND: the pattern had to be started with Escape twice and the step picked in the timeline first, else a face left selected makes Pattern start in Faces mode and the step fails ("The selected faces no longer exist")
- Bracket (60 x 40 x 5 base, a wall, two counterbored holes, a rib, a chamfer): completes
  - WORKAROUND: no Rib tool. A triangle sketched on an offset YZ plane and extruded symmetric 4 mm and joined
  - WORKAROUND: the wall rectangle is drawn 4 mm in from the back edge, not against it. A rectangle sharing an edge with the projected outline loses the strip profile (section 14)
- Handle (10 mm circle swept along a half circle of radius 20 on XZ): completes, volume within 3% of the theory
  - WORKAROUND: the arc path is added without the UI (Arc tool gestures are the Sketch pass's job). The end chamfers of a real handle were not built
- Flange (100 mm disc with a 30 mm bore as two circles in one sketch, 8 mm thick, one 6 mm through hole at radius 35, circular pattern of 6): completes
  - WORKAROUND: the pattern is started with Escape twice, then the hole step picked in the timeline

Never reached in any part: Rib, Web, Sphere, Torus, Coil, Pipe, Thread (not in the Solid tab), a fillet and shell in the Fusion order, Delete on a round (section 1).
