# OpenZCAD

OpenZCAD is a browser-first parametric CAD workspace: exact B-rep solid modeling, a replayable feature history, and direct on-model manipulation, with no desktop install. The canonical project document stores named parameters, sketches, and an ordered command history, and a WebAssembly solid kernel rebuilds exact geometry in a background worker.

![OpenZCAD workspace — Mounting Bracket demo](docs/design/readme-mounting-bracket.png)

## Highlights

**Exact parametric modeling.** Primitives, multi-profile sketch/extrude, revolve, booleans, transforms, mirror-copy, shell, solid offset, fillet, chamfer, and linear/circular patterns, built on the [BrepKit](https://github.com/esaueng/brepkit) exact kernel. New face-attached sketches re-resolve an exact lineage reference at their history position instead of freezing a viewport plane. Parametric expressions, ordered feature history with editing and deletion, deterministic replay, transactions, and undo/redo.

**Direct manipulation.** Shapr3D-style modeling straight on the model: drag a face to offset it, drag a sketch region into a solid, drag an edge to grow a fillet or chamfer, move/rotate bodies with a snapping gizmo — every drag pairs with exact numeric entry. In-viewport sketching with snapping and live dimensions, box select, selection filters, a marking menu, an Esc ladder, and a live orientation widget with perspective/orthographic switching.

**Two kernels, one topology language.** BrepKit is the primary kernel; documents containing STEP imports rebuild through OCCT. Both kernels publish the same exact topology witnesses and a safe subset of semantic lineage ([ADR-011](docs/adrs/ADR-011-unified-topology-identity.md), [ADR-013](docs/adrs/ADR-013-persistent-topology-lineage.md)). Primitive, sweep, and supported rigid-transform identities can survive upstream edits. Boolean, blend, pattern, direct-edit, and STEP provenance remain hash-only where complete evolution is not proved, and every ambiguous or unsupported resolution fails closed.

**Import and export.** Editable STEP import is stored in replayable document history and rebuilt through OCCT. Selecting an exact imported face shows its surface type and area; the shipped direct-edit subset includes validated through-hole and cylindrical-face edits. A bounded read-only recognizer proves blind holes, counterbores, countersinks, bosses, prismatic pockets, and conical tapers in isolation, but those broader coordinated edits are not wired into the product yet. STEP export preserves distinct solids as a compound; STL export is always millimetres. STL imports become mesh bodies. All geometry and exports run in the browser worker.

**Local-first, optionally cloud.** IndexedDB autosave works with no account; when local and cloud copies diverge, the newer version wins instead of discarding work. Optional passwordless profiles unlock cloud projects, synced settings, and live per-project collaboration with owner/editor/viewer roles and one project-wide edit lease. Conflict recovery always writes a local recovery project before choosing the room version, keeping the leased local version, or saving the local version as a copy. Sharing and lease enforcement remain disabled in checked-in deployment configuration pending controlled rollout.

<p align="center">
  <img src="docs/design/readme-pipe-flange.png" width="49%" alt="Pipe Flange demo — revolved flange with a patterned bolt circle" />
  <img src="docs/design/readme-heat-sink.png" width="49%" alt="Heat Sink demo — extruded base with a parametric fin field" />
</p>

## Quick start

Requires Node.js 20.19+ on the 20.x line, or Node.js 22.12+, and pnpm 10.

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm dev:web
```

Open the URL Vite prints. Three built-in demos (Mounting Bracket, Pipe Flange, Heat Sink) are available from the start screen.

Settings are available from the start screen, the workspace gear, the command palette, or `Ctrl/Cmd+,` — the Settings page overlays the workspace, so any in-flight work survives it.

## Architecture

```text
React workspace (apps/web)
  ├─ canonical ProjectDocument + CommandManager   (source of truth)
  ├─ IndexedDB autosave
  ├─ Three.js viewport                            (disposable projection)
  └─ geometry Web Worker
       ├─ brepkit-wasm  — primary exact B-rep kernel
       └─ occt-wasm     — STEP import/export; documents with STEP
                          features rebuild through OCCT

Cloudflare Worker (beta orchestration only)
  ├─ D1 project metadata, documents, sessions, settings
  ├─ R2 artifact coordination
  ├─ Email-code identity + owner authorization (optional)
  ├─ Durable Object live project rooms
  └─ AI assistant proposal stream (optional, experimental)
```

Boundaries that hold everywhere:

- The browser document/history model is the source of truth; meshes are disposable projections.
- Geometry and exports run in the browser worker, never in the Cloudflare Worker.
- Both kernels persist identical topology fingerprints; resolution is fail-closed at every call site. Documents saved by the pre-fingerprint OCCT scheme are rejected with a re-select diagnostic rather than reinterpreted.
- Schema-v1 through schema-v5 documents migrate to additive schema v6 on load.

See [architecture.md](architecture.md) and the decision records in [docs/adrs](docs/adrs).
The current implementation status and explicitly unshipped gaps are tracked in
[the capability matrix](docs/capability-matrix.md).

The monorepo is a pnpm workspace: `apps/web` plus focused packages — `document-core` (canonical model), `command-system` (undo/redo, transactions), `geometry` (sketch regions, plane math), `kernel-adapter` (BrepKit + OCCT behind one interface), `viewport` (React-free three.js scene framework), `io-step`/`io-stl`, `ai-contracts`, `cloudflare-adapters`, `persistence`, and `shared`.

## Development

```bash
pnpm dev:web          # Vite + local Cloudflare Worker
pnpm typecheck        # TypeScript
pnpm lint             # ESLint
pnpm test             # unit and integration tests (Vitest)
pnpm test:web         # web app tests
pnpm test:e2e         # Playwright end-to-end suite
pnpm test:coverage    # unit tests with coverage
pnpm build            # production web/worker bundle
pnpm deploy:beta      # beta-only Cloudflare deployment
```

Local development uses `AUTH_MODE=development` and the isolated `user_beta_dev` identity. Never deploy `apps/web/wrangler.jsonc`: it is a development-only config and deliberately binds a placeholder dev database ID so it cannot write to beta data (create a real dev D1 and replace the ID for local use). The worker refuses to start if development authentication is combined with a guarded or non-development environment. When R2/Durable Object bindings are absent, the affected routes return a clean `FEATURE_DISABLED` 501 before touching persistence.

### Performance

Interaction and startup performance are measured, not guessed — see [docs/performance-baseline.md](docs/performance-baseline.md) for the committed baselines and history. Rendering is on demand: hover picking is coalesced to one raycast per frame and skipped during camera drags, and the shadow map only re-renders when geometry changes. Reproduce the interaction numbers with:

```bash
OZ_PERF=1 pnpm exec playwright test interaction-probe
```

The exact adapter and BrepKit WASM load lazily inside the geometry worker on the first non-empty rebuild or export; OCCT (~22 MB) remains a second lazy boundary used for STEP documents and compound STEP export. Canonical rebuild results use a worker-local LRU capped at 8 entries and 32 MiB, with at most 4 distinct loads in flight. Cache hits are structured-cloned and exports remain uncached caller-owned work. See [ADR-015](docs/adrs/ADR-015-bounded-exact-rebuild-cache.md) and the measured bundle inventory in [docs/performance-baseline.md](docs/performance-baseline.md).

## Beta deployment

Email sign-in uses Cloudflare Email Service and Turnstile. Before enabling a real beta login:

- onboard the `auth.esau.app` sending domain and keep the `EMAIL` binding restricted to `login@auth.esau.app`;
- create a managed Turnstile widget allowlisting `zcad.esau.app` and bind its site key as `TURNSTILE_SITE_KEY`;
- deploy with `pnpm deploy:beta`, which applies the remote D1 migrations before publishing the Worker;
- set `AUTH_MODE=email-code`, `ENVIRONMENT=beta`, `AUTH_EMAIL_FROM=login@auth.esau.app` (the checked-in beta config also sets `PRODUCTION_GUARD`, which makes the worker refuse development auth outright);
- provide secrets, generated with `openssl rand -base64 32` where appropriate and set via `wrangler secret put`, never committed: `AUTH_OTP_PEPPER`, `TURNSTILE_SECRET_KEY`, `SETTINGS_ENCRYPTION_KEY` (must stay stable across deploys), `AI_IDENTITY_PEPPER`, `AI_DEPLOYMENT_ALLOWED_EMAILS`, and the AI provider key if the assistant is enabled. The required non-provider secrets are declared in `wrangler.jsonc`, so Wrangler rejects an incomplete deployment.

Login codes are single-use, expire after ten minutes, and sit behind per-email and per-IP rate limits. Sessions use a `Secure`, `HttpOnly`, `SameSite=Lax` host cookie; only a SHA-256 hash of the opaque token is stored. Turnstile responses must carry the `email-code` action, and every non-development verification pins the response hostname to the request hostname. `AUTH_LEGACY_OWNER_EMAIL` maps historical `user_beta_dev` projects to their owner's verified email without rewriting documents.

Project sharing is deliberately dark in both checked-in configurations:
`PROJECT_SHARING_ENABLED=false` and
`PROJECT_EDIT_LEASES_ENFORCED=false`. Apply and verify the sharing migration,
run role/revocation/lease/conflict recovery tests in beta, enable viewers first,
and enable editors only together with lease enforcement. These flags are
rollout controls; changing them is not part of a normal application build.

## API surface

```text
GET  /api/health                      GET       /api/assistant/status
GET  /api/auth/config                 POST      /api/assistant/proposals    (SSE)
POST /api/auth/email/start            GET|PATCH /api/settings
POST /api/auth/email/verify           PUT|DELETE /api/settings/assistant-credential
POST /api/auth/logout                 POST      /api/settings/assistant/test
GET  /api/session                     POST      /api/uploads
GET|POST /api/projects                PUT       /api/uploads/:id/content
GET  /api/projects/:id                POST      /api/artifacts/finalize
POST /api/projects/:id/revisions      GET       /api/projects/:id/artifacts
GET  /api/projects/:id/collaboration  (WebSocket upgrade)
POST /api/projects/:id/collaboration  (oversize snapshot recovery)
GET  /api/projects/:id/sharing       POST /api/projects/:id/invitations
PATCH|DELETE /api/projects/:id/members/:userId
DELETE /api/projects/:id/invitations/:invitationId
POST /api/project-invitations/accept
GET  /api/artifacts/:id               GET       /api/artifacts/:id/download
```

Cloud settings, personal credentials, projects, artifacts, and collaboration require an email-code session; the assistant also serves local-only users. Artifacts require an uploaded R2 object before finalization.

## AI assistant (experimental)

An optional side panel turns plain-language requests into reviewable document patches. It is experimental and entirely optional — the workspace is fully functional without it, and it stays dormant until a provider key is configured.

The dock collapses to a launcher in the bottom-right corner of the viewport, which gives its whole column back to the model; the conversation keeps running behind it, and the launcher counts any reply that lands while it is closed. Each project's thread — what was asked, what the assistant asked back, and which proposals were applied or rejected — is kept on the device and read back when the project reopens, so the scrollback is a record rather than a session.

The assistant streams proposals through the OpenAI Responses API. It sees compact feature history, live exact-topology summaries, and the active selection, so "fillet all edges" resolves stable edge fingerprints without manual picking. Output is constrained to a strict CAD patch schema; you preview, apply, or reject, and apply is one normal undoable transaction. PDF and image drawings can be attached as references. The AI can only propose a small allowlisted command patch — it cannot directly mutate a document, viewport, or kernel.

OpenRouter is the default provider. For local development, export the key in the launching shell or set it in `apps/web/.dev.vars` (git-ignored):

```dotenv
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
AI_MODEL=openai/gpt-5.6-terra
```

Runtime bindings are configured as Wrangler vars or secrets:

- `AI_PROVIDER` — `openrouter`, `openai`, or `responses-compatible`.
- `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `AI_API_KEY` — the server-side secret; never shipped to the browser or committed.
- `AI_BASE_URL` — optional endpoint override; required for `responses-compatible`.
- `AI_MODEL` — defaults to `openai/gpt-5.6-terra` (balanced). Use `openai/gpt-5.6-sol` when quality matters more than cost/latency, `openai/gpt-5.6-luna` for cheap latency-sensitive edits.
- `AI_REASONING_EFFORT` — `low`/`medium`/`high`/`xhigh`, default `high`.
- `AI_MAX_OUTPUT_TOKENS` — default `32000`; reasoning shares the budget, and too low a ceiling truncates patches mid-stream as a normal incomplete response.
- `AI_SITE_URL` / `AI_APP_NAME` — optional OpenRouter attribution.
- `AI_ALLOWED_BASE_URL_HOSTS` — exact, comma-separated hostnames approved for saved Responses-compatible endpoints outside development. Redirects are never followed.
- `AI_GLOBAL_DAILY_REQUEST_LIMIT` / `AI_GLOBAL_DAILY_COST_LIMIT_UNITS` — deployment-wide D1-backed ceilings; defaults are 100 requests and 400 weighted cost units per UTC day.
- `AI_DEPLOYMENT_ALLOWED_EMAILS` — secret, comma-separated email allowlist for accounts permitted to spend the deployment provider key. An empty or missing value denies deployment-funded AI outside development.

Signed-in users can instead store a personal provider token (Settings → AI). Tokens are encrypted with AES-GCM by the Worker (`SETTINGS_ENCRYPTION_KEY`) and never enter project documents or browser storage. `GET /api/assistant/status` never exposes provider secrets or deployment availability to a signed-out or non-allowlisted request. Public request identities and IP quota buckets use domain-separated HMAC-SHA-256 values keyed by `AI_IDENTITY_PEPPER`; the raw address is never stored or sent upstream.

Current assistant limitations and gates:

- **Assistant usage is bounded before provider dispatch** — beta requests use an authenticated deployment-key allowlist, D1-backed global/account/opaque-IP request and token-weighted cost quotas, and expiring concurrency leases. Provider-side billing controls remain the final deployment spend cap.
- Deterministic contracts are implemented for face-attached sketches, multi-profile extrudes, mirror, shell, solid offset, transforms, edge modifiers, patterns, and the existing validated direct-edit subset. The six newer operation families remain independently dark behind their `AI_PATCH_*_ENABLED` flags; topology-dependent proposals must repeat the exact digest witness and are rejected when stale.
- Recognized imported-feature coordination remains disabled in `AI_CAD_OPERATION_CAPABILITIES`; proposals cannot import geometry or perform collaboration actions.

## Known limitations

- Editable STEP sources are embedded in the canonical document (capped at 12 MB) for deterministic offline replay; large documents get expensive to save, sync, and undo (history snapshots clone the full document).
- Imported STL builds on the exact kernel through its STL importer, sewn into a shell so it can be mirrored, shelled, and offset. It stays a mesh body: no parametric reconstruction is attempted, and a boolean against an exact body is refused by name rather than approximated.
- Collaboration rooms store each document under its own Durable Object key (bounded history, atomic index updates, typed rejection frames for oversize or malformed payloads; documents over ~1.5 MB JSON are rejected). Invitations, owner/editor/viewer authorization, a persisted project edit lease, sharing UI, and recovery-copy-first conflict choices are implemented, but both checked-in sharing flags remain `false` pending controlled beta rollout.
- BrepKit's difficult boolean cases can fall back to mesh-derived topology, and closed-B-spline/NURBS-blend faces are not cross-kernel fingerprint-stable — they fail closed rather than mis-resolve.
- True face attachment requires a schema-v5 lineage reference and an exact planar face at the sketch's history position. Legacy face attachments retain their stored migration frame with a warning; deleted, ambiguous, non-planar, and unsupported current references fail visibly.
- The pinned BrepKit mirror preserves ordinary exact solids, but can report a volume mismatch for some dense boolean-plus-blend histories; exact preflight refuses those bodies without committing history rather than accepting a questionable reflection.
- Viewport idle edges are consolidated to one draw call per visible body; hover and selected edges use small reusable overlay batches.

## Next milestones

1. Run the recovery-copy reload E2E and staged beta checks, then enable viewer sharing before editor sharing; keep both deployment flags off until those gates pass.
2. Wire the exact imported-feature query into live OCCT bodies and add coordinated edits for proved blind/counterbored/countersunk holes, bosses, pockets, and tapers.
3. Extend verified lineage through boolean post-processing, blends, patterns, and direct edits without nearest-geometry rebinding.
4. Enable AI imported-feature operations only after the same deterministic manual command and exact preflight path ships.
5. Measure cache hit rate, rebuild latency, retained worker memory, and the consolidated edge-overlay draw-call reduction on target hardware.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026 Esau Engineering LLC. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for bundled dependency and font notices.
