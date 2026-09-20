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
additive schema revision (the current schema is v15):

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

## Acceptance matrix for the first slice

| Scenario | Expected evidence |
| --- | --- |
| Create `XY` datum at `offset = 10` | Node and named reference persist; resolved origin is `(0, 0, 10)` with the existing right-handed basis. |
| Edit literal offset `10 → -4` | One undoable transaction moves the attached sketch and exact downstream result; no local sketch coordinates change. |
| Edit offset expression `clearance + 2` | Authored expression remains after save/reopen; changing `clearance` moves the datum on replay. |
| Invalid, cyclic, or non-finite expression | Edit is refused before commit; prior exact geometry and history remain available; message names datum and expression. |
| Attach a sketch, then edit datum | Sketch frame resolves at its history position and downstream extrude follows the edit. |
| Directly move a datum-attached sketch along normal | Refused with the datum identity; no hidden canonical conversion. |
| Undo/redo and save/reopen | Same datum ID, expression, attachment, and exact result after every round trip. |
| Suppress or rollback the datum | Dependent sketch/features warn and fail closed; unsuppress/release rollback rebuilds them. |
| Delete with a dependent sketch | Delete is refused with named dependents and no document mutation. |
| Legacy v1–v15 document | Loads unchanged; canonical/frame/face `SketchPlaneRef` behavior and old command replay remain unchanged. |
| Topology-derived source (future guard) | No nearest or ordinal rebinding; deleted, ambiguous, and unsupported sources fail closed. |

## Implementation slices

1. **R01-A — additive schema and normalization.** Add datum node/reference
   types, schema validation, migration from every prior version, and an
   old-document replay fixture. No UI or kernel changes.
2. **R01-B — document commands.** Add create/edit/rename/delete commands,
   expression and unit validation, dependency indexing, undo/redo, suppression,
   and save/reopen coverage.
3. **R01-C — sketch plane resolution.** Add the datum `SketchPlaneRef` variant,
   exact worker and parity resolution at history position, and the explicit
   normal-translation refusal.
4. **R01-D — viewport and inspector.** Add datum visibility/selection, a
   normal-aligned offset manipulator, names and diagnostics. Keep previews
   distinguishable from exact committed geometry.
5. **R01-E — exact consumers.** Qualify mirror, revolve, patterns, extrude end
   conditions, and exact section curves one operation at a time. Each slice
   gets its own failure and lineage tests.
6. **R01-F — derived topology sources.** Only after ADR-013-qualified source
   witnesses exist, add edge/cylinder/vertex/center/intersection datums and
   test edit, deletion, suppression, rollback, and ambiguity behavior.

## Contracts with adjacent roadmap work

* **S01:** annotation placement remains presentation metadata keyed by
  `constraintId`; a datum edit changes the sketch frame, never a label's point
  identity or its stored screen coordinates.
* **S03:** moving a datum does not change constraint ownership or solver
  semantics. DOF/conflict results are recomputed for the same sketch entities;
  a failed datum resolution leaves the last solved sketch unavailable rather
  than presenting stale geometry as current.
* **S04:** datum references target a stable datum node ID. Rectangle/polygon
  point and edge identity remains the separate S04 contract; datum movement
  must not be used to hide decomposition or topology changes.
* **M08:** datum sections may use the exact datum frame after the datum and
  section query are qualified. Display caps remain labeled as display-only.
* **F01/AS01:** to-face, mating, and other topology-dependent consumers use
  typed references and explicit refusal categories; they do not infer a datum
  from a screen plane.

## References

* [R01 roadmap row](../../ROADMAP.md#r01)
* [Current sketch plane and face reference types](../../packages/shared/src/index.ts)
* [Canonical plane frame tests](../../test/geometry.test.ts)
* [Face attachment implementation contract](../../packages/kernel-adapter/src/face-attachment.ts)
* [Topology lineage ADR](../adrs/ADR-013-persistent-topology-lineage.md)
* [Face attachment ADR](../adrs/ADR-014-true-face-attachment.md)
* [Suppression and rollback ADR](../adrs/ADR-017-feature-suppression-and-rollback.md)
* [Product R-1 rationale](../cad-feature-roadmap.md)
