# ADR-009: BrepKit Is the Primary Browser Kernel

## Status

Accepted. Supersedes ADR-006 as the primary modeling and export path.

## Decision

Run `brepkit-wasm` in the existing browser geometry Web Worker for parametric feature rebuilds, B-rep validation, measurement, tessellation, and STEP/STL import and export. Keep the canonical document and command history independent of kernel handles. Keep geometry out of the Cloudflare Worker.

Represent a document body inside the adapter as one or more BrepKit solid handles. This preserves disjoint linear/circular pattern instances without leaking BrepKit compound handles into operations that only accept solids. Collapse a multi-solid body with `fuseAll` only when a downstream boolean, finishing operation, or STEP export requires one solid.

## Rationale

[BrepKit](https://github.com/esaueng/brepkit) provides analytic and NURBS B-rep construction, booleans, finishing, tessellation, validation, and STEP/STL I/O through a substantially smaller browser WASM module than the previous OpenCascade dependency. The existing worker boundary means this migration does not change the document, command, viewport, persistence, collaboration, or AI contracts.

## Consequences

- The exact adapter dependency and runtime identity change from `occt-wasm` to `brepkit-wasm`; the compatibility kernel remains available for imported mesh bodies.
- Viewport meshes and topology polylines remain disposable projections of exact worker-owned B-reps.
- BrepKit can return the unchanged input when a blend-on-blend fillet is unsupported. The adapter converts that no-op into an actionable feature warning and rejects clearly oversized selected-edge fillets.
- Difficult booleans may use BrepKit's mesh fallback and are not guaranteed watertight. NURBS blend STEP round-trips can show a small measurement shift even when the re-imported solid validates.
- The focused exact-kernel suite covers primitives, transforms, sweeps, booleans, finishing, patterns, STEP replay, re-import validation, and AI-generated model execution.
