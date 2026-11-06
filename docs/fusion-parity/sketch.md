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
- [OK] After Sketch the origin planes are drawn in the canvas as small squares beside the part and a click on one starts the sketch there. (The spec first clicked beside the origin, where there is nothing to click; it now clicks the square.) (`Starting a sketch: after Sketch, a click on the plane in the viewport picks it`)
- [OK] Finish Sketch button, Cancel button, empty sketch makes no feature
- [OK] Double-click a sketch in the browser to edit it (`e2e/22`)
- [OK] Sketch dimensions stay editable after reopening, user parameters still drive them (`Dimension: a user parameter ...`)

## 2. Selection

- [OK] Click selects a curve or point; click empty space or Escape clears (`Selection: Escape with a selection ...`)
- [OK] Shift+click adds (`e2e/53`)
- [OK] Ctrl+click (or Shift+click) on something already selected removes it from the selection (`Selection: Ctrl+click takes a selected curve out`)
- [OK] Box drag left to right selects only what is enclosed, right to left selects what it touches (`e2e/53`)
- [OK] Ctrl+A selects the whole sketch (`e2e/53`)
- [OK] Double-click a curve selects the whole connected chain (`Selection: double-clicking a curve selects the whole chain`)
- [OK] Select before tool: Dimension, Offset, Horizontal, Equal, Mirror, Patterns start from the selection (`e2e/53`, `e2e/54`)
- [OK] Pick inside the tool for Mirror, Circular pattern, Scale (curves, then Enter or Next, then the line or centre) (`e2e/53`, `e2e/54`)
- [OK] Ctrl+C / Ctrl+V of selected sketch curves makes copies, pasted in place and selected, with the constraints among them (`Copy and paste`)
- [OK] Right-click on a curve selects it and opens the sketch marking menu (Delete, Construction, Dimension, Offset, OK, Undo, Repeat, Copy) (`Right-click on a selected curve opens a menu`)

## 3. Creation tools

Line
- [OK] Click, click, chain continues; Escape drops the rubber band, second Escape leaves the tool
- [OK] Closing on the start point ends the chain and makes a profile
- [OK] Typed length, Tab, angle, Enter (`e2e/54`)
- [OK] Drag from a line end draws a tangent arc (`e2e/53`)
- [OK] A click is never swallowed by an inference. The line from (60,40) to (80,40) after a triangle drew nothing because (80,40) is under the view cube in the top right of the view; the spec now draws clear of the cube (`Line: a horizontal line drawn clear of a closed triangle`)

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
- [OK] Conic Curve (ends, the point where the tangents meet, a point it passes through) is in the spline menu; it is a curve of its own, closes profiles and drags by its three points (`Conic Curve exists`)
- [OK] Chamfer in a sketch: equal distance, two distances, or distance and angle (with both dimensioned) (`Sketch chamfer offers distance and angle`)
- [OK] Typed values (Tab between fields, Enter) on slots, polygon, ellipse, spline, arcs, circles (`e2e/54`)
- [OK] Hotkeys L R C A D T Q, X toggles construction on the selection (`Keyboard: X toggles construction`)
- [OK] O is Offset, M is Move / Copy (`Keyboard: O starts Offset`)

## 4. Inference and snapping

- [OK] Horizontal and vertical inference with the constraint added (a vertical next to a horizontal line may be stored as perpendicular to it, same result)
- [OK] Perpendicular to a hovered line (`Line: a second line drawn square to a hovered line`)
- [OK] Midpoint of a line gives a midpoint constraint; ending on a line gives point-on-line (`Line: ending on the middle of another line`)
- [OK] Intersection snap ties the point to both curves (`Line: a line started where two lines cross`)
- [OK] Centre snap: a circle clicked on another circle's centre shares the centre
- [OK] Origin and axis snap on lines and circle centres (point on axis constraint)
- [OK] Snap settings popover in the status bar (Fusion has Snap and Sketch Grid in the palette; see section 11)
- [OK] Construction lines and rectangles get the same inferred constraints as normal ones (`Construction line drawn up the Y axis`)
- [OK] Points of every tool (splines, slots, ellipses, polygons ...) are tied to what they were snapped to, axes included (`Fit point spline: a point clicked on an axis`)
- Note: an Equal-length and Parallel inference also fires (a new line that matched another got both constraints). Fusion has fewer hints; not specced

## 5. Constraints

- [OK] Coincident curve first or point first (`e2e/53`)
- [OK] Horizontal, Vertical, Equal apply to a whole selection (`e2e/53`)
- [OK] Concentric, Collinear, Symmetry, Midpoint, Smooth, Parallel, Perpendicular, Tangent, Fix (`e2e/53`, `e2e/54`)
- [OK] Constraint glyph click selects it, Delete removes just that one (`Constraints: click a constraint glyph`)
- [OK] The sketch axes can be picked by Coincident (point on axis) (`Coincident: a loose point and a sketch axis`)
- [OK] The sketch axes can be the line of symmetry (`Symmetry constraint can use a sketch axis`)
- [OK] Conflicting or redundant constraints are refused with a message

## 6. Dimension tool

- [OK] Line length, two parallel lines, angle between lines by sector, point to axis, ellipse radii, circle to circle, circle to line (`e2e/22`, `e2e/53`)
- [OK] Circle gets a diameter (⌀), arc a radius (R) (`Dimension: a circle gets a diameter`)
- [OK] Two points: the dimension turns horizontal, vertical or aligned with where it is placed (the exact zones Fusion uses were not compared)
- [OK] Value box opens on placing; Enter commits; Escape drops a new one, keeps the old value on an edit (`Dimension: Escape in the value box`)
- [OK] Reference (driven) dimension in brackets when the geometry is already fixed (`e2e/53`)
- [OK] Drag a dimension label; it follows its geometry (`e2e/22`)
- [OK] Units in the value (`1 in` is 25.4) and user parameters (`w`) (`Dimension: typing a value with units`, `Dimension: a user parameter`)
- [OK] Every dimension has a name (d1, d2 ..., shown in the value box) and an expression can use them (d2 = d1 * 2); loops are reported (`Dimension: one dimension can use another`)
- Note: Fusion lets you flip an existing dimension between driving and driven. Not found in the UI; not tested (see the end)

## 7. Modify tools

- [OK] Trim a line at crossing curves; a line cut at a circle stays tied to it (`Trim: the new end of a line cut at a circle`)
- [OK] Trimming keeps every constraint and dimension that still holds (a circle cut into an arc keeps what was tied to it), so the trimmed keyhole is fully constrained (`Trim: cutting a circle into an arc`, `56 Keyhole`)
- [OK] Extend, Break (`e2e/54`)
- [OK] Offset: one click picks the tangent chain (a rounded rectangle gives all 8 curves) (`Offset of a rounded rectangle`)
- [OK] Offset of a rectangle keeps corners sharp, a circle offsets concentrically (`e2e/22`)
- [OK] A negative typed distance flips the offset to the other side of the cursor (`Offset of a circle: a negative typed distance`)
- [OK] Fillet and chamfer on lines and arcs, typed radius, dof kept (`e2e/22`, `e2e/54`)
- [OK] Mirror about a drawn line, with the mirror constraint (`e2e/53`, `56 Symmetric profile`)
- [OK] Mirror about a sketch axis (the usual way to make a symmetric profile) (`Mirror can use the sketch Y axis`)
- [OK] Rectangular and circular patterns, typed counts, Enter applies (`e2e/22`, `e2e/53`)
- [OK] Scale about a base point with its dimensions (`e2e/54`)
- [OK] Move / Copy (M) inside a sketch: X and Y offsets and an angle, move or copy (`Move / Copy exists inside the sketch`)
- [OK] Deleting a corner point removes the two lines at it

## 8. Construction geometry

- [OK] X with a selection toggles it construction, X with nothing selected switches the mode (dashed, not part of profiles)
- [OK] Construction circle used for a bolt circle (`56 Mounting plate`)
- [OK] Inferred constraints on construction lines (see section 4)

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

The Sketch Palette sits at the bottom right of the view while sketching (collapsible; not on the phone).

- [OK] Look At (turn the view square to the sketch after orbiting)
- [OK] Show Profile
- [OK] Show Points
- [OK] Show Dimensions (hides the labels; the one being typed into stays)
- [OK] Show Constraints
- [OK] Slice (the model in front of the sketch plane is cut away with a clipping plane)
- [GAP] 3D Sketch. Not a toggle: see below
- [OK] Snap is in the palette and in the status bar, with its settings popover

3D Sketch needs more than a switch. Every entity here is plane-local 2D (points are x, y), the solver (planegcs) is 2D only, profiles and the sketch feature carry one plane, and picking is a ray cast onto that plane. A real 3D sketch means: points with a z; a pick that moves in 3D (axis locks, drag on a plane, snap to body vertices, edges and other sketches' points); 3D constraints (a solver that is not planegcs, or a separate 3D layer for coincident, on-plane, parallel, perpendicular and lengths); a sketch feature that stores 3D curves and hands them to Sweep, Loft and Pipe as paths; and a view that shows depth cues. That is a feature of its own, not part of this pass.

## 12. Layout

Screenshots: `e2e/screenshots/parity/<size>-<tool>.png`, 1280x800, 1000x700, phone 390x844, every tool.

- [OK] The prompt that flashes in sits under the options bar in one stack with it, so it never lands on the Cancel / Finish bar or the options bar (`Layout at 1280x800`, `Layout at 1000x700`)
- [OK] On a phone the prompt sits under the options bar (`Layout on a phone, 390x844`)
- [OK] At 1000x700 the Finish bar shortens to the state and two icon buttons and stays on one line inside the view (`Layout at 1000x700`). The view itself is still about 470 px wide there, between the browser and the inspector
- [OK] At 1280x800 the options bar sits clear of the Finish bar and view cube; it wraps rather than squeezing into a column
- [OK] Phone: options bar and Undo point / Done / Cancel / Finish bar fit the width, no sideways scrolling
- [OK] Phone: the options bar is one scrolling row (about 50 px) instead of a wrapped block; the notes are hidden
- [OK] The Text options bar reads "Text" with the field "Words"

## Not checked this pass

Sketching on a body face, Project, extrude (next pass). Not exercised: the exact zones where a two-point dimension turns horizontal, vertical or aligned; Insert image/canvas, Stretch, Blend curve, rotate-in-sketch, Sketch Dimension on splines, driven-dimension toggling, selecting profile regions for delete.
