# ADR-014: Resolve face-attached sketches at their history position

> **Historical amendment (2026-08-15):** ADR-020 replaces the production
> BrepKit dependency with Remus. BrepKit references below describe the state
> when this decision was recorded.

> **Historical amendment (2026-08-25):** the in-plane axis is no longer derived
> from the world axis least aligned with the normal, and the persisted frame is
> no longer diagnostic only. Both are described under "Frame orientation is
> anchored to the attachment" below; the paragraphs in Decision record the
> original rule.

## Status

Accepted and implemented for schema-v5 face references on both exact adapters
(2026-07-31).

## Context

A sketch created on a model face historically stored the face hash, measured
area/center/normal, and a model-space frame. Reusing that frame forever makes
the sketch look attached while it is actually frozen in space. Rebinding by a
nearby plane, centroid, normal angle, face ordinal, or viewport ID would be
worse: a valid-looking rebuild could silently attach design intent to the wrong
face after an upstream edit.

OpenZCAD now has schema-v5 topology references with exact witnesses and a safe
subset of persistent lineage ([ADR-013](ADR-013-persistent-topology-lineage.md)).
Feature history is canonical, so the source face must be resolved at the point
where the sketch occurs—not from the final body after downstream operations.

## Decision

For `SketchPlaneRef.type === "face"` with a schema-v5 `faceReference`, both the
BrepKit and OCCT replay paths shall:

1. pause at the sketch's feature-history position;
2. find the then-current source body identified by the plane reference;
3. resolve the topology reference through the fail-closed lineage resolver;
4. require exactly one exact planar carrier with finite center and unit normal;
5. derive a deterministic orthonormal frame from the current face center and
   canonical normal; and
6. use that frame for sketch geometry and every dependent sweep.

The in-plane axis is derived from the world axis least aligned with the
canonical face normal, then crossed and normalized. It is not inherited from a
kernel parameterization or traversal order. Both adapters use the shared
resolver so the frame convention cannot drift by kernel.
*(Superseded 2026-08-25 — see "Frame orientation is anchored to the
attachment".)*

The persisted source area, center, normal, and frame are a migration snapshot
and diagnostic evidence only. They never rescue a current lineage reference.
*(The frame is no longer diagnostic only; the rest stands, and none of them
rescue a reference. See below.)*

### Frame orientation is anchored to the attachment (2026-08-25)

Deriving the in-plane axis from the normal alone is not implementable, which
the original rule did not account for: a sphere carries no continuous field of
tangent directions, so every normal-only rule has a discontinuity somewhere and
can only move it. The chosen rule had two, and ordinary parametric edits walked
into both.

- Picking the world axis least aligned with the normal flips which axis wins
  the moment the two smallest components tie. Measured: a 30-degree-tilted face
  nudged from 44.9 to 45.1 degrees about Z rotated its sketch 81.8 degrees, and
  the jump does not shrink with the step.
- `canonicalNormal` orients by the sign of the first non-zero component, so a
  face whose raw measured normal crosses that component's zero reverses, taking
  `yAxis` with it and mirroring the sketch. `plane.normal` comes straight from
  `measureFaceGeometry` and is not canonical, so this is reachable.

Neither raised a warning: the sketch and every feature built on it silently
moved.

The frame therefore needs an anchor, and the frame persisted when the user
chose the face is the only one available. Both degrees of freedom are seeded
from it — the resolved normal keeps the sense the stored `zAxis` had, and the
in-plane axis is the stored `xAxis` projected back onto the evolved plane. The
world-axis rule remains underneath for a seed that cannot span the new plane.

This narrows what "diagnostic only" meant rather than abandoning it. The
snapshot still never decides *which* face a reference resolves to — the
fail-closed lineage resolver alone does that, and every failure mode above
still fails. It now decides only how the frame is oriented within the plane
that resolver already chose.

Determinism is unaffected: the result is a pure function of the resolved
center, the resolved normal, and the persisted frame, all of which are in the
document. It cannot drift, because every rebuild seeds from the same stored
snapshot rather than from the previous rebuild's output.
If the face was deleted, resolves ambiguously, becomes non-planar, has an
unsupported witness, or is unavailable at the sketch's history position, the
rebuild fails with the sketch and source feature named.

Legacy face attachments without `faceReference` continue using their stored
frame and emit a warning. This preserves old documents without pretending that
the snapshot has acquired persistent attachment semantics.

Product creation is fail-closed at the same boundary. The UI only creates a
new face attachment when the current exact planar face carries a schema-v5
reference whose `currentHash` matches the picked face. Hash-only planar faces
remain available for their supported direct edits, but Sketch is disabled with
an explicit explanation. The UI does not synthesize a reference or silently
create another legacy snapshot.

An existing legacy attachment can be converted explicitly to a fixed plane.
That undoable edit copies the stored migration frame into a
`SketchPlaneRef.type === "frame"`, preserving the current geometry while
honestly dropping the unsupported face-association claim.

## Consequences

- Supported sketches follow valid upstream transforms and dimensional changes.
- The same exact reference selected by the UI and AI digest is authoritative;
  neither path can invent a replacement face.
- A deleted or unprovable source fails visibly instead of moving a sketch.
- Legacy documents remain replayable, but their warning identifies snapshot
  behavior and offers an explicit geometry-preserving conversion to a fixed
  plane.
- Full attachment coverage remains bounded by ADR-013 lineage coverage. A
  hash-only boolean, blend, pattern, direct edit, or STEP face does not become
  lineage-safe merely because it is planar.

## Verification

The shared resolver has unit coverage for stable movement and refusal of
deleted, ambiguous, non-planar, invalid, and unsupported references. Both exact
adapter suites exercise history-position resolution. Product and AI creation
copy the current exact face reference and deterministic attachment frame.
Product unit and interaction coverage also prove that hash-only planar faces
retain Offset Face while refusing Sketch, and that legacy-to-fixed conversion
removes the diagnostic without changing the derived body representation.
Rendered browser acceptance creates a current face attachment, suppresses its
source feature, verifies the named history-position warning, and resumes the
source to prove that the warning clears and the attachment rebuilds.
