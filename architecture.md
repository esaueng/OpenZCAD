# OpenZCAD Architecture

OpenZCAD is a local-first parametric CAD system. The canonical `ProjectDocument` and its command history live in the browser. Exact geometry is a derived projection rebuilt by Remus in a browser Web Worker, for every document including STEP imports. The Cloudflare Worker coordinates persistence, collaboration, and AI, but never owns interactive geometry.

## Layers

- `shared`: branded IDs and schema-v41 contracts for nodes, revisions, checkpoints, assets, additive schema-v5 topology lineage, versioned canonical sketch bases, reference-form mesh payloads, sketch relations, absolute/horizontal/vertical reference distances, sketch composites with topology-bound corner/side reference targets, authored boundary provenance and explicit legacy-conversion aliases, sketch ellipses and splines, datum planes (offset, midplane, three-point and parallel-at-point), datum axes (two points, straight edge, cylinder or cone axis, plane intersection) with revolve, circular-pattern and Move consumers, revolve region profiles (U09), typed parameters, transform pivots and copies, solid result options (extrude intersect, keep originals), extrude to-face extents and draft, drawing sheets and views (D01) with their dimensions, notes and explicit finishing-body updates (D02), reference images (I05), linked and unlinked sketch projections (I01), Objects folders (U06), gears including straight bevel gears (M14), collaboration messages, modeling features, and API payloads.
- `document-core`: immutable document operations, feature ordering, parameter expression evaluation, editable STEP features, finishing/pattern/modeling features, v1–v12 normalization, and checkpoint creation.
- `command-system`: pre-assigned deterministic IDs, validation, transactions, replay, and bounded undo/redo. It also converts reviewed `CadPatchProposal` operations into ordinary commands.
- `ai-contracts`: compact document digests, the strict JSON Schema sent to the model, runtime proposal validation, and the allowlisted patch operation types.
- `kernel-adapter/exact`: the lazy `remus-wasm` adapter. It owns native exact primitives, sweeps, transforms, booleans, mirror/shell/offset, edge finishing, patterns, imported meshes, face-attachment resolution, tessellation/topology projection, validity checks, measurements, and STEP/STL export, and the exact import of STEP sources. There is no second production kernel: OpenCascade lives only in the parity corpus's reference implementation under `test/parity/occt-reference/`. See [ADR-020](docs/adrs/ADR-020-remus-browser-kernel.md).
- `kernel-adapter` (root): the synchronous helpers both adapters and the app share — topology lineage, face attachment, imported-feature recognition, and the mesh-to-STL handoff. No kernel runs here.
- `geometry`: document-side geometry only — sketch-plane frames, 2D profiles, sketch regions, shared tolerances, mesh welding, the sketch-curve subsystem (ellipses and the one spline fit every consumer reads: exact clamped B-splines, knot insertion, region pieces), and the sketch-text subsystem (opentype-backed glyph outlines and polygon union for text profiles). It builds no solids.
- `viewport`: Three.js projection and picking only. It never mutates canonical geometry or document state. It renders Z-up to match the kernel, so a part's vertical axis is +Z on screen exactly as it is in the solid.
- `persistence` and `cloudflare-adapters`: local/in-memory and D1/R2 implementations, schema normalization, revisions/checkpoints, upload sessions, and artifact coordination.
- `apps/web`: React workspace, IndexedDB autosave, geometry worker, and Cloudflare Worker routes.

## Document lifecycle

1. A UI form or approved AI proposal creates validated commands.
2. `CommandManager` applies one command or transaction, appends serialized replay data, and advances the document version.
3. The React app autosaves the canonical document to IndexedDB.
4. The geometry worker receives `{ type: "sync", document }`. Empty documents avoid loading a kernel; other documents lazy-load the exact adapter.
5. The worker keys the rebuild by canonical project content (excluding derived output), deduplicates matching in-flight work, and may return a structured clone from its bounded LRU. A miss replays the full exact feature history.
6. The worker returns derived meshes, bounds, volume, face counts, validity warnings, and exportable body IDs tagged with project/version.
7. The app rejects stale results and attaches only matching derived state without advancing model history.
8. Manual save creates a durable checkpoint in the beta persistence service.
9. A checkpoint's document is kept on the device as well as in the account, so
   restoring an earlier save state works offline. Restoring adopts that model
   as one undoable forward edit; branching copies it into a new project. See
   [ADR-022](docs/adrs/ADR-022-save-state-restore-and-branching.md).

Exact faces and edges carry kernel-neutral witnesses and, for the safe subset, semantic lineage names. Selection remains viewport state until a command captures a topology reference; feature commands never depend on Three.js objects, transient kernel handles, nearest geometry, or traversal order.

For a current face-attached sketch, each exact adapter pauses replay at the
sketch's history position, resolves its schema-v5 lineage reference against the
then-current source body, requires one exact planar face, and derives a
deterministic frame from the evolved center/normal, oriented by the frame the
sketch was attached with — the anchor that keeps an ordinary dimension change
from silently rotating or mirroring the sketch, since no normal-only rule can
be continuous everywhere. The snapshot still never decides which face resolves.
Legacy attachments without lineage retain their migration frame with a warning. See [ADR-014](docs/adrs/ADR-014-true-face-attachment.md).

A projected sketch object (I01, schema v33) is an ordinary line, arc, circle or ellipse that also records its source edge by schema-v5 lineage and a linked or unlinked mode. At a linked object's sketch position the exact build re-finds the edge on the then-current source body through verified lineage only (no hash match, no proximity) and projects it along the sketch normal. Every later feature in that build reads the re-projected geometry, and the result is published as `derived.sketchProjections`. If the projection moved, the browser writes it back to the object as a normalization, so every browser view reads what the model was built from. A broken source (deleted, unavailable at that history position, or no longer the same kind of curve) keeps the stored geometry, which is the last valid projection, and raises an advisory. Repair is an explicit re-pick, validated by a rebuild before it commits, or an unlink. The solver holds linked objects fixed. Unlinked objects are plain geometry whose source is provenance only.

When opening a project, local and remote copies are loaded together and reconciled by content, never by version number or clock alone ([ADR-016](docs/adrs/ADR-016-project-cloud-sync.md)). A copy that retains all of the other's authored work is taken. Otherwise the device's last-synced version shows which side moved; when both moved, or that baseline is unknown, a copy wins only if its revision history descends from the other's latest revision. Anything else opens as an explicit conflict rather than a silent winner.

## Exact export lifecycle

STEP/STL buttons send an export request to the existing geometry worker with the current document and selected live body IDs. The worker rebuilds the exact shapes through the same adapter and exports them, multi-body STEP compounds included. The main thread creates the local download, then best-effort uploads those already-generated bytes and finalizes their metadata through the Worker API. The Cloudflare Worker stores bytes but never loads a geometry kernel. The viewport and export therefore share the same exact build path, although exports deliberately bypass the rebuild-result cache. Expired upload sessions are swept hourly and on later upload creation; D1 tracking is retained whenever R2 deletion fails so cleanup remains retryable. See [ADR-018](docs/adrs/ADR-018-client-generated-artifacts.md).

## Editable STEP lifecycle

The browser reads an imported STEP file (up to 128 MB), stores its bytes in the content-addressed source blob store, and records a SHA-256 reference plus artifact id in an `imported-step` feature command (documents from before references carry the source text embedded, capped at 12 MB, and replay unchanged). The canonical document — now a few hundred bytes per import — goes to the geometry worker, which resolves references from the blob store or the archived artifact before rebuilding. The kernel imports the exact shape on every replay, honouring the file's own declared length and plane-angle units; later transforms, booleans, finishing, patterns, selection, and export therefore share one exact B-rep path. The Cloudflare Worker archives the source best-effort; replay does not depend on that network artifact.

## Imported mesh lifecycle

STL, 3MF, OBJ, glTF binary and PLY imports become one `imported-mesh` feature whose triangles are already in document units. The triangles are encoded once into a canonical binary payload (`OZMESH` v1: little-endian float64 vertices and uint32 indices, lossless against the embedded JSON numbers), stored in the same content-addressed source blob store as STEP sources, and the feature and its `import.mesh` command carry only a SHA-256 `meshPayloadRef` — so neither the node, the command log nor the undo entry repeats the mesh. The payload is archived as the feature's `mesh-payload` artifact, which is what other devices, share links and backups resolve the reference from; the original upload is still archived best-effort as a stored file. The geometry worker resolves references with the STEP prefetch (blob store first, then the checksum-verified artifact) and rebuilds through the same STL handoff, so no file parser runs on replay. Documents written before references embed `vertices`/`indices` and replay unchanged; they are never rewritten into the reference form, and embedding remains the fallback when this browser denies blob storage.

## Drawing lifecycle

A drawing sheet (D01, schema v30) is canonical content in `ProjectDocument.drawings`: paper, scale, projection angle, title-block text and, per view, a standard orientation (six principal views or the isometric), the bodies it shows and where its centre sits on the paper in millimetres. Projected lines are never stored. The Draw workspace mode draws the sheet over the stage (the 3D viewer stays mounted beneath it) and edits it only through `drawing.*` commands, which undo, save and sync like any other and are kept out of the geometry rebuild key. Projection runs in its own lazy worker from a canonical tessellation the geometry worker makes on request (`drawing-tessellation`): each body meshed at its nominal display deflection — never the held deflection the viewport keeps through small edits — with faces, triangles, vertices and edges in an order that depends only on their coordinates. From it come kernel-sampled feature-edge polylines plus silhouettes of curved faces, with occlusion tested against every body's triangles (approximate to the display tolerance; the pinned `projectEdges` only tests occlusion locally and draws no silhouettes). One page model feeds the on-screen sheet and the dependency-free PDF and SVG writers, which are deterministic for a given model state and kernel pin, whether the model was edited in the session or rebuilt cold. Each sheet stores a fingerprint of its source bodies' persistent topology hashes and extents; when the model no longer matches it, the sheet shows a stale state and refuses export until an explicit Update rebinds it.

Dimensions and notes (D02, schema v31) live on the sheet as `DrawingSheet.annotations`: each names the model edges it measures by persistent reference (ADR-013 lineage name, then ADR-011 hash, through the same fail-closed `resolveEdge` ladder as stored measurements) and where its text sits relative to its view, never a value. Values are read from exact edge vertices and published circle data, projected into the view, each time a ready sheet is drawn, so they follow the sheet's fence: a stale sheet shows none until Update. A reference that resolves to no edge or to several, or an edge the view can no longer measure, marks the annotation broken in place; export is refused until it is re-picked or deleted, and nothing is ever rebound to a nearby edge. An aligned span or an angle that slopes into the view, and any length or angle on the isometric view, is refused rather than read foreshortened; horizontal and vertical spans in a principal view measure along a model axis and stay exact. The same page model carries the dimension strokes, filled arrowheads and rotated text into the preview, PDF and SVG.

## Reference image lifecycle

A reference image (I05, schema v32) is canonical content in `ProjectDocument.referenceImages`: a PNG or JPEG laid on a principal plane (with a numeric offset), a datum plane (followed by id through the frame the exact build resolved), or a planar face (followed by lineage, keeping the frame it was placed on when the face cannot be found, or a fixed coincident frame when the face has no lineage), with its in-plane centre, turn, width (height follows the picture's aspect) and opacity. The pixels never enter the document. Insertion sniffs the file's leading bytes, caps it at 20 MB and 8192 px a side, stores it in the same content-addressed source blob store STEP sources and mesh payloads use, and archives it best-effort as a `reference-image` artifact (PNG or JPEG only, checked when the upload session is created and again at finalize); the record holds only the SHA-256 reference and the artifact id, and a browser that denies blob storage is refused rather than embedding the picture. Edits go through `reference-image.*` commands that undo, save and sync like any other and, like drawing edits, are kept out of the geometry rebuild key, so an image edit never rebuilds. The viewport resolves bytes from the blob store, then from the checksum-verified artifact, decodes them with `createImageBitmap` straight from a Blob (never a fetched data URL, which the CSP refuses) and draws one textured quad per image in a group added to the scene directly: it is never raycast, and the PNG viewport export's allowlist leaves it out. STEP, mesh, drawing and SVG exports read features and bodies only, so they cannot see an image. Visibility is view state, like datum planes'. Project backups carry the picture as a source and refuse a backup that lacks one; source-blob cleanup keeps every picture the document or its undo history names. A picture placed in a local project, or whose upload failed, keeps an `artifact_local_` id and joins the local-only import sources: the sync indicator counts it, and the next account save (or local-project adoption) archives it and rewrites its id everywhere it appears, undo snapshots and commands included. A duplicate or branch caches the source's pictures on this device and gives them device-local ids, so it never depends on the source project's artifact; the account copy carries import sources only, so an account duplicate then uploads the pictures into the new project and stores the rewritten copy before it is reported made (a picture that fails keeps its local id for the copy's next save). Share links drop the section (a share serves import sources only).

## Objects folders

Objects folders (U06, schema v34) are canonical organization in `ProjectDocument.objectFolders`: named folders with a parent (null at the top level), so they nest, and explicit body placements. A body with no placement follows the body it was made from (its feature's target, or a boolean's first operand), so a body keeps its folder while fillets, holes and booleans reshape it under new ids. Folders change only through `objectFolder.*` commands, which undo, save, replay and sync like any other and are kept out of the geometry rebuild key, so filing a body never rebuilds. Which folders are collapsed is a per-device preference, and a folder's visibility toggle hides or shows its bodies through the same per-project view state as a body's eye. Share-link snapshots keep the folders (they organize bodies whose names a visitor already sees) but, like every shared snapshot, none of their commands or undo entries. Loading validates the section as written and never rewrites it. The I02 STEP assembly hierarchy is meant to land as nested folders.

## Linked projection constraints

Exact history reprojects linked edges at the sketch's history position, then solves its persistent relations with every linked curve held fixed. Broken links remain held at their last stored geometry. The solve uses a disposable kernel so its scratch state never enters retained history checkpoints. Projection states and ordinary geometry overrides publish together only after a successful solve; a failure blocks features using that sketch and its sketch exports. Ordinary authored values remain canonical, so current-link and cold rebuilds solve again after the browser normalizes moved linked geometry.

The exact result also publishes session sketch geometry qualified by source project and document version. Sketch rendering, snapping, entity cards and profile/measurement reads use that resolved view; commands, history and saved documents retain authored data. Stale or loaded channels are discarded. Geometry-preserving edit and cache reuse may requalify the channel only after the existing canonical geometry-content equality proof.

Explicit driver release (unlink, relation removal or entity deletion) captures the current solved geometry in the same user transaction before dropping the driver. These ordinary commands replay and undo together; unchanged expression fields survive using the existing solve-application comparison. Geometry-dependent edits of linked sketches require a current exact result before planning from that view.

## Objects folders

Objects folders (U06, schema v34) are canonical organization in `ProjectDocument.objectFolders`: named folders with a parent (null at the top level), so they nest, and explicit body placements. A body with no placement follows the body it was made from (its feature's target, or a boolean's first operand), so a body keeps its folder while fillets, holes and booleans reshape it under new ids. Folders change only through `objectFolder.*` commands, which undo, save, replay and sync like any other and are kept out of the geometry rebuild key, so filing a body never rebuilds. Which folders are collapsed is a per-device preference, and a folder's visibility toggle hides or shows its bodies through the same per-project view state as a body's eye. Share-link snapshots keep the folders (they organize bodies whose names a visitor already sees) but, like every shared snapshot, none of their commands or undo entries. Loading validates the section as written and never rewrites it. The I02 STEP assembly hierarchy is meant to land as nested folders.

## Collaboration lifecycle

After D1 resolves current project read access, the client upgrades
`GET /api/projects/:id/collaboration` to a WebSocket. The Worker authenticates
the email-code session, replaces caller-controlled identity/role headers, and
reaches the per-project Durable Object only through its binding. The room
requires that trusted role for WebSocket and HTTP snapshot traffic, rechecks a
non-owner's D1 membership before document writes and lease acquisition/renewal,
and broadcasts presence plus canonical snapshots. Editors submit against an
expected room version; viewers never request a lease. Same-version divergence
becomes an explicit conflict instead of an automatic winner.

D1 remains the durable membership source of truth. Durable Object storage holds
the latest document, bounded snapshot history, and one project-wide edit lease,
not a second membership copy. The 30-second server-time lease survives an
abrupt socket disconnect and is renewed by a 10-second client heartbeat; a
clean project change releases it, while another editor can take over after TTL.

The client strips derived meshes before transmission, debounces edits, and uses
the authenticated HTTP snapshot path above 900 KB. An unresolved conflict
blocks autosend and survives dialog close/reload through a small sentinel while
the full divergent document remains in IndexedDB. Room and account conflicts
share one dialog (`ProjectConflictDialog`), never the sharing menu. Every
resolution first saves a recovery project — once per document state, whichever
remote cites it. “Keep this device’s version” on a room conflict additionally
requires this client's unexpired lease and the exact expected room version.
The room's version line is transport, not the account's fence: a document
adopted from the room keeps the account baseline it had, and a fenced 409 is
reconciled by baseline and revision descent before it becomes a conflict
dialog. Sharing and lease
enforcement are enabled in the checked-in beta configuration
(`wrangler.jsonc`) and off in the development one. See
[ADR-019](docs/adrs/ADR-019-durable-collaboration-authorization.md).

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
- Cron trigger: a bounded retryable sweep for expired upload sessions and their R2 objects.
- Worker secret: `OPENROUTER_API_KEY` for OpenRouter, or `OPENAI_API_KEY`/`AI_API_KEY` for OpenAI and other Responses-compatible providers; `AI_API_KEY` is never sent to OpenRouter. Secrets are never shipped to the browser.
- `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_REASONING_EFFORT`, `AI_SITE_URL`, and `AI_APP_NAME` select and attribute a Responses-compatible provider/model without code changes. Saved custom endpoint hostnames require the exact `AI_ALLOWED_BASE_URL_HOSTS` allowlist outside development, and provider redirects are not followed.
- D1 stores versioned user-scoped application preferences separately from canonical project documents. Optional personal AI tokens are stored in a separate table as AES-GCM ciphertext bound to the authenticated user; `SETTINGS_ENCRYPTION_KEY` remains a Worker secret and plaintext tokens are used only inside the provider request.
- Deployment-funded AI requires either Premium membership or the authenticated email in `AI_DEPLOYMENT_ALLOWED_EMAILS`. D1 enforces each account's Free or Premium request, weighted-unit and concurrency limits; there is no shared deployment usage cap.

## API and errors

All JSON POST bodies are validated. Oversized bodies return `413`, malformed data `400`, unauthenticated requests `401`, unauthorized resources `404`, unconfigured services `503`, upstream AI failure `502`, and unexpected errors a generic `500`. Provider error bodies and secrets are never returned to the client.

## Security posture

This remains beta-only. Project, revision, artifact, import/export, settings, and collaboration requests require a single-use email-code session. Project reads and collaboration are role-scoped; owner-only sharing mutations remain separately authorized, and document writes require owner/editor access plus the active lease when enforcement is enabled. Public assistant identities are HMAC-SHA-256 values keyed by the Worker-only `AI_IDENTITY_PEPPER`. Deployment-funded AI additionally requires an authenticated Premium or allowlisted email, while personal provider credentials remain user-scoped. Development mode supplies an isolated local identity and must not be used on a public route. Parameter expressions use a parser rather than `eval`. AI output is schema-constrained, digest-bound where topology matters, exact-preflighted, previewed, and user-approved before it becomes a command transaction.
