# ADR-018: Stored extrude operation inference

## Status

Accepted.

## Decision

Add optional `operation` and `targetBodyId` fields to extrude feature data.
`operation` is `new-body`, `add`, or `cut`. Its absence preserves every legacy
document as `new-body`. A stored add or cut requires one existing target body;
a new-body extrusion has no target. The fields are additive, normalization
already preserves unknown additive feature fields, and no schema-version bump
or data migration is required.

Resolve the operation once, before commit, from exact geometry produced in the
browser worker. A new-body extrusion supplies the candidate volume and bounds.
Bounds only reject impossible positive-volume overlaps; every remaining target
is measured by an exact union. Shared volume is
`target + extrusion - union`. Classification uses the larger of a relative
`1e-6` volume tolerance and bounding-diagonal cubed times `1e-9`; it never uses
float equality.

- No positive shared volume, including face/edge/point tangency: `new-body`.
- Candidate wholly enclosed by exactly one larger target: `cut`.
- Partial positive-volume overlap with exactly one target: `add`.
- Coincident material, more than one overlapping target, or any refused exact
  measurement: `new-body`. This avoids silently choosing or consuming a body.

The live preview rebuilds the resolved operation and exposes it as read-only
feedback. Commit stores that exact resolution. Later sketch, parameter, or
target edits do not re-run inference. If a stored add/cut loses positive-volume
overlap, the exact rebuild emits a feature warning and omits the result instead
of changing the operation. Editing extrusion distance preserves the stored
operation and target.

## Consequences

- Creation may require several exact worker rebuilds when several live body
  bounds overlap the candidate. Requests remain coalesced, and only the newest
  distance/profile result can reach the viewport.
- Automatic inference consumes at most one body. Users can still model an
  intentional multi-body merge with the explicit Boolean tools.
- Stored add/cut results use hash-only boolean topology lineage until the
  kernel exposes a verified extrusion-boolean evolution relation.
- Older clients preserve the additive fields when their document handling
  spreads feature data, but render the extrusion as a new body because they do
  not understand its boolean meaning. Mixed-version collaboration therefore
  requires an ADR-018-capable client before relying on the projected result.
