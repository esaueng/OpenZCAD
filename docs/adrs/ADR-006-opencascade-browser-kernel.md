# ADR-006: OpenCascade Is the Primary Browser Kernel

## Status

Accepted. Supersedes ADR-005 as the primary modeling and export path. The polyhedral kernel remains a compatibility path for imported mesh bodies.

## Decision

Run `occt-wasm` in the existing browser geometry Web Worker and use it for parametric feature rebuilds, B-rep validation, measurement, tessellation, and STEP/STL export. Keep the canonical document and command history independent of kernel handles. Never run the geometry kernel in the Cloudflare Worker.

## Rationale

OpenZCAD's core promise requires analytic primitives and exact boolean/export topology. OpenCascade provides that mature geometry behavior while preserving the established browser-worker boundary. A worker-local kernel also prevents its roughly 22 MB WASM module from blocking the main UI thread.

## Consequences

- STEP files import into replayable exact features; exports come from exact OpenCascade shapes and are re-imported in tests as valid solids.
- Viewport meshes remain disposable tessellations of exact B-reps.
- The initial exact-kernel download is materially larger than the previous compatibility kernel.
- Imported STL bodies keep the compatibility path because triangle meshes are not parametric B-reps.
