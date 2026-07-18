# OpenZCAD Architecture

OpenZCAD is a local-first parametric CAD system. The canonical `ProjectDocument` and its command history live in the browser. Exact geometry is a derived projection rebuilt by BrepKit in a browser Web Worker. The Cloudflare Worker coordinates persistence and AI, but never owns interactive geometry.

## Layers

- `shared`: branded IDs and schema-v2 contracts for nodes, revisions, checkpoints, assets, derived topology, collaboration messages, and API payloads.
- `document-core`: immutable document operations, feature ordering, parameter expression evaluation, editable STEP features, finishing/pattern features, v1-to-v2 normalization, and checkpoint creation.
- `command-system`: pre-assigned deterministic IDs, validation, transactions, replay, and bounded undo/redo. It also converts reviewed `CadPatchProposal` operations into ordinary commands.
- `ai-contracts`: compact document digests, the strict JSON Schema sent to the model, runtime proposal validation, and the allowlisted patch operation types.
- `kernel-adapter/exact`: the `brepkit-wasm` adapter. It owns exact primitives, STEP import, sweeps, transforms, booleans, edge finishing, patterns, tessellation/topology projection, validity checks, measurements, and STEP/STL export.
- `kernel-adapter` and `geometry`: compatibility support for imported mesh bodies and deterministic legacy tests. They are not the primary exact modeling path.
- `viewport`: Three.js projection and picking only. It never mutates canonical geometry or document state. It renders Z-up to match the kernel, so a part's vertical axis is +Z on screen exactly as it is in the solid.
- `persistence` and `cloudflare-adapters`: local/in-memory and D1/R2 implementations, schema normalization, revisions/checkpoints, upload sessions, and artifact coordination.
- `apps/web`: React workspace, IndexedDB autosave, geometry worker, and Cloudflare Worker routes.

## Document lifecycle

1. A UI form or approved AI proposal creates validated commands.
2. `CommandManager` applies one command or transaction, appends serialized replay data, and advances the document version.
3. The React app autosaves the canonical document to IndexedDB.
4. The geometry worker receives `{ type: "sync", document }` and rebuilds the feature history with BrepKit.
5. The worker returns derived meshes, bounds, volume, face counts, validity warnings, and exportable body IDs tagged with project/version.
6. The app rejects stale results and attaches only matching derived state without advancing model history.
7. Manual save creates a durable checkpoint in the beta persistence service.

Exact faces and edges are projected with deterministic one-based sub-shape ordinals. Selection remains viewport state until a command captures an ordinal; feature commands never depend on Three.js objects or transient kernel handles.

When opening a project, local and remote copies are loaded together. The higher document version wins; derived timestamps break ties. This prevents an older cloud response from shadowing newer local edits.

## Exact export lifecycle

STEP/STL buttons send an export request to the existing geometry worker with the current document and selected live body IDs. The worker rebuilds the exact shapes and exports them through BrepKit. The main thread only creates the download and records best-effort export metadata with the Worker API. The viewport and export therefore share the same exact build path.

## Editable STEP lifecycle

The browser reads an imported STEP file (up to 12 MB), records the source text and artifact reference in an `imported-step` feature command, and sends the canonical document to the geometry worker. BrepKit imports the exact shape on every replay, so later transforms, booleans, fillets, chamfers, patterns, selection, and export use the same exact B-rep path. The Worker archives the source best-effort; replay does not depend on that network artifact.

## Collaboration lifecycle

After project ownership is authorized, the client upgrades `GET /api/projects/:id/collaboration` to a WebSocket. A per-project Durable Object broadcasts presence and canonical document snapshots, accepts only newer versions, and reports same-version divergent documents as conflicts. Clients preserve local state on conflict, strip derived meshes before transmission, debounce edits, and pause live broadcasting above 900 KB. IndexedDB and manual D1 checkpoints remain the durable recovery path.

## AI lifecycle

`POST /api/assistant/proposals` accepts a user request and a compact document digest. Embedded STEP source and mesh arrays are omitted from model context; exact selected face/edge context is included. The beta Worker calls OpenRouter's OpenAI-compatible Responses endpoint by default (or direct OpenAI/another compatible endpoint) with streaming, `store: false`, a stable authenticated-user safety identifier, configurable reasoning effort, a strict JSON Schema structured output, and system instructions that require the smallest safe document patch and prohibit claims that a patch was applied.

The patch vocabulary covers named parameters, existing feature dimensions, primitive creation, sweeps, booleans, transforms, edge modifiers, patterns, renaming, and deletion. The client assembles `response.output_text.delta` events, validates the final proposal again, and displays it. Preview runs the proposal against a temporary `CommandManager`; Apply converts it to normal commands and commits one undoable transaction. `GET /api/assistant/status` exposes configuration metadata but never the secret.

A proposal can build a complete multi-part object rather than one primitive at a time. A body-creating operation publishes a `localId` alias, and later operations in the same proposal reference it as `$alias`. `commandsForCadPatch` pre-assigns the real ids with `createBodyFeatureIds()` and resolves each alias as it converts, so aliases never enter a serialized payload and replay, undo, and persistence stay unchanged. `runTransaction` validates each command against the evolving document, so a boolean can consume bodies the same patch created. Hollow parts are therefore modelled as an outer solid minus a positioned cavity; there is no shell or offset operation in the kernel.

The digest reports every body's liveness (`consumed`), placement (`bbox`), and volume, because the feature list alone cannot say whether an earlier boolean already absorbed a body. Conversion rejects a patch before it reaches the document when an alias dangles, is duplicated, or names a consumed body, when a boolean repeats an operand, when an edge modifier targets a body created in the same patch (its edges do not exist yet), or when any parameter expression cannot be evaluated — `setParameter` otherwise stores an unreadable expression verbatim and the body silently fails to build.

## Storage and Cloudflare mapping

- IndexedDB: immediate local autosave and offline reopen.
- D1: project documents, project metadata, revision/checkpoint snapshots, upload sessions, and artifact metadata.
- R2: large source/export assets when configured.
- Durable Objects: authenticated per-project presence and live document synchronization.
- Workflows/Queues: export/import orchestration scaffolding.
- Worker secret: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or provider-neutral `AI_API_KEY`; never shipped to the browser.
- `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_REASONING_EFFORT`, `AI_SITE_URL`, and `AI_APP_NAME` select and attribute a Responses-compatible provider/model without code changes.

## API and errors

All JSON POST bodies are validated. Oversized bodies return `413`, malformed data `400`, unauthenticated requests `401`, unauthorized resources `404`, unconfigured services `503`, upstream AI failure `502`, and unexpected errors a generic `500`. Provider error bodies and secrets are never returned to the client.

## Security posture

This remains beta-only. Beta requests require Cloudflare Access identity and all project, revision, artifact, import/export, and collaboration operations are owner-scoped. Development mode supplies an isolated local identity and must not be used on a public route. Cloudflare Access must be configured at the route boundary; the Worker intentionally trusts Access's injected assertion and email headers. Parameter expressions use a parser rather than `eval`. AI output is schema-constrained, runtime-validated, previewed, and user-approved before it becomes a command transaction.
