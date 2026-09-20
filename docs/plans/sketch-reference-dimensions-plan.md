# S02 — Driven and reference sketch dimensions

**Status:** design only. This document defines the first implementation slices;
it adds no runtime schema, command, solver, or viewport behavior.

**Baseline:** OpenZCAD `main` at `efa2662910199e6d23d63f337e35d3d591614d21a`.
The current canonical document schema is v15. The implementation must recheck
the merged S01/S04/R01 base and join their single additive migration envelope;
S02 must not reserve a separate schema bump.

## Decision

Keep three meanings separate:

* A **driving dimension** is the existing `SketchConstraint` record. It owns a
  `constraintId`, stores a `ParamValue`, enters GCS, and may move sketch
  geometry when its value is edited.
* A **reference dimension** is a saved sketch annotation. It owns an
  `annotationId`, stores only target identity and presentation metadata, and
  derives a measured value from the current sketch geometry. It never enters
  GCS, never changes a `SketchObjectData` field, and never becomes a constraint
  through a click or a label drag.
* A **free inspection measurement** remains the existing project-adjacent
  `Measurement` record. It can measure bodies, faces, and edges and must not be
  folded into the sketch's canonical document. S02 reuses its provenance and
  stale-target vocabulary where useful, but does not turn a viewport pick into
  a sketch annotation implicitly.

The first reference-dimension slice supports distance, angle, and radius over
the existing primitive sketch identities. Rectangle and polygon point/edge
references wait for S04's tagged composite identity and inverse-fit contract.
Datum-plane and world-space targets wait for R01's resolved frame contract.

## Why the current contracts need this distinction

The current sketch dimension renderer consumes `SketchConstraint` records and
labels every row as “Driving”. `constraintId` is therefore an ownership key,
not a generic annotation key. S01's saved `dimensionLabelPositions` map is
presentation state keyed by that driving identity; dragging it does not alter
the constraint value. Reusing that path for a reference row without changing
the identity and command validation would make a read-only measurement look
editable or route a click into the solver.

The existing `Measurement` model already demonstrates the other half of the
contract: target identity is persisted while world-space annotation geometry is
rebuilt, quality and status are explicit, and unresolved targets remain visible
as repairable rows. It is intentionally stored beside the project document so
an inspection action does not invalidate exact geometry history. A sketch
reference dimension is different because it is authored document intent and
must follow the sketch through save/reopen and command replay.

## Proposed additive document shape

The implementation should add an optional field to `SketchNode` in the shared
S01/S02/S04/R01 v15-to-v16 envelope:

```ts
type SketchReferenceDimensionData =
  | { dimensionKind: 'distance'; a: SketchPointRef; b: SketchPointRef }
  | { dimensionKind: 'radius'; objectId: EntityId }
  | { dimensionKind: 'angle'; a: EntityId; b: EntityId };

interface SketchReferenceDimension {
  annotationId: string;
  data: SketchReferenceDimensionData;
}

interface SketchNode {
  // Existing fields remain unchanged.
  referenceDimensions?: SketchReferenceDimension[];
  // Existing S01 map remains the shared plane-local placement store.
  dimensionLabelPositions?: Record<string, SketchDimensionLabelPosition>;
}
```

The eventual identity can receive a dedicated brand, but its serialized form
must be a generated, stable ID rather than a coordinate hash. The ID is
created once, retained when the target's parameters move, and supplied again
on command replay. It must not be derived from target order or the current
numeric result.

`constraintId` remains reserved for `SketchConstraint`; `annotationId` is
reserved for `SketchReferenceDimension`. A label or list row must carry an
explicit tagged identity when the two appear together:

```ts
type SketchDimensionIdentity =
  | { kind: 'constraint'; constraintId: SketchConstraintId }
  | { kind: 'reference'; annotationId: string };
```

The current S01 map can store both IDs because it is already a string-keyed
presentation map. Its placement command should gain a reference-aware sibling
or a tagged identity input; the existing driving command and serialized
`sketch.constraint.label-position` replay contract remain valid for old saves.
No implementation may accept a bare string and infer whether it is a
constraint or annotation by searching both arrays.

Reference rows contain no authored numeric value and no `ParamValue` field.
The value, unit, geometry witness, quality, and status are derived projection
data. This prevents a stale saved number from being mistaken for current
geometry and makes a reference dimension incapable of constraining the model
by deserialization alone.

### Target identity and supported geometry

For the first slice, targets are validated against the owning sketch at command
time and at every rebuild:

| Dimension | Persisted target | First supported geometry | Measurement rule |
| --- | --- | --- | --- |
| Distance | two `SketchPointRef` values | line endpoints; circle/arc centers; arc start/end | Euclidean distance in sketch-local coordinates |
| Radius | one `EntityId` | circle or arc | positive resolved radius |
| Angle | two line `EntityId` values | line objects only | included angle in `[0°, 180°]`, using the existing directed line-endpoint convention |

The resolver checks that every object belongs to the sketch, that each point
role is legal for its object kind, that radius is finite and positive, and that
angle operands are distinct lines with finite non-zero direction. It refuses a
missing object, an illegal point role, a degenerate radius, or an invalid line
direction by status rather than choosing the nearest replacement. A pair of
distinct points that currently coincide may report a valid zero distance; the
same target identity twice is refused at creation because it is not a
meaningful reference.

S04's `CompositePointRef` and `CompositeEdgeRef` are not duplicated here. Once
S04's common `SketchPointRef`/curve-reference union lands, the S02 resolver
may consume it through the shared resolver. The S02 annotation record and
`annotationId` do not change when that happens. A polygon side-count change
that invalidates a composite target follows S04's atomic refusal and repair
contract.

### Presentation and units

Reference labels must carry an explicit **Reference** or **Measured** marker,
use the reference visual treatment, and expose an accessible name such as
“Reference distance, 12 mm”. They must not say “Driving”, offer an expression
editor, or invoke `editConstraint` on click. A reference label drag updates
only its plane-local placement offset. The measurement line and witness
geometry are derived from the current target positions.

The underlying sketch values remain in the document unit system. Display unit
selection converts a finite measured result for presentation only, just as the
existing measurement dock does. It never rewrites the target's `ParamValue` or
stores a converted number in the reference record. Angle display remains in
degrees. Whole-document unit conversion stays under I03 and is outside S02;
S02 must not promise physical conversion of arbitrary expression strings.

Expression behavior is therefore explicit rather than implicit:

* If an object's coordinate, radius, or a referenced sketch plane expression
  resolves, the reference value is recomputed from the resolved geometry while
  all authored expression strings remain byte-for-byte unchanged.
* If a target expression is unknown, cyclic, non-finite, or otherwise cannot be
  resolved, the annotation remains in the document with `unresolved` status
  and a named reason. The solver is not called and the document is not edited.
* A parameter edit that changes a valid target updates the measured projection
  in the same document revision, but does not change the annotation identity or
  add a constraint.

## Last-good state and failure semantics

The persisted annotation stores identity and placement only. The worker/session
may retain the last successfully resolved value and graphic while a newer
revision is being evaluated, but it must label that projection `stale` and
never present it as the proposed value. On a failed evaluation it transitions
to `unresolved` with a reason naming the annotation and target. On save/reopen,
the resolver starts from the authored targets: a valid target becomes
`current`; an invalid one becomes `unresolved` without inventing a saved
measurement. This follows the existing measurement record's honest stale-row
behavior while keeping the canonical document free of derived geometry.

An invalid reference dimension is local to its annotation. It does not make
the sketch solver conflict, does not alter S03's DOF/residual state, and does
not hide the last committed exact sketch. If the sketch plane itself is
unavailable because of an R01 datum failure, the local target identity may
remain valid but the world-space graphic is unavailable; the UI must say
“reference frame unavailable” rather than reinterpret local coordinates in a
canonical plane.

Deleting or changing a targeted sketch object must not silently strand a saved
annotation. The first command slice should refuse object deletion when live
reference dimensions depend on it and name the annotations, requiring an
explicit delete-reference operation first. A later delete-with-dependents
transaction may remove both records atomically, but it must never retarget by
proximity or silently turn a reference into a driving constraint. Suppressed
annotations remain in the dependency walk and report unresolved targets; they
are not omitted from validation merely because their row is hidden.

## Exact history, undo, and persistence

Reference dimensions have no geometry effect, so their records and placement
must be excluded from the exact geometry input digest wherever the adapter
constructs a sketch history prefix. Adding, deleting, or moving a reference
dimension may create a document undo entry, but it must not change the exact
body, solver inputs, or cache result. The cache test should prove equal exact
output before and after an annotation-only edit; it may report a cache miss if
the current coarse digest cannot yet separate presentation fields, but the
implementation slice should narrow that digest rather than claim the
annotation constrains geometry.

Commands are ordinary replayable document edits:

* `reference-dimension.add` records the stable `annotationId` and target refs.
* `reference-dimension.delete` removes exactly that identity.
* `reference-dimension.label-position` writes the shared plane-local offset.
* A future `reference-dimension.rename` may change only presentation metadata;
  it is not part of the first slice unless the UI needs a user label.

Each command validates against the current sketch before cloning or mutating.
Add, delete, and label movement are one undoable action. Undo/redo restores the
same identity, target refs, placement, and command-log payload; redo does not
allocate a new ID. Save/reopen normalizes an absent field to no annotations,
preserves existing v15 sketches byte-for-byte in meaning, and rebuilds every
derived result from current geometry.

Because the records live inside `SketchNode`, existing `nodes` history snapshots
capture them. The shared migration envelope must nevertheless update structural
validators, backup/cloud round-trip fixtures, and any sketch-node size limits.
No new top-level order is needed for S02: reference dimensions are annotations
owned by a sketch and are evaluated at that sketch's existing history position.

## Shared schema and adjacent work

S02 coordinates with the active designs as follows:

* **S01 / PR #381, head `6bc19e48`:** keep `dimensionLabelPositions` as
  plane-local offsets. Driving rows continue to use `constraintId`; reference
  rows use `annotationId` through an explicit tagged placement input. A datum
  move changes the world projection of both rows while preserving local offset
  and driving/reference identity.
* **S03 / PR #383, head `24ed4ccd`:** reference rows are not solver rows. They
  do not participate in residual ranking, conflict refusal, DOF, or entity
  highlighting. A failed reference measurement leaves S03's solver result
  unchanged.
* **S04 / PR #379, head `06fff2d6` (latest reviewed design head):** use the
  shared point/curve reference union and stable composite topology tokens once
  available. Do not add a second composite-ref encoding in S02 or change
  `constraintId` semantics.
* **R01 / PR #380, head `83e40c9`:** a datum-backed sketch resolves its local
  reference dimensions in the datum's exact plane frame. Datum invalidity makes
  the world annotation unavailable while preserving the local target record;
  no display frame or last-good frame is used as an exact replacement.

All four designs must join one additive v15-to-v16 normalization envelope
selected from the merged base. The envelope validates optional S01 label
positions, S02 reference dimensions, S04 tagged refs, and R01 datum/history
fields together, with one newer-schema refusal and shared legacy fixtures.
S02 itself does not edit `PROJECT_DOCUMENT_SCHEMA_VERSION`.

## Bounded implementation slices

1. **S02-A — shared types and pure resolver.** Add the optional sketch field,
   validation helpers, stable ID allocation, and a pure resolver for primitive
   distance/angle/radius. Unit tests cover legal targets, zero/degenerate
   cases, expression resolution, units, finite bounds, and named failures.
2. **S02-B — commands and persistence.** Add add/delete/placement commands,
   dependency checks, undo/redo, command replay, normalizer, and backup/cloud
   fixtures within the shared v16 envelope. Test save/reopen and identity
   preservation after parameter edits.
3. **S02-C — distinct rendering and accessibility.** Reuse the existing
   dimension graphic machinery, but render reference styling and “Reference”
   labels. Test that click/keyboard/drag paths never call the driving editor or
   mutate constraints; test stale and unresolved states.
4. **S02-D — composite and datum consumers.** After S04 and R01 qualify their
   contracts, add composite point/edge targets and datum-backed world frames.
   These slices must preserve the same `annotationId`, exact failure behavior,
   and cache boundary.

No S02 slice adds AI proposal editing, drawing dimensions, whole-document unit
conversion, or a new constraint kind. D02 may later reuse the resolver, but its
associative drawing annotation model remains a separate design.

## Acceptance matrix for the first implementation

| Scenario | Expected evidence |
| --- | --- |
| Add a distance, angle, or radius reference | Stable `annotationId` and target identity are saved; no `SketchConstraint` is added; GCS input and DOF are unchanged. |
| Move its label | Only the plane-local placement offset changes; measured value, target refs, and constraints do not. |
| Edit driving geometry or a parameter | The reference value follows current resolved geometry; authored expressions and `annotationId` remain unchanged. |
| Display units change | The rendered value converts for display only; document units, target expressions, and stored refs are unchanged. |
| Unknown/cyclic/non-finite target expression | Row becomes `unresolved` with a named reason; no solver call, geometry mutation, or new exact projection occurs. |
| Worker rebuild in progress | Last-good result may be shown as `stale`; it is marked as such and never treated as the proposed current value. |
| Delete a targeted object | Delete refuses atomically and names the reference annotations, or an explicit future delete-with-dependents command removes both; no nearest retargeting. |
| Undo/redo add/delete/placement | Same annotation ID, target refs, local placement, and command replay result return; redo does not allocate a new ID. |
| Save/reopen valid document | Annotation identity and target refs round-trip; derived value recomputes as `current` from geometry. |
| Save/reopen invalid target | Annotation remains repairable and shows `unresolved`; no stale numeric value is presented as current. |
| S01 label and S02 row share a sketch | Driving placement remains keyed by `constraintId`, reference placement by `annotationId`, and both move in world space when the plane datum moves. |
| S04 composite target | Not accepted by the primitive slice; it becomes valid only through S04's shared tagged identity contract. |
| Exact-history cache | Annotation-only edits do not change exact geometry or solver semantics; datum changes follow R01's separate transitive digest contract. |

## References

* [S02 roadmap row](../../ROADMAP.md#s02)
* [Current sketch constraints and IDs](../../packages/shared/src/index.ts)
* [Current annotation renderer](../../apps/web/src/lib/sketch/dimensionAnnotations.ts)
* [Current free-measurement record](../../apps/web/src/lib/measurementRecord.ts)
* [S01 label placement PR](https://github.com/esaueng/OpenZCAD/pull/381)
* [S03 constraint feedback PR](https://github.com/esaueng/OpenZCAD/pull/383)
* [S04 composite identity PR](https://github.com/esaueng/OpenZCAD/pull/379)
* [R01 datum geometry PR](https://github.com/esaueng/OpenZCAD/pull/380)
