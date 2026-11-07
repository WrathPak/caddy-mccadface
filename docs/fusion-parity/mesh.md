# Fusion 360 Mesh tab vs CADdy McCADFace

Same format as `solids.md`. Fusion behaviour is from daily-use knowledge of Fusion, not from this app's code. Status marks come from driving the app (real clicks, keys, typed values) at 1600x900 on generated STL files: a 40 x 30 x 20 box with a corner on the origin (volume 24000, top face at z = 20), a 4000 triangle sphere, a pawn-like figure, an L bracket and a 500 thousand triangle slab. Nothing is checked in; `e2e/mesh-kit.ts` writes the files.

- `[OK]` matches Fusion
- `[GAP]` Fusion does it, we do not (or we get it wrong). Spec in `e2e/64-mesh-parity.spec.ts`, marked `test.fail()` with a comment naming the gap; it flips when the gap is closed
- `[PARTIAL]` works but differs. The part that works has a passing spec, the part that differs a `test.fail()` one
- Real jobs: `e2e/65-mesh-real-parts.spec.ts` (section 12)
- Shared helpers: `e2e/mesh-kit.ts` (STL writers, mesh stats from the display arrays, Mesh tab helpers)

What the Mesh tab offers today: Import Mesh, Refine, Smooth, Reduce, Plane Cut, Repair, Convert to Mesh, Measure, Section Analysis. Fusion's Mesh tab has roughly three times as many commands. The Solid tab adds Combine, Move / Copy / Scale and the Detail tab Text, which are the only other ways to work on a mesh.

The thing a 3D printing Fusion user hits first: a mesh with a flipped patch or an inside-out STL cannot be repaired (every kernel step says "Not manifold"), a mesh cannot become a solid, and a mesh cannot be hollowed. Sections 4, 5 and 6.

## 1. Insert

Fusion: Insert > Insert Mesh (STL, OBJ, 3MF) with a Units choice (mm, cm, in, m ...), a position manipulator, and Tessellate to turn a B-rep into a mesh with a Refinement setting.

- [OK] An STL comes in as a mesh body: closed, the right size, six face groups for a box (`Insert Mesh: an STL becomes a mesh body`)
- [OK] Import Mesh is in the Mesh tab and takes the same file (`Insert Mesh is in the Mesh tab`)
- [OK] 3MF: export a mesh as 3MF and insert that file again, same volume (`3MF round trip`)
- [GAP] OBJ files: "Unsupported file type" (`Insert Mesh takes an OBJ file`)
- [PARTIAL] Units: no choice when inserting, the file goes in at scale 1. The Scale number in the Insert step can be edited afterwards (25.4 for an inch model) and resizes it exactly (`Insert Mesh: the Scale in the timeline step`; `Insert Mesh asks for units and a position` is the gap)
- [GAP] Placement: nothing puts a model on the origin or picks the point; a scan made at x = 300 stays there (`Insert Mesh can put the model on the origin`)
- [OK] Convert to Mesh (Tessellate) turns a solid into a mesh body of the same volume (`Convert to Mesh (Tessellate)`)
- [GAP] Tessellate has no Refinement (coarse, fine, deviation, angle) (`Convert to Mesh has a refinement setting`)
- [OK] A 500 thousand triangle STL inserts in 1.9 to 2.8 s (`Break: 500 thousand triangles`)

## 2. Prepare: face groups

Fusion: Generate Face Groups (Fast / Accurate), Combine Face Groups, Separate Face Groups.

- [PARTIAL] Face groups are made on insert from a crease angle (the "Face split angle", default 20 degrees). Changing it in the Insert step regroups the sphere into many faces (`Face groups: the Face split angle`). There is no command to generate them again on a mesh made by Reduce, Smooth or Plane Cut (`Generate Face Groups is a Mesh tab command`). Meshes over 400 thousand triangles stay one face
- [GAP] Combine Face Groups and Separate Face Groups (`Combine Face Groups and Separate Face Groups`)

## 3. Prepare: Repair

Fusion: Repair with Type Stitch and Fill Holes / Remove Isolated / Wrap / Rebuild, and a report of what it found.

- [OK] A box with its whole top face missing comes back closed with its volume (`Repair closes a hole`)
- [OK] Cracks between vertices (0.0004 mm apart) are welded and the mesh closes (`Repair welds cracks`)
- [OK] Make Closed Mesh: a repaired mesh takes part in Combine > Cut with a solid (`Make Closed Mesh`). The fill is a flat fan around the centroid of the hole (code reading; curved holes not checked)
- [GAP] No repair types: one Weld distance. Wrap and Rebuild, the way out for self-intersecting scans, do not exist (`Repair offers repair types`)
- [GAP] No report: the kernel counts welded, degenerate, duplicate and holes filled and throws the numbers away (`Repair says what it fixed`)
- [GAP] An inside-out STL (all normals inverted) imports with a negative volume and stays negative through Repair and every other tool (`Repair turns an inside-out mesh`)
- [GAP] A mesh with one patch wound the wrong way (a common STL fault; the import does not notice it) makes Repair, Plane Cut, Reduce, Combine all fail with "Not manifold", and Repair is where Fusion fixes it (`Repair makes the faces of a mesh agree`). Found by accident when a generated figure had one inverted cap
- [GAP] An open mesh (a face missing) fails Plane Cut and Reduce with "Not manifold" and the message does not point at Repair (`Break: a mesh that is not closed`). Fusion's Plane Cut works on an open mesh
- [OK] A mesh with an edge shared by four triangles (two boxes touching along an edge) inserts and cuts without a crash (`Break: two boxes touching along one edge`)

## 4. Prepare: Remesh and Reduce

Fusion: Remesh (Adaptive / Uniform, Density, Preserve sharp edges, Preserve boundaries) and Reduce (Tolerance / Proportion / Face count, Preserve boundaries, Preserve sharp edges).

- [OK] Refine splits every edge longer than the Max edge length; the shape and the six face groups stay (`Refine (Remesh): long edges are split`)
- [GAP] Remesh types: Refine only splits, it never merges or re-triangulates, no Uniform, no Adaptive, no Density, no sharp edge setting (`Remesh has Uniform, Adaptive and Density types`)
- [OK] Reduce by tolerance: the 4000 triangle sphere drops to about a quarter and keeps its volume within 2 percent (`Reduce by tolerance`)
- [GAP] Reduce to a face count or a proportion. The tolerance is a geometric error in mm and the help text under it describes welding instead (`Reduce to a face count or a proportion`)
- [OK] 500 thousand triangles: see section 11 for the times

## 5. Modify

- [OK] Plane Cut, Trim: z = 10 keeps the positive side, capped, closed, volume 12000 (`Plane Cut, Trim`)
- [OK] Plane Cut, Split Body: both halves are bodies, each closed, 12000 each (`Plane Cut, Split Body`)
- [OK] The Plane Cut dialog previews the cut, and Escape leaves the body alone (`Plane Cut: the preview shows the cut`)
- [GAP] Plane Cut along a picked face or origin plane or a tilted plane: only X, Y or Z through the origin plus an offset. A scan sitting on the bed at an angle cannot be cut along its own face (`Plane Cut can cut along a picked face`)
- [GAP] Fill Type None / Uniform / Minimal: the cut is always capped flat (`Plane Cut has a Fill Type`)
- [OK] Combine (Join) of two mesh bodies gives one closed mesh with the union volume (`Combine joins two mesh bodies`)
- [OK] Combine Cut of a solid box out of a mesh gives a mesh with the right volume (`Combine Cut: a solid box cut out of a mesh`)
- [GAP] Smooth makes the part bigger: the default (10 passes, strength 0.5) on a 40 x 30 x 20 box grows its bounding box by about 1.1 mm a side. A bracket that fits another part stops fitting. Wrong geometry (`Smooth keeps the size of a part`)
- [OK] Smooth on a sphere keeps it closed and within 5 percent of its volume (`Smooth runs on a sphere`)
- [GAP] Smooth on selected faces, with Preserve boundaries (`Smooth can be limited to selected faces`)
- [GAP] Shell of a mesh: "Shell needs a solid body, not a mesh" (`Shell of a mesh`)
- [GAP] Reverse Normal (`Reverse Normal is a Mesh tab command`)
- [GAP] Delete Faces: a face is selected, Delete does nothing at all, no step and no message (`Delete on a selected mesh face`). The Delete Face tool says "needs a solid body, not a mesh"
- [GAP] Erase And Fill (`Erase And Fill is a Mesh tab command`)
- [GAP] Direct edit / translate a face group: Press/Pull says "Offset Face needs a solid body, not a mesh" (`Direct edit: Press/Pull on a mesh face`)
- [GAP] Convert Mesh to B-rep, Prismatic or Faceted: the only conversion is solid to mesh. Fillet and Chamfer say "need a solid body, not a mesh"; Thread says the same (`Convert Mesh to B-rep`)
- [OK] Move a mesh body 5 mm, as an editable timeline step (`Move: a mesh body moves`)
- [OK] Move with Create copy leaves the mesh and adds a copy (`Move with Create copy`)
- [OK] Scale 0.5 in Move halves it, about its middle (`Scale (uniform) on a mesh`)
- [GAP] Non-uniform Scale (`Scale can be non-uniform`)

## 6. Selection

Fusion: click a face group, a body, brush (paint) select, Grow, Shrink, select by angle, filters.

- [OK] A click picks one face group (the box has 6), a click on another picks that one (`Selection: a click on a mesh picks one face group`)
- [OK] Shift-click adds a face group, Escape clears (`Selection: Shift-click adds a second face group`)
- [OK] The Select filter in the status bar set to Body: the first click picks the whole mesh body (`Selection filter`)
- [OK] The Browser row of a mesh body picks the body (`Selection: the Browser row`)
- [GAP] Brush (paint) selection, Grow and Shrink on a mesh. The Hair tab has a paint tool for its own use only (`Selection: paint (brush), Grow and Shrink`)

## 7. Inspect

- [OK] Measure on a mesh: top face and side face give Area 1200 and 600, the angle 90 and the centre distance 22.361 (`Measure on a mesh`). Picks are faces, the crease edges and bodies; there are no vertices to pick on a mesh
- [OK] Section Analysis on a mesh opens and sets z = 10 (`Section Analysis on a mesh`)
- [GAP] Mesh Section Sketch: the outline of a mesh on a plane as a sketch (`Mesh Section Sketch`)
- [PARTIAL] Sketch on a mesh face opens the sketch (`Sketch on a mesh face`), but Extrude cut from it fails with "Expected a B-rep body": the click on the profile also takes the mesh face behind it as a profile. The same happens from a sketch on the XY plane under the part. (A sketch away from the part, as in `e2e/04-stl-import`, works.) The spec for the failing half is in `e2e/65` (`sketch on the mesh face and Extrude cut`)
- [OK] The status bar shows Tris (`Status bar: Tris`)
- [GAP] No mesh stats: open edges, non-manifold edges, volume, "is this closed?". The only way to know is to run a Boolean or Repair and read "Not manifold" (`Mesh stats`)

## 8. Export

- [OK] Export STL of a mesh body: the file has every triangle (`Export STL of a mesh body`)
- [OK] Export 3MF: object, millimetres, every triangle (`3MF round trip`, `e2e/65` name plate)
- [GAP] OBJ export, and a Refinement setting for solids that are tessellated on the way out (`Export offers OBJ and a mesh refinement`)

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
- [PARTIAL] Reduce on an open mesh reports "Not manifold" as a step error (`Break: the error of a mesh step on an open mesh`), no hint what to do

## 11. Performance (500 thousand triangles, a closed slab, software WebGL)

- [OK] Insert STL: 1.9 to 2.8 s
- [OK] Plane Cut, Trim: 6.0 s. Plane Cut, Split Body: 10.5 s. Both halves closed with the right total volume
- [OK] Reduce (tolerance 0.05) of the 504 thousand triangle slab: 4.6 s, down to 6.3 thousand triangles (the slab is mostly flat). Refine to 0.2 mm of that result: 5.3 s (`Break: Reduce and Refine on half a million triangles`; the spec prints the times as `MESH PERF`). Refine on the full 500 thousand triangles was not timed, the 2 million triangle limit would stop it with a message
- Not measured: Smooth on a big mesh, Combine of two big meshes

## 12. Real jobs (`e2e/65-mesh-real-parts.spec.ts`)

Each starts from an imported STL written by the spec.

- Scan with holes (three missing patches on a figure, Repair, split in two with Plane Cut, export STL): completes with no workaround once the figure is a valid closed mesh. The first version of the fixture had one inverted cap and Repair said "Not manifold"; that is the section 3 flipped patch gap, and the reason it matters to a real scan
- Big STL (504 thousand triangles cut in half with Plane Cut, Split Body): completes in about 10 s, both halves closed
- Mini figure (hollow, drain hole): completes with a workaround
  - WORKAROUND: Shell does not work on a mesh. The figure is hollowed with a scaled copy (Move, Scale 0.85, Create copy, then Combine > Cut). The wall is 15 percent of the local radius, not a constant thickness (0.7 mm on the 4.5 mm stem). The drain hole is a solid box cut through the base with Combine
- STL bracket (convert to B-rep, then fillet or extrude): the conversion does not exist
  - WORKAROUND: the bracket stays a mesh; a 5 mm hole is cut with a solid post (Box) and Combine > Cut, so it is square. The natural route, a sketch on the bracket's face (or on the XY plane under it) and Extrude cut, fails: the profile click also takes the mesh face as a profile and Extrude stops with "Expected a B-rep body". Fillet of the inside corner is not possible at all (`test.fail()` specs)
- Name plate (text engraved into a mesh, export 3MF): completes with no workaround
  - Text is on the Detail tab (not the Mesh tab), the mesh face picked first; Engrave cuts it into the mesh (the volume drops, the body stays one closed mesh); the 3MF holds exactly the triangles of the engraved mesh, in millimetres. Export is on the Solid tab, not the Mesh tab
- Inch STL: WORKAROUND, Scale 25.4 on the Insert step in the timeline (no units choice on Insert)

