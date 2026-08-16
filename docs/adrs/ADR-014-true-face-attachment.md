# ADR-014: Resolve face-attached sketches at their history position

> **Historical amendment (2026-08-15):** ADR-020 replaces the production
> BrepKit dependency with Remus. BrepKit references below describe the state
> when this decision was recorded.

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

The persisted source area, center, normal, and frame are a migration snapshot
and diagnostic evidence only. They never rescue a current lineage reference.
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
