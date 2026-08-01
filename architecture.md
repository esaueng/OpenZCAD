# OpenZCAD Architecture

OpenZCAD is a local-first parametric CAD system. The canonical `ProjectDocument` and its command history live in the browser. Exact geometry is a derived projection rebuilt by BrepKit or, for STEP documents, OCCT in a browser Web Worker. The Cloudflare Worker coordinates persistence, collaboration, and AI, but never owns interactive geometry.

## Layers

- `shared`: branded IDs and schema-v6 contracts for nodes, revisions, checkpoints, assets, additive schema-v5 topology lineage, collaboration messages, modeling features, and API payloads.
- `document-core`: immutable document operations, feature ordering, parameter expression evaluation, editable STEP features, finishing/pattern/modeling features, v1–v5 normalization, and checkpoint creation.
- `command-system`: pre-assigned deterministic IDs, validation, transactions, replay, and bounded undo/redo. It also converts reviewed `CadPatchProposal` operations into ordinary commands.
- `ai-contracts`: compact document digests, the strict JSON Schema sent to the model, runtime proposal validation, and the allowlisted patch operation types.
- `kernel-adapter/exact`: the lazy `brepkit-wasm` adapter. It owns native exact primitives, sweeps, transforms, booleans, mirror/shell/offset, edge finishing, patterns, imported meshes, face-attachment resolution, tessellation/topology projection, validity checks, measurements, and STEP/STL export. Documents containing STEP imports route to the lazy OCCT adapter.
- `kernel-adapter` (root): the synchronous helpers both adapters and the app share — topology lineage, face attachment, imported-feature recognition, and the mesh-to-STL handoff. No kernel runs here.
- `geometry`: document-side geometry only — sketch-plane frames, 2D profiles, sketch regions, shared tolerances, and mesh welding. It builds no solids.
- `viewport`: Three.js projection and picking only. It never mutates canonical geometry or document state. It renders Z-up to match the kernel, so a part's vertical axis is +Z on screen exactly as it is in the solid.
- `persistence` and `cloudflare-adapters`: local/in-memory and D1/R2 implementations, schema normalization, revisions/checkpoints, upload sessions, and artifact coordination.
- `apps/web`: React workspace, IndexedDB autosave, geometry worker, and Cloudflare Worker routes.

## Document lifecycle

1. A UI form or approved AI proposal creates validated commands.
2. `CommandManager` applies one command or transaction, appends serialized replay data, and advances the document version.
3. The React app autosaves the canonical document to IndexedDB.
4. The geometry worker receives `{ type: "sync", document }`. Empty documents avoid loading a kernel; other documents lazy-load the exact adapter and route STEP histories through OCCT.
5. The worker keys the rebuild by canonical project content (excluding derived output), deduplicates matching in-flight work, and may return a structured clone from its bounded LRU. A miss replays the full exact feature history.
6. The worker returns derived meshes, bounds, volume, face counts, validity warnings, and exportable body IDs tagged with project/version.
7. The app rejects stale results and attaches only matching derived state without advancing model history.
8. Manual save creates a durable checkpoint in the beta persistence service.

Exact faces and edges carry kernel-neutral witnesses and, for the safe subset, semantic lineage names. Selection remains viewport state until a command captures a topology reference; feature commands never depend on Three.js objects, transient kernel handles, nearest geometry, or traversal order.

For a current face-attached sketch, each exact adapter pauses replay at the
sketch's history position, resolves its schema-v5 lineage reference against the
then-current source body, requires one exact planar face, and derives a
deterministic frame from the evolved center/normal. The persisted frame is
diagnostic only. Legacy attachments without lineage retain their migration
frame with a warning. See [ADR-014](docs/adrs/ADR-014-true-face-attachment.md).

When opening a project, local and remote copies are loaded together. The higher document version wins; derived timestamps break ties. This prevents an older cloud response from shadowing newer local edits.

## Exact export lifecycle

STEP/STL buttons send an export request to the existing geometry worker with the current document and selected live body IDs. The worker rebuilds the exact shapes through the same document-selected adapter and exports them; BrepKit may lazy-load OCCT to assemble multi-body STEP compounds. The main thread only creates the download and records best-effort export metadata with the Worker API. The viewport and export therefore share the same exact build path, although exports deliberately bypass the rebuild-result cache.

## Editable STEP lifecycle

The browser reads an imported STEP file (up to 12 MB), records the source text and artifact reference in an `imported-step` feature command, and sends the canonical document to the geometry worker. The presence of that feature routes the document through OCCT, which imports the exact shape on every replay; later transforms, booleans, finishing, patterns, selection, and export therefore share one exact B-rep path. The Cloudflare Worker archives the source best-effort; replay does not depend on that network artifact.

## Collaboration lifecycle

After project read access is authorized, the client upgrades `GET /api/projects/:id/collaboration` to a WebSocket. A per-project Durable Object broadcasts presence and canonical document snapshots, enforces owner/editor/viewer roles per message, and persists one project-wide edit lease before granting it. Editors submit against an expected room version; viewers never request a lease. Same-version divergence becomes an explicit conflict instead of an automatic winner.

The client strips derived meshes before transmission, debounces edits, and uses
the authenticated HTTP snapshot path above 900 KB. An unresolved conflict
blocks autosend and survives dialog close/reload through a small sentinel while
the full divergent document remains in IndexedDB. Every resolution first saves
a recovery project. “Keep my version” additionally requires this client's
unexpired lease and the exact expected room version. Sharing and lease
enforcement remain disabled in checked-in configuration.

## AI lifecycle

`POST /api/assistant/proposals` accepts a user request and a compact document digest. Embedded STEP source and mesh arrays are omitted from model context; exact selected face/edge context is included. The beta Worker calls OpenRouter's OpenAI-compatible Responses endpoint by default (or direct OpenAI/another compatible endpoint) with streaming, `store: false`, a stable authenticated-user safety identifier, configurable reasoning effort, a strict JSON Schema structured output, and system instructions that require the smallest safe document patch and prohibit claims that a patch was applied.

The patch vocabulary covers named parameters, existing feature dimensions, primitive creation, sketches (including exact face attachment), multi-profile extrusion, sweeps, booleans, transforms, mirror, shell, solid offset, validated direct edits, edge modifiers, patterns, renaming, and deletion. Topology-dependent operations must copy the current exact digest witness and are rejected when stale or invented. The client assembles `response.output_text.delta` events, validates the final proposal again, and displays it. Preview and Apply share exact preflight; Apply converts the patch to normal commands and commits one undoable transaction. `GET /api/assistant/status` exposes configuration metadata but never the secret.

A proposal can build a complete multi-part object rather than one primitive at a time. A body-creating operation publishes a `localId` alias, and later operations in the same proposal reference it as `$alias`. `commandsForCadPatch` pre-assigns real IDs with `createBodyFeatureIds()` and resolves each alias during conversion, so aliases never enter serialized replay. `runTransaction` validates each command against the evolving document, so a boolean can consume bodies the same patch created. Hollow parts may use the exact shell command when its opening-face references are already present in the digest; otherwise subtracting a deterministic cavity remains available.

The digest reports every body's liveness (`consumed`), placement (`bbox`), and volume, because the feature list alone cannot say whether an earlier boolean already absorbed a body. Conversion rejects a patch before it reaches the document when an alias dangles, is duplicated, or names a consumed body, when a boolean repeats an operand, when an edge modifier targets a body created in the same patch (its edges do not exist yet), or when any parameter expression cannot be evaluated — `setParameter` otherwise stores an unreadable expression verbatim and the body silently fails to build.

## Storage and Cloudflare mapping

- IndexedDB: immediate local autosave and offline reopen.
- D1: project documents, project metadata, revision/checkpoint snapshots, upload sessions, and artifact metadata.
- R2: large source/export assets when configured.
- Durable Objects: authenticated per-project presence and live document synchronization.
- Workflows/Queues: export/import orchestration scaffolding.
- Worker secret: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or provider-neutral `AI_API_KEY`; never shipped to the browser.
- `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_REASONING_EFFORT`, `AI_SITE_URL`, and `AI_APP_NAME` select and attribute a Responses-compatible provider/model without code changes. Saved custom endpoint hostnames require the exact `AI_ALLOWED_BASE_URL_HOSTS` allowlist outside development, and provider redirects are not followed.
- D1 stores versioned user-scoped application preferences separately from canonical project documents. Optional personal AI tokens are stored in a separate table as AES-GCM ciphertext bound to the authenticated user; `SETTINGS_ENCRYPTION_KEY` remains a Worker secret and plaintext tokens are used only inside the provider request.
- Deployment-funded AI requires the authenticated email to appear in `AI_DEPLOYMENT_ALLOWED_EMAILS`. D1 atomically enforces global daily request/cost ceilings in addition to account/IP window and concurrency limits.

## API and errors

All JSON POST bodies are validated. Oversized bodies return `413`, malformed data `400`, unauthenticated requests `401`, unauthorized resources `404`, unconfigured services `503`, upstream AI failure `502`, and unexpected errors a generic `500`. Provider error bodies and secrets are never returned to the client.

## Security posture

This remains beta-only. Project, revision, artifact, import/export, settings, and collaboration requests require a single-use email-code session. Project reads and collaboration are role-scoped; owner-only sharing mutations remain separately authorized, and document writes require owner/editor access plus the active lease when enforcement is enabled. Public assistant identities and IP quota buckets are domain-separated HMAC-SHA-256 values keyed by the Worker-only `AI_IDENTITY_PEPPER`; the raw address is never stored or sent upstream. Deployment-funded AI additionally requires an allowlisted authenticated email, while personal provider credentials remain user-scoped. Development mode supplies an isolated local identity and must not be used on a public route. Parameter expressions use a parser rather than `eval`. AI output is schema-constrained, digest-bound where topology matters, exact-preflighted, previewed, and user-approved before it becomes a command transaction.
