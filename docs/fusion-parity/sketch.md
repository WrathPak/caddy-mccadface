# Fusion 360 sketch environment vs CADdy McCADFace

Written for the owner to skim and correct. Fusion behaviour is from daily-use knowledge of Fusion, not from this app's code. Status marks come from driving the app (real clicks, keys, typing) at 1280x800 on an origin plane and an offset plane, plus the earlier specs `e2e/22`, `53`, `54` where noted.

- `[OK]` matches Fusion
- `[GAP]` Fusion does it, we do not. Failing spec in `e2e/55-sketch-parity.spec.ts` (marked `test.fail()`, flips when fixed)
- `[PARTIAL]` works but differs. Spec named
- Part specs: `e2e/56-sketch-real-parts.spec.ts`
- Screenshots of every tool at three sizes: `e2e/screenshots/parity/`

Spec names below are the start of the test title in `55` unless a file is given.

## 1. Starting, finishing, editing a sketch

- [OK] Sketch button, pick XY/XZ/YZ in the browser tree, view turns to look at the plane
- [OK] Sketch on an offset (construction) plane: sketch sits on it, feature order is plane then sketch (`Sketch on an offset plane`)
- [GAP] Fusion shows the origin planes in the canvas after Create Sketch and you click one there. Here only the browser tree works (`Starting a sketch: after Sketch, a click on the plane in the viewport picks it`)
- [OK] Finish Sketch button, Cancel button, empty sketch makes no feature
- [OK] Double-click a sketch in the browser to edit it (`e2e/22`)
- [OK] Sketch dimensions stay editable after reopening, user parameters still drive them (`Dimension: a user parameter ...`)

## 2. Selection

- [OK] Click selects a curve or point; click empty space or Escape clears (`Selection: Escape with a selection ...`)
- [OK] Shift+click adds (`e2e/53`)
- [GAP] Ctrl+click (or Shift+click) on something already selected removes it from the selection. Ours keeps it (`Selection: Ctrl+click takes a selected curve out`)
- [OK] Box drag left to right selects only what is enclosed, right to left selects what it touches (`e2e/53`)
- [OK] Ctrl+A selects the whole sketch (`e2e/53`)
- [GAP] Double-click a curve selects the whole connected chain (`Selection: double-clicking a curve selects the whole chain`)
- [OK] Select before tool: Dimension, Offset, Horizontal, Equal, Mirror, Patterns start from the selection (`e2e/53`, `e2e/54`)
- [OK] Pick inside the tool for Mirror, Circular pattern, Scale (curves, then Enter or Next, then the line or centre) (`e2e/53`, `e2e/54`)
- [GAP] Ctrl+C / Ctrl+V of selected sketch curves makes copies. Ctrl+V does nothing here (`Copy and paste`)
- [GAP] Right-click on a curve or in a tool gives the marking/context menu (Delete, Normal/Construction, Repeat, Undo, OK). Here no menu opens (`Right-click on a selected curve opens a menu`)

## 3. Creation tools

Line
- [OK] Click, click, chain continues; Escape drops the rubber band, second Escape leaves the tool
- [OK] Closing on the start point ends the chain and makes a profile
- [OK] Typed length, Tab, angle, Enter (`e2e/54`)
- [OK] Drag from a line end draws a tangent arc (`e2e/53`)
- [GAP] Occasionally a click is swallowed: after closing a triangle, a horizontal line from (60,40) to (80,40) draws nothing because the click snaps to a stray inference (`Line: a horizontal line drawn clear of a closed triangle`)

Rectangle, circle, arc
- [OK] 2-point rectangle: four lines, horizontal/vertical constraints, only position left free
- [OK] 3-point rectangle (`e2e/54`)
- [OK] Centre rectangle: typed 100 x 60 gives a fully constrained rectangle on the origin with a construction diagonal and midpoint (`56 Mounting plate`)
- [OK] Centre-diameter circle: the typed value is the diameter (`Circle: the typed value is the diameter`)
- [OK] 2-point, 3-point, 2-tangent circles (`e2e/54`)
- [OK] 3-point arc, centre-point arc, tangent arc (`e2e/54`)

Other curves
- [OK] Fit point spline, control point spline, closing by clicking the first point, tangent handles (`e2e/22`)
- [OK] Ellipse, slots (three kinds), polygon (inscribed, circumscribed, edge), point, text, SVG/DXF import (`e2e/22`, `e2e/54`)
- [GAP] Conic curve is missing from the Create menus (`Conic Curve exists`)
- [PARTIAL] Chamfer in a sketch has two distances only. Fusion also has equal distance and distance-and-angle (`Sketch chamfer offers distance and angle`)
- [OK] Typed values (Tab between fields, Enter) on slots, polygon, ellipse, spline, arcs, circles (`e2e/54`)
- [OK] Hotkeys L R C A D T Q, X toggles construction on the selection (`Keyboard: X toggles construction`)
- [GAP] O is Offset in Fusion; here O does nothing (`Keyboard: O starts Offset`)

## 4. Inference and snapping

- [OK] Horizontal and vertical inference with the constraint added (a vertical next to a horizontal line may be stored as perpendicular to it, same result)
- [OK] Perpendicular to a hovered line (`Line: a second line drawn square to a hovered line`)
- [OK] Midpoint of a line gives a midpoint constraint; ending on a line gives point-on-line (`Line: ending on the middle of another line`)
- [OK] Intersection snap ties the point to both curves (`Line: a line started where two lines cross`)
- [OK] Centre snap: a circle clicked on another circle's centre shares the centre
- [OK] Origin and axis snap on lines and circle centres (point on axis constraint)
- [OK] Snap settings popover in the status bar (Fusion has Snap and Sketch Grid in the palette; see section 11)
- [GAP] Construction lines get none of the inferred constraints a normal line gets (a construction line from the origin up the Y axis is left free to turn) (`Construction line drawn up the Y axis`)
- [GAP] Fit point spline points clicked on an axis get no on-axis constraint, unlike lines and circle centres (`Fit point spline: a point clicked on an axis`)
- Note: an Equal-length and Parallel inference also fires (a new line that matched another got both constraints). Fusion has fewer hints; not specced

## 5. Constraints

- [OK] Coincident curve first or point first (`e2e/53`)
- [OK] Horizontal, Vertical, Equal apply to a whole selection (`e2e/53`)
- [OK] Concentric, Collinear, Symmetry, Midpoint, Smooth, Parallel, Perpendicular, Tangent, Fix (`e2e/53`, `e2e/54`)
- [OK] Constraint glyph click selects it, Delete removes just that one (`Constraints: click a constraint glyph`)
- [GAP] The sketch axes cannot be picked by Coincident (point on axis) (`Coincident: a loose point and a sketch axis`)
- [GAP] The sketch axes cannot be the line of symmetry (`Symmetry constraint can use a sketch axis`)
- [OK] Conflicting or redundant constraints are refused with a message

## 6. Dimension tool

- [OK] Line length, two parallel lines, angle between lines by sector, point to axis, ellipse radii, circle to circle, circle to line (`e2e/22`, `e2e/53`)
- [OK] Circle gets a diameter (⌀), arc a radius (R) (`Dimension: a circle gets a diameter`)
- [OK] Two points: the dimension turns horizontal, vertical or aligned with where it is placed (the exact zones Fusion uses were not compared)
- [OK] Value box opens on placing; Enter commits; Escape drops a new one, keeps the old value on an edit (`Dimension: Escape in the value box`)
- [OK] Reference (driven) dimension in brackets when the geometry is already fixed (`e2e/53`)
- [OK] Drag a dimension label; it follows its geometry (`e2e/22`)
- [OK] Units in the value (`1 in` is 25.4) and user parameters (`w`) (`Dimension: typing a value with units`, `Dimension: a user parameter`)
- [GAP] Fusion names each dimension d1, d2 and an expression can use them (d2 = d1 * 2). Ours has no dimension names (`Dimension: one dimension can use another`)
- Note: Fusion lets you flip an existing dimension between driving and driven. Not found in the UI; not tested (see the end)

## 7. Modify tools

- [OK] Trim a line at crossing curves; a line cut at a circle stays tied to it (`Trim: the new end of a line cut at a circle`)
- [GAP] Trimming a circle into an arc drops the constraints the cutting lines had on it, so a trimmed keyhole is closed but loose (`Trim: cutting a circle into an arc`, `56 Keyhole`)
- [OK] Extend, Break (`e2e/54`)
- [OK] Offset: one click picks the tangent chain (a rounded rectangle gives all 8 curves) (`Offset of a rounded rectangle`)
- [OK] Offset of a rectangle keeps corners sharp, a circle offsets concentrically (`e2e/22`)
- [GAP] A negative typed distance flips the offset to the other side of the cursor (`Offset of a circle: a negative typed distance`)
- [OK] Fillet and chamfer on lines and arcs, typed radius, dof kept (`e2e/22`, `e2e/54`)
- [OK] Mirror about a drawn line, with the mirror constraint (`e2e/53`, `56 Symmetric profile`)
- [GAP] Mirror about a sketch axis (the usual way to make a symmetric profile) (`Mirror can use the sketch Y axis`)
- [OK] Rectangular and circular patterns, typed counts, Enter applies (`e2e/22`, `e2e/53`)
- [OK] Scale about a base point with its dimensions (`e2e/54`)
- [GAP] Move/Copy (M) inside a sketch, with typed offsets and rotation. No such tool (`Move / Copy exists inside the sketch`)
- [OK] Deleting a corner point removes the two lines at it

## 8. Construction geometry

- [OK] X with a selection toggles it construction, X with nothing selected switches the mode (dashed, not part of profiles)
- [OK] Construction circle used for a bolt circle (`56 Mounting plate`)
- [GAP] No inferred constraints on construction lines (see section 4)

## 9. Dragging geometry

- [OK] Dragging one side of a plain rectangle moves only that side (`Dragging one side of a plain rectangle`)
- [OK] Dragging a circle by its edge resizes it, by its centre moves it (`Dragging a circle by its edge`)
- [OK] Fully constrained curves are in the solver's fixed set and the bar says Fully constrained (`56`, every part ends with it)
- [OK] A dragged side takes its dimensions with it (`e2e/22`)

## 10. Undo and redo

- [OK] Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z (`Sketch redo`)
- [OK] One step per operation (a typed rectangle, a trim, an offset undoes whole)
- [OK] Ctrl+Z mid-polyline and mid-spline takes back one point (`e2e/53`, `e2e/54`)

## 11. Sketch palette

Fusion shows a Sketch Palette panel while sketching. There is none here, so every option is a gap.

- [GAP] Look At (turn the view square to the sketch after orbiting). Only done once when the sketch starts (`Sketch palette has Look At`)
- [GAP] Show Profile (`Sketch palette has Show Profile`)
- [GAP] Show Points (`Sketch palette has Show Points`)
- [GAP] Show Dimensions, and it hides the labels (`Sketch palette has Show Dimensions`, `Show Dimensions off hides ...`)
- [GAP] Show Constraints (`Sketch palette has Show Constraints`)
- [GAP] Slice (`Sketch palette has Slice`)
- [GAP] 3D Sketch (`Sketch palette has 3D Sketch`)
- [OK] Snap is a status-bar toggle with a settings popover (grid snapping is a flag in it), standing in for the palette's Sketch Grid and Snap checkboxes

## 12. Layout

Screenshots: `e2e/screenshots/parity/<size>-<tool>.png`, 1280x800, 1000x700, phone 390x844, every tool.

- [GAP] The prompt that flashes in (for example "Click the two lines, circles or arcs ...") is centred and lands on top of the Cancel / Finish bar on 13 tools at 1280x800 and over the options bar as well at 1000x700 (`Layout at 1280x800`, `Layout at 1000x700`)
- [GAP] On a phone the same prompt covers the title of the options bar (`Layout on a phone, 390x844`)
- [GAP] At 1000x700 the "Fully constrained · 0 profiles" status wraps onto two lines and the 3D view is only about 470 px wide between the browser and the inspector (`Layout at 1000x700`)
- [OK] At 1280x800 the options bar sits clear of the Finish bar and view cube; it wraps rather than squeezing into a column
- [OK] Phone: options bar and Undo point / Done / Cancel / Finish bar fit the width, no sideways scrolling
- Note: phone Rectangular Pattern options take about 260 px of an 844 px screen (a third of the sketch area); not specced
- Note: the Text options bar reads "Text Text" (title and field label identical); not specced

## Not checked this pass

Sketching on a body face, Project, extrude (next pass). Not exercised: the exact zones where a two-point dimension turns horizontal, vertical or aligned; Insert image/canvas, Stretch, Blend curve, rotate-in-sketch, Sketch Dimension on splines, driven-dimension toggling, selecting profile regions for delete.
