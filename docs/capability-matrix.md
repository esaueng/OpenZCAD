# Capability and gap matrix

Snapshot: 2026-09-01, schema v13
([schema constant](../packages/shared/src/index.ts)). “Exact” means the browser
geometry worker evaluates the operation through a B-rep kernel. “Implemented
behind flags” is not a production-availability claim. Approximate previews and
isolated proof modules are called out explicitly.

| Area                    | Current capability                                                                                                                                                                                                       | Status                                  | Explicit limit / release gate                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical model         | Schema-v13 `ProjectDocument`, serialized command history, replay, transactions, undo/redo, and v1–v12 normalization ([schema constant](../packages/shared/src/index.ts))                                                 | Working                                 | Public schema changes remain additive; exact topology references use the schema-v5 contract carried by schema v13                                                                                                                               |
| Exact geometry          | Remus implements mirror-copy, shell, and sharp positive-outward solid offset for every document, imported STEP included                                                                                                  | Working safe subset                     | Dense filleted bodies mirror at preserved volume; the exact-volume guard remains and only a synthetic broken kernel trips it ([real body](../test/modeling-operation-preflight.test.ts), [guard](../packages/kernel-adapter/src/remus-modeling-operations.test.ts)). The OpenCascade convex-planar offset limit and its capability fields are deleted (Z5); the reference adapter is corpus-only |
| STEP                    | Exact Remus import/export honouring the file's declared units, plus live bounded imported-feature proofs and grouped hole auto-parameterization                                                                          | Partial                                 | Blind/counterbore/countersink proofs have coordinated commands; boss, pocket, and taper proofs remain read-only. Blends on imported bodies fit B-spline bands where a quarter cylinder is exact (K0.4)                                          |
| Topology identity       | Exact witnesses and semantic lineage for supported primitives, sweeps, and rigid transforms on both kernels                                                                                                              | Working safe subset                     | Booleans and add/cut extrudes carry identity by unique analytic carrier (shared or split carriers stay hash-only); blends, patterns, direct edits, and STEP provenance stay explicitly hash-only where complete evolution is unavailable                                                                                                  |
| Face-attached sketches  | Schema-v5 face references resolve an exact planar face at the sketch’s history position on both exact adapters; new UI attachments require a current matching reference; a deterministic frame is rebuilt from that face | Working for current references          | Deleted, ambiguous, non-planar, and unsupported faces stop rebuild. Hash-only faces refuse new sketches. Legacy attachments use the stored migration frame with a warning and can be converted explicitly to a fixed plane                      |
| Sketch constraints      | Direct tools cover every schema-backed kind; distance and angle use placed, expression-aware driving values and commit the constraint plus solved coordinates as one undoable transaction                            | Working for line/arc/circle identities  | Rectangles, polygons, and text lack constrainable point identity. Distance/angle driving targets render on canvas and reopen the editor. Radius annotations, saved placement, driven dimensions, and DOF/conflict UI remain roadmap work                                                             |
| Multi-profile extrusion | Multiple exact closed profiles on Remus; deterministic AI contract available                                                                                                                                             | Working                                 | Keep the seam and history-position fixtures green as topology contracts evolve; the parity corpus still checks the same profiles against the OpenCascade reference                                                                              |
| Modeling UI             | Mirror, shell opening-face selection, and solid-offset forms share command preflight and expression validation                                                                                                           | Working safe subset                     | Output lineage remains hash-only. Solid offset is no longer withheld on imported documents — that gate described OpenCascade, which Z5 deleted                                                                                                  |
| Direct edits            | Planar offsets, cylindrical hole/boss radius edits, through-hole resize, feature removal, and grouped blind/counterbore/countersink bindings run with analytic and volume validation                                     | Partial                                 | Imported-hole diameter changes are supported for ordinary proofs; depth/angle changes and chamfered-entry counterbore resizes fail explicitly. Pocket-depth and taper-angle edits remain disabled                                               |
| Imported-feature proof  | Live bounded analytic adjacency proofs publish non-overlapping blind-hole, counterbore (including conical entry chamfers), countersink, boss, and conical-taper metadata with imported derived topology                  | Working safe subset                     | The polygon-pocket detector remains isolated until the live query can publish exact straight-edge loops. No tessellation/nearest guessing; ambiguous/incomplete proofs fail closed. Only the three hole families produce coordinated operations |
| Viewport edges          | One idle exact-edge batch per visible body with ownership, picking, hover, selection, seams, and wireframe                                                                                                               | Working                                 | Continue measuring draw calls and consolidate further only against the committed probe                                                                                                                                                          |
| Local persistence       | IndexedDB autosave, offline reopen, and recovery-project writes before every destructive collaboration resolution                                                                                                        | Working                                 | Reload-survival remains a required real-session beta check during the collaboration rollout                                                                                                                                                     |
| Cloud settings          | Serialized/coalesced saves, revision chaining, bounded conflict retry, offline resume, session epochs, and logout flush                                                                                                  | Working                                 | Separate from project-conflict resolution by design                                                                                                                                                                                             |
| Collaboration           | Invitation acceptance UI, owner/editor/viewer APIs and dialog, one-time token copy, per-message authorization, one persisted project-wide edit lease, and explicit conflict actions                                      | Working for authenticated beta accounts | The beta flags admit any authenticated email; project ownership/membership and edit leases still authorize access and writes. The secret account canary remains a scoped fallback if the global flags are closed again                          |
| Conflict recovery       | One dialog for room and account divergence: Keep this device’s version, Use the other version, and Save mine as a copy all preserve the losing document first, once per document state; unresolved divergence survives dialog close/reload | Working client flow                     | Keep mine on a room conflict requires this client’s unexpired lease and the exact expected room version; release gate is the reload E2E                                                                                                                            |
| AI proposals            | Strict schema, deterministic digest-bound validation, exact preflight, review, and one undoable transaction; recognized imported-hole edits validate against published proofs                                            | Working, rollout-gated allowlist        | Imported geometry creation and collaboration actions remain disabled; stale topology witnesses and stale imported-feature proofs are rejected                                                                                                   |
| Kernel delivery         | The exact adapter and Remus load lazily in the worker; jobs have tagged lifecycle state and stale-result gating. Every pin and production bundle records raw, gzip, and Brotli WASM size against the [staged policy](kernel-wasm-size-policy.md) | Working                                 | The PR #165 pin emits a 7,776,918-byte raw / 2,747,755-byte gzip / 1,955,827-byte Brotli-q11 kernel. First-load latency remains hardware-dependent and must be measured separately from UI bundle startup                                         |
| Exact rebuild cache     | Canonical-content key excluding derived state; structured-cloned LRU results; in-flight deduplication; 8-entry, 32 MiB, 4-load bounds                                                                                    | Working bounded cache                   | Exports are uncached and caller-owned; cache performance and retained memory need target-hardware baselines                                                                                                                                     |
| Production rollout      | Beta/development resources only                                                                                                                                                                                          | Deliberately absent                     | No production target or production-domain configuration is authorized                                                                                                                                                                           |

## Wave convergence

### Wave 0: baselines and immediate hardening

- Cloud settings serialization/retry, orientation-widget lifecycle, performance
  probes, and the pinned-kernel topology-history spike are present.
- The spike is characterization evidence, not permission to trust raw kernel
  evolution. ADR-013 records the safe subset and bridge gaps.

### Wave 1: independent foundations

- Exact-edge batching and its matched interaction baseline are working.
- Sharing authorization and additive topology witness/reference contracts are
  implemented. Unknown/closed free-form carriers fail closed.

### Wave 2: lineage, roles, leases, and worker lifecycle

- Kernel history is candidate evidence only. Exact witnesses independently
  verify the shipped semantic lineage subset, and unsupported transitions
  retain unique-hash fallback.
- Geometry worker state is project/version/request tagged. Broadcast rebuilds
  coalesce; explicit export/preview work remains lossless.
- Sharing storage, routes, role authorization, and the persisted project lease
  are enabled for authenticated beta accounts and remain closed in local Worker
  development by default.

### Wave 3: modeling contracts

- Schema v13 owns mirror, shell, and solid-offset features. Mirror creates an
  independent body; shell and offset consume their source and own the result.
- Positive shell thickness is inward while retaining the outer envelope;
  positive solid offset is outward. These unit/sign conventions are public and
  must not change silently.
- Imported-feature recognition is a narrow proof service, not a claim that the
  six feature families are editable in the workspace.

### Wave 4: product UI and conflict safety

- New face-attached sketches resolve lineage at their history position on both
  exact kernels. The stored frame is diagnostic, never a fallback for a current
  lineage reference. The UI refuses new attachments to hash-only faces rather
  than creating a warned legacy snapshot.
- Modeling forms expose exact readiness and kernel-specific unsupported reasons.
- The app centrally blocks mutations for viewers, while waiting for a lease, or
  during unresolved conflict. Recovery choices preserve a local project first.

### Wave 5: deterministic AI and worker convergence

- New AI operations use the same commands and exact preflight as manual UI.
  Topology-dependent proposals are bound to the exact digest that prompted them.
- The exact adapter/Remus boundary is now dynamic, OpenCascade is deleted
  from the adapter and ships nowhere, and canonical derived results use the
  bounded worker-local cache described in
  [ADR-015](adrs/ADR-015-bounded-exact-rebuild-cache.md).

## Feature flags and rollout order

The root beta `wrangler.jsonc` currently sets:

```text
PROJECT_SHARING_ENABLED=true
PROJECT_EDIT_LEASES_ENFORCED=true
PROJECT_PERSONAL_SYNC_ENABLED=true
```

`apps/web/wrangler.jsonc` remains closed for local Worker development. The beta
rollout is now:

1. Apply and verify the sharing migration and Durable Object binding.
2. Admit every authenticated account; continue enforcing project ownership,
   membership, and same-origin checks server-side.
3. Run authorization, revocation, lease-expiry, conflict recovery-copy, and
   reload-survival tests against the target beta environment.
4. Roll back all three global flags together if live authorization or lease
   behavior regresses; the secret allowlist may be used for a scoped retest.
5. Keep production configuration absent until separately authorized.
