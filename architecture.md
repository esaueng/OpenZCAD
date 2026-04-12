# OpenZCAD Architecture

OpenZCAD is a browser-based parametric CAD application. The system is designed so the browser owns modeling, the Cloudflare Worker owns orchestration, and derived geometry artifacts are disposable.

## Core layers
- `document-core`: canonical project state, feature tree, parameters, sketches, revisions.
- `command-system`: deterministic mutations, transactions, undo/redo, replay.
- `kernel-adapter`: browser geometry execution seam. MVP ships with a mock kernel plus an OpenCascade-ready adapter boundary.
- `viewport`: render projection only. Meshes are derived from document and kernel outputs.
- `io-*`: STEP/STL import-export boundaries.
- `persistence`: save/load semantics and artifact manifests.
- `cloudflare-adapters`: D1/R2/Queues/DO/Workflow implementations.

## Cloudflare mapping
- Worker routes expose the project API and upload/export orchestration.
- D1 stores metadata and revision pointers, never large blobs.
- R2 stores uploads, exports, thumbnails, and large snapshots.
- Durable Objects host collaboration room, lock, and presence scaffolding.
- Queues handle background validation and thumbnail requests.
- Workflows orchestrate multi-step import and export pipelines.

## CAD rules
- Viewport meshes are never the source of truth.
- Feature outputs are referenced through stable entity IDs and reference paths.
- STEP export is allowed only for native kernel B-Rep outputs. The MVP mock kernel reports export capability honestly instead of inventing geometry.

## Local development
- `pnpm dev:web` runs the Vite dev server with the Cloudflare Vite plugin.
- Browser workers execute geometry derivation.
- Worker bindings fall back to in-memory development repositories when D1/R2 bindings are absent.

