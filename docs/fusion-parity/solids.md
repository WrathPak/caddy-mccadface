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

- [OK] One fillet face selected, Delete: the body stays and the corner is sharp again (24000 mm3). Delete on faces runs Delete Face (`Delete on a selected fillet face heals it`); with a whole body selected it still deletes the body, and a face that cannot heal says so and leaves the body alone
- [OK] The timeline gets an editable Delete Face step, not a `delete` of the body (`Delete on a fillet face adds an editable Delete Face step`)
- [OK] Ctrl+Z after that brings the round back (`Delete on a fillet face can be undone`)
- [OK] A chain of fillet faces (the top edge round and its corner round, three faces, shift-click) heals all of them (`Delete on a chain of fillet faces`)
- [OK] A chamfer face heals the same way (`Delete on a chamfer face`)
- [OK] The wall of a hole is a face; Delete fills the hole (`Delete on the wall of a hole fills the hole`)
- [OK] A fillet in a body that has no Fillet feature (a rounded corner in an extruded sketch, as an imported STEP would be): Delete heals it (`Delete on a fillet face of a body that was never filleted`)
- [OK] The Delete Face tool itself (menu entry present, kernel heals fillets, holes and bosses: `src/kernel/modeling-ops.test.ts`)

## 2. Fillet

Fusion's dialog: Edges (with Tangent Chain on by default), Type (Rolling ball / Chord length / Setback), Radius, per-edge Variable radius, corner Setback, Rule fillet, G2, a radius manipulator in the canvas, live preview.

- [OK] Click an edge, type the radius, live preview, OK (`Fillet: click an edge, type the radius`)
- [OK] A drag arrow stands in the viewport for the radius (`Fillet: a drag arrow stands in the viewport`)
- [OK] Picking a face takes all of its edges, picking it again lets them go (`48-tool-feel`, not repeated here)
- [OK] A radius too large for the part is reported and the body is not lost (`Fillet: a radius too large`)
- [OK] A zero or negative radius is not accepted (`Fillet: a negative or zero radius`)
- [OK] Edit the radius from the timeline, then change the extrude below it: the fillet follows and stays `ok` (`Fillet: edit the radius from the timeline`, `Fillet: the extrude shortened under a fillet`)
- [OK] Tangent Chain: clicking one edge of a tangent chain (line, arc, line) takes the whole chain, on by default, with a Tangent chain checkbox in the dialog (`Fillet: clicking one edge of a tangent chain`)
- [GAP] Variable radius (a radius per end) (`Fillet: Variable radius`)
- [GAP] Setback corner type and Rule fillet (`Fillet: Setback corner type and Rule fillet`)
- [GAP] Chord length and G2 (curvature continuous) fillet types: not offered (same dialog; no separate spec)

## 3. Chamfer

- [OK] Equal distance on an edge (`Chamfer: equal distance on an edge`)
- [OK] A distance too large is reported, the body is not lost (`Chamfer: a distance too large`)
- [GAP] Two distances and Distance and angle (`Chamfer: Two distances and Distance and angle`)

## 4. Shell

Fusion: Faces to remove, Inside / Outside / Both sides, Thickness, Tangent chain, Individual thickness per face.

- [OK] Remove the top face, inside, 2 mm wall: exact volume (`Shell: remove the top face`)
- [OK] A face selected before starting the tool is the face to remove (`Shell: the face picked before the tool starts`)
- [OK] Outside grows the wall outward and keeps the inner size (`Shell: Outside grows the wall outward`)
- [OK] Outside keeps the outer corners and bottom edges sharp (an intersection join, as Fusion) (`Shell: Outside keeps the outer corners ... sharp`)
- [OK] A zero or negative thickness is not accepted (`Shell: a zero or negative thickness`)
- [OK] A wall thicker than half the part is reported and the body stays (`Shell: a wall thicker than half the part`)
- [OK] Several faces can be removed (`Shell: several faces can be removed`)
- [OK] Edit the extrude under the shell to a size the shell cannot fit, then back: the shell recovers (`Shell: extrude under it cut down ...`)
- [OK] After a fillet on the top edges the shell gives the real wall: box 80 x 50 x 30 with R3 top edges, top face removed, 1.5 mm: about 17000 mm3, the enclosure order in Fusion (fillet, then shell) (`Shell: after a fillet on the top edges the shell is the right wall`)
- [OK] A wall thicker than the fillet radius still shells: the inward offset is taken from a copy with the thin rounds healed away, so the inside corner is sharp (`Shell: a wall thicker than the outside fillet radius still shells`)
- [GAP] Individual (per-face) thickness (`Shell: a different thickness for a chosen face`)

## 5. Revolve

Fusion: Profile, Axis (a sketch line or edge or construction axis), Type (Angle / To / Full), Direction (One side / Two sides / Symmetric), Operation.

- [OK] A profile against its axis, a full turn, live preview, OK (`Revolve: a profile against its axis`)
- [OK] A typed angle of 90 makes a quarter (`Revolve: a typed angle of 90`)
- [OK] Join / Cut / Intersect / New body are offered (`Revolve: Cut, Intersect and New body`). The axis it picks by itself, and a selected edge as axis: `48-tool-feel`; the angle arc handle: `48-tool-feel` (Revolve has a rotary handle)
- [GAP] Symmetric, Two sides and To object (`Revolve: Symmetric, Two sides and To object extents`)

## 6. Sweep, Loft, Rib, Web

- [OK] Sweep: the profile is taken, a click on the path line sets the path, live preview, right volume (`Sweep: the profile is taken`)
- [GAP] Sweep: Orientation (perpendicular / parallel), Taper angle, Twist angle, Guide rail (`Sweep: Orientation, Taper angle, Twist angle and Guide rail`)
- [OK] Loft: two profiles at different heights blend into a frustum with the right volume, live preview. Both sketches are taken in order at once (`Loft: two profiles at different heights`)
- [GAP] Loft: guide rails, centre line, end conditions (tangent, smooth) (`Loft: guide rails, a centre line and end conditions`)
- [GAP] Rib (`Rib and Web exist in the Create menu`)
- [GAP] Web (same test)

## 7. Primitives, Thread

- [OK] Box with typed width, depth and height (`Box: typed width, depth and height`). Drag arrows: `50-drag-handles`
- [OK] Cylinder from the Box menu with radius and height (`Cylinder from the Box menu`). Drag arrows: `50-drag-handles`
- [GAP] Sphere (`Sphere primitive is in the Create menu`)
- [GAP] Torus (`Torus primitive ...`)
- [GAP] Coil (`Coil primitive ...`)
- [GAP] Pipe (`Pipe primitive ...`)
- [PARTIAL] Thread exists (Detail tab, and a cosmetic thread on tapped holes) but is not a Create > Thread button in the Solid tab (`Thread is in the Solid tab Create group`)

## 8. Hole

- [OK] Click a point on a face, type the diameter, Through all (`Hole: click a point on a face`)
- [OK] Counterbore with bore diameter and depth (`Hole: counterbore`)
- [OK] Countersink has a diameter and an angle (`Hole: countersink has a diameter and an angle`)
- [OK] The countersink (and counterbore) diameter follows the hole diameter while it is at its automatic size, and is widened if it would not be wider than the hole (`Hole: a countersink follows the hole diameter`)
- [OK] Tapped has a Modeled option that cuts the real helix (`Hole: Tapped offers a modeled thread`)
- [GAP] No field to type the offsets from the edges after a click (Fusion drops into a sketch to dimension the point; here only the click or sketch points place it) (`Hole: an exact position from an edge`)
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
- [OK] Draft: a click on the top face picks that face for the neutral plane; a body face under the pointer wins over an origin plane drawn across the view (`Draft: a click on the top face picks that face`)
- [GAP] Draft types Parting line and Step (`Draft: Parting line and Step draft types`)
- [OK] Split Body: a plane through the middle makes two bodies (`Split Body: a plane through the middle`)
- [OK] Scale: a uniform factor of 2 in the Move gizmo doubles the part (`Scale: a uniform scale factor of 2`)
- [PARTIAL] Scale is a mode of Move, not Modify > Scale with Uniform / Non-Uniform and a scale point (`Scale: a separate Scale command`)

## 11. Move / Copy, Align

- [OK] Translate by a typed amount (`Move: translate X by 25`)
- [OK] Rotate 90 degrees about Z (`Move: rotate 90 degrees`)
- [GAP] Create Copy (the command is called Move / Copy, the dialog has no copy option) (`Move: a Create copy option`)
- [GAP] Point to Point and a pivot or axis for the rotation (rotation is about the body centre) (`Move: Point to point`)
- [GAP] Align (`Align: align a body to another`)

## 12. Combine

Fusion picks the target and tools by clicking bodies in the canvas.

- [OK] Join two overlapping blocks into one body (`Combine: Join two overlapping blocks`)
- [OK] Cut (`Combine: Cut`), Intersect (`Combine: Intersect`)
- [OK] Keep tools leaves the tool body after a Cut (`Combine: Keep tools`)
- [OK] With Combine open a click on a body in the viewport picks the body (`Combine: clicking a body in the viewport`)

## 13. Construct, Inspect, material

- [OK] Offset plane (the Construct group has Plane at Angle, Tangent Plane, Midplane, Plane Through 3 Points, Axis through 2 points / normal to face / of cylinder, Point at vertex / centre / axis and plane) (`Construct menus ...`). Drags: `50-drag-handles`; angle plane, axis and point driving: `21-modeling-tools`
- [OK] Offset Plane from the top face selected first, with a typed distance (`Offset Plane: with the top face selected first`)
- [OK] Offset Plane: a face (or origin plane) clicked after the tool has started becomes the base (`Offset Plane: a face clicked after the tool has started`)
- [OK] Plane at Angle has plane, axis and angle (`Plane at Angle`)
- [OK] Measure: the distance between two faces at different heights (`Measure`)
- [OK] Section Analysis: plane normal, offset and flip; arrow for the offset: `50-drag-handles` (`Section Analysis: plane normal, offset and flip`)
- [OK] The section plane can be picked from an origin plane, a construction plane or a flat face, with an offset from it (`Section Analysis: the section plane is picked`)
- [PARTIAL] Interference is an assembly command, not in the Solid tab Inspect group (`Interference of solid bodies`)
- [GAP] Physical Material (density, mass, centre of gravity) (`Physical Material`)
- [PARTIAL] Appearance exists (Render tab) but not in the Solid tab (`Appearance is in the Solid tab`)

## 14. Break it

Each is a spec in `61`; all pass as written unless a gap above says otherwise.

- [OK] Escape in the Fillet dialog cancels: no step, no preview (`Escape in the Fillet dialog`)
- [OK] Ctrl+Z / Ctrl+Y while the Fillet dialog is open leave the document whole (`Ctrl+Z while the Fillet dialog is open`)
- [OK] Undo and redo after a fillet put back exactly the fillet, stray Escapes included (`Undo and redo after a fillet`)
- [OK] Deleting the sketch under an extruded, filleted part does not crash and undo brings it back (`Deleting the sketch under`)
- [OK] Two sketches on one plane (80 x 50 and a 72 x 42 inside it): a click in the middle of Extrude offers the innermost profile (`Extrude: a click in the middle of two overlapping sketches`)
- [OK] A rectangle that shares an edge with the projected outline of a face gives the strip as a profile (240) and the remainder (2160), so a wall can be drawn against the back edge (`Sketch on a face: a rectangle that shares an edge`)
- [OK] Shell after fillet gives the right body and a wall thicker than the fillet works: section 4
- [OK] Delete on a face heals it (Delete Face), it no longer deletes the body: section 1

## 15. Real parts (`e2e/62-solids-tools-real-parts.spec.ts`)

Each is built from a blank document with the mouse and keyboard.

- Enclosure (80 x 50 x 30 box, an R3 fillet on the top edges, a 2 mm shell open at the top, an offset plane 5 above, a lid with a lip as one body): completes with no workaround, in the Fusion order
  - the plane is Offset Plane with the box top clicked after the tool started; one click on the top face takes all four fillet edges; the lid is drawn first and the lip second (the click in the middle offers the inner rectangle)
- Knob (revolved profile drawn with the Line tool on XZ, a groove sketched on the top face and cut with a negative distance, circular pattern of 12): completes with no workaround; the pattern removes 12 grooves and the cut step no longer warns
- Bracket (60 x 40 x 5 base, a wall, two counterbored holes, a rib, a chamfer): completes
  - WORKAROUND: no Rib tool. A triangle sketched on an offset YZ plane and extruded symmetric 4 mm and joined
  - the wall rectangle is drawn against the back edge, sharing it with the projected outline
- Handle (10 mm circle swept along a half circle of radius 20 on XZ): completes, volume within 3% of the theory
  - WORKAROUND: the arc path is added without the UI (Arc tool gestures are the Sketch pass's job). The end chamfers of a real handle were not built
- Flange (100 mm disc with a 30 mm bore as two circles in one sketch, 8 mm thick, one 6 mm through hole at radius 35, circular pattern of 6): completes with no workaround (Pattern started from the hole step in the timeline repeats that feature)

Never reached in any part: Rib, Web, Sphere, Torus, Coil, Pipe, Thread (not in the Solid tab).
