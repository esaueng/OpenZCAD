# OpenZCAD

OpenZCAD is a browser-first parametric CAD workspace for people who want to turn design intent into editable, exact solid models without installing a desktop CAD stack. The canonical project document stores named parameters, sketches, feature history, and replayable commands; the [BrepKit](https://github.com/esaueng/brepkit) WebAssembly kernel rebuilds exact B-rep geometry in a browser worker; and an optional AI assistant translates plain-language changes into reviewable, previewable, undoable document patches.

![OpenZCAD workspace](docs/design/openzcad-workspace-qa.png)

## What works

- Exact BrepKit geometry for primitives, sketch/extrude, revolve, transforms, booleans, fillet, chamfer, and linear/circular patterns.
- Parametric expressions, ordered feature history, editing, deletion, deterministic replay, transactions, and undo/redo.
- Editable STEP import stored in replayable document history. Selecting an exact imported face shows its surface type and area; complete through-hole cylinders expose a measured diameter that can be changed parametrically, and validated face features can be removed. STEP and STL downloads come from the same browser worker that rebuilds viewport geometry.
- A dense model/viewport/inspector workspace with exact face/edge selection, contextual finishing actions, measurements, diagnostics, and responsive compact states.
- Local-first IndexedDB autosave. When local and beta-cloud copies differ, OpenZCAD opens the newer document version instead of discarding local work.
- Cloudflare Access identity in beta, owner-scoped project/artifact routes, and a development-only local identity mode. `AUTH_LEGACY_OWNER_EMAIL` can map existing beta data to its original owner without rewriting documents.
- Live per-project collaboration over a Durable Object WebSocket room, with presence, version-aware document sync, and conflict preservation.
- Streamed AI proposals through the OpenAI Responses API. The assistant receives compact feature history plus the active topology selection and can propose parameter/dimension edits, primitives, sweeps, booleans, transforms, fillets/chamfers, and patterns. Output is constrained to a strict CAD patch schema; users preview, apply, or reject it. Apply creates one normal undoable transaction.
- Beta Worker endpoints for project persistence, revisions/checkpoints, upload coordination, artifact metadata, exports, and AI proposal streaming.

## Architecture

```text
React workspace
  ├─ canonical ProjectDocument + CommandManager
  ├─ IndexedDB autosave
  ├─ Three.js viewport (projection only)
  └─ geometry Web Worker
       └─ brepkit-wasm exact B-rep

Cloudflare Worker (beta orchestration only)
  ├─ D1 project metadata and documents
  ├─ R2 artifact coordination
  ├─ Cloudflare Access identity + owner authorization
  ├─ Durable Object live project rooms
  └─ OpenAI Responses API stream → strict CadPatchProposal
```

Important boundaries:

- The browser document/history model is the source of truth. Meshes are disposable projections.
- Geometry and exports run in the browser worker, never in the Cloudflare Worker.
- AI can propose a small allowlisted command patch. It cannot directly mutate a document, viewport, or kernel.
- Saves/checkpoints are separate from model-edit revisions. Schema-v1/v2 documents migrate to schema v3 on load; v3 adds replayable exact-topology direct edits. Existing owner data can be mapped by email.

See [architecture.md](architecture.md) and the decisions in [docs/adrs](docs/adrs).

## Local setup

Requirements: Node.js 20+ and pnpm 10.

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm dev:web
```

Open the local URL printed by Vite. The CAD workspace works without an AI key; the assistant displays a clear configuration message until one is provided.

Local development uses `AUTH_MODE=development` and the isolated `user_beta_dev` identity. Beta deployment uses `AUTH_MODE=cloudflare-access` and must sit behind a Cloudflare Access policy. Set `AUTH_LEGACY_OWNER_EMAIL` as a Worker secret or variable to the Access email that should inherit historical `user_beta_dev` projects.

OpenRouter is the default AI provider. Configure secrets only in `apps/web/.dev.vars` or with `wrangler secret`:

```dotenv
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
AI_MODEL=openai/gpt-5.6-terra
```

For local development, copy the example, set the key, and restart `pnpm dev:web`:

```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars
```

For the beta Worker, store the key as a Cloudflare secret instead of a file:

```bash
pnpm --filter @openzcad/web exec wrangler secret put OPENROUTER_API_KEY --env beta
```

The assistant checks `GET /api/assistant/status` on startup and reports the configured model/reasoning tier without exposing the secret. `.dev.vars` files are ignored by Git.

The recommended default is `openai/gpt-5.6-terra`: it is the balanced GPT-5.6 tier for reliable structured CAD planning. Use `openai/gpt-5.6-sol` when maximum quality matters more than cost/latency, or `openai/gpt-5.6-luna` for inexpensive, latency-sensitive edits.

Direct OpenAI and other Responses-compatible providers remain supported. Non-secret settings live in `wrangler.jsonc`:

- `AI_PROVIDER` accepts `openrouter`, `openai`, or `responses-compatible` and defaults to OpenRouter in the checked-in app config.
- `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or provider-neutral `AI_API_KEY` supplies the server-side secret.
- `AI_BASE_URL` optionally overrides the provider endpoint and is required for `responses-compatible`.
- `AI_MODEL` defaults to `openai/gpt-5.6-terra` for OpenRouter and `gpt-5.6-sol` for direct OpenAI when no app config overrides it.
- `AI_REASONING_EFFORT` defaults to `high` and accepts `low`, `medium`, `high`, or `xhigh`.
- `AI_MAX_OUTPUT_TOKENS` defaults to `32000`. Reasoning tokens share this budget, and a multi-part model runs to roughly 20 operations; too low a ceiling truncates the patch mid-stream, which the provider reports as a normal incomplete response rather than an error. Lower it only if your model caps output below the default.
- `AI_SITE_URL` and `AI_APP_NAME` optionally send OpenRouter attribution headers.

All provider/model choices are centralized; no API key is shipped to the browser or committed.

## Commands

```bash
pnpm dev:web      # Vite + local Cloudflare Worker
pnpm typecheck    # TypeScript
pnpm lint         # ESLint
pnpm test         # unit and integration tests
pnpm build        # production web/worker bundle
pnpm deploy:beta  # beta-only Cloudflare deployment
```

The BrepKit WASM bundle is about 4.7 MB uncompressed (about 1.7 MB gzip). It is loaded in the geometry worker, not the main UI thread. OpenZCAD consumes the installable `crates/wasm/pkg` subpackage from the `esaueng/brepkit` fork's `main` branch; the lockfile records the exact resolved `main` commit, and BrepKit is not resolved from the npm registry.

## API surface

- `GET /api/health`
- `GET /api/session`
- `GET /api/assistant/status`
- `GET|POST /api/projects`
- `GET /api/projects/:id`
- `POST /api/projects/:id/revisions`
- `GET /api/projects/:id/collaboration` (WebSocket upgrade)
- `POST /api/projects/:id/collaboration` (oversize snapshot recovery)
- `POST /api/uploads`
- `PUT /api/uploads/:id/content`
- `POST /api/artifacts/finalize`
- `GET /api/projects/:id/artifacts`
- `GET /api/artifacts/:id`
- `GET /api/artifacts/:id/download`
- `POST /api/assistant/proposals` (SSE)

Project and revision routes remain schema compatible. The legacy finalize-without-upload and fake export-job routes were removed; artifacts now require an uploaded R2 object before finalization.

## Beta limitations and risks

- The beta route must be protected by Cloudflare Access. Local development identity mode is intentionally unsuitable for a public deployment.
- D1/R2 IDs in the checked-in Wrangler configuration are beta placeholders until real beta resources are provisioned.
- Editable STEP sources are embedded in the canonical document for deterministic offline replay and capped at 12 MB. This preserves editability but can make large documents expensive to save and sync.
- Imported STL remains a mesh body and uses the compatibility path; native parametric reconstruction is not attempted.
- Edge topology references use geometric fingerprints instead of relying on unrelated kernel enumeration orders. Direct face edits additionally fingerprint exact surface area/center and cylindrical diameter/axis, so upstream topology changes fail closed rather than modifying a different same-sized face. Upstream geometry edits can still invalidate a downstream finishing feature with a visible diagnostic.
- BrepKit's difficult boolean cases can fall back to mesh-derived topology, and its STEP round-trip of NURBS blends can shift measured volume slightly. Exports are still re-imported and validated in focused tests; persistent naming and broader STEP interoperability fixtures remain milestones.
- Live rooms synchronize canonical documents and presence, persist a bounded room history, conservatively merge disjoint edits from a shared base, and recover oversized snapshots over authenticated HTTP. Invitations, viewer/editor roles, and edit locks remain future work.
- AI proposals cannot yet create sketch entities, face-attached sketches, imported geometry, or collaboration actions. Body-producing operations can publish a local alias for later operations in the same proposal.
- Exactness-first geometry adds a meaningful initial worker download. Service-worker caching and finer code splitting are future performance milestones.

## Next milestones

1. Sharing invitations, viewer/editor roles, and edit locks.
2. Expand imported-face dimension edits beyond complete through holes to blind/counterbored holes, bosses, pockets, tapers, and coordinated multi-face features; add mirror, shell/offset, face-attached sketches, and richer STEP assembly manifests.
3. Persistent naming resilient to upstream topology changes.
4. Broader AI patch operations as each feature receives a deterministic command contract.
5. Exact-kernel caching, loading UX, and finer worker bundle splitting.
