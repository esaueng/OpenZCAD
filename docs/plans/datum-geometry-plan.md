# R01 — Offset Plane and Midplane

**Design baseline:** 2026-10-16, canonical document schema v17.

> **Schema note (2026-10-17):** v18 is now taken by the S07 sketch
> relations (#705). Read this plan's v17 → v18 bump as v18 → v19, and its
> "pre-v18" documents as pre-v19; the migration content is unchanged.

> **Implementation deviation (2026-10-17, R01-A/B):** a datum plane is a
> `FeatureNode` with `featureKind: 'datum-plane'` in `featureOrder`, not a
> separate `DatumPlaneNode` in a new `historyOrder` union. The datum
> reference is therefore `{ type: 'datum', datumFeatureId: FeatureId }`, and
> `featureOrder` stays the one authoritative timeline. This removes the union
> migration, the legacy `featureOrder`-projection reconciliation for old undo
> entries, and the dedicated `history.*` commands: reorder, suppression,
> rollback, deletion, undo/redo, persistence and the prefix cache already
> treat every feature uniformly, so a datum inherits them unchanged. The
> datum owns no body (`bodyId` stays undefined), and its warnings carry its
> real feature id instead of an invented one.
>
> Every other contract here stands: the three source kinds (a face source
> requires `faceReference` and `sourceCentroid`), parallel-only Midplane,
> signed expression-capable offsets, `reverseNormal`, the
> `ModelingPlaneReference` union on Split/Mirror (legacy numeric planes keep
> their meaning; mixed payloads are refused), a frame map keyed by datum id
> that Sketch/Split/Mirror read at their history position in both the Remus
> build and the OCCT parity reference through one pure construction module
> (in `packages/geometry`), fail-closed resolution with the
> datum named and no stored-frame fallback, and refusal to delete a datum
> while anything still uses it. Reorder refuses a sketch moving before its
> datum because the reorder gate now reads a sketch's plane reference too.
> The bump is v18 → v19. The Plane tool, Items/History presentation and AI
> operations (R01-C/D) remain open.

> **Point constructors (2026-10-19, schema v25):** the release boundary below
> moved for two constructors. `three-point` takes three point sources: the
> origin is the first, u points at the second and the normal follows the
> right-hand rule (first → second → third); points closer than the linear
> tolerance, or a third point within it of the line through the other two,
> are refused. `parallel-point` takes one plane source (canonical, datum or
> qualified face) and one point source, and copies the plane's axes through
> the point. A point source is either expression-capable world coordinates
> or an `edge-vertex`: one end of an open edge named by its schema-v5
> lineage, where `end` 0 is the end whose quantized coordinates sort first
> by x, then y, then z. The vertex's exact position comes from the resolved
> edge; a deleted, ambiguous, closed or hash-only edge refuses by name, and
> no vertex is chosen by proximity. Both kernels share the construction
> rules (`packages/geometry`) and the edge-vertex resolver
> (`face-attachment.ts`). Vertex re-pick repair and AI operations for these
> kinds remain open.

This revision replaces the earlier canonical-offset-only first slice.
[ROADMAP.md](../../ROADMAP.md#r01) owns delivery status. This document proposes
contracts and acceptance evidence; it adds no runtime capability or schema bump.

## Decision and scope

Start R01 with named, editable **Offset Plane** and **Midplane** document nodes,
consumed by **Sketch, Split, and Mirror**. A consumer stores a datum ID rather
than a copied origin/normal. Rebuilding the datum therefore updates all three
consumers through the same history-position resolver.

The reference workflow demonstrates offsetting a planar face by a signed
distance, saving the plane in Items, selecting it as a Split tool, and creating
a midplane between two parallel planar faces. Preserve that direct workflow in
the existing workspace column, tool card, Items, and history UI. Its additional
plane menu entries are future scope, not requirements for this release.

| First release | Boundary                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Offset Plane  | Source: a canonical plane, an earlier datum plane, or one qualified exact planar face. Signed, expression-capable offset; zero is valid.  |
| Midplane      | Two distinct, separated, parallel planar sources, in any combination of the same three source kinds. Opposing face normals are supported. |
| Sketch        | Create/re-enter a sketch on a datum; existing profile-based features follow the resolved sketch frame.                                    |
| Split         | One datum plane splits one body using the existing two-result contract.                                                                   |
| Mirror        | One datum plane mirrors one body using the existing separate-copy contract.                                                               |

Angled/bisector, three-point, curve/edge/point-derived planes, axes, points,
coordinate systems, datum sections, new pattern/revolve axes, multi-tool splits,
and keep-originals options remain outside this release. A nonparallel Midplane
input is refused; the tool does not guess an angular bisector. Existing numeric
Split/Mirror inputs remain available unchanged. No new dependency, kernel
package update, remote migration, or deployment is required by this design.

## Document schema and compatibility

The proposed implementation bump is **v17 → v18**, covering the node,
references, and ordered history together. This design PR does not change
`PROJECT_DOCUMENT_SCHEMA_VERSION`. If another schema lands first, rebase the
implementation and explicitly revise this target to the next unused version.
Preserve the already merged v16 sketch basis/annotation fields and v17 fields;
the former plan's shared future v15/S01/S04 envelope is no longer the baseline.

The following are proposed shared types, not current exported APIs:

```ts
type DatumPlaneRef = { type: 'datum'; datumPlaneId: EntityId };

// Preserve canonical basisRevision, including the v16 XZ convention.
type CanonicalPlaneSource = Extract<SketchPlaneRef, { type: 'canonical' }>;

// New face sources require both proven lineage and an exact centroid anchor.
type FacePlaneSource = Omit<
  Extract<SketchPlaneRef, { type: 'face' }>,
  'faceReference' | 'sourceCentroid'
> & {
  faceReference: FaceTopologyReferenceV5;
  sourceCentroid: Vector3;
};

type DatumPlaneSource = CanonicalPlaneSource | DatumPlaneRef | FacePlaneSource;

type DatumPlaneDefinition =
  | {
      kind: 'offset';
      source: DatumPlaneSource;
      offset: ParamValue;
      reverseNormal?: boolean;
    }
  | {
      kind: 'midplane';
      sources: [DatumPlaneSource, DatumPlaneSource];
      reverseNormal?: boolean;
    };

type DatumPlaneNode = BaseNode & {
  kind: 'datum-plane';
  datumPlaneId: EntityId;
  definition: DatumPlaneDefinition;
};

type HistoryEntryRef =
  | { kind: 'feature'; featureId: FeatureId }
  | { kind: 'datum-plane'; datumPlaneId: EntityId };

type ModelingPlaneReference = ParametricPlane | DatumPlaneRef;

interface ProjectDocument {
  historyOrder?: HistoryEntryRef[]; // present after normalization
}
```

Add `DatumPlaneNode` to `DocumentNode` and `DatumPlaneRef` to `SketchPlaneRef`.
The existing `plane` property in Split/Mirror feature data and document-core
inputs becomes `ModelingPlaneReference`: legacy untagged `{ origin, normal }`
retains its exact meaning, while `{ type: 'datum', datumPlaneId }` is the new
alternative. Reject unknown tags and mixed datum/numeric payloads. Do not add a
competing optional `planeRef` with fallback precedence.

A datum's ID is its node ID, stable across rename, source replacement, undo,
and redo. It belongs to the active part and creates no body or `FeatureNode`.
Names are bounded presentation metadata and never reference keys. A canonical
source chosen from the viewport starts at offset zero using
`newCanonicalPlaneRef`; the datum's separate offset is the editable distance.
Existing canonical sources retain their authored offset and `basisRevision`.
No old sketch or numeric feature is automatically converted to a datum.

### Migration, history snapshots, and validation

`historyOrder` is the authoritative union of features and datums.
`featureOrder` remains a compatibility projection containing exactly its
feature entries in the same order; it must never be an independent second
timeline. No separate persisted datum-order array is needed.

For pre-v18 documents, normalize the existing effective feature replay order
into feature entries without changing IDs, geometry, local sketch coordinates,
command payloads, basis markers, suppression metadata, or primitive/composite
constraint identity. Preserve the existing feature-order resolver's treatment
of legacy documents. For v18, reject duplicate, missing, wrong-kind, orphaned,
or projection-inconsistent entries instead of silently appending a datum.
Validate part ownership, source shapes, bounded expressions, references, and
acyclic ordering at disk, backup, account-save, and collaboration boundaries.
Distinguish malformed graphs from well-shaped broken attachments: missing
source targets in saved data remain named, unresolved references available for
repair. Validate ordering/ownership for targets that exist; reject cycles,
forward edges, malformed payloads, and invalid timeline membership. New authoring
commands require every source to exist and resolve. Preserve this distinction
for legacy face attachments as well as new datum references.

Add `historyOrder` to `HISTORY_FIELDS` and the splice allowlist in
`packages/shared/src/document-history.ts`. Preserve old undo/redo entries:
when applying a legacy entry that changes only `featureOrder`, reconcile its
feature projection into the union in the same transaction, retaining datum
entries and validating dependencies. An old history entry must never erase a
new datum or leave two conflicting orders. Existing serialized commands keep
their replay versions and feature-index semantics; the compatibility adapter
maps them into the union. New timeline commands use explicit entry identity.

Update backup/saved-state validation, undo checkpoints, replay, and cloud
history equality/merge comparisons together. Accept no same-version
collaboration result that ignores a changed `historyOrder`. A merged candidate
must pass graph/order validation before acceptance. Older clients continue to
refuse newer schemas; they must not save a projection that drops datums.
Resolved frames and kernel handles remain derived and are stripped from all
canonical snapshots by `withoutDerivedProjection`.

## Exact source resolution and plane geometry

Resolve each datum **once at its own timeline entry**, using the then-current
source body/face or earlier datum. Every later consumer reads that resolved
result. Do not resolve the source again against final viewport topology: a
later Split may consume the very body that defined the plane. Two datums
defined before and after a transform may intentionally resolve differently.

Canonical sources use `canonicalPlaneBasis(plane, basisRevision)`, including
the front-facing XZ normal for revision 2. Datum sources require an earlier,
successfully resolved datum in the same part. Face sources follow
[ADR-011](../adrs/ADR-011-unified-topology-identity.md),
[ADR-013](../adrs/ADR-013-persistent-topology-lineage.md), and the amended
[ADR-014](../adrs/ADR-014-true-face-attachment.md):

1. Require a current exact planar face, a matching v5 `faceReference`/hash,
   qualified witness/lineage, and a finite exact centroid at creation.
2. Resolve that reference uniquely against the source body's state at the datum
   entry. Both the body's producer and the reference's producing feature must
   precede the datum. A source consumed before that entry is unavailable.
3. Re-derive origin from the resolved centroid and orient the frame using the
   persisted attachment seed, as in `resolveFaceAttachment`. The seed controls
   orientation only; it never selects a face or rescues failed lineage.

Hash-only, mesh, non-planar, and unqualified face sources are unavailable, with
a reason. A planar-looking tessellation does not establish an exact plane.
Boolean evolution demand must include faces referenced by datum nodes, so
lazy lineage probing does not withdraw a supported attachment accidentally.
Support remains bounded by the actual qualified lineage subset; R01 does not
claim to finish K05.

### Offset Plane

For source frame `(o, u, v, n)` with unit normal, evaluate the authored offset
`d` in document units and use `o' = o + d * n`. Keep `u`, `v`, and `n`.
Positive/negative values follow the visible source normal; zero is valid.
`reverseNormal` reverses the **result** normal and `v`, preserving a
right-handed frame; it does not change `o'` or the meaning of the source offset.
The UI calls this action “Flip normal”, not “Flip offset”.

Keep both source and offset expressions authored as `ParamValue`. Display-unit
conversion follows existing parameter controls; no new unit interpretation or
whole-document conversion is introduced. Rename/delete parameter traversals
must include expressions nested inside canonical sources as well as `offset`.

### Midplane

Persist ordered source roles **A** and **B**; rebuilding never sorts them by
name, coordinates, or normal. Resolve frames A/B, then:

1. Require parallel unit normals using
   `length(cross(nA, nB)) <= GEOMETRY_RELATIVE_TOLERANCE`. Antiparallel normals
   are equally valid. This is numerical parallelism tolerance, not an angled
   plane approximation.
2. Let `s = dot(oB - oA, nA)`. Require distinct source identities and
   `abs(s) > geometryTolerance(max(length(oA), length(oB)))`. Coincident sources
   are refused even if they have different IDs.
3. Use `o = oA + (s / 2) * nA` and A's `u`, `v`, `n`. This keeps the in-plane
   origin anchored to A while placing the plane halfway between the carriers;
   tangential movement of B alone does not slide an attached sketch.
4. Apply optional result-normal reversal as for Offset Plane.

Reuse the existing constants from `packages/geometry/src/tolerance.ts`; test
both sides of each boundary. Source order and normal direction are explicit
design intent: they determine sketch orientation and Split's positive/negative
output identities. Midplane has no editable offset field. Replace either
source through a labeled A/B picker without silently exchanging the roles.
Flipping the result normal preserves both Split output IDs but exchanges which
geometric half each ID denotes; preview those side labels before commit.

## Replay, derived results, and cache correctness

Replace feature-only iteration at build/checkpoint boundaries with the unified
timeline. A datum contributes a resolved frame or a typed failure to an exact
build map keyed by datum ID. It allocates no solid. Sketch bases and the
Split/Mirror builders read this map; both production Remus and the OCCT parity
reference must use the same pure plane construction rules.

Publish datum resolution states through the worker result for the matching
document version: resolved frame, suppressed/unavailable state, or failure with
source role and reason. Viewport picking, sketch re-entry, preview, diagnostics,
and export consume that result. They must not substitute a frame inferred from
`derived.bodyRepresentations` at a different history position or revision.
Extend warning provenance for datum entries instead of inventing a feature ID
for a non-feature node.

The prefix cache must digest a datum's complete definition, orientation seeds,
source IDs/witnesses, relevant resolved parameters, ordering, and suppression.
A consumer must carry its transitive datum dependencies, not only the datum ID.
Earlier feature-prefix digests guard upstream body changes. Add resolved datum
states to JS checkpoint snapshots and restore/discard them with kernel
checkpoints, including non-kernel entries in progress/cancellation accounting.
Rebuild-cache keys and selective parameter-scope readers need the same coverage.

Literal `10 → 12`, parameter changes, A/B replacement, source movement, normal
flip, suppression, and reorder must invalidate every affected suffix. Matching
content restored by undo may reuse a matching checkpoint. An unresolved import
source is transient: a face-derived datum and its suffix must not retain a
failure checkpoint that prevents recovery when source bytes arrive.

## Consumer contracts

| Consumer                       | Required behavior                                                                                                                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sketch                         | Store only the datum reference. Resolve at the sketch feature's history position, using the datum result already produced earlier. Re-entry, grid, camera alignment, snaps, solver projection, dimensions, and sketch DXF use that same basis.                                         |
| Existing sketch-based features | Extrude/revolve/loft/sweep continue to obtain the sketch's resolved frame; qualify their existing paths after the union changes. This adds no datum revolve axis or new end condition.                                                                                                 |
| Split                          | Resolve the datum to the exact numeric plane immediately before the existing kernel split call. Preserve `secondBodyId`, positive/negative half semantics, target consumption, naming, and existing tangent/no-intersection refusal. The displayed quad's extent never limits the cut. |
| Mirror                         | Resolve through the same map immediately before the existing exact mirror call. Preserve the original and the mirrored copy's identity, transform/lineage behavior, and existing export contract.                                                                                      |

In-plane movement of a datum-attached sketch edits its local geometry. Normal
translation is refused with the datum named; edit the datum explicitly instead.
Changing an existing sketch to another datum is an explicit, undoable
attachment edit that preserves local coordinates and previews the resulting
world-space movement. It never claims to preserve world placement implicitly.
Driving and reference annotation positions remain plane-local and follow the
frame without becoming solver constraints or changing identity.

Creation/edit forms for Split/Mirror offer the existing numeric plane controls
and an explicit datum picker. Reopening a datum-backed feature preserves its
ID reference; it must not round-trip through displayed origin/normal strings.
Selection distinguishes the target body from the plane tool and permits picking
an existing datum from Items or the viewport. Preview and committed exact
geometry must agree. Failure blocks the affected consumer's preview/commit and
export rather than using the last rendered plane.

## Dependencies, commands, and failure behavior

Add a typed dependency walker for datum sources, sketch attachments, and
Split/Mirror plane references, alongside existing body/sketch/feature edges.
Include suppressed and rollback-hidden nodes. Use it for create/edit/reorder,
source feature deletion, datum deletion, parameter rename/delete, cache demand,
and the source/dependents inspector. Do not infer ID references from every
string in a definition or confuse parameter identifiers with node IDs.

New commands: `datum-plane.add`, `datum-plane.update`, `datum-plane.delete`,
`history.reorder`, `history.suppress`, and `history.rollback`. Reuse `node.rename`
and the existing visibility metadata contract. Assign creation IDs before
serialization so replay/redo preserve them. All changes are one undoable
transaction, subject to existing editing permissions and collaboration leases.
Legacy feature commands keep their recorded semantics via the union adapter.
Suppression/rollback retain the separate manual and suffix metadata semantics
of [ADR-017](../adrs/ADR-017-feature-suppression-and-rollback.md).

Creation and direct datum/consumer edits preflight the candidate graph,
expressions, frames, and affected active exact consumers before committing.
On refusal, authored state, solver state, undo cursor, and last-good projection
stay unchanged. Preserve existing upstream-edit semantics: an upstream change
or an imported saved document can expose a broken downstream attachment;
retain its authored definition and report the failure instead of deleting it.
Unrelated existing failures must not prevent repairing the broken source.

| Condition                                                                                                                         | Fail-closed result / recovery                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing datum/source node or wrong node kind                                                                                      | Retain the named broken reference; no numeric/frame fallback. Replace the source explicitly or undo the source change.                                    |
| Source after datum; datum after consumer; self-reference/cycle; cross-part source                                                 | Refuse create/edit/reorder atomically. Reject structurally invalid imported graphs before replay.                                                         |
| Source body consumed, producer suppressed, or rollback excludes source                                                            | Datum unavailable at its history position; affected consumers do not build. Restoring the source/timeline allows normal replay.                           |
| Face deleted, split/merged without uniquely qualified lineage, ambiguous, non-planar, unsupported witness, invalid centroid/frame | Propagate the typed reason, datum name, source role, and producing feature. No proximity, ordinal, or stale-seed rebinding.                               |
| Midplane sources become nonparallel or coincident                                                                                 | Keep the authored A/B references and show the named geometric refusal. Repair a source or undo; do not change construction mode.                          |
| Offset expression unknown, cyclic, non-finite, or otherwise invalid                                                               | Refuse direct edit with expression/parameter named; no checkpoint or document mutation. Existing broken data stays visible for repair.                    |
| Datum suppressed or excluded by rollback                                                                                          | Keep its node/references and skip its frame. Active dependents report unavailable-datum diagnostics. Preserve manual and rollback suppression separately. |
| Delete datum, source feature, or source datum with dependents                                                                     | Refuse and list dependents, including suppressed ones. Delete dependents or explicitly replace their source first. No implicit cascade or detachment.     |
| Stale worker reply or cancelled/superseded exact preflight                                                                        | Discard by document version and operation identity; no command, frame, or geometry publication.                                                           |

A last-good exact body may remain visible for repair under existing retained
projection behavior, but must be labeled as retained and cannot authorize
export of a failed consumer. Last-solved sketch coordinates can remain local
repair data while their world frame is unavailable. Datum frame failure must
not masquerade as a successful GCS solve or erase S03 conflict/DOF evidence.
Recovery clears only the diagnostics resolved by a successful rebuild.

## Interaction and rendering

Add one **Plane** tool to the existing tool catalogue/command palette. Its card
offers **Offset Plane** and **Midplane**, named source slots, selected-source
badges, an offset expression control where applicable, Flip normal, Cancel,
and Done. Preselection may populate a compatible source; it must not mutate
the document until Done. Keep the camera stable while picking and dragging.

Offset uses a normal-aligned drag handle and numeric entry, with immediate
translucent preview; drag events coalesce into one committed edit. Midplane
shows A/B picks and a live midpoint preview after both valid sources exist.
Done stays unavailable with a specific reason until exact preflight succeeds.
Esc/Cancel leaves no node, history entry, parameter change, or selection leak.

Committed planes appear in Items and the unified history with editable names,
visibility, source/dependent inspection, and an edit action. Drawing a finite
quad is presentation only: all consumers use the infinite mathematical plane.
Hidden planes remain valid dependencies, are absent from viewport raycasts,
and remain available through labeled Items/picker controls. Plane selection
must not masquerade as `TopologySelection` with a fake body/face hash; introduce
a distinct datum selection target and update filters/callouts accordingly.

Use the existing translucent fill/border, hover, and selection conventions,
with readable state labels/badges as well as color. Provide keyboard source
lists, numeric editing, focus restoration, and announced invalid-source states;
neither creation nor repair may require dragging a small viewport handle.
Preview geometry is temporary; a committed datum has no body mesh or STEP/STL
solid and does not affect model bounds/fit-to-selection as a solid would.

## Ripple inventory

Paths below are current owning seams, to be audited again at implementation.
New plane helpers/tests may be split into focused files beside them.

| Area / owning files                                                                                                                | Required change                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/index.ts`                                                                                                     | Node/reference unions, Split/Mirror plane union, proposed v18, derived datum states/warnings, distinct datum selection identity. Preserve v16 basis markers.                                                                                                                       |
| `packages/shared/src/document-history.ts`, `document-validation.ts`, `textLimits.ts`                                               | History field/splice allowlists, bounded names/expressions, graph/order validation shared by import boundaries.                                                                                                                                                                    |
| `packages/document-core/src/index.ts`, `feature-order.ts`, `sketch-reference-dimensions.ts`                                        | Datum CRUD, union ordering/projection, normalization, source/dependent and expression walks, deletion guards, local sketch/annotation invariants, suppression/rollback.                                                                                                            |
| `packages/command-system/src/index.ts`                                                                                             | Command factories/replay, legacy command adaptation, graph/exact preflight, undo atomicity, readonly/lease restrictions, datum-aware parameter operations.                                                                                                                         |
| `packages/geometry/src/index.ts`, `tolerance.ts`                                                                                   | Shared offset/midplane construction and reference resolution context; exhaustive handling of the new sketch variant. Reuse tolerances/basis revisions.                                                                                                                             |
| `packages/kernel-adapter/src/exact-build-loop.ts`, `exact-feature-builders.ts`, `exact-profile-builders.ts`, `exact-types.ts`      | Ordered datum evaluation, build-map propagation, Sketch/Split/Mirror resolution, source availability, typed failure propagation.                                                                                                                                                   |
| `packages/kernel-adapter/src/face-attachment.ts`, `topology-lineage.ts`, `exact-boolean-evolution.ts`, `exact-lineage-builders.ts` | Qualified face attachment/orientation; datum-derived lineage demand and producer dependencies.                                                                                                                                                                                     |
| `packages/kernel-adapter/src/exact.ts`, `exact-history-cache.ts`, `exact-suppression.ts`, `rebuild-progress.ts`                    | Union checkpoint indices/digests/snapshots, expression scope, suppression, progress, cancellation, transient-source recovery.                                                                                                                                                      |
| `packages/kernel-adapter/src/exact-sketch-dxf.ts`, export/read-only query paths                                                    | Exact resolved sketch basis; refuse unavailable frames; never export datum quads as solids.                                                                                                                                                                                        |
| `test/parity/occt-reference/occt-step.ts` and parity fixtures                                                                      | Mirror union replay/resolution in the reference adapter; geometry and failure parity without widening unrelated lineage claims.                                                                                                                                                    |
| `apps/web/src/App.tsx`, `lib/tools.tsx`, `components/ToolBar.tsx`, `CommandPalette.tsx`                                            | Plane entry, source-picking orchestration, preselection, transaction lifecycle, permissions, availability, repair actions.                                                                                                                                                         |
| `apps/web/src/lib/modelingOperations.ts`, `featureValidation.ts`, `components/forms/ModelingOperationsForm.tsx`                    | Preserve datum IDs during Split/Mirror creation/editing, target/tool roles, exact preview/preflight, numeric defaults.                                                                                                                                                             |
| `apps/web/src/lib/sketch/planeBasis.ts`, sketch session/solver/snapping and `SketchWorkflow.tsx`                                   | Version-matched datum results at sketch history position, re-entry/camera, local edits, annotation projection, normal-move refusal.                                                                                                                                                |
| `apps/web/src/components/ModelViewer.tsx`, `components/viewer/planePickerRig.ts`, `packages/viewport/src`                          | Persistent planes/picking, distinct selection/filter/callout handling, hidden-plane behavior, temporary previews, fit/bounds exclusion.                                                                                                                                            |
| `apps/web/src/lib/featureHistory.ts`, `featureSuppression.ts`, `featureRepair.ts`, `components/FeatureHistoryPanel.tsx`            | Union rows, dependency inspection, reorder/rollback, typed warnings, edit routing, explicit source replacement.                                                                                                                                                                    |
| `apps/web/src/worker/geometryWorker.ts`, `hooks/useGeometryWorker.ts`, geometry/rebuild cache keys                                 | Datum serialization, revision/operation matching, cancellation, exact preflight, no frame-only publication after failure.                                                                                                                                                          |
| `packages/ai-contracts/src/index.ts`, command-system AI bridge, `apps/web/src/lib/aiPatchPreflight.ts`                             | Readable datum IDs/definitions/status; extend `add_mirror`'s plane schema; bounded `add_datum_plane`, `update_datum_plane`, `add_datum_sketch`, and `add_split` operations, runtime validation, typed aliases, summaries, exact preflight. AI Split authoring is currently absent. |
| `packages/persistence/src/index.ts`, `apps/web/src/lib/projectBackup.ts`, saved-state/branch/restore code                          | Preserve nodes, references, union order, old undo histories, schema through offline, backup, saved-state, restore/branch round trips.                                                                                                                                              |
| `packages/cloudflare-adapters/src/index.ts`                                                                                        | Graph validation at account/collaboration boundaries, order-aware history equality/conflicts, lease enforcement, newer-schema refusal.                                                                                                                                             |
| CSS class coverage, desktop bridge, UI/AI capability digests                                                                       | Style new classes, preserve input contracts, advertise only qualified commands. New AI operations stay disabled until schema/runtime/alias/preflight support is complete.                                                                                                          |

## Acceptance matrix

All entries below are required future implementation evidence, not tests run by
this documentation PR. Use synthetic fixtures; no private reference model or
recording is needed in the repository.
Place pure resolver cases beside `face-attachment.test.ts`, command/migration
and cache regressions in the root test project, UI cases in web Vitest, and
complete workflows in Playwright. Keep new parity cases under
`test/parity/**/*.spec.ts` so they run in the serial parity job.

| Scenario                                                                     | Required evidence                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offset canonical XY by `10`, `0`, `-4`                                       | Exact expected origins/normals; one stable named node; Sketch, Split, Mirror consume its ID.                                                                                                    |
| New and legacy XZ sources                                                    | Revision 2 faces Front; absent-marker legacy basis replays unchanged. Signed offsets and extrude direction do not silently flip.                                                                |
| Offset a qualified face by `-10`                                             | Origin/normal follows the exact carrier; signed value and drag preview agree after Done/reopen.                                                                                                 |
| Midplane between z=0 and z=20, both normal senses, oblique parallel carriers | Midpoint is z=10 or the analytic oblique midpoint; A's frame is retained.                                                                                                                       |
| Midplane roles/orientation                                                   | Selection order persists; tangential B movement does not slide the frame; normal flip changes orientation explicitly with stable output IDs.                                                    |
| Midplane bad sources                                                         | Duplicate/coincident, nonparallel, invalid-normal, hash-only, mesh, non-planar, unqualified inputs refuse by name; both sides of tolerance boundaries covered.                                  |
| Mixed source kinds and chains                                                | Face + datum, canonical + face, datum-on-datum resolve at the correct history entry; chain edits propagate transitively.                                                                        |
| Source consumed later                                                        | Define datum from a body, Split that body with it, then Mirror/sketch using the earlier datum. Success does not depend on the original body surviving final display.                            |
| Sketch and annotations                                                       | Local objects/constraints/driving/reference labels stay unchanged while the world frame moves; re-entry, snaps, camera, extrusion, sketch DXF agree. Normal translation refuses.                |
| Split geometry                                                               | A 10×10×20 box cut at z=8 has volumes 800 and 1200, sum 2000; side-to-ID mapping follows the normal. Edit/undo preserves both output IDs.                                                       |
| Mirror geometry                                                              | A known box reflects to analytic bounds about moved/oblique planes; volume and original remain, with qualified lineage and exact STEP replay.                                                   |
| Expressions and parameters                                                   | Raw expression survives reopen; parameter edits move all three consumers. Rename rewrites all readers; delete refuses even for suppressed datums.                                               |
| Cache invalidation                                                           | Literal offset, parameter, source, Midplane A/B, upstream body, suppression, reorder, normal edits cannot restore stale checkpoints. Cached/uncached/undo-restored results agree.               |
| Failure/recovery                                                             | Deleted/ambiguous/split/merged/non-planar/unsupported faces and transient missing imports produce named diagnostics; repair/resume clears them without fallback or permanent failed checkpoint. |
| Graph safety                                                                 | Self/cyclic/forward/cross-part refs, consumed-before-datum sources, illegal reorders, deleting referenced sources refuse atomically, including suppressed consumers.                            |
| Preflight lifecycle                                                          | Invalid edits, stale replies, cancellation, Esc change no document/solver/undo state. One successful drag is one undo step.                                                                     |
| Suppression/rollback/visibility                                              | Datum + feature suffix is one timeline; release rollback preserves manual suppression; hidden visibility alone changes no exact result.                                                         |
| Persistence compatibility                                                    | Pre-v18 canonical/frame/face and numeric Split/Mirror fixtures replay unchanged in meaning; annotation/import metadata survives; bad v18 orders/future schemas refuse.                          |
| Durable history/cloud                                                        | Old undo entries plus datum edits survive undo/redo, backup, reopen, saved-state restore/branch, account save, collaboration. Order-only divergence never disappears as “same”.                 |
| Browser workflow                                                             | Create Offset Plane, sketch/extrude, Split, Mirror, edit offset, undo/redo, reload; create/edit Midplane and repeat consumers. Assert persisted IDs and exact geometry, not screenshots alone.  |
| Accessibility/input                                                          | Keyboard source/repair selection, numeric entry, focus/announcements, hidden-plane selection, color-independent roles, stable camera during pick/drag.                                          |
| AI contracts                                                                 | New schemas agree with validators/alias maps/preflight; invented/stale face sources and forward datum aliases refuse; numeric mirror proposals remain valid.                                    |

## Bounded implementation sequence

1. **R01-A — schema, timeline, and commands.** Proposed v18, typed dependency
   graph, datum CRUD, durable history, suppression/rollback, legacy normalization
   and persistence validators together. No exposed Plane tool yet.
2. **R01-B — exact source and plane evaluation.** Qualified face sources,
   canonical basis revisions, parallel Midplane math, union replay, cache and
   worker results, failure recovery, OCCT parity.
3. **R01-C — Sketch, Split, and Mirror consumers.** Qualify all three, preserve
   legacy inputs and sketch-local data, integrate exact preview/export and the
   AI contract path. This is part of the first release, not a deferred generic
   “exact consumers” phase.
4. **R01-D — integrated interaction and acceptance.** Plane tool/card, Items,
   history, picking/dragging, repair, accessibility, complete browser round trips.
   Advertise the release only after A–D acceptance passes.

Implementation PRs run the repository's required lint, typecheck, root + web
tests, parity corpus, root build/bundle-size gate, and browser e2e checks. Keep
the existing `validate`, `e2e`, and Cloudflare verification merge gates; native
Apple Silicon dispatch remains separately requested. This documentation PR
needs document-format/link review, not a claim of runtime geometry verification.

## Remaining R01 and adjacent contracts

Later slices can extend `DatumPlaneDefinition` with angled/three-point and
curve/edge/point sources only after specifying identity, orientation,
degeneracy, history dependencies, and qualified lineage. Axes may derive from
supported edges/cylinders or plane intersections; points from qualified
vertices/centers; coordinate systems from an origin and two non-collinear
directions. Missing, ambiguous, or unsupported sources stay broken until
explicitly repaired. No ordinal/proximity rebinding is permitted.

S01/S02 annotation identity and S03 solver evidence remain local to the sketch;
S04 composite point/edge identity stays independent of frame placement. M08
datum sections later consume an exact resolved `ParametricPlane`, retaining
the distinction between display clipping and exportable exact section curves.
M11 owns keep-originals and multi-tool Split depth. AS01/AS02 and I03 retain
cross-part/assembly and whole-document unit-conversion decisions. None of these
remainders is marked delivered by this design or its initial plane release.
