# Reference CAD feature comparison — 26 September 2026

> **Supporting record.** [The master roadmap](../../ROADMAP.md) owns priorities,
> dependencies and delivery status. This document is the dated feature
> inventory that the 2026-09-26 roadmap revision was drawn from; the remaining
> work it names is tracked under master IDs, not here.

**What was reviewed:** the complete public user manual of a mainstream
direct-modeling CAD application (desktop and tablet clients, commercial B-rep
kernel, cloud sync, browser share links), read article by article on
2026-09-26: workspace and navigation, sketching and constraints, every 3D tool,
transforms, construction geometry, section/measure/isolate/display modes,
history and items management, variables and expressions, import/export,
drawings, visualization, collaboration, and the release notes for the last
twenty-five releases. The product is deliberately unnamed here; it is "the
reference CAD" throughout, following the repository convention.

**What was compared against:** OpenZCAD `main` at `aaa2d326` (PR #451), read
from source: the command-context tool groups, the shared schema's feature and
constraint kinds, the measurement records, the expression evaluator, the tool
shortcut table, the display-mode set, and the current roadmap rows. Nothing
below claims a runtime behaviour that was not read in code or already recorded
in the roadmap.

**How to read it:** section 1 is the outcome; section 2 is the inventory, one
subsection per area, each ending in the OpenZCAD position and the master ID
that owns the remainder; section 3 lists the design conventions worth adopting
independent of any single feature; section 4 is what OpenZCAD has that the
reference CAD does not, which is the part of the roadmap not to trade away.

---

## 1. Outcome

The four structural gaps the roadmap already names (constraint-complete
sketching, reference geometry, drawings, assemblies) survive the comparison
unchanged. Two things move:

1. **The reference CAD ships no assemblies either.** Its manual says so
   outright and offers Align as the workaround; assemblies imported from
   other systems lose their relations. It ships drawings, visualization,
   versions and share links without them. That supports the roadmap's order
   (drawings before assemblies) and argues for splitting a small "insert
   another project's bodies" step out of AS01 rather than waiting on joints.
2. **A fifth gap is workspace convention, not geometry.** A cluster of
   features that every mainstream tool shares and that need no kernel work is
   thin or absent in OpenZCAD: a full single-key hotkey set, saved views,
   navigation presets, item folders and type filters, history step actions
   (zoom to, rename, duplicate, filter by selection, bake), notable-point
   picks for measurement, X-ray and hidden-edge display, box-drag filter keys
   and select-through. Individually small, together
   they are what makes a tool feel complete to someone arriving from the
   mainstream. The roadmap revision adds them as U05–U07 and M13 so they can
   be scheduled deliberately instead of accreting.

Everything else the comparison surfaced is depth inside rows that already
exist (extrude extents, blend options, sweep/loft controls, section-view
controls, pattern definitions, transform variants, export options, drawing
annotation types) and is folded into those rows as named slices.

---

## 2. Inventory by area

### 2.1 Workspace, access and navigation

**Reference CAD.** Floating menus over the canvas: a main menu on the left
(search, sketch, insert, construct, transform, tools) and the constraint menu
on the right in a sketch. An adaptive menu lists the tools valid for the
current selection with one default made active (face → offset face, region →
extrude, body → move/rotate, line+face → rotate around axis, region+axis →
revolve, two faces of two bodies → align/replace face); a "More" entry holds
the rest. Many tools complete by clicking empty canvas rather than a Done
button. Command search (a single key, or ⌘F) matches abbreviations ("p3" for
plane through 3 points), lists recent commands when empty, and filters by the
current selection. Right-click context menus on the cube, sketch, model,
visualization and drawing. Single-letter hotkeys for tools (E extrude, F
fillet/chamfer, H shell, M move/rotate, N translate, P project, S scale, V
revolve, W sweep; L line, C circle, A arc, R rectangle, G polygon, I spline, O
offset, T trim) and Shift+letter for constraints, all user-customizable, with a
setting that decides whether a bare key means "hotkey" or "start a search".
⌘1–7 switch reset/front/back/top/bottom/right/left. Hover a face and press
Space to sketch on it or zoom to it. Navigation presets emulate other CAD
packages' orbit/pan/zoom bindings. Orientation cube with faces, twelve edges,
eight corners, rotate arrows in planar view, double-click to reset. Up to eight
saved views, which also store an active section cut. A field-of-view slider
runs from orthographic to perspective. Modes (section, isolate, measure) live
in a small area that adapts to the selection.

**OpenZCAD.** The verb rail and command card are the adaptive menu (one primary
verb per pick), the ⌘K bar is command search with an "ask the assistant" tail,
the cube, orthographic/perspective toggle and a right-click marking menu exist,
and nine tools carry a single-key shortcut (`apps/web/src/lib/tools.tsx`).
Missing: hotkeys for most tools and all constraints, customization, the
hotkey-versus-search setting, fuzzy/abbreviation matching and recent commands
in search, selection-aware search results, saved views, navigation presets,
the FOV slider, view hotkeys. → **U05** (keyboard and command contract),
**U07** (viewing depth).

### 2.2 Selection

**Reference CAD.** Box select is direction-typed: left-to-right selects only
what is fully enclosed, right-to-left everything touched; while dragging, Tab
cycles the filter and B/F/E force bodies/faces/edges. Selected items stay
visible through occluding geometry. Clicking where several items overlap opens
a pick list naming each candidate (sketch, face, edge), with item names shown
if the user named them. A Select Through mode picks internal geometry without
hiding anything. Double-click selects a whole body, or a connected sketch
group in a sketch. Fully defined sketch geometry draws green, under-defined
blue; selecting a sketch element highlights its constraints and dimensions.

**OpenZCAD.** Direction-typed box selection (enclosed versus crossing), a
selection filter, depth cycling, a topology pick list for ambiguous hits,
face/edge double-click promotion to the owning body, on-top selection of the
current pick and the concave-edge occlusion fix (PR #408) exist. The sketch
solve state is a tone on the Solve control and per-entity highlighting follows
residuals (S03). Missing: filter keys during box drag, select-through and
double-click selection of a connected sketch group. → **U07**, with the
sketch colour states under **S03**.

### 2.3 Sketching

**Reference CAD.** Entities: line (chained, Enter/Escape to finish, auto-close),
arc, circle (typed diameter or radius before placing, per a global
radius/diameter annotation setting), ellipse (two typed axes), polygon
(triangle/pentagon/hexagon/octagon presets, side count editable right after
placing), rectangle (center, diagonal, three-point, each with an anchor point),
spline (fit-point and control-point, add/remove points, break/join badge,
tangency by aligning the control polyline), text (any installed font, height,
alignment, becomes ordinary sketch profiles and is then editable only as
geometry), a pen-only automatic line/arc that switches on a wiggle. Modify:
trim (click segments), offset edge (single or chain, per-loop arrows), move/
rotate with the gizmo and a copy badge, linear and circular pattern (total or
spacing definition, quantity, uniform or rotated orientation) which leaves a
_pattern constraint_ on the source so the instances stay linked until it is
deleted, delete, make construction / make regular, project (sketches, edges,
faces or whole bodies onto a plane or planar face; a "linked" toggle keeps the
projection associative). Constraints: parallel, perpendicular, tangent,
coincident, midpoint, equal, concentric, horizontal/vertical, symmetry (two
similar elements about a line), lock/unlock (fix a point), disconnect (delete
the coincident/midpoint constraints on a point), and drag-and-drop creation
(drop a point on a point, line or midpoint). Auto-constraining while drawing
adds horizontal/vertical, perpendicular, tangent (arc from an endpoint) and
coincident; with it off, only connected endpoints and midpoints are
constrained. Snapping: grid, sketch guidelines (purple extensions that reveal
where coincidence/tangency is available), sketch guidepoints (endpoints,
midpoints, arc centers, profile centers), 3D guidepoints (vertices, edge
midpoints, face and hole centers), and "distant edges" (geometry off the sketch
plane projected in while in an orthogonal view), with optional text hints
naming the snap. Dimensions: length with a distance-type badge
(absolute/horizontal/vertical), diameter or radius, angle between two lines,
two arcs/splines, or a line and a curve; any field takes an expression. A
setting decides whether the first or last selected entity stays anchored when
a constraint moves things. Sketch planes: pick one of three world-plane tiles
at the origin, a planar face or construction plane, or hover and press Space;
"Normal to Sketch" recovers the view; continuing on the same plane edits the
same sketch, anything else starts a new one, and each sketch is an item in the
tree.

**OpenZCAD.** Twelve constraint kinds including driving distance/angle/radius
with persistent, draggable labels (S01); fillet, chamfer and offset on line
pairs and loops (S05); construction toggle; sketch text with bundled fonts;
face-attached sketches; drawing-then-typing numeric entry. Missing entities:
ellipse, spline, slot, point (**I01**). Missing modify tools: trim/extend,
mirror, patterns (**S05**), and the pattern-constraint idea is worth adopting
when S05 patterns land. Missing constraints: symmetry, lock, disconnect
(**S07**, new). Missing inference: auto-constraining while drawing and the
guideline/guidepoint/distant-edge snapping family (**S08**, new). Reference
dimensions (**S02**) and the distance-type badge (**S02**, added as a slice).
Sketch entry ergonomics and Normal-to-sketch are **S06**.

### 2.4 Construction geometry

**Reference CAD.** Axes: through two points, at the intersection of two
planes, of a cylinder or cone, along an edge or sketch line, perpendicular to
a face at a point. Planes: offset from a face, midplane between two faces,
through three points, on a curve at a point (normal to the curve), perpendicular
to an edge at a point, through an edge at an angle to a reference face,
parallel to a face at a point. Every reference is re-pickable from the history
card, sizes are editable, points snap to purple highlights, and pre-selecting
the defining geometry makes "Add plane"/"Add axis" appear in the adaptive menu.
Uses named: sketch planes, mirror planes, split and section planes, pattern
and revolve axes.

**OpenZCAD.** None; the offset datum plane is designed but not implemented.
The reference catalogue above is now the **R01** target list, with the offset
plane and the cylinder/edge axis as the first two slices because revolve,
circular pattern and mirror consume them.

### 2.5 Solid tools

**Extrude.** Reference: faces or regions; gizmo distance; boolean badge with
new body / union / subtract / intersect where new body, union and subtract are
chosen automatically from whether the swept volume touches or enters an
existing body; draft angle from the gizmo; history fields for sides
(one-sided/symmetric), extent (distance, to object, through all with flip),
start (from profile, offset with start and end offsets, from plane). OpenZCAD:
inferred add/cut, two-sided and symmetric, draft as a separate face feature.
→ **F01** gains "start from plane / start-and-end offset" as a slice next to
to-face/through-all.

**Revolve.** Reference: region plus an axis that may be a grid axis,
construction axis, sketch line or linear body edge; angle; a height that turns
the revolve into a helix (coils, threads) and an elevation field in history;
auto-boolean like extrude. OpenZCAD: partial revolve about an in-sketch axis,
helical sweep as a separate feature. → **R01** unblocks model-axis revolve;
add "revolve about a body edge or datum axis" as the first R01 consumer.

**Loft.** Reference: ordered closed profiles on separate planes, connection
points dragged to control vertex mapping and twist, guide curves (sketch curves
or edges that must intersect every section), periodic loft, start/end tangent
continuity none/G1/G2 with magnitude. OpenZCAD: loft to an apex; guides and
tangency open. → **M04** slices named: guides, connection-point mapping,
periodic, end continuity.

**Sweep.** Reference: profile position (auto, path intersection, closest
point, closest endpoint), orientation (normal to path, parallel to profile),
twist angle, scale along the path, corner type (mitre or round), fillet the
path to avoid self-intersection. OpenZCAD: sweep with a sketch guide rail;
twist open. → **M04** slices named.

**Offset Face.** Reference: one or many faces, tangent faces included
automatically, works on non-planar faces, distance type for a single face
(radius/diameter for circular faces, total against an opposite face, offset),
with a documented warning that switching type reinterprets the value.
OpenZCAD: Offset/Total and radius resize are U01's command contract; the
"switching type reinterprets the value" case is a U01 test to add; tangent
propagation is **M07**.

**Chamfer/Fillet.** Reference: one tool where dragging the arrow inward makes a
chamfer and outward a fillet; chamfer auto (equal setback) or two-distance;
fillet by radius or chord width; continuity G1/G2; corner rolling-ball or
setback; overflow auto/cliff/smooth/notch; a profile slider with a curvature
magnitude from −1 (flat) to 1 (sharp), which drops the radial dimension;
include tangent edges; Y-shaped blend toggle. OpenZCAD: fillet, distance-angle
and two-setback chamfer, variable radius under two laws behind a maturity gate
(M03). → **M03** gains chordal, G2, setback corner and tangent-edge chaining as
kernel-qualified slices; the drag-direction chamfer/fillet fold is a **U01**
interaction question, not a feature.

**Shell.** Reference: pick faces to remove, thickness from the gizmo. OpenZCAD:
equivalent.

**Booleans.** Reference: union/subtract/intersect with target and tool badges
that can be toggled per body, Keep Originals (none / all / modified / removed),
and the boolean type switchable in the history card. Extrude and revolve
carry the same badge. OpenZCAD: exact-only booleans with typed refusal, no
keep-originals, no type switch. → **M11** (new) for keep-originals and
target/tool re-pick across booleans, split and mirror.

**Split Body.** Reference: several splitting tools in one step (construction
or grid planes, sketch profiles which merge when connected, another body's
faces or coplanar edges, the body's own face, an image), projected through the
body so contact is not required; keep originals. OpenZCAD: plane split only.
→ **M11**.

**Replace Face.** Reference: extend or trim faces to meet a target face, with
flip. OpenZCAD: none. → **M07** slice.

**Offset Edge (3D).** Reference: offset a body edge or chain into a new sketch
element. OpenZCAD: none. → **I01** (projection family).

**Project.** Reference: project sketches, edges, faces or whole bodies as
_edges_ (an imprint that splits the target face, stays visible with the body,
and follows the source) or as _sketches_ (ordinary sketch items, optionally
linked); planar targets take both, curved targets edges only; also used to
merge same-plane sketches. OpenZCAD: none. → **I01** for sketch projection;
edge imprint is **K09** (imprint) and stays deferred.

**Wrap & Emboss.** Reference: map sketch regions onto a cylindrical or conical
face preserving arc length, emboss (positive) or engrave (negative) depth,
rotation and center, with a gizmo. OpenZCAD: none. → **M12** (new, deferred,
kernel-gated).

### 2.6 Transforms

**Reference CAD.** Move/Rotate with the gizmo (center snaps to geometry,
auto-orientation toggle, arrows for distance or angle with typed values, tiles
for planar moves, a copy badge that stamps repeated copies and a link badge
that decides whether copies stay in the same history step); Scale uniform or
non-uniform about a movable center, with copy; Pattern linear on one to three
axes and circular, by total or spacing plus quantity, uniform or rotated
orientation, for bodies or sketch profiles, instances placed in an items
folder; Align (bodies to faces, planes, axes, circular or linear edges, with
snap points, flip and gizmo adjustment, and snapping into coplanar/collinear/
concentric positions); Rotate Around Axis; Mirror about a face, sketch line,
axis or construction plane with keep originals; Translate by two picked points.

**OpenZCAD.** Move/rotate gizmo, uniform scale, mirror, linear/circular/grid
patterns. Missing: copy badges, non-uniform scale about a center, align,
rotate-around-axis with a model axis, translate by two points, pattern
total/spacing definitions and orientation modes. → **M10** (new, transform
depth) and **M02** (pattern definitions).

### 2.7 Section, measure, isolate, display

**Section View.** Reference: any plane or planar face; a gizmo moves the plane
deeper, tilts it and flips the kept side; "2D section" (orthographic with
background silhouettes, Normal to Section to recover) and "Section only" (hide
everything but the cut); cut fills coloured per body with random colours where
bodies share the default colour; overlapping bodies highlighted inside the cut
as an interference check; sketching on the section datum plane, measuring and
editing inside the section; sections saved with saved views. OpenZCAD: three
canonical planes with an offset and hole-preserving caps, exact section curves
on release with DXF export (M08). → **M08** gains gizmo move/tilt/flip,
section-only, 2D section, per-body fills and sketch-on-section-plane as
slices; **M09** gains "overlap highlight in the section cut" as its first,
display-only slice.

**Measure.** Reference: a movable panel; object measurements (length, area,
volume, radius, diameter, angle, perpendicular angle, minimum and maximum
distance, central distance from a center or axis, parallel distance including
radial difference between concentric items, X/Y/Z deltas) with sums over
multiple picks; point-to-point between notable points (endpoints, midpoints,
centers, intersections, face and hole centers) and 3-point angle; pin any
measurement as a persistent annotation, with a "show pinned measurements"
display toggle; hover to highlight the measured entity; the bottom-of-screen
readout shows a selection's measurements without entering the mode. OpenZCAD:
a measurement workbench with distance, angle, diameter, edge length/total,
face area and body volume, each labelled with its exactness provenance.
Point-to-point distance already reports X/Y/Z deltas and creates a visible
viewport annotation with a show/hide control
(`apps/web/src/lib/measurements.ts`,
`apps/web/src/components/MeasurementDock.tsx`).
Missing: picks snapped to notable points, 3-point angle,
maximum/central/parallel distances and hover highlighting of measured
entities.
→ **M13** (new, measure depth).

**Isolate.** Reference: isolate the selection, exit to restore; the history
filters to the isolated items. OpenZCAD: isolate one body from the parts list
(`isolateBody` in `App.tsx`). Selection-set isolate and the history filter are
**U06**.

**Display modes.** Reference: wireframe with silhouettes, X-ray with an
opacity slider, shaded, visualized (materials); zebra stripes with direction
and scale, curvature map with scale; show edges, show hidden edges, show
decals. OpenZCAD: shaded+edges, shaded, wireframe (`displayMode.ts`). → **U07**
for X-ray, hidden edges, silhouettes; **M09** already owns curvature/zebra
overlays.

### 2.8 History, items, variables

**History.** Reference: one step per action with an expandable card whose
fields (values and references) are editable, references re-picked through
"Edit…/Select…"; step menu: insert breakpoint (later steps disabled, hover to
remove), suppress/unsuppress, zoom to, rename, duplicate, delete, expand/
collapse; filter to steps related to the isolated items or to the current
selection; merge history up to a breakpoint (irreversible after the session
closes, keep or delete sketches and variables); imports appear as one Import
step, imported native projects keep their steps; variables are listed in the
history with rename-and-update-references. Sketch steps carry their plane and
projection references. OpenZCAD: editable feature history with suppression,
rollback marker, reorder, parameter rows with inline rename that rewrites
dependants (U02), and per-feature editors. Missing: zoom to, rename, duplicate
step, filter by selection/isolation, bake-to-breakpoint, and a uniform
"re-pick this reference" affordance on every card. → **U06** (new).

**Items.** Reference: every sketch, body, plane, axis, image, mesh and drawing
is an item with a type icon; filter by type; folders with drag-and-drop and
folder-level visibility; rename; hide/show, show hidden, invert visibility;
zoom to; reveal in items from the model; image opacity; pattern instances
auto-foldered; STEP hierarchy becomes nested folders. OpenZCAD: bodies list
with visibility, on/off body parameters (L05 slice). Missing: folders, type
filter, reveal, invert, planes/axes/images as items (the latter follow R01 and
I05). → **U06**; STEP hierarchy as folders is **I02**.

**Variables and expressions.** Reference: variables typed as length, angle or
number, created from a panel or from any input field ("Create length1 = 4"),
renamed with reference update; expressions in any numeric field with + − × ÷,
parentheses, a documented function set (sqrt, sign, floor, ceil, round, abs,
mod, min, max, avg, the trigonometric and inverse trigonometric family, pi(),
radians()), units inside expressions (5 mm + 2 cm, 3 in * 2, feet/inch
fractional forms with documented parse traps), dimensional rules (an area
divided by a length is a length; length plus angle is an error) and automatic
conversion to the workspace unit. OpenZCAD: named parameters with expressions,
the pi constant and a function set (abs, sqrt, floor, ceil, round, min, max,
and degree-based sin/cos/tan) in `packages/document-core`; no units inside
expressions, no parameter unit type or inverse trigonometric functions.
→ **F05** (new, expression depth), scoped as a Revalidate of the grammar first.

### 2.9 Import and export

**Import.** Reference: 2D DWG/DXF (lines, polylines, Béziers, arcs, circles,
ellipses, polygons; no annotations, styles, colours or constraints); 3D native
kernel files, STEP, IGES, STL as reference, its own format, two foreign native
part/assembly formats, more under an enterprise tier; images (PNG, JPG, first
PDF page, TIFF, BMP, GIF) placed with a gizmo and an opacity slider; another of
the user's own projects, merged with its history. Advanced import preferences:
simplify geometry, two healing passes, accurate edge computation, sewing,
"import planar curves as sketches". A 1 km³ design-space limit. STEP hierarchy
kept as nested folders; all foreign imports are one history step. OpenZCAD:
STEP, STL, 3MF/OBJ/GLB/PLY, its own and a guided foreign-native import; no
DXF import, no image import, no project insert. → **D04** (DXF import),
**I05** (new, reference images), **AS01** (insert project as a bounded first
slice), **I02** (hierarchy).

**Export.** Reference: 2D DWG/DXF/PDF/SVG/JPEG/PNG for sketches and drawings
(layers, hatches and annotations filtered out of sketch export; construction
geometry never exported); 3D native, kernel-native, STEP (AP203/214/242), IGES,
3MF, STL, OBJ with colours, GLB, USDZ; options for include dimensions, hidden
items, hidden sketches, mesh bodies, vertex colours, geometry/texture
compression, resolution presets or explicit deviation and angle tolerances,
save each first-level item or each sketch plane as a separate file in a zip,
units; favourite formats and batch export; export of the isolated selection;
direct hand-off to three slicers; quick export from the dashboard. OpenZCAD:
STEP, STL, 3MF, OBJ, GLB and section DXF. → **I04** (new, export options and
sketch/drawing formats); slicer hand-off is **L09** (deferred).

### 2.10 Drawings

**Reference CAD.** Create a drawing from selected bodies: title, sheet
orientation, ISO/ANSI sheet sizes, view-to-sheet scale, an "include four views"
option (front as base, left, top, isometric as projections). Drawing
properties: projection angle, title-block layout (simple, empty sheet, border
only, horizontal, vertical with a revision table, block, block with a free
table), units, angle format, length and angle precision, decimal separator,
line widths per class (visible, hidden, dimension, center, section, detail).
Title-block fields (title, units, scale, projection angle, size, date, sheet
size) fill automatically until edited by hand. Views: base views in any of the
six orthographic orientations or isometric, or a custom camera angle; projected
views that stay aligned with their base when either moves; section views from
a drawn section line with an arrow dragged to place the result; detail views
from a drawn circle, with their own scale and hidden-line toggle; per-view
scale and hidden lines; the reference bodies of a view editable. Dimensions:
line length, point-to-point, point-to-line, line-to-line, arc angle, 3-point
angle, line-to-line angle, radius, diameter, min/max distance; automatic
dimensioning of a picked item through the adaptive menu; placement snaps to
equal increments; each dimension has an editor for prefix, suffix and tolerance
(symmetrical, deviation, limits, basic). Geometry annotations: centerlines
(2-point, 2-line, 3-point circular, 3-point), center marks, intersection
marks, which also become dimension references. Notes up to 1,200 characters,
attached to an item or free. Images on the sheet. Drawings are refreshed from
the model by an explicit Update command (a hotkey), not live. Export DWG/DXF/
PDF; share links include drawings with a PDF download.

**OpenZCAD.** Design and HLR evidence only (D01). This catalogue is now the
acceptance list for **D01–D04**, and the explicit-update behaviour is adopted
as the D02 minimum: annotations refresh on command and show as stale in
between, which satisfies "update or visibly invalidate" without live
associativity.

### 2.11 Visualization, collaboration, versions

**Reference CAD.** A separate visualization space: 100+ materials dragged onto
bodies or faces, per-material transmission, IOR, scale, roughness, mapping
rotation, colour by hex/pick/swatch, opacity, a default body colour; decals
from images with wrap and cylindrical projection; custom materials from GLB or
an image; environments with light rotation, sun elevation, intensity and a
ground plane; camera FOV, aperture and blur for depth of field; capture with
resolution presets, an AI-enhanced capture, textured USDZ/GLB export and AR
viewing. Collaboration: team spaces, drafts, shared-with-me, per-project
invitations with edit access, share links that open a project page in a
browser; published versions as read-only browser views with viewer/commenter
roles, team/link/invited access, optional drawings with PDF download, and
comments anchored to a point on the model; project versions listed with
editor, device and sync state and restorable as latest; storage states
(local only, synced, cloud only) with download/remove and automatic offload of
inactive projects; a conflict dialog naming the last editor; up to eight saved
views for reviews; screenshots with visibility settings.

**OpenZCAD.** Cloud sync, roles and leases, save-state restore and branching,
share links with Tweak, thumbnails, backups (L01/L03); body colour; no material
presets, environments or captures. → **L02** rescoped to presets, a
lighting environment and a capture with resolution presets, with decals,
custom materials, AR and generated imagery explicitly out; **L08** (new,
deferred) for anchored comments and drawings on share links; the versions
list with editor/device columns is an **L03** slice.

---

## 3. Conventions worth adopting regardless of feature

- **Auto-boolean by geometry.** Extrude and revolve pick new-body, union or
  subtract from whether the swept volume touches or enters an existing body,
  with a badge to override and intersect always explicit. OpenZCAD already
  infers add/cut for extrude; the same rule should reach revolve, sweep and
  loft, and the badge should be the one override surface (U01).
- **Keep originals as a universal option** on booleans, split, mirror and
  transforms with copy, stored in the history card (M11, M10).
- **Every reference re-pickable from the history card** with the same
  "Edit…/Select…" affordance, and every selection during a tool shown as a
  toggleable badge on the geometry (U06, U01).
- **Pattern as a constraint** in sketches: instances stay linked to the source
  until the pattern constraint is deleted (S05).
- **Explicit drawing update with visible staleness** instead of live
  associativity for the drawings MVP (D02).
- **Complete-by-clicking-empty-canvas** for adaptive-menu tools, alongside
  Enter and a Done control (U01, already the command contract's territory).
- **Typed variables** (length, angle, number) and **units inside expressions**
  with dimensional checking (F05).
- **A single anchored-entity rule** for what moves when a constraint is
  applied, exposed as a setting (S03/S08).
- **Selection-aware command search** that lists only the commands valid for
  the current pick, and a recent-commands list on an empty query (U05).

---

## 4. Where OpenZCAD is ahead

Not to be traded for the parity work above:

- Exact-only booleans with a typed, categorised refusal, and measurements
  labelled by exactness provenance; the reference CAD exposes neither.
- The assistant: digest-bound, preflighted, single-transaction proposals with
  drawing/PDF ingestion and a dimension audit; the reference CAD's only
  generative feature is image enhancement in visualization.
- Tweak mode and curated parameters reachable from a share link (configurable
  parts for non-modellers); the reference CAD's share links are view/comment
  only.
- Local-first persistence with honest divergence handling and save-state
  branching; the reference CAD warns against opening a project on two devices
  and offers linear versions only.
- Bounded imported-feature recognition that compiles recognized STEP geometry
  into editable history (H01); the reference CAD imports foreign geometry as
  one opaque step.
- Browser delivery with no install, and a schema that is public and versioned.
