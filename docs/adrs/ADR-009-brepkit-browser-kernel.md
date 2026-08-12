# ADR-009: BrepKit Is the Primary Browser Kernel

## Status

Accepted. Supersedes ADR-006 as the primary modeling and export path.

## Decision

Run `brepkit-wasm` in the existing browser geometry Web Worker for parametric feature rebuilds, B-rep validation, measurement, tessellation, and STEP/STL import and export. Consume the installable `crates/wasm/pkg` subpackage from the `esaueng/brepkit` fork's `main` branch rather than resolving the same-named package from the npm registry. Keep the canonical document and command history independent of kernel handles. Keep geometry out of the Cloudflare Worker.

Represent a document body inside the adapter as one or more BrepKit solid handles. This preserves disjoint linear/circular pattern instances without leaking BrepKit compound handles into operations that only accept solids. Collapse a multi-solid body with `fuseAll` only when a downstream boolean, finishing operation, or STEP export requires one solid.

## Rationale

[BrepKit](https://github.com/esaueng/brepkit) provides analytic and NURBS B-rep construction, booleans, finishing, tessellation, validation, and STEP/STL I/O through a substantially smaller browser WASM module than the previous OpenCascade dependency. The existing worker boundary means this migration does not change the document, command, viewport, persistence, collaboration, or AI contracts.

## Consequences

- The exact adapter dependency and runtime identity change from `occt-wasm` to the fork-built `brepkit-wasm`. Imported mesh bodies now build on BrepKit too, through its STL importer: the compatibility kernel has been deleted (see ADR-005).
- The git dependency targets `main` plus the WASM package subdirectory, while the lockfile identifies the exact resolved `main` commit and its recorded fork source commit. Updating the fork does not silently change existing OpenZCAD builds; publish the refreshed package on `main`, update the lockfile, and rerun the geometry gates.
- Viewport meshes and topology polylines remain disposable projections of exact worker-owned B-reps.
- BrepKit can return the unchanged input when a blend-on-blend fillet is unsupported. The adapter converts that no-op into an actionable feature warning and rejects clearly oversized selected-edge fillets.
- Difficult booleans may use BrepKit's mesh fallback and are not guaranteed watertight. NURBS blend STEP round-trips can show a small measurement shift even when the re-imported solid validates.
- The focused exact-kernel suite covers primitives, transforms, sweeps, booleans, finishing, patterns, STEP replay, re-import validation, and AI-generated model execution.

## Amendment (Z5, 2026-08-01) — the second kernel is gone from the app

ADR-009 made BrepKit primary; OpenCascade stayed reachable underneath it, and until Z3 a document carrying an `imported-step` feature rerouted the whole rebuild to it. Z3 removed that reroute and Z5 removed the code:

- `occt-step.ts`, `occt-modeling-operations.ts`, and `occt-lineage.ts` no longer exist in `packages/kernel-adapter`. `ExactKernelAdapter.kind` is the constant `'brepkit'`, and there is one implementation of it. Nothing in `apps/web` names a kernel.
- `occt-wasm` moved from a dependency of `packages/kernel-adapter` to a **root devDependency**. That is the whole of what "delete OpenCascade" means here: gone from anything shipped, still installed for tests.
- The adapter cluster moved verbatim to `test/parity/occt-reference/` and deliberately stopped implementing `ExactKernelAdapter`, so it cannot be mistaken for a kernel the app could be pointed at. Its one consumer is the parity corpus, which still measures every corpus file and import-modeling scenario through both implementations and records every divergence in `corpus-pins.ts`.

Why the reference was kept rather than deleted with the rest: the corpus is what made removing a second kernel safe, and the pins are the record of that comparison. Deleting the instrument in the same change that relies on it would have been a clause buried in a deletion. Retiring the comparison stays available as its own small, reversible decision — the baselines and closed-form reference bar hold up without it.

The cross-kernel legs of `exact-kernel-adapter.test.ts`, `kernel-seam.test.ts`, and `topology-lineage-spike.test.ts` went with the deletion. Each was replaced by the absolute claim it was standing in for — a closed-form volume, a pinned count, a named refusal — rather than dropped, because "two implementations agree" is not evidence when only one remains.
