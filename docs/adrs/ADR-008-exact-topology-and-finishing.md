# ADR-008: Deterministic Exact Topology References

## Status

Accepted. Topology references are amended by ADR-011: both kernels now
persist geometric fingerprints instead of sub-shape ordinals.

## Decision

Expose face and edge selections as one-based exact-kernel sub-shape ordinals generated during each exact rebuild. The viewport receives those IDs with the disposable mesh/wire projection. When a finishing command is created, it captures the selected edge ordinals in the canonical document; the exact adapter resolves them against the rebuilt target shape before applying fillet or chamfer.

Store editable STEP source text in the import feature command, with an artifact reference for archival. This makes STEP replay deterministic and offline while keeping all geometry work inside the browser worker. Patterns likewise remain ordinary replayable document features and produce exact multi-solid bodies.

## Consequences

- Topology IDs survive command replay and fresh kernel handles for unchanged upstream geometry; transient handle values do not.
- Upstream changes can reorder sub-shapes. A stale finishing reference fails visibly instead of silently selecting a different edge. Persistent geometric naming is a future milestone.
- Embedded STEP source increases document size, so import and collaboration limits are explicit.
