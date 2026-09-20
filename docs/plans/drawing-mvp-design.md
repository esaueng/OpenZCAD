# D01 drawing MVP: sheet/view contract and projection qualification

Status: design and consumer-artifact qualification only (2026-09-20). This note closes
the design-first slice of [D01](../../ROADMAP.md#d01). It does not add a
drawing editor, a PDF dependency, a new persisted schema, or a production
projection adapter.

## Scope and product contract

D01 is a drawing-sheet document attached to one saved model revision. The MVP
has four standard orthographic/axonometric views (front, top, right, iso), a
sheet size and units, an explicit scale, offline save/reload, and a PDF handoff
whose line geometry comes from the same view records. Dimensions, centerlines,
notes, title blocks, associative annotations, section/detail views, DXF, and
model-edit update/invalidation belong to D02–D04.

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
  units: UnitSystem;
  paper: { size: 'A4' | 'A3' | 'letter'; orientation: 'portrait' | 'landscape' };
  scale: { numerator: number; denominator: number }; // 1:1, 1:2, 2:1; positive integers
  modelRevision: RevisionId;
  views: Array<{
    id: EntityId;
    kind: DrawingViewKind;
    sourceBodyIds: BodyId[];
    projection: DrawingProjection;
    centerMm: { x: number; y: number };
    visible: boolean;
    hiddenLines: boolean;
  }>;
};
```

The persisted contract stores intent only: source body IDs, revision fence,
projection frame, sheet placement, visibility policy, units, paper, and scale.
It does not store WASM handles, tessellated meshes, flattened polylines, SVG,
or PDF bytes. The view validator rejects non-finite vectors, zero directions,
an x-axis parallel to the direction, non-positive scale, and views that name a
body absent from the fenced revision. The normalizer must fail closed on a
future drawing schema, matching `normalizeDocument`'s existing behavior for a
future project schema.

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

For each returned point `(u, v)` in model units, convert to page millimetres by

`page = viewCenterMm + (u, v) * (scale.numerator / scale.denominator) * unitToMm`.

The transform is deterministic and shared by screen preview and PDF export.
Fit-to-sheet is a placement helper only; it must write an explicit scale and
center, never an implicit viewport zoom. Scale changes move every view through
the same transform and do not rerun geometry.

## Qualification evidence against the pinned kernel

Current OpenZCAD main (`efa2662910199e6d23d63f337e35d3d591614d21`) pins both
`remus-wasm` and `remus-wasm-io` to Remus commit
`62bf14725585dc869d41fc64822ef1f339dcb09c` (`2.130.29` in the lockfile). That exact source exposes
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
   existing IndexedDB local store without storing derived lines.
2. **Projection service:** resolve the fenced source revision, call the pinned
   `projectEdges` API for each selected body, merge line classes without
   dropping a body, and expose refusal/stale reasons. Add the synthetic box and
   drilled-plate oracle harness above; keep run counts diagnostic.
3. **Preview:** render visible and hidden polylines through the shared page
   transform; prove front/top/right/iso placement and a `1:2` scale change in a
   browser test. Keep camera zoom out of the persisted sheet.
4. **PDF handoff:** serialize the same transformed line records to a bounded
   vector PDF writer, include paper/units/scale metadata, and test that a
   reload then export is byte-stable for the same canonical document and kernel
   pin. PDF dependencies and font policy require a separate implementation
   decision; this design does not select one.

5. **Revision behavior:** after a model edit, a sheet whose `modelRevision`
   differs must rebuild before export or show an explicit stale/refused state;
   it must not silently export its prior derived lines.

Dependencies remain narrow: R01's datum-plane identity can later supply custom
view frames; M08's exact section work is for D03 and does not gate these four
standard views; S04's composite identity design must not be copied into this
sheet schema without a reviewed source-reference contract.
