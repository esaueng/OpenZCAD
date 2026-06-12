# OpenZCAD Architecture

OpenZCAD is a browser-based parametric CAD application. The system is designed so the browser owns modeling, the Cloudflare Worker owns orchestration, and derived geometry artifacts are disposable.

## Core layers
- `document-core`: canonical project state, feature tree, parameters, sketches, revisions. Documents are immutable values: every mutating operation clones and returns a new document, which is what lets the command history hold plain references.
- `command-system`: deterministic mutations, transactions, undo/redo, replay. Command factories pre-assign the IDs an operation will create and serialize them with the payload, so replaying a command log rebuilds the exact same entity graph. Undo history is capped (100 entries).
- `kernel-adapter`: browser geometry execution seam. MVP ships with a mock kernel plus an OpenCascade-ready adapter boundary. `syncDocument` processes features in `featureOrder`; boolean and transform features resolve their targets against bodies already produced in the same pass (falling back to the previous derived state), so a fresh sync after load or replay is self-sufficient.
- `viewport`: render projection only. Meshes are derived from document and kernel outputs.
- `io-*`: STEP/STL import-export boundaries.
- `persistence`: save/load semantics, artifact manifests, upload-session lifecycle (15-minute TTL, single use).
- `cloudflare-adapters`: D1/R2/Queues/DO/Workflow implementations.

## Workspace UI
The browser app (apps/web) follows the OpenCAE design system (see `src/theme/tokens.css`): AppShell = TopBar / [StepBar | ViewerShell | ContextPanel] / OutcomePanel / StatusBar. The StepBar drives a seven-step generative workflow (Model, Preserve, Constraints, Loads, Study, Generate, Results) with per-step completion indicators; the right ContextPanel renders only the active step's controls. Workflow annotations are document data: body roles (`gdRole`), loads (`gdLoadFx/Fy/Fz`), and study settings (project-node `gd*` keys) are written through the `node.metadata.set` command, so they undo, replay, and persist with the model. Generate runs `runMockGenerativeStudy` (apps/web/src/lib/generative.ts), a deterministic estimator that stands in for the native topology kernel; outcomes are session state, summarized in the OutcomePanel and previewed by scaling design-space bodies.

## Geometry sync pipeline
The app posts the document to a browser worker whenever `document.version` changes. The worker derives body representations and replies with a result tagged by `projectId`/`version`; the app discards stale replies and commits matching ones via `commitDerivedState`, which intentionally does not bump `version` (this breaks the re-derive feedback loop and distinguishes model edits from re-derivation).

## Cloudflare mapping
- Worker routes expose the project API and upload/export orchestration.
- D1 stores metadata and revision pointers, never large blobs.
- R2 stores uploads, exports, thumbnails, and large snapshots.
- Durable Objects host collaboration room, lock, and presence scaffolding.
- Queues handle background validation and thumbnail requests.
- Workflows orchestrate multi-step import and export pipelines.

## API behavior
- All POST bodies are validated; malformed input returns `400` with `{ "error": string }`. Bodies over 25MB return `413`. Unknown routes/resources return `404`; unexpected failures return `500` without internals.
- `POST /api/projects/:id/revisions` requires the path ID, payload `projectId`, and `document.projectId` to agree, and returns `404` for unknown projects.
- `POST /api/imports/finalize` returns `404` when the upload session is unknown, expired, or already consumed (sessions are single-use). It previously returned `200` with `{"artifactId": null}`.
- Export workflow kick-off is best-effort: the recorded artifact and job are the durable contract.

## CAD rules
- Viewport meshes are never the source of truth.
- Feature outputs are referenced through stable entity IDs and reference paths.
- STEP export is allowed only for native kernel B-Rep outputs. The MVP mock kernel reports export capability honestly instead of inventing geometry.

## Local development
- `pnpm dev:web` runs the Vite dev server with the Cloudflare Vite plugin.
- Browser workers execute geometry derivation.
- Worker bindings fall back to in-memory development repositories when D1/R2 bindings are absent (state resets per isolate).

## Security posture and known limitations
- **No authentication yet.** Every API request acts as a fixed development user (`user_beta_dev`); project access is not scoped per user beyond the listing query. Real auth must land before any non-beta exposure.
- Parameter expressions are evaluated with a sandboxed recursive-descent parser (never `eval`/`Function`).
- Upload file names are sanitized before being embedded in R2 object keys; upload sessions expire and are single-use.
- `listProjects` on D1 parses each project's full document JSON to compute revision metadata; acceptable at beta scale, but revision metadata should move to columns before documents grow large.
- The D1 `database_id` in wrangler config is a placeholder; deploys fall back to in-memory persistence until a real beta database is provisioned.
- The mock kernel produces placeholder meshes (e.g. boolean results render as overlaid child bodies); fidelity arrives with the OpenCascade.js adapter.
