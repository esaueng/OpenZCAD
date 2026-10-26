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
  base-14 Helvetica faces with WinAnsi encoding and is not embedded; any other
  character becomes "?" before layout so preview and exports agree. Output has
  no timestamps or ids and is byte-stable for a model state and kernel pin,
  however the model was built (see Canonical tessellation).
- **Workspace.** Peter chose this placement and accepted the fence and
  projection departures above (2026-10-19). Drawings open as a fourth
  workspace mode, Draw: sheets in a left column, properties on the right, and
  the sheet canvas between them, which draws
  the sheet over the stage and allows only `drawing.*` commands (undo included);
  the model stays read-only there.

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
