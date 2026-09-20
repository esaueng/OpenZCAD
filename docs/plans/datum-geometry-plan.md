# R01 — Datum geometry and editable reference planes

**Status:** design only. This plan defines the first bounded implementation
slice; it does not add runtime schema, commands, or viewport behavior.

## Decision

Start R01 with one editable reference node: a **canonical offset datum plane**.
It is a named document node whose definition is a principal plane (`XY`, `XZ`,
or `YZ`) plus a signed, expression-capable offset along that plane's normal.
The node owns the datum's identity; a consumer stores a reference to that node,
not a copied frame. Moving the offset therefore moves every supported consumer
through normal history replay.

The first slice deliberately excludes angled, mid-plane, three-point, and
topology-derived planes, axes, points, and coordinate systems. Their source
contracts are described below so that later slices do not invent incompatible
references. A canonical datum is useful without topology lineage and can land
independently of K05.

## Why this fits the current model

The current document already has immutable `ProjectDocument` values, ordered
nodes and features, replayable commands, parameter expressions, and three
canonical sketch planes with a parametric normal offset. `SketchPlaneRef` also
distinguishes canonical, stored-frame, and fail-closed face references. Those
contracts are the right foundation: a datum plane should promote a reusable
canonical definition to a named node rather than create another kind of
viewport-only frame.

The exact face attachment contract in [ADR-014](../adrs/ADR-014-true-face-attachment.md)
resolves at the sketch's history position. Topology identity and deletion
behavior follow [ADR-013](../adrs/ADR-013-persistent-topology-lineage.md): a
reference is never rebound by proximity, traversal order, or a replacement
face. The existing suppression and rollback semantics in
[ADR-017](../adrs/ADR-017-feature-suppression-and-rollback.md) apply to datum
nodes and their dependents as document state.

## Proposed additive document contract

The implementation should add these concepts to the shared schema in one
additive migration envelope. At the PR base the shared schema constant is v15;
the implementation must re-check the actual merged base after S01/S04 land and
must not reserve or bump a version independently.

```ts
type DatumPlaneDefinition = {
  kind: 'canonical-offset';
  plane: PlaneId;       // XY, XZ, or YZ
  offset: ParamValue;   // signed document-unit distance along plane normal
};

type DatumPlaneNode = BaseNode & {
  kind: 'datum-plane';
  datumPlaneId: EntityId;
  definition: DatumPlaneDefinition;
};

type DatumPlaneRef = {
  type: 'datum';
  datumPlaneId: EntityId;
};

type HistoryEntryRef =
  | { kind: 'feature'; featureId: FeatureId }
  | { kind: 'datum-plane'; datumPlaneId: EntityId };

interface ProjectDocument {
  historyOrder?: HistoryEntryRef[]; // required after normalization
}
```

The exact brand names can follow the repository's existing `PlaneId`, `EntityId`
and node conventions. The important invariants are:

* `datumPlaneId` is stable across edits and is scoped to the document. The
  node's name is presentation metadata, never an identity key.
* The offset is retained as the authored `ParamValue`; replay evaluates it in
  the document parameter scope and rejects non-finite, missing, cyclic, or
  otherwise invalid expressions before changing the document.
* The resolved frame is derived state. It is not serialized as the authority,
  and it is not used as a fallback when a datum reference cannot resolve.
* The node appears in document/history order before a consumer. A reference to
  a later datum is invalid rather than a request to look ahead in the final
  viewport.
* Datum nodes participate in the same explicit replay timeline as features.
  The additive `historyOrder` is the authoritative ordered union; legacy
  `featureOrder` remains readable and is normalized into it for old documents.
  A datum is not an un-ordered `BaseNode` that happens to be found by a map
  walk.
* The canonical basis uses the existing right-handed `PLANE_BASES` contract.
  Positive offset has the same signed-normal meaning as a canonical sketch
  offset; units are document units and display conversion remains a UI concern.

The future reference union should be additive:

```ts
type PlaneReference =
  | { type: 'canonical'; plane: PlaneId; offset: ParamValue }
  | { type: 'datum'; datumPlaneId: EntityId }
  | { type: 'frame'; frame: SketchPlaneFrame };
```

Existing canonical, frame, and face references remain readable. Existing face
references retain their lineage authority and warning behavior; they are not
migrated automatically to datum nodes.

### One migration envelope with S01 and S04

R01 must share one additive schema envelope with the S01 label-placement fields
and S04 composite point/edge references. The envelope has optional, independently
validated fields, one normalization path, and one newer-schema refusal; it must
not become three competing v15-to-v16 migrations. If the merged base has moved
past v15, the next unused schema version is selected from that base and all
three designs update together. Existing documents keep their node IDs,
`featureOrder`, command log, primitive constraint operands, and canonical/frame/
face plane refs byte-compatible in meaning.

`historyOrder` is a persisted document field, so the implementation must also
update the durable history field list and splice allowlist in
[`document-history.ts`](../../packages/shared/src/document-history.ts), document
normalization, project-backup/cloud validators, and command replay. In
particular, the shared node/order validator used by
[`cloudflare-adapters`](../../packages/cloudflare-adapters/src/index.ts) must
accept and validate datum entries. Backup, cloud round-trip, and undo snapshots
must preserve create/delete/reorder of a datum; a history snapshot that drops
the new order is data loss.

Whole-document conversion is outside this design. R01 does not convert every
canonical sketch, frame, or coordinate into a datum, and it does not rewrite
legacy history on load. Per-consumer adoption is explicit and undoable; any
whole-document conversion remains the I03 decision and scope.

## Replay timeline, suppression, and exact-history cache

The first datum consumer exposes a current feature-history assumption that must
be closed before implementation. The exact adapter currently replays
`listFeaturesInOrder`, while the history-prefix cache digests a feature and its
referenced sketch. A datum definition lives in neither of those feature payloads
nor the sketch's `datumPlaneId`, so a literal offset edit could incorrectly
restore a post-datum checkpoint.

The R01 implementation therefore uses `historyOrder` for replay and cache
boundaries:

* The datum entry is replayed at its timeline position, before every consumer.
  A consumer before the datum is an invalid order and is refused before exact
  work starts.
* Each datum entry receives a stable digest containing its complete authored
  definition, name/identity-bearing metadata used by replay, suppression and
  rollback state, and the resolved parameter values its offset expression reads.
  The first consumer's digest includes the transitive datum definition and its
  scope, not just `{ type: 'datum', datumPlaneId }`.
* A literal edit from `10` to `12` must invalidate the datum checkpoint and all
  downstream prefixes even when IDs, feature order, or the sketch's local
  coordinates are unchanged. Undoing back to the old canonical content may
  reuse the old checkpoint because its digest is equal again.
* `historyScopeDigest` continues to carry units and parameter errors, but it is
  not a substitute for the datum definition. The datum digest must be tested
  against both literal and expression-backed edits and against a parameter edit
  that changes a datum's resolved offset.
* A datum's cached state includes its resolved frame and dependent exact
  projection only after successful evaluation. An invalid edit cannot publish
  a new checkpoint or overwrite the last-good exact projection.

Suppression and rollback are timeline state, not feature-only UI flags. A datum
entry carries the same effective suppression decision as a feature entry, and
the rollback command writes every affected history entry (datum and feature) in
one transaction. A suppressed datum remains in `historyOrder` and remains a
dependency source for diagnostics; its dependents are not silently reattached
to a prior frame. Resuming it removes only the timeline suppression that the
same command owns, preserving an intentional individual suppression.

The required regression cases are: create a datum before a sketch, build a
checkpoint, edit a literal offset and prove the checkpoint is not restored;
suppress/unsuppress the datum with a downstream feature; roll back across the
datum and restore the suffix; and undo/redo each transition with identical
history order and exact warnings.

## First consumer: sketches

`SketchPlaneRef` gains a datum variant carrying `datumPlaneId`. At the sketch's
history position, the exact rebuild resolves the datum node, evaluates its
offset, and derives the same orthonormal frame used by a canonical sketch. The
sketch's local coordinates and constraints stay unchanged. A datum edit moves
the sketch's plane and lets downstream features replay against the moved
sketch.

A datum-attached sketch is fixed to its datum along the normal. A direct sketch
translation with non-zero normal distance must refuse with a named diagnostic,
just as a face-attached sketch refuses normal movement today. In-plane sketch
translation remains a sketch edit and must not rewrite the datum definition.

The first consumer slice should cover sketch creation/re-entry and exact
rebuild. Extrude, revolve, mirror, patterns, and section operations consume the
reference only in later slices after each operation can prove its own exact
plane contract. A display clipping plane is not an exact section curve and
must retain the distinction recorded by M08.

## Future source contracts

These are design boundaries, not first-slice implementation requirements:

| Datum kind | Source identity | Resolution rule | First failure |
| --- | --- | --- | --- |
| Angled plane | canonical plane + angle, or a datum plane + angle | Evaluate parameters and normalize a non-zero normal | invalid expression or zero/parallel definition |
| Mid-plane | two plane references | Resolve both exact planes and construct the signed bisector | missing, parallel, or ambiguous inputs |
| Three-point plane | three point references | Resolve three distinct non-collinear points | deleted/ambiguous point or collinearity |
| Datum axis | canonical direction/origin; later edge, cylinder, or intersection source | Topology sources require a typed exact witness and lineage | deleted/ambiguous/unsupported source |
| Datum point | canonical coordinates; later vertex, center, or intersection source | Topology sources use the same lineage reference discipline | deleted/ambiguous/unsupported source |
| Coordinate system | origin point plus two non-collinear directions/axis references | Normalize a right-handed frame | invalid frame or unresolved source |

Topology-derived datums must store the producing feature, semantic lineage name,
current hash, witness version, and exact witness where the existing topology
contract supports it. They must not store only a face/edge ordinal or a viewport
ID. Unsupported free-form and incomplete evolution remain unavailable rather
than approximate. A source deletion, suppression, ambiguous evolution, or
unverified transition invalidates the datum and every dependent operation until
the user repairs the reference.

## Edit, suppression, delete, and rollback behavior

* **Offset edit:** one undoable transaction updates the datum definition. The
  next rebuild resolves the new expression and replays consumers. A failed
  evaluation leaves the prior exact document and derived projection intact,
  with a diagnostic naming the datum and parameter.
* **Expression or unit change:** retain the authored expression. Re-evaluate in
  the document's unit scope after a parameter or unit edit; do not bake a
  display-unit number into the datum. A conversion must preserve the physical
  distance and be covered by round-trip tests.
* **Undo/redo:** creation, rename, offset edit, and delete are replayable
  document commands. Undo restores the previous node/reference graph; redo
  restores the same datum identity and expression.
* **Save/reopen:** the node, definition, references, and command history are
  persisted. On reopen, rebuild from the definition; never persist a resolved
  mesh or frame as the authority.
* **Suppression:** suppressing a datum skips its derived frame. Dependent
  sketches and features report a typed, named unresolved-datum warning and do
  not silently use the last frame. Rollback suppression follows the existing
  feature-suffix semantics and is reversible as one transaction.
* **Delete:** deletion is refused while live dependents exist, naming the
  dependent features. An explicitly designed future “delete with dependents”
  flow may detach or replace references in one transaction; it must not leave
  dangling IDs or silently convert them to canonical planes. A datum with no
  dependents can be deleted and recovered by undo.

## Dependency and parameter safety

The datum reference graph is a document dependency, not a render relationship.
The implementation needs a typed walker that finds datum references in sketches,
feature payloads, section/mirror inputs, future axis/point definitions, and
nested arrays. It must index dependents even when their node is individually
suppressed or lies under the rollback marker. Deletion validates this graph
before cloning or removing nodes, names the first few dependent nodes, and
leaves the document byte-for-byte unchanged on refusal. The same graph powers
reorder validation, stale-datum diagnostics, and the inspector's dependent
list; `featureHistory`'s current feature-only walk is not sufficient.

The offset is also a parameter reader. Parameter operations must include
`datum-plane.definition.offset` in the same expression traversal as feature
data and sketch plane refs:

* Rename rewrites a datum offset expression atomically with every other live
  reader and preserves the raw expression string when no identifier changes.
* Delete refuses when a datum offset still reads the parameter, including when
  the datum or its consumers are suppressed. It must name the datum and its
  expression rather than leaving an unresolved offset.
* Set/edit preflight evaluates the proposed offset and all affected consumers
  before committing. Unknown identifiers, cycles, non-finite results, and
  invalid units reject the whole transaction; storing a broken expression and
  waiting for a later rebuild is not valid for a datum that controls the
  history frame.
* A failed preflight leaves the authored document, solver state, and last-good
  exact projection untouched. A successful parameter rename/delete or datum
  edit is one versioned transaction and invalidates the affected history-cache
  prefix as described above.

The implementation must not rely on the current generic parameter walker to
discover the new field accidentally. Add dedicated tests for rename, delete,
cyclic/unknown offset, suppressed consumers, and atomic invalid-offset edits.

## Exact projection versus sketch solver state

There are two separate results when a datum edit is invalid:

1. The canonical document remains the last committed authored state. Its last
   successful exact rebuild may remain visible as a clearly retained
   **last-good exact projection**, with a datum diagnostic attached; it is not
   relabeled as the proposed invalid position.
2. The sketch solver may retain its last solved local coordinates for the same
   sketch, but it has no valid world frame while the datum cannot resolve. The
   UI must mark the sketch frame unavailable and must not present those local
   coordinates as newly solved world geometry or feed them to downstream exact
   features.

When the datum becomes valid again, the solver reuses the authored local
coordinates/constraints in the newly resolved frame and exact replay publishes
the new projection. A stale frame, stale exact body, and failed solver result
are different states with different diagnostics; none may silently substitute
for another. S03's DOF/conflict result remains attached to the same sketch
entities and is not erased by a frame failure.

## Acceptance matrix for the first slice

| Scenario | Expected evidence |
| --- | --- |
| Create `XY` datum at `offset = 10` | Node and named reference persist; resolved origin is `(0, 0, 10)` with the existing right-handed basis. |
| Edit literal offset `10 → -4` | One undoable transaction moves the attached sketch and exact downstream result; no local sketch coordinates change. |
| Edit offset expression `clearance + 2` | Authored expression remains after save/reopen; changing `clearance` moves the datum on replay. |
| Invalid, cyclic, or non-finite expression | Edit is refused before commit; prior exact geometry and history remain available; message names datum and expression. |
| Exact-history checkpoint after literal edit | A built `offset = 10` prefix is not restored for `offset = 12`; the datum and every downstream digest change. Undo back to `10` may restore the matching checkpoint. |
| Attach a sketch, then edit datum | Sketch frame resolves at its history position and downstream extrude follows the edit. |
| Directly move a datum-attached sketch along normal | Refused with the datum identity; no hidden canonical conversion. |
| Undo/redo and save/reopen | Same datum ID, expression, attachment, and exact result after every round trip. |
| Suppress or rollback the datum | Dependent sketch/features warn and fail closed; unsuppress/release rollback rebuilds them. |
| Delete with a dependent sketch | Delete is refused with named dependents and no document mutation. |
| Reorder/delete with suppressed consumers | Dependency validation still sees suppressed and rollback-suppressed consumers; illegal reorder/delete refuses atomically. |
| Rename/delete a referenced parameter | Datum offset expressions are rewritten or deletion is refused in the same traversal as feature/sketch expressions, including suppressed nodes. |
| Invalid datum offset preflight | No authored document, solver state, exact projection, or cache checkpoint changes; diagnostics distinguish invalid frame from retained last-good exact projection. |
| S01 label after datum move | Label placement stored in plane-local coordinates keyed by `constraintId`; the world label moves with the datum while local placement and driving value remain unchanged. |
| Legacy schema document | Loads unchanged; canonical/frame/face `SketchPlaneRef` behavior and old command replay remain unchanged. The shared migration envelope preserves S01/S04 optional fields and datum order without whole-document conversion. |
| Backup/cloud/undo history round trip | Datum create/delete/reorder, suppression, and references survive history snapshots, project backup, cloud validation, save/reopen, undo, and redo. |
| Topology-derived source (future guard) | No nearest or ordinal rebinding; deleted, ambiguous, and unsupported sources fail closed. |
| Future exact datum section (M08) | Section resolves an exact `ParametricPlane` from the datum (not a display frame); offset edits change exact section curves/area and DXF coordinates, while posed-preview export refuses when the body is not in document pose. |

## Implementation slices

1. **R01-A — shared migration envelope and timeline.** Add datum node/reference
   types, the unified `historyOrder`, schema validation, and normalization from
   every prior version. Update durable history fields/splicing, backup/cloud
   validators, and replay fixtures together with the S01/S04 envelope. No UI or
   kernel changes.
2. **R01-B — document commands and dependencies.** Add create/edit/rename/delete
   commands, atomic expression/unit preflight, a datum-aware dependency index,
   undo/redo, suppression/rollback timeline commands, and save/reopen coverage.
3. **R01-C — cache and sketch plane resolution.** Add the datum
   `SketchPlaneRef` variant, exact worker/parity resolution at history position,
   the explicit normal-translation refusal, and transitive datum digests in
   exact-history checkpoints. Test literal, expression, parameter, suppression,
   and invalid-offset cache invalidation.
4. **R01-D — viewport and inspector.** Add datum visibility/selection, a
   normal-aligned offset manipulator, plane-local S01 label projection, names,
   last-good/invalid-frame diagnostics, and retained-solver-state handling.
   Keep previews distinguishable from exact committed geometry.
5. **R01-E — exact consumers.** Qualify mirror, revolve, patterns, extrude end
   conditions, and exact section curves one operation at a time. Each slice
   gets its own failure and lineage tests; M08 uses an exact resolved
   `ParametricPlane` for section/DXF and retains posed-preview export refusal.
6. **R01-F — derived topology sources.** Only after ADR-013-qualified source
   witnesses exist, add edge/cylinder/vertex/center/intersection datums and
   test edit, deletion, suppression, rollback, and ambiguity behavior.

## Contracts with adjacent roadmap work

* **S01:** annotation placement remains presentation metadata keyed by
  `constraintId`. Store its authored position in the sketch plane's local
  coordinates (with the same local anchor semantics as the dimension), not as
  a world coordinate. A datum edit changes the resolved world frame and moves
  the label with it; it never changes the label's point identity, local offset,
  or driving value. The shared migration envelope carries S01's optional label
  fields beside the datum fields.
* **S03:** moving a datum does not change constraint ownership or solver
  semantics. DOF/conflict results are recomputed for the same sketch entities.
  If the datum is invalid, the last solved local sketch state may be retained
  for repair, but its world frame is unavailable and its last-good exact
  projection is labeled as retained; neither state is presented as a new solve.
* **S04:** datum references target a stable datum node ID. Rectangle/polygon
  point and edge identity remains the separate S04 contract; datum movement
  must not be used to hide decomposition or topology changes. Datum fields and
  S04 tagged refs share one additive migration envelope and one schema refusal.
* **M08:** datum sections may use the exact resolved `ParametricPlane` after the
  datum and section query are qualified. Offset edits must rebuild exact section
  curves and update DXF coordinates; a display `SketchPlaneFrame` is never an
  export authority. Display caps remain labeled as display-only, and posed
  preview export retains its explicit refusal when document pose is not exact.
* **F01/AS01:** to-face, mating, and other topology-dependent consumers use
  typed references and explicit refusal categories; they do not infer a datum
  from a screen plane.

## Review dispositions

The independent design review is resolved by the contracts above:

* cache invalidation now includes the transitive datum definition and has a
  literal-edit checkpoint regression;
* replay, suppression, and rollback use an explicit unified timeline rather
  than assuming every participant is a `FeatureNode`;
* dependency and parameter traversals include suppressed consumers and datum
  offsets, with atomic invalid-edit/delete behavior;
* whole-document conversion is explicitly deferred to I03;
* the schema version is selected from the actual merged S01/S04 base, with one
  migration envelope and persistence/backup/cloud validator work;
* S01 labels remain plane-local while datum edits move their world projection;
* invalid frames, retained solver coordinates, and last-good exact projections
  remain distinct states; and
* M08's future exact section path uses `ParametricPlane`, not display frames.

## References

* [R01 roadmap row](../../ROADMAP.md#r01)
* [Current sketch plane and face reference types](../../packages/shared/src/index.ts)
* [Canonical plane frame tests](../../test/geometry.test.ts)
* [Face attachment implementation contract](../../packages/kernel-adapter/src/face-attachment.ts)
* [Exact-history checkpoint cache](../../packages/kernel-adapter/src/exact-history-cache.ts)
* [Exact feature replay loop](../../packages/kernel-adapter/src/exact.ts)
* [Durable document-history fields](../../packages/shared/src/document-history.ts)
* [Parameter reference traversal](../../packages/document-core/src/index.ts)
* [Cloud document validation boundary](../../packages/cloudflare-adapters/src/index.ts)
* [Topology lineage ADR](../adrs/ADR-013-persistent-topology-lineage.md)
* [Face attachment ADR](../adrs/ADR-014-true-face-attachment.md)
* [Suppression and rollback ADR](../adrs/ADR-017-feature-suppression-and-rollback.md)
* [Product R-1 rationale](../cad-feature-roadmap.md)
