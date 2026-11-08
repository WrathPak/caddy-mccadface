# Fusion 360 Mesh tab vs CADdy McCADFace

Same format as `solids.md`. Fusion behaviour is from daily-use knowledge of Fusion, not from this app's code. Status marks come from driving the app (real clicks, keys, typed values) at 1600x900 on generated STL files: a 40 x 30 x 20 box with a corner on the origin (volume 24000, top face at z = 20), a 4000 triangle sphere, a pawn-like figure, an L bracket and a 500 thousand triangle slab. Nothing is checked in; `e2e/mesh-kit.ts` writes the files.

- `[OK]` matches Fusion
- `[GAP]` Fusion does it, we do not (or we get it wrong). Spec in `e2e/64-mesh-parity.spec.ts`, marked `test.fail()` with a comment naming the gap; it flips when the gap is closed
- `[PARTIAL]` works but differs. The part that works has a passing spec, the part that differs a `test.fail()` one
- Real jobs: `e2e/65-mesh-real-parts.spec.ts` (section 12)
- Shared helpers: `e2e/mesh-kit.ts` (STL writers, mesh stats from the display arrays, Mesh tab helpers)

What the Mesh tab offers today, grouped like Fusion's (Create, Prepare, Modify, Assemble, Construct, Inspect, Select, Export): Import Mesh (units, placement), Convert to Mesh (refinement), Section Sketch; Repair (Make Closed Mesh, Close Holes, Stitch, Remove, Wrap, Rebuild), Reverse Normal, Convert Mesh (to B-rep), Reduce, Refine / Remesh, Generate / Combine / Separate Face Groups; Plane Cut, Smooth, Shell, Delete Faces, Erase And Fill, Move Face Group, Move (with non-uniform Scale); Combine; Offset Plane; Measure, Section Analysis, Mesh Stats; Brush Select, Grow, Shrink; Export (STL, 3MF, OBJ with a Refinement). The less common tools sit in the carets of Generate Face Groups and Delete Faces.

The things a 3D printing Fusion user hits first were a flipped patch or an inside-out STL that Repair could not fix, a mesh that cannot become a solid and a mesh that cannot be hollowed; sections 3, 5 and 12 now cover them (winding is unified on import, Repair has types and a report, Convert Mesh builds a solid, Shell works on a mesh). Still open: sections 1, 2, 4 (count / proportion / Remesh types), 5 (face-group editing, Erase And Fill, direct edit, non-uniform Scale), 6, 7 (Mesh Section Sketch, mesh stats) and 8.

## 1. Insert

Fusion: Insert > Insert Mesh (STL, OBJ, 3MF) with a Units choice (mm, cm, in, m ...), a position manipulator, and Tessellate to turn a B-rep into a mesh with a Refinement setting.

- [OK] An STL comes in as a mesh body: closed, the right size, six face groups for a box (`Insert Mesh: an STL becomes a mesh body`)
- [OK] Import Mesh is in the Mesh tab and takes the same file (`Insert Mesh is in the Mesh tab`)
- [OK] 3MF: export a mesh as 3MF and insert that file again, same volume (`3MF round trip`)
- [OK] OBJ files come in (polygons are fanned, negative indices work) and go out; the round trip keeps the volume (`Insert Mesh takes an OBJ file`, `e2e/66` `OBJ`)
- [OK] Units: the Mesh tab's Import Mesh opens an Insert dialog with Units (mm, cm, m, in, ft), Placement and Scale; the model in the viewport is the live preview and OK is one undo step. Cancel keeps the mesh as it was inserted (it does not remove it). The Solid tab's Import still inserts straight away at the file's own units; the same fields are in the step (`Insert Mesh asks for units and a position`, `e2e/66` `Insert Mesh dialog`)
- [OK] Placement: Keep position, Center on origin or Drop to ground plane (the underside on z = 0, centred in X and Y). Picking a point by hand is not there (`Insert Mesh can put the model on the origin`)
- [OK] Convert to Mesh (Tessellate) turns a solid into a mesh body of the same volume (`Convert to Mesh (Tessellate)`)
- [OK] Convert to Mesh has a Refinement: Coarse, Medium, Fine or Custom surface deviation and angle (`Convert to Mesh has a refinement setting`, `e2e/66` `Convert to Mesh`)
- [OK] A 500 thousand triangle STL inserts in 1.9 to 2.8 s (`Break: 500 thousand triangles`)

## 2. Prepare: face groups

Fusion: Generate Face Groups (Fast / Accurate), Combine Face Groups, Separate Face Groups.

- [OK] Face groups are made on insert from a crease angle (the "Face split angle", default 20 degrees; changing it in the Insert step regroups the sphere into many faces, `Face groups: the Face split angle`). Generate Face Groups is a command that runs again on any mesh, after Reduce, Smooth or Plane Cut, Fast (crease angle) or Accurate (regions grow from the flattest triangles and stay within the angle of their own average direction, so a smooth sphere is cut into patches), with an Angle (`Generate Face Groups is a Mesh tab command`, `e2e/66` `Generate Face Groups`). Meshes over 400 thousand triangles stay one face
- [OK] Combine Face Groups (pick two or more faces) and Separate Face Groups (a painted or picked patch becomes its own group per connected piece). The groups are kept through Move Face Group, Delete Faces and Erase And Fill (`Combine Face Groups and Separate Face Groups`, `e2e/66` `Combine Face Groups`)

## 3. Prepare: Repair

Fusion: Repair with Type Stitch and Fill Holes / Remove Isolated / Wrap / Rebuild, and a report of what it found.

- [OK] A box with its whole top face missing comes back closed with its volume (`Repair closes a hole`)
- [OK] Cracks between vertices (0.0004 mm apart) are welded and the mesh closes (`Repair welds cracks`)
- [OK] Make Closed Mesh: its own Mesh tab button (and Repair type): joins cracks, winds every triangle the same way, flips an inside-out mesh and closes holes by ear clipping in the plane of the hole (a flat hole is filled flat; a hole on a curved surface is filled with a flat patch, not a curved one). A repaired mesh takes part in Combine > Cut with a solid (`Make Closed Mesh`)
- [OK] Repair types: Make Closed Mesh, Close Holes, Stitch, Remove (small loose shells), Wrap and Rebuild (`Repair offers repair types`; the types have specs in the last section of `e2e/64`). Wrap and Rebuild build a new closed manifold mesh through a voxel grid and marching tetrahedra, so they work on self-intersecting and badly broken scans; the result follows the original to about half a voxel (the Voxel size field, automatic by default) and has new, even triangles, so it is finer and smoother than the input. Wrap fills closed cavities, Rebuild keeps them. A gap wider than about two voxels is sealed only when Gap to close is raised; otherwise the step stops with a message that says so. No max hole size for Close Holes
- [OK] Repair reports what it did (holes closed, vertices welded, triangles flipped, shells removed, degenerate dropped) in a toast and in the dialog while it previews (`Repair says what it fixed`)
- [OK] An inside-out STL (all normals inverted) is wound the right way round on import, volume positive; a shell that sits inside another one (a cavity) keeps its inward winding. Reverse Normal flips a whole mesh back (no per-face Reverse Normal yet) (`An inside-out STL ...`)
- [OK] A mesh with one patch wound the wrong way (a common STL fault) is unified on import and again by Repair (`Repair makes the faces of a mesh agree`). The import pass is limited to 1.5 million triangles; above that only the sign of the whole mesh is checked
- [OK] An open mesh (a face missing): Plane Cut trims it and leaves the cut open (no cap), with a message that says so (`Break: a mesh that is not closed`); Reduce, Refine, Combine and Shell fail with a message that names Repair ("This mesh is not closed or not manifold ... Run Mesh > Repair (Make Closed Mesh) first") (`Not manifold: a Boolean on a mesh that is not closed says Repair`)
- [OK] A mesh with an edge shared by four triangles (two boxes touching along an edge) inserts and cuts without a crash (`Break: two boxes touching along one edge`)

## 4. Prepare: Remesh and Reduce

Fusion: Remesh (Adaptive / Uniform, Density, Preserve sharp edges, Preserve boundaries) and Reduce (Tolerance / Proportion / Face count, Preserve boundaries, Preserve sharp edges).

- [OK] Refine splits every edge longer than the Max edge length; the shape and the six face groups stay (`Refine (Remesh): long edges are split`)
- [OK] Remesh types: Refine (split only, as before), Uniform (edge length), Adaptive (shorter edges where the surface bends) and Density (a factor on the triangle count), with Preserve sharp edges and Preserve boundaries. It splits, collapses, flips and relaxes, and snaps back to the original surface, so a box keeps its corners (`Remesh has Uniform, Adaptive and Density types`, `e2e/66` `Remesh`). Up to 300 thousand triangles
- [OK] Reduce by tolerance: the 4000 triangle sphere drops to about a quarter and keeps its volume within 2 percent (`Reduce by tolerance`)
- [OK] Reduce by Tolerance, Proportion (percent to keep) or Face count, with Preserve boundaries and Preserve sharp edges (quadric edge collapse). Meshes over 150 thousand triangles are first thinned by the fast simplifier, which ignores the two preserve switches for the Tolerance type (`Reduce to a face count or a proportion`, `e2e/66` `Reduce`)
- [OK] 500 thousand triangles: see section 11 for the times

## 5. Modify

- [OK] Plane Cut, Trim: z = 10 keeps the positive side, capped, closed, volume 12000 (`Plane Cut, Trim`)
- [OK] Plane Cut, Split Body: both halves are bodies, each closed, 12000 each (`Plane Cut, Split Body`)
- [OK] The Plane Cut dialog previews the cut, and Escape leaves the body alone (`Plane Cut: the preview shows the cut`)
- [OK] Plane Cut along a picked face, an origin or construction plane, or an axis, with an offset along the normal and a tilt about two in-plane axes (typed, or the two arcs in the viewport). A scan sitting on the bed at an angle can be cut along its own face (`Plane Cut can cut along a picked face`, `e2e/66` `Plane Cut`)
- [OK] Fill type None (open cut, also on an open mesh), Minimal (fewest triangles) or Uniform (cap triangles as big as the mesh's own) (`Plane Cut has a Fill Type`)
- [OK] Combine (Join) of two mesh bodies gives one closed mesh with the union volume (`Combine joins two mesh bodies`)
- [OK] Combine Cut of a solid box out of a mesh gives a mesh with the right volume (`Combine Cut: a solid box cut out of a mesh`)
- [OK] Smooth keeps the size of a part: Taubin smoothing with Preserve sharp edges (creases over 35 degrees stay) and Preserve boundaries on by default, and a closed mesh gets its volume scaled back when nothing is pinned; a box keeps its corners exactly (`Smooth keeps the size of a part`)
- [OK] Smooth on a sphere keeps it closed and within 5 percent of its volume (`Smooth runs on a sphere`)
- [OK] Smooth on selected faces, with Preserve boundaries (`Smooth can be limited to selected faces`); the faces are picked in the Smooth dialog or selected first
- [OK] Shell of a mesh (Solid tab Shell, also in the Mesh tab): inward or outward, a true offset, picked faces become openings, nothing picked gives a closed hollow. Each vertex moves to where the offset planes of the faces around it meet, so a flat wall is exactly the thickness and box corners stay sharp (a curved wall is the thickness along the vertex normal, a percent or two thin on a slope). Needs a closed mesh; a wall thicker than the narrowest part stops with a message. Individual thickness and the other advanced Shell options are for solids only (`Shell of a mesh`, `Mesh Shell: ...`)
- [OK] Reverse Normal: flips the whole body (`Reverse Normal is a Mesh tab command`). Not per face
- [OK] Delete on a selected mesh face removes the face group, leaves an open mesh, as an editable "Delete Faces" step with a message that points at Repair (`Delete on a selected mesh face`). The kernel op is `meshDeleteFaces`. The Delete Face tool (Modify) still says "needs a solid body, not a mesh"
- [OK] Erase And Fill: the faces (picked, or painted with the Brush) are removed and every hole is closed with a patch that is triangulated, refined and relaxed into the surface. Delete Faces is its own tool and leaves the hole open (`Erase And Fill is a Mesh tab command`, `e2e/66` `Brush paints`, `Erase And Fill`). The Delete key on a selected face is a separate item above
- [OK] Press/Pull and Offset Face on a mesh face do the same as Move Face Group (`Direct edit: Press/Pull on a mesh face`)
- [PARTIAL] Convert Mesh to B-rep (Mesh tab, editable step): Faceted sews every triangle into an OpenCascade face (limit 5000 faces by default, a message says what to do above it); Prismatic fits each flat face group to one planar face with holes (edges between flat groups merged, so a long edge is one edge) and builds a real solid, so Fillet, Shell, Hole and Press/Pull work on it. A round hole or boss (a curved group closed by two round loops that are exactly the loops of flat neighbours) is fitted to a true cylindrical face, and its neighbours use the exact circle, so Hole, Fillet and Measure see it as round. Partial cylinders (fillets), cones and spheres are NOT fitted: each triangle of such a group stays a flat face. A hole with very few segments (a crease over the Face split angle) also stays in triangles (`Convert Mesh (Prismatic)`, `(Faceted)`, `the converted bracket takes Fillet`). The mesh must be closed and one shell; it says Repair otherwise
- [OK] Move Face Group (Mesh tab): a face group or painted patch moves along its normal (the arrow or a typed Distance) and by an X, Y, Z translation; the triangles around it stretch and the mesh stays closed (`e2e/66` `Move Face Group`)
- [OK] Move a mesh body 5 mm, as an editable timeline step (`Move: a mesh body moves`)
- [OK] Move with Create copy leaves the mesh and adds a copy (`Move with Create copy`)
- [OK] Scale 0.5 in Move halves it, about its middle (`Scale (uniform) on a mesh`)
- [OK] Non-uniform Scale: Move has a Scale type with Uniform and Non-uniform (a factor per axis, a negative one mirrors); it works on mesh bodies and says so for solids (`Scale can be non-uniform`, `e2e/66` `Scale`)

## 6. Selection

Fusion: click a face group, a body, brush (paint) select, Grow, Shrink, select by angle, filters.

- [OK] A click picks one face group (the box has 6), a click on another picks that one (`Selection: a click on a mesh picks one face group`)
- [OK] Shift-click adds a face group, Escape clears (`Selection: Shift-click adds a second face group`)
- [OK] The Select filter in the status bar set to Body: the first click picks the whole mesh body (`Selection filter`)
- [OK] The Browser row of a mesh body picks the body (`Selection: the Browser row`)
- [OK] Brush Select (paint triangles, [ ] changes the size, Shift erases), Grow and Shrink on a mesh, from the Select group or the toolbar. What is painted is picked up by Delete Faces, Erase And Fill, Move Face Group and Separate Face Groups (`Selection: paint (brush), Grow and Shrink selection on a mesh`, `e2e/66`)

## 7. Inspect

- [OK] Measure on a mesh: top face and side face give Area 1200 and 600, the angle 90 and the centre distance 22.361 (`Measure on a mesh`). Picks are faces, the crease edges and bodies; there are no vertices to pick on a mesh
- [OK] Section Analysis on a mesh opens and sets z = 10 (`Section Analysis on a mesh`)
- [OK] Sketch on a mesh face opens the sketch (`Sketch on a mesh face`), and Extrude cut from it cuts the mesh: a mesh face is never taken as a profile, the extruded tool is tessellated and cut out with manifold (`e2e/65` `sketch on the mesh face and Extrude cut`, and the drain hole of the figure from a sketch on the XY plane)
- [OK] Mesh Section Sketch: the outline a plane cuts out of a mesh (axis, plane, face or tilted, with an offset) becomes an ordinary Sketch step with lines, arcs and circles fitted within a tolerance, previewed in the dialog and usable for Extrude (`Mesh Section Sketch is a Mesh tab command`, `e2e/66` `Mesh Section Sketch`). The sketch is not tied to the mesh: edit the mesh and cut again
- [OK] The status bar shows Tris (`Status bar: Tris`)
- [OK] Mesh stats: a card over the viewport for the selected mesh body (or Inspect > Mesh Stats for all): triangles, open edges, non-manifold edges, flipped edges, shells, volume, surface area and a Manifold / Not manifold verdict (`Mesh stats`, `e2e/66` `Mesh stats`)

## 8. Export

- [OK] Export STL of a mesh body: the file has every triangle (`Export STL of a mesh body`)
- [OK] Export 3MF: object, millimetres, every triangle (`3MF round trip`, `e2e/65` name plate)
- [OK] Export as OBJ, and a Refinement (Coarse, Medium, Fine, Custom deviation and angle) for the solids that are tessellated on the way out, for STL, 3MF and OBJ (`Export offers OBJ and a mesh refinement`, `e2e/66` `Export refinement`)

## 9. Interplay with solids and the timeline

- [OK] Combine Join, Cut and Intersect take meshes and solids together; the result is a mesh (section 5)
- [OK] Extrude cut into a mesh from a sketch on an origin plane (`e2e/04-stl-import`, `e2e/65` bracket)
- [OK] Edit the Plane Cut offset from the timeline, the mesh follows (`Timeline: edit the Plane Cut offset`)
- [OK] Ctrl+Z / Ctrl+Y take a mesh step back and bring it again (`Timeline: Ctrl+Z after a mesh step`)
- [OK] Deleting the Insert step under a Plane Cut leaves the Plane Cut in error ("A selected body no longer exists"), no crash, and undo brings both back (`Timeline: dropping a step under a mesh feature`)
- not checked: dragging a mesh step to a different place in the timeline

## 10. Break it

- [OK] Escape in a mesh dialog leaves no step, no preview (`Break: Escape in a mesh dialog`)
- [OK] Ctrl+Z with a mesh dialog open undoes the step under it (the Insert), the dialog stays open on an empty document, Ctrl+Y brings everything back (`Break: Ctrl+Z with a mesh dialog open`). Fusion disables Undo while a command is open
- [OK] A mesh tool with two bodies and none picked keeps OK disabled (`Break: a mesh tool started with nothing`)
- [OK] Plane Cut with the plane outside the part keeps the body (`Break: Plane Cut with the plane outside`)
- [OK] Reduce on an open mesh reports a step error that names Repair (`Break: the error of a mesh step on an open mesh`)

## 11. Performance (500 thousand triangles, a closed slab, software WebGL)

- [OK] Insert STL: 1.9 to 2.8 s
- [OK] Plane Cut, Trim: 6.0 s. Plane Cut, Split Body: 10.5 s. Both halves closed with the right total volume
- [OK] Reduce (tolerance 0.05) of the 504 thousand triangle slab: 4.6 s, down to 6.3 thousand triangles (the slab is mostly flat). Refine to 0.2 mm of that result: 5.3 s (`Break: Reduce and Refine on half a million triangles`; the spec prints the times as `MESH PERF`). Refine on the full 500 thousand triangles was not timed, the 2 million triangle limit would stop it with a message
- Not measured: Smooth on a big mesh, Combine of two big meshes

## 12. Real jobs (`e2e/65-mesh-real-parts.spec.ts`)

Each starts from an imported STL written by the spec.

- Scan with holes (three missing patches on a figure, Repair, split in two with Plane Cut, export STL): completes with no workaround once the figure is a valid closed mesh. The first version of the fixture had one inverted cap and Repair said "Not manifold"; that is the section 3 flipped patch gap, and the reason it matters to a real scan
- Big STL (504 thousand triangles cut in half with Plane Cut, Split Body): completes in about 10 s, both halves closed
- Mini figure (hollow, drain hole): completes with no workaround. Shell (1.2 mm, a true offset, even wall) then a circle sketched on the XY plane and Extrude cut up through the base into the cavity
- STL bracket: completes with no workaround. Convert Mesh (Prismatic) gives a solid with 8 planar faces, then Fillet of the inside corner and a round Hole through the leg. Staying a mesh also works now: a sketch on the leg's face and Extrude cut cuts a round hole in the mesh (the post and Combine route stays as a spec too). A fillet on the inside corner adds material, so the old `test.fail()` spec that wanted the volume to drop was wrong and now expects it to grow
- Name plate (text engraved into a mesh, export 3MF): completes with no workaround
  - Text is on the Detail tab (not the Mesh tab), the mesh face picked first; Engrave cuts it into the mesh (the volume drops, the body stays one closed mesh); the 3MF holds exactly the triangles of the engraved mesh, in millimetres. Export is on the Solid tab, not the Mesh tab
- Inch STL: WORKAROUND, Scale 25.4 on the Insert step in the timeline (no units choice on Insert)

