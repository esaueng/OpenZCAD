# D01 drawing MVP: sheet/view contract and projection qualification

Status: design and consumer-artifact qualification (2026-09-20); the
foundation slice is implemented (2026-10-19, schema v30) — see
[Implementation decisions](#implementation-decisions-d01-foundation-schema-v30)
for where it departs from this design. This note originally closed
the design-first slice of [D01](../../ROADMAP.md#d01). It does not add a
drawing editor, a PDF dependency, a new persisted schema, or a production
projection adapter.

## Scope and product contract

D01 is a drawing-sheet document attached to one exact saved model snapshot. The MVP
has four standard orthographic/axonometric views (front, top, right, iso), a
sheet size and units, an explicit scale, offline save/reload, and a PDF handoff
whose line geometry comes from the same view records. Dimensions, centerlines,
notes, title blocks, associative annotations, section/detail views, DXF, and
model-edit update/invalidation belong to D02–D04.

Roadmap reconciliation (2026-09-30, [FreeCAD comparison](../reviews/freecad-comparison-2026-09-30.md)):
this initial D01 slice uses the shared sheet scale shown below. The broader D01
catalogue (additional view orientations, aligned projection groups and per-view
scale overrides) remains later design/implementation acceptance, not covered by
the qualification evidence here. A per-view override needs a reviewed persisted
field, shared preview/PDF effective-scale transform and unit/reopen tests before
exposure; an absent override must retain the sheet scale. D02 owns title-block
layouts and automatically filled title, units, scale, projection-angle,
sheet-size and date fields until edited. The drawing product milestone combines
D01 with a bounded D02 dimension/update-or-invalidation/reopen/PDF handoff; D01
can still be implemented independently of annotations and assemblies.

The sheet is canonical user content. A projected polyline set is derived from
the referenced model revision and is disposable: it must be recomputed after
load and must never be used as the model source of truth. A view that cannot be
rebuilt keeps its camera/placement and records a named stale/refused state; it
does not silently show an older projection as current.

## Proposed persisted shape

Add a versioned `drawing` document section (or a `drawing-sheet` node under the
project when the node union is extended). Keep drawing IDs document-local and
keep source references immutable enough to detect a changed model:

```ts
type DrawingViewKind = 'front' | 'top' | 'right' | 'iso';
type DrawingProjection = {
  origin: Vector3;       // model-space projection origin
  direction: Vector3;    // camera-to-model, normalized at validation
  xAxis: Vector3;        // in-plane horizontal axis
};
type DrawingSheet = {
  id: EntityId;
  name: string;
  modelUnits: UnitSystem;
  paper: { size: 'A4' | 'A3' | 'letter'; orientation: 'portrait' | 'landscape' };
  scale: { numerator: number; denominator: number }; // 1:1, 1:2, 2:1; positive integers
  modelSnapshot: {
    projectId: ProjectId;
    checkpointId: string;
    revisionId: RevisionId;
    documentVersion: number;
  };
  views: Array<{
    id: EntityId;
    kind: DrawingViewKind;
    sourceBodyIds: BodyId[];
    projection: DrawingProjection;
    centerMm: { x: number; y: number }; // fixed millimetres on the paper
    visible: boolean;
    hiddenLines: boolean;
  }>;
};
```

The persisted contract stores intent only: source body IDs, exact checkpoint
snapshot fence, projection frame, sheet placement, visibility policy, model
units, paper, and scale. Creating or rebinding a sheet requires selecting an
existing checkpoint; an unsaved current document is not an implicit snapshot.
It does not store WASM handles, tessellated meshes, flattened polylines, SVG,
or PDF bytes. The view validator rejects non-finite vectors, zero directions,
zero or near-zero x-axes, an x-axis parallel to the direction, non-positive
scale, and views that name a body absent from the fenced snapshot. The explicit
consumer tolerance for frame vectors is `FRAME_VECTOR_TOLERANCE = 1e-12` as a
dimensionless vector-norm threshold: reject `norm(direction) <= tolerance` and
`norm(xAxis) <= tolerance` before normalization, then reject the orthogonalized
x-axis when its norm is at or below the same tolerance. The normalizer must fail
closed on a future drawing schema, matching `normalizeDocument`'s existing
behavior for a future project schema.

Projection resolves `modelSnapshot` by loading the exact save-state body from
the local checkpoint store (`loadLocalSaveState(projectId, checkpointId)`) or
the equivalent account save-state endpoint. It verifies project ID, checkpoint
ID, revision ID, document version, and the matching revision/checkpoint records
in the loaded snapshot before replaying it. A missing or pruned checkpoint,
missing source blob needed by replay, or failed metadata check produces a named
stale/refused state. The current open document is never substituted merely
because it has the same `revisionId`; it is usable only when it is the exact
requested checkpoint/version. An explicit rebind selects a new checkpoint and
updates `modelSnapshot`; it is the only operation that changes the source
fence.

The current canonical document already preserves feature history, revision
records, and command log in `ProjectDocument`; `withoutDerivedProjection`
provides the right persistence boundary. The implementation should extend the
canonical document rather than put sheet state in `derived` or the workspace
camera session. Local IndexedDB (`saveLocalProject`/`loadLocalProject`) is the
offline authority; cloud autosave can carry the same canonical document later.

## Projection and page transform

`projectEdges` returns flat 2D polylines in the supplied view plane. D01 should
call it once per source solid with `hiddenLines: true`, retaining visible and
hidden runs as separate line classes. It must pass a bounded, documented
deflection and surface the kernel's refusal if sampling exceeds the native
100,000-point work limit. Curves are therefore polygonal polylines in this
MVP; line-weight/style and curve fitting are export policy, not hidden geometry.

The pinned kernel defines `view = normalize(direction)`, re-orthogonalizes
`xAxis` to `x`, and computes `y = normalize(x × view)`. Thus the kernel's
right-handed plane normal is `x × y = -view`; positive page-up is the returned
`y` coordinate, and `direction` points from camera into the model. D01 must
preserve that sign in both preview and PDF. The standard frame contract is:

| View | direction | xAxis | positive page-up (`y = x × direction`) |
| --- | --- | --- | --- |
| front | `(0,0,1)` | `(1,0,0)` | model `-Y` |
| top | `(0,1,0)` | `(1,0,0)` | model `+Z` |
| right | `(1,0,0)` | `(0,1,0)` | model `-Z` |
| iso | `(1,1,1)` | `(1,-1,0)` | `(-1,-1,2)/√6` |

For each returned point `(u, v)` in model units, convert to page millimetres by

`page = centerMm + (u, v) * (scale.numerator / scale.denominator) * unitToMm`.

`modelUnits` describes the source geometry (`mm`, `cm`, `m`, or `inch`);
`unitToMm` is respectively `1`, `10`, `1000`, or `25.4`. Paper coordinates
are always millimetres, independent of model units. The supported paper boxes
are A4 `210 × 297 mm`, A3 `297 × 420 mm`, and Letter `215.9 × 279.4 mm`; the
orientation field swaps width and height before margins/centers are applied.
PDF points, when implemented, are derived from these fixed paper millimetres
with `72 / 25.4`. The sheet scale changes model spans, while `centerMm` remains
a fixed page position.

The transform is deterministic and shared by screen preview and PDF export.
Fit-to-sheet is a placement helper only; it must write an explicit scale and
center, never an implicit viewport zoom. Scale changes move every view through
the same transform and do not rerun geometry.

## Qualification evidence against the pinned kernel

Current OpenZCAD main (`efa2662910199e6d23d63f337e35d3d591614d21`) pins both
`remus-wasm` and `remus-wasm-io` to Remus commit
`76d76596013f4f89c1d28eaf750c571202eb4837` (`2.130.29` in the lockfile). That exact source exposes
`BrepKernel.projectEdges(solid, origin, direction, xAxis, hiddenLines,
deflection)`, returning `{ visible: number[][], hidden: number[][] }`; each
inner array is `[x0, y0, x1, y1, ...]`. The implementation is orthographic,
re-orthonormalizes `xAxis`, samples edges, and classifies midpoint probes with
an exact point-in-solid query. This is suitable input for D01's line model.

The pin's own native tests cover a 10 mm box in an oblique view: visible and
hidden runs are both non-empty; disabling hidden lines drops the hidden set;
invalid deflection and excessive sampling refuse before allocation. The source
tests are at `crates/operations/src/projection.rs` and the WASM batch binding
test is at `crates/wasm/src/bindings/operations.rs`.

An independent Node probe against the checked-out pinned package exercised two
synthetic solids with `deflection = 0.1`:

| Part/view | Expected oracle | Observed |
| --- | --- | --- |
| 20×10×6 box / front | bounds `[0,-10,20,0]`; hidden set empty | 12 visible, 0 hidden; exact bounds |
| 20×10×6 box / top | bounds `[0,0,20,6]`; hidden set empty | 12 visible, 0 hidden; exact bounds |
| 20×10×6 box / right | bounds `[0,-6,10,0]`; hidden set empty | 12 visible, 0 hidden; exact bounds |
| same box / iso `(1,1,1)` | visible + hidden; finite bounds | 9 visible, 3 hidden; bounds `[-7.0711,-12.2474,14.1421,4.8990]` |
| 20×10×6 plate with Ø4 through-hole / front | outer bounds unchanged; finite line runs | 14 visible, 0 hidden; bounds `[0,-10,20,0]` |
| same drilled plate / top | outer bounds unchanged; finite line runs | 14 visible, 0 hidden; bounds `[0,0,20,6]` |
| same drilled plate / right | outer bounds unchanged; finite line runs | 14 visible, 0 hidden; bounds `[0,-6,10,0]` |
| same drilled plate / iso | visible + hidden; finite bounds | 11 visible, 3 hidden; bounds `[-7.0711,-12.2474,14.1421,4.8990]` |

The box bounds are independent analytic oracles from the primitive extents and
the stated view bases. The drilled plate's bounds are an independent outer
extent oracle; line-run counts are diagnostic only and must not become a
cross-version contract. A future qualification harness should assert finite
coordinates, non-empty visible output for every supported view, expected outer
bounds within `1e-6` model units for boxes, hidden-line presence for the
oblique box, and scale ratios (`1:2` produces exactly half the page span while
preserving model-space bounds).

The current consumer probe also checks orientation and a known run, rather than
using only aggregate counts. For the iso box, the analytic corner projection
with `x = (1,-1,0)/√2` and `y = (-1,-1,2)/√6` is:

```text
p000 = (0, 0)                 p200 = (14.1421356, -8.1649658)
p010 = (-7.0710678, -4.0824829) p210 = (7.0710678, -12.2474487)
p001 = (0, 4.8989795)        p201 = (14.1421356, -3.2659863)
p011 = (-7.0710678, 0.8164966) p211 = (7.0710678, -7.3484692)
```

The pinned consumer output contains the visible run `p000 → p200` and the
three independently expected hidden runs `p201 → p211`, `p211 → p011`, and
`p210 → p211`, each within `1e-6` per coordinate (endpoint order may reverse).
This pins the camera-to-model direction, page-up sign, and a known occlusion
classification. The probe also rejects zero and near-zero x-axis vectors at the
consumer validation boundary; the WASM binding separately rejects non-finite
inputs, while the native operation rejects an exactly zero or parallel frame.

The native Rust test was not run because `cargo` is unavailable in this
workspace. The Node22 probe used the prebuilt paired packages shipped by the
exact current-main pin; it is consumer-artifact evidence, not a substitute for
hosted Remus CI. No claim is made here about NURBS silhouette quality, perspective
projection, exact section curves, or PDF byte fidelity. `projectEdges` is
edge projection with hidden-line removal; section output remains the separate
partial/display path recorded in the roadmap.

## Acceptance slices for implementation

1. **Canonical model:** add a versioned sheet/view section, normalize and
   validate it, and round-trip it through `withoutDerivedProjection` and the
   existing IndexedDB local store without storing derived lines. Persist the
   exact checkpoint ID, project ID, revision ID, and document version.
2. **Snapshot resolution:** load the exact local/account checkpoint body,
   verify all four identity fields and required source blobs, and refuse with a
   named stale reason when it is missing or pruned. Rebinding must be explicit;
   a current document with a matching revision ID is not a fallback.
3. **Projection service:** resolve the fenced source snapshot, call the pinned
   `projectEdges` API for each selected body, merge line classes without
   dropping a body, and expose refusal/stale reasons. Add the synthetic box and
   drilled-plate extent/orientation/known-run oracle harness above; keep run
   counts diagnostic except for those named oracle edges.
4. **Preview:** render visible and hidden polylines through the shared page
   transform; prove front/top/right/iso placement, handedness/page-up sign, and
   a `1:2` scale change in a browser test. Keep camera zoom out of the persisted
   sheet.
5. **PDF handoff:** serialize the same transformed line records to a bounded
   vector PDF writer, include fixed-mm paper/model-unit/scale metadata, and test
   that a reload then export is byte-stable for the same canonical document and
   kernel pin. PDF dependencies and font policy require a separate
   implementation decision; this design does not select one.
6. **Revision behavior:** after a model edit, a sheet whose exact checkpoint is
   no longer available must show an explicit stale/refused state. It must not
   silently project the current document or export prior derived lines; only an
   explicit rebind may select a new checkpoint.

Dependencies remain narrow: R01's datum-plane identity can later supply custom
view frames; M08's exact section work is for D03 and does not gate these four
standard views; S04's composite identity design must not be copied into this
sheet schema without a reviewed source-reference contract.

## Implementation decisions (D01 foundation, schema v30)

The first implementation (research-audit Stage 7, schema v30) follows the
sheet/view contract above with these recorded departures:

- **Shape.** `ProjectDocument.drawings = { sheets: DrawingSheet[] }`, absent
  when a project has no drawings and never synthesized on load. A view stores
  its orientation (`front`, `back`, `left`, `right`, `top`, `bottom`, `iso`)
  rather than free frame vectors; custom angles can add an optional frame
  later. Frames are Z-up and follow the glass-box fold about the front view,
  so `up = x × direction` matches the kernel's handedness: front looks along
  +Y with +Z up, top along −Z with +Y up, right along −X with +Y right, and the
  isometric from (1, −1, 1). `centerMm` is the centre of the view's projected
  extent rather than the image of a stored origin, so a view does not jump
  when the part sits far from the world origin. A projected view names its
  base (`parentViewId`) and keeps its row or column when either moves. Paper
  sizes are ISO A4–A0 and ANSI A–D; the scale is one shared sheet scale.
- **Model fence.** Instead of replaying an exact checkpoint, a sheet stores a
  fingerprint of its source bodies' persistent face and edge hashes and
  extents. When the derived model does not match it, the sheet says so, draws
  outlines only and refuses export; an explicit, undoable Update rebinds it.
  Nothing older is ever drawn as current, but a sheet cannot yet show a model
  state other than the current one; checkpoint replay remains open.
- **Projection.** Measured against the pin, `projectEdges` decides occlusion
  by stepping a point `1e-4 · diagonal` toward the camera, so walls further
  along the ray and other bodies never hide anything, and curved faces get no
  silhouettes. The implementation projects in its own worker from the
  display projection instead: kernel-sampled feature-edge polylines plus
  display-mesh silhouettes of curved faces, with occlusion against every
  body's triangles, each projected edge segment split exactly where it
  crosses an occluding triangle's edge. It is approximate to the display
  tolerance and is labelled so in the sheet panel. `test/drawing-projection.test.ts`
  keeps the box bounds and isometric known-run oracles above and records the
  pinned kernel's gaps as a diagnostic.
- **Canonical tessellation.** The projection's triangles and edge polylines
  are not the viewport's. The display mesh holds an earlier deflection
  through edits that stay within 25 % of it, and a cold reload meshes again
  at the nominal value, so drawing from it let a sheet read ready after a
  reload while exporting different bytes. The geometry worker's
  `drawing-tessellation` request meshes each body at its nominal display
  deflection for its own exact bounds (never a held one) and puts faces,
  triangles, vertices and edges in an order that depends only on their
  coordinates, so checkpoint replay and a full rebuild give the same arrays.
  The fingerprint needs no tessellation signature: the canonical mesh is a
  function of the exact geometry the fingerprint already fences.
  `test/drawing-canonical-tessellation.test.ts` exports a sheet, rebuilds cold
  in a fresh kernel and compares the PDF and SVG bytes.
- **PDF and fonts.** A dependency-free single-page PDF 1.4 writer and an SVG
  writer serialize the same page model the preview draws. Text uses the
  base-14 Helvetica faces with WinAnsi encoding and is not embedded; common
  engineering symbols outside Latin-1 print as a Latin-1 stand-in (U+2300 ⌀
  as Ø, typographic dashes and the minus sign as "-", curly quotes as
  straight ones) and any other character becomes "?" before layout so
  preview and exports agree. The title-block and note fields warn, without
  refusing, while their text still holds a character that will print as "?".
  Output has
  no timestamps or ids and is byte-stable for a model state and kernel pin,
  however the model was built (see Canonical tessellation).
- **Page bounds.** Paper and orientation changes still keep each `centerMm`
  (above), so a smaller paper can leave views off it. Each view is judged by
  its whole projected footprint, not its centre: the views list marks one off
  the page, partly off it, past the border or over the title block. Export is
  refused, with the reason, while any view runs off the paper; a view over the
  border or the title block is a warning only. "Fit views to sheet" is the
  explicit placement helper: one undoable `drawing.*` transaction that centres
  the views as a group above the title block and, only if they do not fit,
  drops to the largest preset scale at which they do. "Auto scale" is its
  sibling, also one transaction: it re-grids the views (centres that share a
  row or column keep sharing it, so projected views stay aligned) with even
  gaps, at the largest preset at which the grid fits, growing or shrinking.
  Presets run 50:1 to 1:1000 (ISO 5455 plus 4:1, 1:4, 1:8, 1:25, 1:250),
  largest first. As defence in depth the
  composed page drops strokes and text past the paper's edge (lines are split
  at it), and the PDF content is clipped to its MediaBox.
- **Editor-only overlays.** View names (and a view's "drawing…" or error
  text), selection outlines and hit areas are drawn by the editor over the
  page, never by `composeSheetPage`, so PDF and SVG exports carry no view
  labels. Printing them would be a new, explicit sheet option.
- **Sheet zoom.** Ctrl/Cmd+wheel and trackpad or touch pinch zoom the canvas
  about the pointer, with zoom out, zoom in, a percentage readout (100 % is
  the whole sheet fitted) and Fit sheet; a zoomed sheet scrolls with the wheel
  and pans by dragging empty paper or with the middle button. It moves only
  the canvas viewBox: editor state, never saved, never exported, and distinct
  from the Fit views to sheet placement helper.
- **Workspace.** Peter chose this placement and accepted the fence and
  projection departures above (2026-10-19). Drawings open as a fourth
  workspace mode, Draw, which draws
  the sheet over the stage and allows only `drawing.*` commands (undo included);
  the model stays read-only there. Its layout ("paper first", chosen
  2026-10-31): sheet tabs, sync state, zoom and export over the sheet; the
  annotation tools on an icon rail beside the paper with one-key shortcuts;
  a contextual properties panel on the right. While the model rebuilds the
  sheet shows its last drawing of this session faded, never ready or
  exportable. Dark paper is an editor-only, per-device preference; exports
  are always black on white.

## Implementation decisions (D02 annotations, schema v31)

The first D02 slice (research-audit Stage 7, ZC-146/163) adds dimensions and
notes to D01 sheets:

- **Shape.** `DrawingSheet.annotations`, absent when a sheet has none and
  never synthesized on load. Linear dimensions measure horizontally,
  vertically or aligned between two points; radius, diameter and angle
  dimensions; text notes on the paper or in a view, with an optional leader
  to an edge. Each stores only intent: the edges it measures, its text
  placement relative to its view's centre (so moving the view carries it),
  and an optional decimal count. A point is an open edge's `first` or
  `second` end in the view's page order (left, then lower, then nearer) or a
  circle's `center`, so it does not depend on the kernel's edge direction.
- **References and repair.** An edge is stored as body id, ADR-011 hash and,
  when the kernel proves one, the ADR-013 persistent reference, and resolved
  through `resolveEdge`: lineage first, then hash, failing on zero or several
  matches. A box widened through a parameter keeps its lineage, so its
  dimension reads the new width after Update. A reference that no longer
  resolves, a body no longer in the view, a circle now edge-on or two edges
  now parallel leave the annotation broken where it was placed, with a
  reason; export refuses until it is re-picked (Re-pick keeps its placement
  and format) or deleted. Picking refuses an edge whose identity another
  edge shares, so a stored pick can never later bind to a twin.
- **Values and the fence.** Values are computed every time a ready sheet is
  drawn from exact edge vertices and the kernel's published circle data,
  projected into the view; nothing typed, nothing stored. A stale sheet
  shows no values and offers no tools until its explicit Update. An aligned
  span between points at different depths, or an angle with an edge that
  slopes into the view, is refused as foreshortened, as is any length or
  angle on the isometric view; horizontal and vertical spans in a principal
  view measure along a model axis and stay exact.
- **Page and export.** Dimension lines, extension lines and filled
  arrowheads are a `dimension` stroke class (0.25 mm); text may be centred
  and rotated, placed from its measured Helvetica start so preview, SVG and
  PDF agree. A sheet without annotations exports byte-identical to D01.
- **Open.** Tolerances, prefixes and suffixes, centre marks and centrelines
  as references, point-to-line and min/max distances, title-block layouts,
  hole callouts, per-drawing unit and precision properties, and annotations
  on section and detail views (D03).

## Dimension tolerances, prefixes and suffixes (D02, schema v68)

- **Shape.** A dimension gains an optional `tolerance` — `symmetric`
  (`value > 0`), `deviation` or `limits` (`upper > lower`, both signed) or
  `basic` — stated to at most six decimals (what a label prints, so a
  stored tolerance never reads as zero), and an optional `prefix` and
  `suffix` (one trimmed line of at most
  40 characters, printed with a space between). Tolerances are stored as
  deviations from the measured value in the units the dimension prints in
  (the document's until v70's sheet units; degrees on an angle), never as a
  value, so `limits` prints the measured value plus each
  deviation and follows the model through the sheet's explicit Update. A
  reference dimension, a chamfer's `size × angle` and a counterbore or
  countersink callout take no tolerance (refused by the validator); marking a
  dimension Reference drops its tolerance. A toleranced diameter on an M01
  hole's rim states its diameter, not the hole's callout.
- **Text.** Symmetric reads `20 ±0.05`; deviation `20` then `+0.10` over
  `-0.05`; limits `20.10` over `19.95`; basic frames the value. A tolerance
  keeps its own decimals when finer than the dimension's, and a stacked pair
  keeps trailing zeros so its lines agree; no deviation prints as an
  unsigned `0`. The flat label (`20 +0.10/-0.05`, `[20]`) names the
  annotation in lists and the properties panel.
- **Page.** The stacked pair is set at 0.7 × the dimension text, centred on
  the value's mid-height, after the lead and before the suffix, each part a
  start-aligned text on the label's (possibly rotated) baseline; a basic
  frame is a closed `dimension` stroke. A dimension without these fields
  lays out exactly as before, so older sheets export byte-identical.
- **Schema.** v68, built on v67. A content gate refuses the fields in a
  document, its edit history or a drawing command that declares v67 or
  older. Drawing-level units, precision and decimal separator remain the
  next D02 slice.
## Drawing DXF export (D04)

- **What.** Export DXF writes the composed sheet — the same `SheetPage` the
  preview, PDF and SVG draw — as a DXF R12 drawing, one-to-one in paper
  millimetres (`$INSUNITS` 4), so it lands as printed: views at the sheet's
  scale, sections and their hatching, dimensions, notes and the title
  block. Exports are refused under the same conditions as PDF and SVG.
- **Layers.** One layer per stroke kind, since R12 has no line weights:
  `VISIBLE` (7), `HIDDEN` (8, line type `HIDDEN` 3/1.5 mm), `BORDER`,
  `THIN`, `DIMENSION` (3), `HATCH`, `CENTER` (4, `CENTER` 12/1.5/0.5/1.5
  mm, ISO 128 type 04) and `CUTTING` (1), plus `TEXT`; only the layers the
  page uses are declared.
- **Entities.** A two-point stroke is a LINE, a longer one a POLYLINE
  (closed when the stroke is), a filled arrowhead a SOLID, and each text a
  TEXT at its cap height, centred or right-aligned and turned as drawn.
  Characters outside ASCII use the writer's `\U+XXXX` escapes (Ø is
  `\U+00D8`). Curves are the page's polylines — exact edges sampled to the
  display tolerance — as the PDF draws them; an exact-arc view export is not
  this slice.
- **Writer.** `@openzcad/io-dxf` gains SOLID and the `HIDDEN`/`CENTER`
  line types; a file naming only `DASHED` (flat patterns) writes the same
  bytes as before. The export is deterministic.
- **Sketch DXF.** The export dialog's DXF option writes one saved sketch
  through the existing exact sketch exporter (`exportSketchDxf`): the sketch
  menu entry the D04 row left open.

## Drawing properties and title-block fields (D02, schema v70)

- **Shape.** `DrawingSheet.format`, absent when every property is its
  default: `units` (dimensions are measured in document units and printed
  in these), `decimals` and `angleDecimals` (the defaults when an annotation
  sets none), `angleFormat` (`decimal` or `dms`, degrees, minutes and
  seconds with the decimals on the seconds), `decimalSeparator` (`comma`;
  absent is a point) and `lineWidthsMm`, a print weight per line class
  (visible, hidden, thin, border, dimension, hatch, chain, cutting) within
  0.05–2 mm. `drawing.sheet.update` replaces it whole; null clears it.
- **Numbers.** One sheet number format writes every dimension, callout and
  tolerance: a value converts from document to printed units, a tolerance's
  deviations are amounts in the printed units (degrees on an angle), and a
  D°M'S" angle is rounded once in seconds so no 60" carries into a label.
  Values the sheet measures stay in model units; only text changes.
- **Weights.** The page carries the sheet's weights only when it sets any,
  and the SVG and PDF writers read a kind's weight from the page before the
  ISO 128 default, so a sheet without them exports byte-identical. The
  on-screen preview keeps its screen weights.
- **Title block.** The SCALE cell reads `SCALE · SIZE` (`1:1 · A3`), UNITS
  names the printed units, and DATE shows the date of the project's latest
  saved revision until one is typed. Title, scale, size, units and
  projection were already read from the sheet; they cannot disagree with it.
- **Schema.** v70, built on v69 (M17 standard parts). A content gate refuses `format` on a sheet
  or in a sheet update in a document, its history or its commands that
  declares v69 or older.

## Centre marks, intersection marks and centrelines (D02, schema v73)

- **Shape.** Three annotation kinds that mark geometry and state no value:
  `center-mark` (a circle or arc seen face-on), `intersection-mark` (two
  straight edges whose lines cross in the view: a rounded or chamfered
  corner's virtual sharp) and `centerline` in three modes — `points`
  through two points, `lines` midway between two parallel straight edges
  (spanning both along their direction), and `circle` through three points
  (a bolt circle through three hole centres). They store edges and points
  like dimensions, never positions, and take no decimals, tolerance or
  affixes. A dimension or centreline point may be `{ anchor: 'mark' }`, a
  centre or intersection mark of the same view, read through it each time
  the sheet is drawn.
- **Repair.** A mark that is deleted, or no longer marks a point, leaves
  what measured to it broken (`mark-missing`) until re-picked; the
  validator refuses only a mark point naming a non-mark or another view,
  so deleting a mark never makes a sheet unstorable. Parallel edges make no
  intersection, crossing edges no midline (`not-parallel`), and three
  collinear points no circle (`collinear`).
- **Page.** Centre lines are the `chain` stroke (ISO 128 type 04) run
  2.5 mm past what they mark; one shorter than 12 mm, whose dash would not
  show, is drawn thin and solid. A centre mark adds a 1.5 mm solid cross at
  the centre; an intersection mark draws each edge's thin extension from
  1 mm off its near end to 2 mm past the crossing. Marks have no text;
  their 5 mm pick box sits on the point they mark, where a linear or
  centreline tool picks them as a point.
- **Tools.** Centre mark (M), Intersection mark (X), Centreline (L: two
  points, or two straight edges each picked away from their ends) and
  Circular centreline (B: three points). Each is made as soon as its picks
  are in, with no placement click.
- **Schema.** v73, built on v72. A content gate refuses the kinds and mark
  points below v73. Point-to-line and min/max distances measured to marks
  and centrelines are the next D02 slice.

## Distance dimensions (D02, schema v75)

- **Shape.** `kind: 'distance'` measures between two targets in its view: a
  point (an edge end, a face-on circle's centre or a v73 mark), a straight
  edge seen true length, a `points` or `lines` centreline of the same view
  (by id), or a face-on circle. `extent: 'min' | 'max'` measures to each
  circle's near or far side instead of its centre (a wall between two
  holes, their overall span); it needs a circle. Takes decimals, tolerance,
  prefix and suffix like any dimension.
- **Reading.** With a line, the span is square to it (from a line's
  midpoint to the other when both are lines, which must be parallel:
  `not-parallel`); otherwise it runs between the two centres, which must lie
  in one plane parallel to the view like an aligned dimension's
  (`foreshortened`). A span of zero, or a near-side extent where circles
  overlap, is `degenerate`; a deleted centreline is `mark-missing`. The
  result lays out as an aligned linear dimension along the span, so it
  draws and exports through the same page model. The isometric view refuses
  it.
- **Tool.** Distance (T): two picks — a straight edge picked away from its
  ends is a line, a face-on circle a circle, an end a point, a mark a
  point, a straight centreline a line — then a placement click. The panel's
  "Measure circles to" picks centres, near or far sides.
- **Schema.** v75, built on v74, with a content gate below it.

## Finishing-body update repair

When a finishing feature consumes a drawing's body, the sheet offers the
existing explicit Update action for an unambiguous chain of one-to-one
hole, fillet, chamfer, shell, solid-offset or draft results. Additive Thicken
results leave their source live and are excluded from replacement paths. This
updates all affected views and their annotation body references in one
undoable command, together with the source fingerprint. The stored edge
hashes and witnesses, view positions and annotation formatting are kept.
The ordinary edge resolver checks them against the result; a removed or
ambiguous edge stays broken and requires Re-pick before export. Split
halves, copies, booleans and missing paths are never guessed. This adds no
persisted drawing fields or geometry approximations. Schema v39 fences the new
command payload from older clients that would ignore its body replacements.
Regression coverage:
`test/drawing-body-succession.test.ts`, `DrawingWorkspace.test.tsx`, and
`test/e2e/design-review-fixes.spec.ts`.

## Implementation decisions (D03 section views, schema v47)

The first D03 slice adds section views cut from a line drawn across a
principal view. Detail views remain open.

- **Shape.** A section is an ordinary `DrawingView` with an optional
  `section: { sourceViewId, label, depth }`. Its `orientation` is its
  direction of sight and must fold from the source view
  (`drawingViewAlignment` non-null), so the section stays aligned with its
  source exactly as a projected view stays aligned with its base, on the side
  the sheet's projection angle gives that direction (third angle: the side it
  is seen from). The cutting plane is normal to that direction and stores only
  its depth along it, in model units: `dot(direction, p) = depth`, with the
  material nearer the camera removed. Moving either view never moves the cut;
  the section line on the source is derived (`drawingSectionLine`),
  horizontal when the pair shares a column and vertical when it shares a row.
  Labels are one or two capitals, unique per sheet, skipping I, O and Q. The
  validator refuses a section of a section or of the isometric, a missing
  source, an unaligned or wrong-side placement, a non-finite depth and unknown
  keys. Named orientations keep the slice small: a horizontal line on a side
  view, a vertical line on the top view and the back's mirror pairs have no
  aligned principal orientation and are refused with a reason; free section
  frames are a later field.
- **Schema.** v47, built on v45 (M14 double-enveloping wheels); v46 is
  claimed by the D06 dimension-schema slice. Older clients must refuse: they
  would draw the view uncut and without its line.
- **Commands.** `drawing.view.add` carries the whole section view;
  `drawing.view.update` gains `sectionDepth` (the panel's "Cut at X/Y/Z" field,
  in world coordinates). Moving a source carries its sections along (and a
  projected view carries its own sections on), a section moves only along its
  shared axis, switching projection angle mirrors it across its source, and
  deleting a source deletes its sections with their annotations (one undoable
  command).
- **Projection.** The kernel's `section()` returns only the cap and refuses
  the case a section view exists for most — a plane down a bore's axis. So the
  geometry worker's drawing-tessellation request takes an optional section
  plane (`drawingSection`): each solid crossing it is cut by an exact
  half-space boolean (a box over the removed side), solids wholly in front are
  dropped and solids wholly behind kept whole, and the result goes through the
  same canonical tessellation and projection worker as any view. Every drawn
  line, the cut outline included, is then a kernel-sampled exact edge; hidden
  lines stay approximate to the display tolerance as in D01. Faces lying in the
  plane are returned as `cutFaces` and hatched at 45°, 2.5 mm apart, measured
  from the paper's corner; the hatch's curved boundaries follow the
  tessellation's chords. Sections default to hidden lines off.
- **Fallback.** Measured on the pin, the exact-only boolean refuses most
  planes through a cylindrical hole in a box (x = 20 through a Ø12 bore fails,
  x = 20.0001 succeeds, y = 15 succeeds). A refused body is not dropped: it
  comes back whole with the refusal, and the projection cuts its tessellation
  (`meshSection.ts`: triangles clipped, edges and silhouettes split at the
  plane, the cap rebuilt from plane crossings, nested by containment and
  triangulated). The panel says so ("Approximate: cut from the tessellation"),
  and its cut edges carry no identity, so it cannot be dimensioned until the
  kernel cuts it exactly. A plane that crosses no body is refused on the view
  and blocks export by name; it is never drawn from an older model.
- **Fence.** The cut is a function of the source bodies the sheet's
  fingerprint already fences and of the stored depth, so sections follow the
  same explicit Update, stale state and offline reopen as other views. Their
  projections are cached by fingerprint and view intent (depth included).
- **Dimensions.** The cut body's edges are published with ADR-011 hashes
  (`edgeTopology`) and placed beside the model's bodies under a key no body id
  can take (`sectionBodyKey`), so the D02 resolver, picker and layout work
  unchanged on a section: an annotation still stores the model body id and an
  edge hash. Edges the cut leaves whole keep their source hash; edges it trims
  or creates (a bore's floor, its walls) have new hashes and no lineage name,
  so an edit that moves one leaves its dimension broken until re-picked —
  never rebound to a neighbour.
- **Page.** New stroke kinds go through the one page model to the preview,
  PDF and SVG: `hatch` (0.18 mm), `chain` (0.25 mm, ISO 128 long-dash-dot
  12/1.5/0.5/1.5) across the source view 4 mm past its extent, `cutting`
  (0.7 mm) for the line's 6 mm ends, filled arrows in the direction of sight,
  the label at each end, and the caption "SECTION A-A" (WinAnsi has no en
  dash) above the view, or below it when that would face its source. A sheet
  without sections writes byte-identical PDF and SVG.
- **Tool.** The rail's Section view tool (S): drag across a front, top or
  side view; mostly sideways makes a horizontal line, mostly up or down a
  vertical one, at the press point, snapped within 2 mm to the view's middle
  or a circle's centre. The section then follows the pointer along its arrows,
  aligned with its source and kept clear of it, and a click places it.
- **Open.** Detail views; free (non-principal) section planes, offset and
  aligned (stepped) sections; per-body hatch angles; lineage for cut edges so
  a dimension survives an edit that moves them; exact cuts the pinned kernel
  refuses (a Remus robustness ask).

## Detail views (D03, schema v78)

- **Shape.** `DrawingView.detail`: `sourceViewId`, a label from the shared
  section/detail sequence, the circle's `center` in the source's model
  (u, v) and `radius` in model units, and the detail's own `scale`. The view
  keeps the source's orientation and bodies (the validator refuses any
  other; a body change on the source carries to its details, and a detail's
  own bodies cannot be edited) and its own hidden-line setting. A detail is
  not the source of a section, a projected view or another detail, and goes
  with its source when that is deleted.
- **Page.** The detail's transform centres the circle's centre on the view
  at its own scale; its footprint is the circle's square. Every stroke it
  draws, every line it offers to pick and every leader target is cut to the
  circle on the paper. The source shows the circle as a thin line with the
  bold letter outside it at 45°; the detail shows its own boundary circle
  and the caption `DETAIL A (4:1)` beneath it. Dimensions on a detail
  measure the model (true values, whatever the detail's scale).
- **Tool.** Detail view (K): press at the centre of the region on a view,
  drag to its rim (at least 2 mm), then the detail follows the pointer at
  the smallest preset at least twice the sheet's scale until a click places
  it. The panel edits the detail's scale and radius.
- **Schema.** v78, built on v77, gated below it.

### Drawing entry and visibility (2026-11-01)

Entering Draw without a retained sheet choice prefers the unique saved sheet
whose body set exactly matches the currently visible result bodies. This is
resolved after a pending model rebuild as well. Ambiguous or absent matches
fall back to the first sheet. An explicit sheet choice is retained with the
project's projection cache while switching between Build and Draw; opening
another project discards it. Hide/Isolate never changes saved view body IDs,
fingerprints or annotations. Drawing properties name the sheet bodies and
explain this distinction when the sheet includes a body hidden in Build.

Canonical tessellation and drawing sections request idle boolean-lineage
demand. They read geometry rather than demand additional evolution metadata,
so entering Draw does not upgrade an idle model to an eager probe rebuild.
Downstream modeling references still force the probes they require.
